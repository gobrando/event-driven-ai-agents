import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { JobStore } from '../src/store.mjs';
import { createBridge } from '../src/server.mjs';
import { signWebhook } from '../src/webhook.mjs';
import { HttpJobStore, validateBridgeUrl } from '../src/http-store.mjs';

const fixture = JSON.parse(await readFile(new URL('../examples/fixtures/ticket.json', import.meta.url)));

async function harness(t) {
  const webhookSecret = randomBytes(32).toString('hex');
  const workerToken = randomBytes(32).toString('hex');
  const store = new JobStore(':memory:');
  const server = createBridge({ store, webhookSecret, workerToken });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  return { store, url, webhookSecret, workerToken, client: new HttpJobStore(url, workerToken) };
}

async function post(url, body, headers = {}) {
  return fetch(`${url}/events`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
}

test('signed HTTP delivery, durable queue, remote claim and completion execute end to end', async t => {
  const { url, webhookSecret, client } = await harness(t);
  const body = JSON.stringify(fixture);
  const headers = signWebhook(body, webhookSecret);
  const accepted = await post(url, body, headers);
  assert.equal(accepted.status, 202);
  const receipt = await accepted.json();
  assert.equal((await post(url, body, headers)).status, 200);
  const job = await client.claim();
  assert.equal(job.id, receipt.id);
  await client.renew(job.id, job.leaseToken);
  await client.complete(job.id, job.leaseToken, { status: 'review-ready' });
  assert.equal((await client.get(job.id)).state, 'completed');
  assert.equal(await client.claim(), null);
});

test('unsigned, tampered and stale webhook deliveries cannot enqueue jobs', async t => {
  const { url, webhookSecret, client } = await harness(t);
  const body = JSON.stringify(fixture);
  assert.equal((await post(url, body)).status, 401);
  const signed = signWebhook(body, webhookSecret);
  const altered = JSON.stringify({ ...fixture, id: 'tampered' });
  assert.equal((await post(url, altered, signed)).status, 401);
  assert.equal((await post(url, body, signWebhook(body, webhookSecret, String(Math.floor(Date.now() / 1000) - 301)))).status, 401);
  assert.equal(await client.claim(), null);
});

test('worker endpoints require separate credentials and stale fencing token is rejected', async t => {
  const { url, webhookSecret, client } = await harness(t);
  assert.equal((await fetch(`${url}/jobs/claim`, { method: 'POST' })).status, 401);
  const producer = new HttpJobStore(url, webhookSecret);
  await assert.rejects(producer.claim(), /BRIDGE_HTTP_401/);
  const body = JSON.stringify(fixture);
  await post(url, body, signWebhook(body, webhookSecret));
  const job = await client.claim();
  await assert.rejects(client.complete(job.id, 'incorrect-token', {}), /BRIDGE_HTTP_409/);
  const malformed = await fetch(`${url}/jobs/${job.id}/renew`, {
    method: 'POST', headers: { authorization: `Bearer ${client.token}`, 'content-type': 'application/json' }, body: 'null',
  });
  assert.equal(malformed.status, 400);
});

test('invalid payload, conflicting duplicate and oversized body return errors', async t => {
  const { url, webhookSecret } = await harness(t);
  const malformed = '{bad json';
  assert.equal((await post(url, malformed, signWebhook(malformed, webhookSecret))).status, 400);
  const unsupported = JSON.stringify({ ...fixture, command: 'run' });
  assert.equal((await post(url, unsupported, signWebhook(unsupported, webhookSecret))).status, 422);
  const original = JSON.stringify(fixture);
  await post(url, original, signWebhook(original, webhookSecret));
  const changed = JSON.stringify({ ...fixture, data: { ...fixture.data, title: 'other' } });
  assert.equal((await post(url, changed, signWebhook(changed, webhookSecret))).status, 409);
  assert.equal((await post(url, 'x'.repeat(65_537))).status, 413);
});

test('remote workers require TLS except loopback, and reject credentials in URLs', () => {
  assert.equal(validateBridgeUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const value of ['http://example.invalid', 'https://user:secret@example.invalid', 'https://example.invalid/token?secret=value']) {
    assert.throws(() => validateBridgeUrl(value));
  }
});
