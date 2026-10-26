import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DESTINATION_PATH,
  MOCK_EVENT_CATALOG,
  SUBSCRIPTION_TTL_MS,
  discoverAllEvents,
  runSubscriptions,
} from '../scripts/subscriptions.mjs';

const liveEnv = {
  CONNECT_CONNECTOR: 'oauth/synthetic-test',
  MCP_SERVER_URL: 'https://mcp.example.invalid/mcp',
  MCP_EVENT_NAME: 'synthetic.issue.created',
  MCP_EVENT_ARGUMENTS_JSON: '{}',
  MCP_IDEMPOTENCY_KEY: 'persisted-synthetic-intent-001',
  MCP_SUBSCRIPTION_ID: 'sub_synthetic_001',
  DATABASE_URL: 'postgresql://synthetic.invalid/poc',
  POC_ALLOW_SUBSCRIPTION_WRITES: 'true',
  POC_TEST_DATA_ONLY: 'true',
};

function fakeDependencies({ pages, savedBinding, cleanupStatus = 'pending' } = {}) {
  const calls = [];
  const binding = savedBinding === undefined
    ? { subscriptionId: 'sub_synthetic_001', connectorId: 'connector_synthetic', eventName: 'synthetic.issue.created' }
    : savedBinding;
  const subscription = {
    id: 'sub_synthetic_001',
    name: 'synthetic.issue.created',
    arguments: {},
    status: 'pending',
    expiresAt: '2026-10-16T12:10:00.000Z',
  };
  let pageNumber = 0;
  const operations = {
    async getSubscription(input) {
      calls.push(['getSubscription', input]);
      return subscription;
    },
    async unsubscribe(input) {
      calls.push(['unsubscribe', input]);
      return { ...subscription, status: 'stopped', cleanupStatus };
    },
    async listSubscriptions(input) {
      calls.push(['listSubscriptions', input]);
      return input?.cursor
        ? { subscriptions: [subscription] }
        : { subscriptions: [], nextCursor: 'subscription-page-2' };
    },
  };
  const adapter = {
    createAdapter(input) {
      calls.push(['createAdapter', input]);
      return operations;
    },
  };
  return {
    calls,
    dependencies: {
      async loadSdk() {
        calls.push(['loadSdk']);
        return {
          experimental_connectEventsAdapter(input) {
            calls.push(['adapter', input]);
            return adapter;
          },
          connectAuthProvider(connector, tokenParams) {
            calls.push(['authProvider', { connector, tokenParams }]);
            return 'fake-auth-provider';
          },
          async createMCPClient(input) {
            calls.push(['createMCPClient', input]);
            return {
              experimental_events: {
                async list(input) {
                  calls.push(['list', input]);
                  const catalogPages = pages ?? [{ events: structuredClone(MOCK_EVENT_CATALOG) }];
                  return catalogPages[pageNumber++];
                },
                async subscribe(input) {
                  calls.push(['subscribe', input]);
                  return subscription;
                },
              },
              async close() { calls.push(['client.close']); },
            };
          },
          async experimental_getSubscription(connector, input) {
            calls.push(['directGetSubscription', connector, input]);
            return { ...subscription, connectorId: 'connector_synthetic', destination: { path: DESTINATION_PATH } };
          },
        };
      },
      async createStore(databaseUrl) {
        calls.push(['createStore', databaseUrl]);
        return {
          async getSubscriptionBinding(id) {
            calls.push(['getSubscriptionBinding', id]);
            return id === '__poc_preflight__' ? null : binding;
          },
          async bindSubscription(input) { calls.push(['bindSubscription', input]); },
          async stopSubscription(id) { calls.push(['stopSubscription', id]); },
          async close() { calls.push(['store.close']); },
        };
      },
    },
  };
}

test('every command defaults to dry-run without importing SDKs or exposing configuration', async () => {
  const fixture = fakeDependencies();
  for (const command of ['discover', 'create', 'inspect', 'list', 'stop']) {
    const result = await runSubscriptions({
      argv: [command],
      env: { ...liveEnv, CONNECT_TOKEN_PARAMS_JSON: '{"subject":{"type":"app"},"secret":"never-print-me"}' },
      dependencies: fixture.dependencies,
    });
    assert.equal(result.mode, 'dry-run');
    assert.ok(!JSON.stringify(result).includes('never-print-me'));
  }
  assert.deepEqual(fixture.calls, []);
});

