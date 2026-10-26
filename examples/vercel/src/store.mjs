import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export class StoreError extends Error {
  constructor(code) {
    super(code);
    this.name = 'StoreError';
    this.code = code;
  }
}

function requiredString(value) {
  if (typeof value !== 'string' || value.length === 0) throw new StoreError('INVALID_INPUT');
  return value;
}

function checkBindingInput(binding) {
  for (const key of ['subscriptionId', 'connectorId', 'eventName']) requiredString(binding[key]);
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new StoreError('INVALID_INPUT');
}

// The SDK verifier validates the envelope; the receiver validates provider data.
// Keep the verified envelope intact. Neither context nor queue content authorizes work.
function receiptInput(delivery) {
  requiredString(delivery.deliveryId);
  requiredString(delivery.subscriptionId);
  requiredString(delivery.source?.connectorId);
  if (delivery.version !== 1 || delivery.source.type !== 'mcp') throw new StoreError('INVALID_INPUT');
  let kind;
  if (delivery.event && !delivery.control) {
    requiredString(delivery.event.name);
    kind = 'event';
  } else if (!delivery.event && ['gap', 'terminated'].includes(delivery.control?.type)) {
    kind = delivery.control.type;
  } else {
    throw new StoreError('INVALID_INPUT');
  }
  const serialized = canonicalJson(delivery);
  return {
    delivery: JSON.parse(serialized),
    serialized,
    hash: createHash('sha256').update(serialized).digest('hex'),
    kind,
  };
}

function authorizeDelivery(binding, delivery) {
  if (!binding) throw new StoreError('UNKNOWN_SUBSCRIPTION');
  if (binding.connectorId !== delivery.source.connectorId
    || (delivery.event && binding.eventName !== delivery.event.name)) {
    throw new StoreError('BINDING_MISMATCH');
  }
}

function nextState(state, kind) {
  if (state === 'terminated' || state === 'stopped') return state;
  return kind === 'event' ? state : kind;
}

async function summarize(delivery, kind, state, summarizeFn) {
  if (kind !== 'event') {
    return { kind, summary: `Subscription ${delivery.subscriptionId}: ${kind}; ${kind === 'gap' ? 'source reconciliation required' : 'new event work stopped'}.` };
  }
  if (state !== 'active') {
    return { kind: 'skipped', summary: `Delivery ${delivery.deliveryId} skipped: subscription ${delivery.subscriptionId} is ${state}.` };
  }
  const summary = await summarizeFn(structuredClone(delivery));
  if (typeof summary !== 'string' || summary.length === 0) throw new StoreError('INVALID_SUMMARY');
  return { kind: 'event', summary };
}

function bindingFromRow(row) {
  return row ? {
    subscriptionId: row.subscription_id,
    connectorId: row.connector_id,
    eventName: row.event_name,
    state: row.state,
  } : null;
}

function checkLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new StoreError('INVALID_INPUT');
}

