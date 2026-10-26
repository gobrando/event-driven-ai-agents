import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Experimental_McpEventVerificationError } from '@vercel/connect/mcp';
import { createMemoryStore } from '../src/store.mjs';
import { createMemoryQueue } from '../src/queue.mjs';
import { createReceiver } from '../src/receiver.mjs';
import { runOnce } from '../src/worker.mjs';
import { offlineSigner, receiverIdentity } from './support/offline-signer.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/issue-created.json', import.meta.url)));
let signer;
before(() => { signer = offlineSigner(); });
after(() => { assert.equal(signer.close(), true); });

async function harness() {
  const store = createMemoryStore();
  const queue = createMemoryQueue();
  await store.bindSubscription({ subscriptionId: fixture.subscriptionId, connectorId: fixture.source.connectorId, eventName: fixture.event.name });
  return { store, queue, receive: createReceiver({ store, queue, verifierOptions: receiverIdentity }) };
}

test('valid SDK-verified RS256 delivery queues a replay that the pull worker summarizes once', async () => {
  const { store, queue, receive } = await harness();
  const logs = [];
  assert.equal((await receive(signer.request(fixture, { token: signer.token() }))).status, 204);
  await runOnce({ store, queue, log: line => logs.push(JSON.parse(line)) });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, 'event');
  assert.match(logs[0].summary, /TEST-001: Example export button/);
  assert.equal((await receive(signer.request(fixture, { token: signer.token() }))).status, 204);
  await runOnce({ store, queue, log: line => logs.push(line) });
  assert.equal(logs.length, 1);
  const result = await store.process(fixture.deliveryId, () => assert.fail('must reuse stored summary'));
  assert.equal(result.duplicate, true);
});

test('invalid signature is rejected before durable acceptance', async () => {
  const { store, receive } = await harness();
  const token = signer.token();
  assert.equal((await receive(signer.request(fixture, { token: `${token.slice(0, -4)}AAAA` }))).status, 401);
  assert.deepEqual(await store.pending(), []);
});

test('missing signature is rejected before durable acceptance', async () => {
  const { store, receive } = await harness();
  assert.equal((await receive(signer.request(fixture))).status, 401);
  assert.deepEqual(await store.pending(), []);
});

test('wrong project, destination purpose, audience and expired token are rejected', async () => {
  const { receive } = await harness();
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [
    { project_id: 'prj_another' },
    { connect: { purpose: 'not_delivery', version: 1, destinationPath: '/api/hooks' } },
    { connect: { purpose: 'mcp_event_delivery', version: 1, destinationPath: '/another-path' } },
    { aud: 'https://vercel.com/another-team' },
    { iat: now - 600, exp: now - 480 },
  ]) assert.equal((await receive(signer.request(fixture, { token: signer.token(claims) }))).status, 401);
});

test('unsupported payload is rejected and unknown subscription remains retryable', async () => {
  const { store, receive } = await harness();
  const malformed = structuredClone(fixture);
  malformed.event.data.title = 42;
  assert.equal((await receive(signer.request(malformed, { token: signer.token() }))).status, 422);
  const unknown = { ...fixture, subscriptionId: 'unknown' };
  assert.equal((await receive(signer.request(unknown, { token: signer.token() }))).status, 503);
  assert.deepEqual(await store.pending(), []);
});

test('failed queue send leaves durable outbox for worker recovery', async () => {
  const { store, queue } = await harness();
  const receive = createReceiver({ store, queue: { send: async () => { throw new Error('offline'); } }, verifierOptions: receiverIdentity });
  assert.equal((await receive(signer.request(fixture, { token: signer.token() }))).status, 503);
  assert.equal((await store.pending()).length, 1);
  const logs = [];
  await runOnce({ store, queue, log: line => logs.push(JSON.parse(line)) });
  assert.equal(logs.length, 1);
  assert.deepEqual(await store.pending(), []);
});

test('verification unavailable or misconfigured receiver returns 503', async () => {
  const { store, queue } = await harness();
  for (const code of ['configuration_error', 'verification_unavailable']) {
    const receive = createReceiver({ store, queue, verifierOptions: receiverIdentity, verify: async () => { throw new Experimental_McpEventVerificationError(code); } });
    assert.equal((await receive(signer.request(fixture, { token: signer.token() }))).status, 503);
  }
});

test('worker retries a failed handler and honors shutdown before polling', async () => {
  const queue = createMemoryQueue();
  await queue.send({ deliveryId: fixture.deliveryId });
  await assert.rejects(queue.receive(async () => { throw new Error('retry'); }), /retry/);
  let calls = 0;
  await queue.receive(async () => { calls += 1; });
  assert.equal(calls, 1);
  await runOnce({ store: { pending: () => assert.fail('must not poll') }, queue, signal: AbortSignal.abort() });
});

test('deployed entrypoint fails closed with no live configuration', async () => {
  const { default: endpoint } = await import('../api/hooks.mjs');
  const previous = process.env.POC_LIVE_ENABLED;
  delete process.env.POC_LIVE_ENABLED;
  try { assert.equal((await endpoint.fetch(signer.request(fixture))).status, 503); }
  finally { if (previous !== undefined) process.env.POC_LIVE_ENABLED = previous; }
});
