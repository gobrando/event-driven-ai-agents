import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createMemoryStore, createSqlStore } from '../src/store.mjs';

const binding = { subscriptionId: 'sub-synthetic', connectorId: 'connector-synthetic', eventName: 'issue.created' };

function event(deliveryId = 'delivery-synthetic') {
  return {
    version: 1,
    deliveryId,
    subscriptionId: binding.subscriptionId,
    source: { type: 'mcp', connectorId: binding.connectorId },
    context: {},
    event: {
      eventId: `event-${deliveryId}`,
      name: binding.eventName,
      timestamp: '2026-10-16T12:00:00.000Z',
      data: { id: 'SYN-1', title: 'Synthetic queue example', body: 'Synthetic fixture only.' },
      cursor: null,
    },
  };
}

function control(kind, deliveryId = `delivery-${kind}`) {
  const delivery = event(deliveryId);
  delete delivery.event;
  delivery.control = kind === 'gap'
    ? { type: 'gap', cursor: null, truncated: true }
    : { type: 'terminated', error: { code: -32000, message: 'Synthetic provider termination.' } };
  return delivery;
}

function sqlAdapter(db) {
  return {
    query: async (statement, parameters = []) => (await db.query(statement, parameters)).rows,
    transaction: (fn) => db.transaction((tx) => fn(sqlAdapter(tx))),
    close: () => db.close(),
  };
}

const adapters = {
  'offline fixture memory': async () => ({ store: createMemoryStore() }),
  'PostgreSQL SQL in offline PGlite': async () => {
    const db = new PGlite();
    const store = createSqlStore(sqlAdapter(db));
    await store.migrate();
    return { store, db };
  },
};

for (const [name, create] of Object.entries(adapters)) {
  test(`${name}: inbox/outbox and lifecycle contract`, async (t) => {
    const { store, db } = await create();
    t.after(() => store.close());
    const reset = async () => {
      if (db) await db.exec('TRUNCATE poc_mcp_outbox, poc_mcp_deliveries, poc_mcp_subscriptions');
      return db ? store : createMemoryStore();
    };

    await t.test('duplicate delivery IDs produce one outbox entry and one stored result', async () => {
      const current = await reset();
      await current.bindSubscription(binding);
      assert.deepEqual(await current.accept(event()), { duplicate: false });
      // JSON object key order does not change receipt identity.
      const reordered = Object.fromEntries(Object.entries(event()).reverse());
      assert.deepEqual(await current.accept(reordered), { duplicate: true });
      assert.deepEqual(await current.pending(), [{ deliveryId: 'delivery-synthetic' }]);
      let calls = 0;
      const summarize = (stored) => { calls += 1; return `Triage: ${stored.event.data.title}`; };
      const first = await current.process('delivery-synthetic', summarize);
      const second = await current.process('delivery-synthetic', summarize);
      assert.equal(first.kind, 'event');
      assert.equal(second.duplicate, true);
      assert.equal(first.summary, second.summary);
      assert.equal(calls, 1);
    });

    await t.test('a conflicting duplicate cannot replace the authoritative receipt', async () => {
      const current = await reset();
      await current.bindSubscription(binding);
      await current.accept(event());
      const forged = event();
      forged.event.data.title = 'Replacement payload';
      await assert.rejects(current.accept(forged), { code: 'DELIVERY_CONFLICT' });
      const result = await current.process('delivery-synthetic', (stored) => stored.event.data.title);
      assert.equal(result.summary, 'Synthetic queue example');
      assert.equal((await current.pending()).length, 1);
    });

    await t.test('unknown binding is retryable and leaves neither inbox nor dispatch intent', async () => {
      const current = await reset();
      await assert.rejects(current.accept(event()), { code: 'UNKNOWN_SUBSCRIPTION' });
      assert.deepEqual(await current.pending(), []);
      await assert.rejects(current.process('delivery-synthetic', () => 'Unexpected work'), { code: 'UNKNOWN_DELIVERY' });
      await current.bindSubscription(binding);
      assert.deepEqual(await current.accept(event()), { duplicate: false });
      assert.equal((await current.process('delivery-synthetic', () => 'Retry succeeds')).summary, 'Retry succeeds');
    });

    await t.test('source connector and event name must match the immutable saved binding', async () => {
      const current = await reset();
      await current.bindSubscription(binding);
      const wrongConnector = event();
      wrongConnector.source.connectorId = 'other-connector';
      const wrongEvent = event();
      wrongEvent.event.name = 'issue.deleted';
      await assert.rejects(current.accept(wrongConnector), { code: 'BINDING_MISMATCH' });
      await assert.rejects(current.accept(wrongEvent), { code: 'BINDING_MISMATCH' });
      await assert.rejects(current.bindSubscription({ ...binding, connectorId: 'other-connector' }), { code: 'BINDING_MISMATCH' });
      assert.deepEqual(await current.pending(), []);
      await assert.rejects(current.process('delivery-synthetic', () => 'Unexpected work'), { code: 'UNKNOWN_DELIVERY' });
    });

    await t.test('outbox retries survive until publication is recorded', async () => {
      const current = await reset();
      await current.bindSubscription(binding);
      await current.accept(event());
      assert.deepEqual(await current.pending(), await current.pending());
      await current.markPublished('delivery-synthetic');
      await current.markPublished('delivery-synthetic');
      assert.deepEqual(await current.pending(), []);
      await assert.rejects(current.markPublished('absent'), { code: 'UNKNOWN_DELIVERY' });
    });

    await t.test('failed processing can retry without a false completed result', async () => {
      const current = await reset();
      await current.bindSubscription(binding);
      await current.accept(event());
      await assert.rejects(current.process('delivery-synthetic', () => { throw new Error('Synthetic interrupted attempt'); }));
      const retried = await current.process('delivery-synthetic', () => 'Completed after retry');
      assert.equal(retried.duplicate, false);
      assert.equal(retried.summary, 'Completed after retry');
    });

    for (const kind of ['gap', 'terminated']) {
      await t.test(`${kind} is persisted on acceptance and stops queued and later event work`, async () => {
        const current = await reset();
        await current.bindSubscription(binding);
        await current.accept(event('before-control'));
        await current.accept(control(kind));
        assert.equal((await current.getSubscriptionBinding(binding.subscriptionId)).state, kind);
        await current.bindSubscription(binding);
        assert.equal((await current.getSubscriptionBinding(binding.subscriptionId)).state, kind);
        await current.accept(event('after-control'));
        const unexpected = () => { throw new Error('Lifecycle must stop business event work'); };
        assert.equal((await current.process('before-control', unexpected)).kind, 'skipped');
        assert.equal((await current.process('after-control', unexpected)).kind, 'skipped');
        assert.equal((await current.process(`delivery-${kind}`, unexpected)).kind, kind);
      });
    }

    await t.test('termination is terminal even when a later gap arrives out of order', async () => {
      const current = await reset();
      await current.bindSubscription(binding);
      await current.accept(control('terminated'));
      await current.accept(control('gap'));
      assert.equal((await current.getSubscriptionBinding(binding.subscriptionId)).state, 'terminated');
      if (db) {
        const [row] = (await db.query('SELECT last_control FROM poc_mcp_subscriptions')).rows;
        assert.equal(row.last_control.error.message, 'Synthetic provider termination.');
      }
    });

    await t.test('an explicitly stopped local binding cannot be reactivated by bind', async () => {
      const current = await reset();
      assert.equal(await current.getSubscriptionBinding('absent'), null);
      await assert.rejects(current.stopSubscription('absent'), { code: 'UNKNOWN_SUBSCRIPTION' });
      await current.bindSubscription(binding);
      await current.stopSubscription(binding.subscriptionId);
      await current.bindSubscription(binding);
      await current.accept(event());
      assert.equal((await current.process('delivery-synthetic', () => { throw new Error('Stopped work'); })).kind, 'skipped');
    });
  });
}