/** Offline fixture only: process-local memory is deliberately never used by live routes. */
export function createMemoryStore() {
  const bindings = new Map();
  const receipts = new Map();
  const outbox = new Map();
  let tail = Promise.resolve();
  const serial = (fn) => {
    const current = tail.then(fn);
    tail = current.catch(() => {});
    return current;
  };
  return {
    mode: 'offline-fixture',
    async migrate() {},
    bindSubscription(binding) {
      return serial(() => {
        checkBindingInput(binding);
        const existing = bindings.get(binding.subscriptionId);
        if (existing && (existing.connectorId !== binding.connectorId || existing.eventName !== binding.eventName)) {
          throw new StoreError('BINDING_MISMATCH');
        }
        if (!existing) bindings.set(binding.subscriptionId, { ...binding, state: 'active' });
        return structuredClone(bindings.get(binding.subscriptionId));
      });
    },
    getSubscriptionBinding(id) {
      return serial(() => structuredClone(bindings.get(requiredString(id)) ?? null));
    },
    stopSubscription(id) {
      return serial(() => {
        const binding = bindings.get(requiredString(id));
        if (!binding) throw new StoreError('UNKNOWN_SUBSCRIPTION');
        if (binding.state !== 'terminated') binding.state = 'stopped';
        return structuredClone(binding);
      });
    },
    accept(input) {
      return serial(() => {
        const { delivery, hash, kind } = receiptInput(input);
        const binding = bindings.get(delivery.subscriptionId);
        authorizeDelivery(binding, delivery);
        const existing = receipts.get(delivery.deliveryId);
        if (existing) {
          if (existing.hash !== hash) throw new StoreError('DELIVERY_CONFLICT');
          return { duplicate: true };
        }
        receipts.set(delivery.deliveryId, { delivery, hash, kind, result: null });
        outbox.set(delivery.deliveryId, false);
        binding.state = nextState(binding.state, kind);
        return { duplicate: false };
      });
    },
    pending(limit = 10) {
      return serial(() => {
        checkLimit(limit);
        return [...outbox].filter(([, published]) => !published).slice(0, limit).map(([deliveryId]) => ({ deliveryId }));
      });
    },
    markPublished(id) {
      return serial(() => {
        requiredString(id);
        if (!outbox.has(id)) throw new StoreError('UNKNOWN_DELIVERY');
        outbox.set(id, true);
      });
    },
    process(id, summarizeFn) {
      return serial(async () => {
        const receipt = receipts.get(requiredString(id));
        if (!receipt) throw new StoreError('UNKNOWN_DELIVERY');
        if (receipt.result) return { duplicate: true, deliveryId: id, ...receipt.result };
        const binding = bindings.get(receipt.delivery.subscriptionId);
        receipt.result = await summarize(receipt.delivery, receipt.kind, binding.state, summarizeFn);
        return { duplicate: false, deliveryId: id, ...receipt.result };
      });
    },
    async close() { await tail; },
  };
}

/**
 * SQL test seam. adapter.query(sql, parameters) returns rows; adapter.transaction(fn)
 * supplies a transaction-scoped adapter. Production and PGlite tests run this same SQL.
 */