test('live create and stop require both independent write guards before SDK loading', async () => {
  for (const command of ['create', 'stop']) {
    for (const [argv, env] of [
      [[command, '--live'], liveEnv],
      [[command, '--live', '--apply'], { ...liveEnv, POC_ALLOW_SUBSCRIPTION_WRITES: 'false' }],
    ]) {
      const fixture = fakeDependencies();
      await assert.rejects(runSubscriptions({ argv, env, dependencies: fixture.dependencies }), /requires --apply/);
      assert.deepEqual(fixture.calls, []);
    }
  }
});

test('every live command requires the explicit test-data guard before SDK loading', async () => {
  for (const command of ['discover', 'create', 'inspect', 'list', 'stop']) {
    const fixture = fakeDependencies();
    await assert.rejects(runSubscriptions({
      argv: [command, '--live', '--apply'],
      env: { ...liveEnv, POC_TEST_DATA_ONLY: 'false' },
      dependencies: fixture.dependencies,
    }), /POC_TEST_DATA_ONLY=true/);
    assert.deepEqual(fixture.calls, []);
  }
});

test('create rejects events unsupported by the receiver before loading the SDK', async () => {
  const fixture = fakeDependencies();
  await assert.rejects(runSubscriptions({
    argv: ['create', '--live', '--apply'],
    env: { ...liveEnv, MCP_EVENT_NAME: 'public.unimplemented.event' },
    dependencies: fixture.dependencies,
  }), /receiver supports only/);
  assert.deepEqual(fixture.calls, []);
});

test('the mock catalog states the actual application-owned synthetic payload contract', () => {
  const schema = MOCK_EVENT_CATALOG[0].payloadSchema;
  assert.equal(MOCK_EVENT_CATALOG[0].name, 'synthetic.issue.created');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['id', 'title', 'body']);
  assert.equal(schema.properties.id.pattern, '^[A-Z0-9-]{1,40}$');
  assert.equal(schema.properties.title.maxLength, 200);
  assert.equal(schema.properties.title.pattern, '\\S');
  assert.equal(schema.properties.body.maxLength, 4000);
});

test('discover follows nextCursor through an empty page and retains server schemas', async () => {
  const definition = {
    name: 'public.test.event',
    delivery: ['webhook'],
    inputSchema: { type: 'object', required: ['testId'] },
    payloadSchema: { type: 'object', required: ['publicText'] },
  };
  const fixture = fakeDependencies({ pages: [
    { events: [], nextCursor: 'catalog-page-2' },
    { events: [definition], nextCursor: null },
  ] });
  const result = await runSubscriptions({ argv: ['discover', '--live'], env: liveEnv, dependencies: fixture.dependencies });
  assert.deepEqual(result.events, [definition]);
  assert.deepEqual(fixture.calls.filter(([name]) => name === 'list'), [
    ['list', undefined], ['list', { params: { cursor: 'catalog-page-2' } }],
  ]);
  const adapterParams = fixture.calls.find(([name]) => name === 'adapter')[1].tokenParams;
  const authParams = fixture.calls.find(([name]) => name === 'authProvider')[1].tokenParams;
  assert.equal(adapterParams, authParams, 'auth and events must share the same resolved parameters');
  assert.equal(fixture.calls.at(-1)[0], 'client.close');
});

test('catalog discovery fails on a repeated cursor instead of looping forever', async () => {
  await assert.rejects(discoverAllEvents({
    async list() { return { events: [], nextCursor: 'same-cursor' }; },
  }), /repeated cursor/);
});

test('create uses documented TTL, persisted intent key, and saves a verified binding after creation', async () => {
  const fixture = fakeDependencies();
  const result = await runSubscriptions({ argv: ['create', '--live', '--apply'], env: liveEnv, dependencies: fixture.dependencies });
  assert.equal(result.bindingSaved, true);
  assert.deepEqual(fixture.calls.find(([name]) => name === 'subscribe')[1], {
    name: 'synthetic.issue.created', arguments: {}, idempotencyKey: liveEnv.MCP_IDEMPOTENCY_KEY, ttlMs: SUBSCRIPTION_TTL_MS,
  });
  assert.deepEqual(fixture.calls.find(([name]) => name === 'directGetSubscription').slice(1), [
    liveEnv.CONNECT_CONNECTOR,
    { id: 'sub_synthetic_001', expectedSubject: { type: 'app' } },
  ]);
  assert.deepEqual(fixture.calls.find(([name]) => name === 'bindSubscription')[1], {
    subscriptionId: 'sub_synthetic_001', connectorId: 'connector_synthetic', eventName: 'synthetic.issue.created',
  });
  const index = (operation) => fixture.calls.findIndex(([name]) => name === operation);
  assert.ok(index('getSubscriptionBinding') < index('subscribe'));
  assert.ok(index('directGetSubscription') < index('bindSubscription'));
  assert.deepEqual(fixture.calls.slice(-2), [['client.close'], ['store.close']]);
});

