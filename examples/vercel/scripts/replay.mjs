import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.mjs';
import { createMemoryQueue } from '../src/queue.mjs';
import { createReceiver } from '../src/receiver.mjs';
import { runOnce } from '../src/worker.mjs';
import { offlineSigner, receiverIdentity } from '../tests/support/offline-signer.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/issue-created.json', import.meta.url)));
const signer = offlineSigner();
const store = createMemoryStore();
const queue = createMemoryQueue();
const logs = [];
try {
  await store.bindSubscription({ subscriptionId: fixture.subscriptionId, connectorId: fixture.source.connectorId, eventName: fixture.event.name });
  const receive = createReceiver({ store, queue, verifierOptions: receiverIdentity });
  const token = signer.token();
  const accepted = await receive(signer.request(fixture, { token }));
  assert.equal(accepted.status, 204);
  await runOnce({ store, queue, log: line => { logs.push(line); console.log(line); } });
  assert.equal(logs.length, 1);
  assert.match(JSON.parse(logs[0]).summary, /TEST-001/);
  assert.equal((await receive(signer.request(fixture, { token }))).status, 204);
  await runOnce({ store, queue, log: line => logs.push(line) });
  assert.equal(logs.length, 1);
  const invalid = `${token.slice(0, -4)}AAAA`;
  assert.equal((await receive(signer.request(fixture, { token: invalid }))).status, 401);
  assert.equal((await receive(signer.request(fixture))).status, 401);
  console.log(JSON.stringify({ evidence: 'deterministic', mode: 'offline-fixture-replay', accepted: 204, duplicateSummaries: 0, invalid: 401, unsigned: 401, llmSpendUsd: 0, liveServicesUsed: false }));
} finally {
  await store.close();
  assert.equal(signer.close(), true, 'The real SDK must have requested the mocked JWKS');
}