export function createSqlStore(adapter) {
  return {
    mode: 'postgres',
    async migrate() {
      const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
      await adapter.transaction(async (tx) => {
        for (const statement of schema.split(';').filter((part) => part.trim())) await tx.query(statement, []);
      });
    },
    async bindSubscription(binding) {
      checkBindingInput(binding);
      return adapter.transaction(async (tx) => {
        await tx.query(`INSERT INTO poc_mcp_subscriptions (subscription_id, connector_id, event_name)
          VALUES ($1, $2, $3) ON CONFLICT (subscription_id) DO NOTHING`,
        [binding.subscriptionId, binding.connectorId, binding.eventName]);
        const [row] = await tx.query('SELECT * FROM poc_mcp_subscriptions WHERE subscription_id = $1 FOR UPDATE', [binding.subscriptionId]);
        const existing = bindingFromRow(row);
        if (existing.connectorId !== binding.connectorId || existing.eventName !== binding.eventName) throw new StoreError('BINDING_MISMATCH');
        return existing;
      });
    },
    async getSubscriptionBinding(id) {
      const [row] = await adapter.query('SELECT * FROM poc_mcp_subscriptions WHERE subscription_id = $1', [requiredString(id)]);
      return bindingFromRow(row);
    },
    async stopSubscription(id) {
      const [row] = await adapter.query(`UPDATE poc_mcp_subscriptions SET state = CASE
        WHEN state = 'terminated' THEN state ELSE 'stopped' END, updated_at = now()
        WHERE subscription_id = $1 RETURNING *`, [requiredString(id)]);
      if (!row) throw new StoreError('UNKNOWN_SUBSCRIPTION');
      return bindingFromRow(row);
    },
    async accept(input) {
      const { delivery, serialized, hash, kind } = receiptInput(input);
      return adapter.transaction(async (tx) => {
        const [bindingRow] = await tx.query('SELECT * FROM poc_mcp_subscriptions WHERE subscription_id = $1 FOR UPDATE', [delivery.subscriptionId]);
        const binding = bindingFromRow(bindingRow);
        authorizeDelivery(binding, delivery);
        const inserted = await tx.query(`INSERT INTO poc_mcp_deliveries
          (delivery_id, subscription_id, envelope, content_hash, kind) VALUES ($1, $2, $3::jsonb, $4, $5)
          ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`,
        [delivery.deliveryId, delivery.subscriptionId, serialized, hash, kind]);
        if (!inserted.length) {
          const [existing] = await tx.query('SELECT content_hash FROM poc_mcp_deliveries WHERE delivery_id = $1', [delivery.deliveryId]);
          if (existing.content_hash !== hash) throw new StoreError('DELIVERY_CONFLICT');
          return { duplicate: true };
        }
        // Receipt, lifecycle transition, and dispatch intent either all commit or all roll back.
        const control = delivery.control && !(kind === 'gap' && ['terminated', 'stopped'].includes(binding.state))
          ? JSON.stringify(delivery.control) : null;
        await tx.query(`UPDATE poc_mcp_subscriptions SET state = $2,
          last_control = COALESCE($3::jsonb, last_control), updated_at = now() WHERE subscription_id = $1`,
        [delivery.subscriptionId, nextState(binding.state, kind), control]);
        await tx.query('INSERT INTO poc_mcp_outbox (delivery_id) VALUES ($1)', [delivery.deliveryId]);
        return { duplicate: false };
      });
    },
    async pending(limit = 10) {
      checkLimit(limit);
      const rows = await adapter.query(`SELECT delivery_id FROM poc_mcp_outbox WHERE published_at IS NULL
        ORDER BY created_at, delivery_id LIMIT $1`, [limit]);
      return rows.map((row) => ({ deliveryId: row.delivery_id }));
    },
    async markPublished(id) {
      const rows = await adapter.query('UPDATE poc_mcp_outbox SET published_at = now() WHERE delivery_id = $1 RETURNING delivery_id', [requiredString(id)]);
      if (!rows.length) throw new StoreError('UNKNOWN_DELIVERY');
    },
    async process(id, summarizeFn) {
      requiredString(id);
      return adapter.transaction(async (tx) => {
        // Use the same subscription-before-receipt lock order as acceptance.
        // The stored receipt is authoritative; the queue supplied only its ID.
        const [binding] = await tx.query(`SELECT s.state FROM poc_mcp_subscriptions s
          JOIN poc_mcp_deliveries d USING (subscription_id)
          WHERE d.delivery_id = $1 FOR UPDATE OF s`, [id]);
        if (!binding) throw new StoreError('UNKNOWN_DELIVERY');
        const [receipt] = await tx.query('SELECT * FROM poc_mcp_deliveries WHERE delivery_id = $1 FOR UPDATE', [id]);
        if (receipt.processed_at) return { duplicate: true, deliveryId: id, kind: receipt.result_kind, summary: receipt.summary };
        const result = await summarize(receipt.envelope, receipt.kind, binding.state, summarizeFn);
        await tx.query(`UPDATE poc_mcp_deliveries SET processed_at = now(), result_kind = $2, summary = $3
          WHERE delivery_id = $1`, [id, result.kind, result.summary]);
        return { duplicate: false, deliveryId: id, ...result };
      });
    },
    close: () => adapter.close(),
  };
}

export async function createPostgresStore(databaseUrl) {
  requiredString(databaseUrl);
  try {
    if (!['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol)) throw new Error('Invalid protocol');
  } catch {
    // Do not include a credential-bearing URL in configuration errors.
    throw new StoreError('INVALID_DATABASE_URL');
  }
  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl, { max: 4, idle_timeout: 20, connect_timeout: 10 });
  const wrap = (client) => ({
    query: (statement, parameters) => client.unsafe(statement, parameters),
    transaction: (fn) => client.begin((tx) => fn(wrap(tx))),
    close: () => sql.end({ timeout: 5 }),
  });
  return createSqlStore(wrap(sql));
}
