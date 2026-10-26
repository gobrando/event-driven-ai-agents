import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateEvent, eventFingerprint } from './events.mjs';

export class JobError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function decode(row) {
  if (!row) return null;
  return {
    id: row.id, event: JSON.parse(row.event), state: row.state,
    attempts: row.attempts, leaseToken: row.lease_token, leaseUntil: row.lease_until,
    result: row.result ? JSON.parse(row.result) : null, error: row.error,
  };
}

export class JobStore {
  constructor(path = '.state/jobs.sqlite', { now = Date.now, maxAttempts = 3 } = {}) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new JobError('INVALID_ATTEMPTS');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.now = now;
    this.maxAttempts = maxAttempts;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
        event TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER, result TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(state, available_at);`);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  enqueue(input) {
    const event = validateEvent(input);
    const fingerprint = eventFingerprint(event);
    // Include the source so unrelated providers may use the same event ID.
    const key = `${event.source}:${event.id}`;
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM jobs WHERE event_key = ?').get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new JobError('EVENT_CONFLICT');
        return { duplicate: true, job: decode(prior) };
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO jobs(id,event_key,fingerprint,event,available_at) VALUES(?,?,?,?,?)')
        .run(id, key, fingerprint, JSON.stringify(event), this.now());
      return { duplicate: false, job: this.get(id) };
    });
  }

  get(id) { return decode(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)); }

  claim({ leaseMs = 300_000 } = {}) {
    if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 3_600_000) throw new JobError('INVALID_LEASE');
    return this.transaction(() => {
      const now = this.now();
      this.db.prepare(`UPDATE jobs SET state = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
        available_at = ?, lease_token = NULL, lease_until = NULL, error = 'LEASE_EXPIRED'
        WHERE state = 'running' AND lease_until <= ?`).run(this.maxAttempts, now, now);
      const next = this.db.prepare("SELECT id FROM jobs WHERE state = 'queued' AND available_at <= ? ORDER BY available_at,rowid LIMIT 1").get(now);
      if (!next) return null;
      this.db.prepare("UPDATE jobs SET state='running',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=?")
        .run(randomUUID(), now + leaseMs, next.id);
      return this.get(next.id);
    });
  }

  renew(id, token, { leaseMs = 300_000 } = {}) {
    if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 3_600_000) throw new JobError('INVALID_LEASE');
    const now = this.now();
    const update = this.db.prepare("UPDATE jobs SET lease_until=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?")
      .run(now + leaseMs, id, token, now);
    if (!update.changes) throw new JobError('STALE_LEASE');
  }

  complete(id, token, result) {
    const encoded = JSON.stringify(result);
    if (!encoded || Buffer.byteLength(encoded) > 32_768) throw new JobError('INVALID_RESULT');
    const update = this.db.prepare("UPDATE jobs SET state='completed',result=?,error=NULL,lease_token=NULL,lease_until=NULL WHERE id=? AND state='running' AND lease_token=? AND lease_until>?")
      .run(encoded, id, token, this.now());
    if (!update.changes) throw new JobError('STALE_LEASE');
    return this.get(id);
  }

  fail(id, token, error = 'JOB_FAILED') {
    const now = this.now();
    // Persist bounded diagnostic codes, never exception messages containing
    // remote response bodies, credentials or local paths.
    const code = /^[A-Z0-9_]{1,80}$/.test(error) ? error : 'JOB_FAILED';
    const update = this.db.prepare(`UPDATE jobs SET state=CASE WHEN attempts>=? THEN 'failed' ELSE 'queued' END,
      available_at=?,error=?,lease_token=NULL,lease_until=NULL
      WHERE id=? AND state='running' AND lease_token=? AND lease_until>?`)
      .run(this.maxAttempts, now + 5000, code, id, token, now);
    if (!update.changes) throw new JobError('STALE_LEASE');
    return this.get(id);
  }

  close() { this.db.close(); }
}