test('PostgreSQL transaction rolls back receipt and lifecycle when outbox insertion fails', async (t) => {
  const { store, db } = await adapters['PostgreSQL SQL in offline PGlite']();
  t.after(() => store.close());
  await store.bindSubscription(binding);
  await db.exec("ALTER TABLE poc_mcp_outbox ADD CONSTRAINT synthetic_dispatch_failure CHECK (delivery_id <> 'fail-outbox')");
  await assert.rejects(store.accept(control('gap', 'fail-outbox')), /synthetic_dispatch_failure/);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM poc_mcp_deliveries')).rows[0].count, 0);
  assert.equal((await store.getSubscriptionBinding(binding.subscriptionId)).state, 'active');
  assert.deepEqual(await store.pending(), []);
  await db.exec('ALTER TABLE poc_mcp_outbox DROP CONSTRAINT synthetic_dispatch_failure');
  assert.deepEqual(await store.accept(control('gap', 'fail-outbox')), { duplicate: false });
  assert.equal((await store.getSubscriptionBinding(binding.subscriptionId)).state, 'gap');
});

test('a second SQL store instance reads the first instance durable receipt and result', async (t) => {
  const { store, db } = await adapters['PostgreSQL SQL in offline PGlite']();
  t.after(() => store.close());
  await store.bindSubscription(binding);
  await store.accept(event());
  await store.process('delivery-synthetic', () => 'Persisted synthetic summary');
  const second = createSqlStore(sqlAdapter(db));
  const result = await second.process('delivery-synthetic', () => { throw new Error('Must reuse persisted summary'); });
  assert.equal(result.duplicate, true);
  assert.equal(result.summary, 'Persisted synthetic summary');
});
