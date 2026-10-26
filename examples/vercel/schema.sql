-- Application-owned durable inbox, transactional queue outbox, and local bindings.
-- Apply explicitly with the migration script. No runtime path creates tables.
CREATE TABLE IF NOT EXISTS poc_mcp_subscriptions (
  subscription_id text PRIMARY KEY,
  connector_id text NOT NULL,
  event_name text NOT NULL,
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'gap', 'terminated', 'stopped')),
  last_control jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS poc_mcp_deliveries (
  delivery_id text PRIMARY KEY,
  subscription_id text NOT NULL REFERENCES poc_mcp_subscriptions(subscription_id),
  envelope jsonb NOT NULL,
  content_hash text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('event', 'gap', 'terminated')),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  result_kind text CHECK (result_kind IN ('event', 'gap', 'terminated', 'skipped')),
  summary text,
  CHECK ((processed_at IS NULL AND result_kind IS NULL AND summary IS NULL)
    OR (processed_at IS NOT NULL AND result_kind IS NOT NULL AND summary IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS poc_mcp_outbox (
  delivery_id text PRIMARY KEY REFERENCES poc_mcp_deliveries(delivery_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE INDEX IF NOT EXISTS poc_mcp_outbox_pending
  ON poc_mcp_outbox(created_at) WHERE published_at IS NULL;