test('create cannot invent a provider event absent from its authenticated catalog', async () => {
  const fixture = fakeDependencies({ pages: [{ events: [] }] });
  await assert.rejects(runSubscriptions({ argv: ['create', '--live', '--apply'], env: liveEnv, dependencies: fixture.dependencies }), /authenticated catalog/);
  assert.ok(!fixture.calls.some(([name]) => name === 'subscribe'));
  assert.deepEqual(fixture.calls.slice(-2), [['client.close'], ['store.close']]);
});

test('create needs a persisted idempotency key before importing the SDK', async () => {
  const fixture = fakeDependencies();
  await assert.rejects(runSubscriptions({ argv: ['create', '--live', '--apply'], env: { ...liveEnv, MCP_IDEMPOTENCY_KEY: '' }, dependencies: fixture.dependencies }), /MCP_IDEMPOTENCY_KEY/);
  assert.deepEqual(fixture.calls, []);
});

test('inspect uses saved binding and adapter without opening an MCP connection', async () => {
  const fixture = fakeDependencies();
  const result = await runSubscriptions({ argv: ['inspect', '--live'], env: liveEnv, dependencies: fixture.dependencies });
  assert.equal(result.subscription.id, liveEnv.MCP_SUBSCRIPTION_ID);
  assert.ok(!fixture.calls.some(([name]) => name === 'createMCPClient'));
  assert.ok(fixture.calls.findIndex(([name]) => name === 'getSubscriptionBinding') < fixture.calls.findIndex(([name]) => name === 'getSubscription'));
  assert.equal(fixture.calls.at(-1)[0], 'store.close');
});

test('inspect refuses unknown bindings before making a remote lookup', async () => {
  const fixture = fakeDependencies({ savedBinding: null });
  await assert.rejects(runSubscriptions({ argv: ['inspect', '--live'], env: liveEnv, dependencies: fixture.dependencies }), /saved authorized application binding/);
  assert.ok(!fixture.calls.some(([name]) => name === 'getSubscription'));
});

test('stop records lifecycle only after adapter unsubscribe and exposes pending cleanup', async () => {
  const fixture = fakeDependencies();
  const result = await runSubscriptions({ argv: ['stop', '--live', '--apply'], env: liveEnv, dependencies: fixture.dependencies });
  assert.equal(result.bindingStopped, true);
  assert.match(result.nextStep, /cleanup is pending/);
  assert.ok(fixture.calls.findIndex(([name]) => name === 'unsubscribe') < fixture.calls.findIndex(([name]) => name === 'stopSubscription'));
  assert.ok(!fixture.calls.some(([name]) => name === 'createMCPClient'));
});

test('list follows adapter subscription pagination through an empty page', async () => {
  const fixture = fakeDependencies();
  const result = await runSubscriptions({ argv: ['list', '--live'], env: liveEnv, dependencies: fixture.dependencies });
  assert.equal(result.subscriptions.length, 1);
  assert.deepEqual(fixture.calls.filter(([name]) => name === 'listSubscriptions'), [
    ['listSubscriptions', undefined], ['listSubscriptions', { cursor: 'subscription-page-2' }],
  ]);
});

test('invalid live URL, subject, JSON, or conflicting flags fail before dependency loading', async () => {
  for (const [argv, env, pattern] of [
    [['discover', '--live'], { ...liveEnv, MCP_SERVER_URL: 'http://mcp.example.invalid' }, /HTTPS/],
    [['discover', '--live'], { ...liveEnv, MCP_SERVER_URL: 'https://user:secret@mcp.example.invalid' }, /credentials/],
    [['discover', '--live'], { ...liveEnv, CONNECT_TOKEN_PARAMS_JSON: '{broken' }, /valid JSON/],
    [['discover', '--live'], { ...liveEnv, CONNECT_TOKEN_PARAMS_JSON: '{"subject":{"type":"user"}}' }, /user subject/],
    [['discover', '--live', '--mock'], liveEnv, /cannot be combined/],
  ]) {
    const fixture = fakeDependencies();
    await assert.rejects(runSubscriptions({ argv, env, dependencies: fixture.dependencies }), pattern);
    assert.deepEqual(fixture.calls, []);
  }
});
