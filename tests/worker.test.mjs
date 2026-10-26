import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JobStore } from '../src/store.mjs';
import { workOnce, workLoop } from '../src/worker.mjs';

const event = JSON.parse(await readFile(new URL('../examples/fixtures/ticket.json', import.meta.url)));

test('worker records one result and does not rerun duplicate deliveries', async () => {
  const store = new JobStore(':memory:');
  try {
    const { job } = store.enqueue(event);
    let calls = 0;
    const options = { store, config: { mode: 'mock' }, log: () => {}, runJob: async input => { calls++; assert.equal(input.id, event.id); return { artifact: 'synthetic' }; } };
    await workOnce(options);
    store.enqueue(event);
    assert.equal(await workOnce(options), null);
    assert.equal(calls, 1);
    assert.equal(store.get(job.id).state, 'completed');
  } finally { store.close(); }
});

test('failed job remains retryable and output does not contain secret exception text', async () => {
  const store = new JobStore(':memory:');
  try {
    const { job } = store.enqueue(event);
    const logs = [];
    const result = await workOnce({ store, config: {}, log: line => logs.push(line), runJob: async () => { throw new Error('token=never-print-this'); } });
    assert.equal(result.failed, true);
    assert.equal(store.get(job.id).state, 'queued');
    assert.ok(!logs.join('').includes('never-print-this'));
  } finally { store.close(); }
});

test('shutdown does not claim new work', async () => {
  await workOnce({ store: { claim: () => assert.fail('must not claim') }, signal: AbortSignal.abort() });
});

test('continuous remote worker recovers after a transient claim failure', async () => {
  const real = new JobStore(':memory:');
  const shutdown = new AbortController();
  let attempts = 0;
  const logs = [];
  const { job } = real.enqueue(event);
  const store = {
    claim() { attempts++; if (attempts === 1) throw new Error('BRIDGE_HTTP_503'); return real.claim(); },
    complete: (...args) => real.complete(...args), fail: (...args) => real.fail(...args), renew: (...args) => real.renew(...args),
  };
  try {
    await workLoop({ store, config: { mode: 'mock' }, signal: shutdown.signal,
      log: line => logs.push(line), runJob: async () => ({ status: 'review-ready' }),
      delay: async () => { if (attempts >= 2) shutdown.abort(); },
    });
    assert.equal(attempts, 2);
    assert.equal(real.get(job.id).state, 'completed');
    assert.ok(logs.some(line => JSON.parse(line).state === 'bridge-retry'));
  } finally { real.close(); }
});
