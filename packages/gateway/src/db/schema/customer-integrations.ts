/** No provider credentials are stored here: only scoped data and one-shot action receipts. */
export const CUSTOMER_INTEGRATIONS_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS customer_integration_snapshots (
  user_id TEXT NOT NULL CHECK (user_id <> 'default'),
  app TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  items JSONB NOT NULL DEFAULT '[]',
  synced_at TIMESTAMPTZ,
  sync_lease_until TIMESTAMPTZ,
  issue TEXT,
  PRIMARY KEY(user_id, app, connection_id)
);
CREATE TABLE IF NOT EXISTS customer_integration_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL CHECK (user_id <> 'default'),
  app TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  action_slug TEXT NOT NULL,
  arguments JSONB NOT NULL,
  summary TEXT NOT NULL,
  confirmation_token TEXT NOT NULL,
  channel_plugin_id TEXT NOT NULL,
  platform_chat_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  request_message_id TEXT NOT NULL,
  prompt_sent_at TIMESTAMPTZ,
  state TEXT NOT NULL CHECK(state IN ('pending','running','succeeded','failed','uncertain','cancelled')),
  expires_at TIMESTAMPTZ NOT NULL,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, request_key)
);
CREATE INDEX IF NOT EXISTS idx_customer_integration_actions_chat
  ON customer_integration_actions(user_id,channel_plugin_id,platform_chat_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_integration_actions_hash
  ON customer_integration_actions(user_id,action_hash,state);
CREATE TABLE IF NOT EXISTS customer_integration_usage (
  owner_key TEXT NOT NULL, period DATE NOT NULL, calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0),
  PRIMARY KEY(owner_key,period)
);
CREATE TABLE IF NOT EXISTS customer_integration_mirrors (
  user_id TEXT NOT NULL CHECK(user_id <> 'default'),
  app TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  local_id TEXT NOT NULL,
  local_updated_at TIMESTAMP NOT NULL,
  PRIMARY KEY(user_id,app,connection_id,external_id),
  UNIQUE(user_id,local_id)
);
`;
