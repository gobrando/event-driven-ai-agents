import { pathToFileURL } from 'node:url';
import { TEST_EVENT_NAME } from '../src/triage.mjs';

export const DESTINATION_PATH = '/api/hooks';
export const SUBSCRIPTION_TTL_MS = 600_000;

// Application-owned mock catalog; this is not a provider's event definition.
export const MOCK_EVENT_CATALOG = Object.freeze([
  {
    name: TEST_EVENT_NAME,
    description: 'Synthetic fixture only. Discover the real server catalog before subscribing.',
    delivery: ['webhook'],
    inputSchema: { type: 'object', additionalProperties: false },
    payloadSchema: {
      type: 'object',
      required: ['id', 'title', 'body'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', pattern: '^[A-Z0-9-]{1,40}$' },
        title: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
        body: { type: 'string', maxLength: 4000 },
      },
    },
  },
]);

const COMMANDS = new Set(['discover', 'create', 'inspect', 'list', 'stop']);

class SubscriptionCommandError extends Error {}

function parseArguments(argv) {
  const commands = argv.filter((argument) => !argument.startsWith('--'));
  const flags = argv.filter((argument) => argument.startsWith('--'));
  const command = commands[0] ?? 'discover';
  if (commands.length > 1 || !COMMANDS.has(command)) {
    throw new SubscriptionCommandError('Choose one command: discover, create, inspect, list, or stop.');
  }
  if (flags.some((flag) => !['--live', '--apply', '--dry-run', '--mock'].includes(flag))) {
    throw new SubscriptionCommandError('Supported flags: --live, --apply, --dry-run, --mock.');
  }
  if (flags.includes('--live') && (flags.includes('--mock') || flags.includes('--dry-run'))) {
    throw new SubscriptionCommandError('--live cannot be combined with --mock or --dry-run.');
  }
  return { command, live: flags.includes('--live'), apply: flags.includes('--apply') };
}

function required(env, name) {
  if (typeof env[name] !== 'string' || !env[name].trim()) {
    throw new SubscriptionCommandError(`${name} is required for this live operation.`);
  }
  return env[name];
}

function jsonObject(value, name) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SubscriptionCommandError(`${name} must contain valid JSON.`);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new SubscriptionCommandError(`${name} must contain a JSON object.`);
  }
  return parsed;
}

