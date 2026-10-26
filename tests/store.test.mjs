import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/store.mjs';
import { validateEvent } from '../src/events.mjs';

const fixture = JSON.parse(await readFile(new URL('../examples/fixtures/ticket.json', import.meta.url)));

test('canonical validation rejects missing fields, commands and paths from event content', () => {
  assert.deepEqual(validateEvent(fixture), fixture);
  for (const event of [
    { ...fixture, command: 'anything' }, { ...fixture, repository: '../escape' },
    { ...fixture, id: 42 }, { ...fixture, data: { title: ' ', body: '' } },
    { ...fixture, data: { ...fixture.data, path: '/tmp' } },
    { ...fixture, occurredAt: 'invalid-date' },
  ]) assert.throws(() => validateEvent(event), /INVALID_EVENT/);
});

test('duplicate event is one durable job and conflicting content cannot replace it', () => {
  const store = new JobStore(':memory:');
  try {
    const initial = store.enqueue(fixture);
    const duplicate = store.enqueue(JSON.parse(JSON.stringify(fixture)));
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.job.id, initial.job.id);
    assert.throws(() => store.enqueue({ ...fixture, data: { ...fixture.data, title: 'Changed content' } }), /EVENT_CONFLICT/);
    assert.equal(store.get(initial.job.id).event.data.title, fixture.data.title);
  } finally { store.close(); }
});

test('separate database connections cannot claim one job concurrently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'event-jobs-'));
  const one = new JobStore(join(root, 'jobs.sqlite'));
  const two = new JobStore(join(root, 'jobs.sqlite'));
  try {
    const { job } = one.enqueue(fixture);
    const first = one.claim();
    assert.equal(first.id, job.id);
    assert.equal(two.claim(), null);
    one.complete(first.id, first.leaseToken, { status: 'review-ready' });
    assert.equal(two.get(first.id).state, 'completed');
    assert.equal(two.claim(), null);
  } finally { one.close(); two.close(); await rm(root, { recursive: true, force: true }); }
});

test('expired lease is reclaimed and stale worker cannot acknowledge or renew', () => {
  let now = 1000;
  const store = new JobStore(':memory:', { now: () => now });
  try {
    store.enqueue(fixture);
    const old = store.claim({ leaseMs: 100 });
    now += 101;
    assert.throws(() => store.complete(old.id, old.leaseToken, {}), /STALE_LEASE/);
    const next = store.claim({ leaseMs: 100 });
    assert.equal(next.id, old.id);
    assert.notEqual(next.leaseToken, old.leaseToken);
    assert.throws(() => store.complete(old.id, old.leaseToken, {}), /STALE_LEASE/);
    assert.throws(() => store.renew(old.id, old.leaseToken), /STALE_LEASE/);
    store.complete(next.id, next.leaseToken, { status: 'complete' });
  } finally { store.close(); }
});

test('retry delay and attempt ceiling stop poison jobs without hot looping', () => {
  let now = 1000;
  const store = new JobStore(':memory:', { now: () => now, maxAttempts: 2 });
  try {
    store.enqueue(fixture);
    const first = store.claim();
    store.fail(first.id, first.leaseToken, 'secret URL should never persist');
    assert.equal(store.get(first.id).error, 'JOB_FAILED');
    assert.equal(store.claim(), null);
    now += 5000;
    const second = store.claim();
    store.fail(second.id, second.leaseToken, 'CHECKS_FAILED');
    now += 5000;
    assert.equal(store.claim(), null);
    assert.equal(store.get(first.id).state, 'failed');
  } finally { store.close(); }
});

test('crashing on the final attempt also reaches failed state', () => {
  let now = 1000;
  const store = new JobStore(':memory:', { now: () => now, maxAttempts: 1 });
  try {
    const { job } = store.enqueue(fixture);
    store.claim({ leaseMs: 100 });
    now += 101;
    assert.equal(store.claim(), null);
    assert.equal(store.get(job.id).state, 'failed');
  } finally { store.close(); }
});
