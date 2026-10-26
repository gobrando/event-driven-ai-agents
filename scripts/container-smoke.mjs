import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { signWebhook } from '../src/webhook.mjs';
import { HttpJobStore } from '../src/http-store.mjs';

const exec = promisify(execFile);
const reserve = createServer();
reserve.listen(0, '127.0.0.1');
await once(reserve, 'listening');
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const project = `event-agent-smoke-${process.pid}`;
const env = {
  ...process.env, BRIDGE_PORT: String(port),
  EVENT_WEBHOOK_SECRET: randomBytes(32).toString('hex'), WORKER_TOKEN: randomBytes(32).toString('hex'),
};
const compose = args => exec('docker', ['compose', '-p', project, ...args], { env, timeout: 120_000, maxBuffer: 512 * 1024 });
const origin = `http://127.0.0.1:${port}`;
async function ready() {
  for (let tries = 0; tries < 120; tries++) {
    try { if ((await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* wait */ }
    await delay(500);
  }
  throw new Error('CONTAINER_NOT_READY');
}
try {
  // Build the current source before the smoke test; a stale local tag must not
  // be accepted as evidence for a changed working tree.
  await exec('docker', ['build', '-t', 'event-driven-ai-agents:local', '.'], { timeout: 300_000, maxBuffer: 1024 * 1024 });
  await compose(['up', '-d', '--no-build']);
  await ready();
  const body = await readFile('examples/fixtures/ticket.json', 'utf8');
  const headers = { 'content-type': 'application/json', ...signWebhook(body, env.EVENT_WEBHOOK_SECRET) };
  const response = await fetch(`${origin}/events`, { method: 'POST', headers, body });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  const client = new HttpJobStore(origin, env.WORKER_TOKEN);
  let job;
  for (let tries = 0; tries < 120; tries++) {
    job = await client.get(id);
    if (['completed', 'failed'].includes(job.state)) break;
    await delay(500);
  }
  assert.equal(job.state, 'completed');
  assert.equal(job.result.status, 'review-ready');
  assert.deepEqual(job.result.changedFiles, ['src/answer.mjs']);
  assert.equal(job.result.modelSpendUsd, 0);
  await compose(['restart', 'bridge']);
  await ready();
  assert.equal((await client.get(id)).state, 'completed');
  const duplicate = await fetch(`${origin}/events`, { method: 'POST', headers, body });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).id, id);
  console.log(JSON.stringify({ evidence: 'local-docker-compose', completedJobs: 1, persistedAcrossRestart: true, duplicateJobs: 0, modelSpendUsd: 0 }));
} catch (error) {
  const logs = await compose(['logs', '--tail', '50']).catch(() => ({ stdout: 'Container logs unavailable' }));
  console.error(logs.stdout);
  throw error;
} finally {
  await compose(['down', '--volumes', '--remove-orphans']);
}