function liveConfiguration(env) {
  const connector = required(env, 'CONNECT_CONNECTOR');
  let url;
  try {
    url = new URL(required(env, 'MCP_SERVER_URL'));
  } catch {
    throw new SubscriptionCommandError('MCP_SERVER_URL must be a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new SubscriptionCommandError('MCP_SERVER_URL must use HTTPS without credentials or a fragment.');
  }
  const tokenParams = env.CONNECT_TOKEN_PARAMS_JSON
    ? jsonObject(env.CONNECT_TOKEN_PARAMS_JSON, 'CONNECT_TOKEN_PARAMS_JSON')
    : { subject: { type: 'app' } };
  const subject = tokenParams.subject;
  if (
    !subject ||
    !['app', 'user'].includes(subject.type) ||
    (subject.type === 'user' && (typeof subject.id !== 'string' || !subject.id.trim()))
  ) {
    throw new SubscriptionCommandError('MCP Events requires an app subject or a user subject with an id.');
  }
  return { connector, tokenParams, transport: { type: 'http', url: url.href } };
}

async function defaultLoadSdk() {
  const [mcp, ai, direct] = await Promise.all([
    import('@ai-sdk/mcp'),
    import('@vercel/connect/ai-sdk'),
    import('@vercel/connect/mcp'),
  ]);
  return {
    createMCPClient: mcp.createMCPClient,
    connectAuthProvider: ai.connectAuthProvider,
    experimental_connectEventsAdapter: ai.experimental_connectEventsAdapter,
    experimental_getSubscription: direct.experimental_getSubscription,
  };
}

async function defaultCreateStore(databaseUrl) {
  const { createPostgresStore } = await import('../src/store.mjs');
  return createPostgresStore(databaseUrl);
}

/** Follow even empty catalog pages. The schemas come from the authenticated server. */
export async function discoverAllEvents(events) {
  const catalog = [];
  const seen = new Set();
  let cursor;
  do {
    const page = await events.list(cursor ? { params: { cursor } } : undefined);
    catalog.push(...page.events);
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new SubscriptionCommandError('Event catalog returned a repeated cursor.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return catalog;
}

async function listAllSubscriptions(operations) {
  const subscriptions = [];
  const seen = new Set();
  let cursor;
  do {
    const page = await operations.listSubscriptions(cursor ? { cursor } : undefined);
    subscriptions.push(...page.subscriptions);
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new SubscriptionCommandError('Subscription list returned a repeated cursor.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return subscriptions;
}

function dryRun(command) {
  const plannedOperations = {
    discover: ['client.experimental_events.list (follow nextCursor)'],
    create: [
      'client.experimental_events.list (choose an authenticated catalog definition)',
      'client.experimental_events.subscribe',
      'experimental_getSubscription (expectedSubject)',
      'store.bindSubscription (persist authorized binding)',
    ],
    inspect: ['store.getSubscriptionBinding', 'adapter.getSubscription'],
    list: ['adapter.listSubscriptions (follow nextCursor)'],
    stop: ['store.getSubscriptionBinding', 'adapter.unsubscribe', 'store.stopSubscription'],
  };
  return {
    mode: 'dry-run',
    command,
    source: 'application-owned synthetic fixture; no SDK imports, network requests, or subscriptions',
    plannedOperations: plannedOperations[command],
    destination: { path: DESTINATION_PATH },
    ...(command === 'discover' ? { events: structuredClone(MOCK_EVENT_CATALOG) } : {}),
    ...(command === 'create'
      ? {
          plannedInput: {
            name: TEST_EVENT_NAME,
            arguments: {},
            idempotencyKey: '<persist MCP_IDEMPOTENCY_KEY before an approved trial>',
            ttlMs: SUBSCRIPTION_TTL_MS,
          },
        }
      : {}),
  };
}

/** All live dependencies are lazy and injectable so safety guards can be tested offline. */
export async function runSubscriptions({ argv = [], env = process.env, dependencies = {} } = {}) {
  const { command, live, apply } = parseArguments(argv);
  if (!live) return dryRun(command);
  if (env.POC_TEST_DATA_ONLY !== 'true') {
    throw new SubscriptionCommandError('Every live operation requires POC_TEST_DATA_ONLY=true and a synthetic/public test connector.');
  }

  if (
    ['create', 'stop'].includes(command) &&
    (!apply || env.POC_ALLOW_SUBSCRIPTION_WRITES !== 'true')
  ) {
    throw new SubscriptionCommandError('Live create/stop requires --apply and POC_ALLOW_SUBSCRIPTION_WRITES=true after explicit approval.');
  }

  const config = liveConfiguration(env);
  let creationInput;
  let subscriptionId;
  let databaseUrl;
  if (command === 'create') {
    creationInput = {
      name: required(env, 'MCP_EVENT_NAME'),
      arguments: jsonObject(env.MCP_EVENT_ARGUMENTS_JSON ?? '{}', 'MCP_EVENT_ARGUMENTS_JSON'),
      // Never generate a fresh key during a retry of an uncertain create result.
      idempotencyKey: required(env, 'MCP_IDEMPOTENCY_KEY'),
      ttlMs: SUBSCRIPTION_TTL_MS,
    };
    if (creationInput.name !== TEST_EVENT_NAME) {
      throw new SubscriptionCommandError(`This receiver supports only the application-owned ${TEST_EVENT_NAME} fixture. Adapt and review the payload validator before subscribing to another event.`);
    }
  }
  if (['create', 'inspect', 'stop'].includes(command)) {
    databaseUrl = required(env, 'DATABASE_URL');
  }
  if (['inspect', 'stop'].includes(command)) {
    subscriptionId = required(env, 'MCP_SUBSCRIPTION_ID');
  }

  const sdk = await (dependencies.loadSdk ?? defaultLoadSdk)();
  const adapter = sdk.experimental_connectEventsAdapter({
    connector: config.connector,
    tokenParams: config.tokenParams,
    destination: { path: DESTINATION_PATH },
  });
  const operations = adapter.createAdapter({ transport: config.transport });
  let client;
  let store;
  try {
    let savedBinding;
    if (databaseUrl) {
      store = await (dependencies.createStore ?? defaultCreateStore)(databaseUrl);
      // Read-only preflight checks the database and explicit migration before any remote write.
      savedBinding = await store.getSubscriptionBinding(subscriptionId ?? '__poc_preflight__');
      if (subscriptionId && !savedBinding) {
        throw new SubscriptionCommandError('Subscription has no saved authorized application binding.');
      }
    }
    if (['discover', 'create'].includes(command)) {
      client = await sdk.createMCPClient({
        transport: {
          ...config.transport,
          authProvider: sdk.connectAuthProvider(config.connector, config.tokenParams),
        },
        experimental_events: { adapter },
      });
      const events = await discoverAllEvents(client.experimental_events);
      if (command === 'discover') return { mode: 'live', command, events };
      const definition = events.find((event) => event.name === creationInput.name);
      if (!definition || !definition.delivery.includes('webhook')) {
        throw new SubscriptionCommandError('MCP_EVENT_NAME must select a webhook event in the authenticated catalog.');
      }
      const subscription = await client.experimental_events.subscribe(creationInput);
      // The adapter deliberately omits connectorId; obtain it from the direct, scoped SDK lookup.
      const full = await sdk.experimental_getSubscription(config.connector, {
        id: subscription.id,
        expectedSubject: config.tokenParams.subject,
      });
      if (
        full.id !== subscription.id ||
        full.name !== creationInput.name ||
        !full.connectorId ||
        full.destination?.path !== DESTINATION_PATH
      ) {
        throw new SubscriptionCommandError('Created subscription did not match the intended application binding. Reuse the same idempotency key to recover.');
      }
      await store.bindSubscription({
        subscriptionId: full.id,
        connectorId: full.connectorId,
        eventName: full.name,
      });
      return {
        mode: 'live',
        command,
        subscription,
        bindingSaved: true,
        registration: 'May be pending. Deliveries before binding persistence receive retryable 503 responses.',
      };
    }
    if (command === 'list') {
      return { mode: 'live', command, subscriptions: await listAllSubscriptions(operations) };
    }
    const subscription = await operations.getSubscription({ id: subscriptionId });
    if (subscription.name !== savedBinding.eventName) {
      throw new SubscriptionCommandError('Subscription event does not match its saved application binding.');
    }
    if (command === 'inspect') return { mode: 'live', command, subscription };

    const stopped = await operations.unsubscribe({ id: subscriptionId });
    await store.stopSubscription(subscriptionId);
    return {
      mode: 'live',
      command,
      subscription: stopped,
      bindingStopped: true,
      ...(stopped.cleanupStatus === 'pending'
        ? { nextStep: 'Remote cleanup is pending; repeat stop with the same subscription ID.' }
        : {}),
    };
  } finally {
    try {
      await client?.close();
    } finally {
      await store?.close();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await runSubscriptions({ argv: process.argv.slice(2) }), null, 2));
  } catch (error) {
    // SDK errors can carry remote response details. Print only application-owned error text.
    console.error(error instanceof SubscriptionCommandError
      ? error.message
      : 'Subscription command failed. Review SDK diagnostics privately. After an uncertain create result, reuse the original MCP_IDEMPOTENCY_KEY; do not create a fresh intent.');
    process.exitCode = 1;
  }
}
