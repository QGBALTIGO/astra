/** Customer identities and browser credentials are separate from owner UI sessions. */
export const CUSTOMER_ACCOUNTS_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS customer_accounts (
  id TEXT PRIMARY KEY,
  channel_user_id TEXT NOT NULL UNIQUE REFERENCES channel_users(id) ON DELETE RESTRICT,
  data_user_id TEXT NOT NULL UNIQUE CHECK(data_user_id <> 'default'),
  current_phone TEXT NOT NULL UNIQUE CHECK(current_phone ~ '^[1-9][0-9]{9,14}$'),
  display_name TEXT NOT NULL DEFAULT '',
  time_zone TEXT NOT NULL DEFAULT 'America/Campo_Grande',
  time_zone_source TEXT NOT NULL DEFAULT 'legacy',
  currency TEXT NOT NULL DEFAULT 'BRL' CHECK(currency = 'BRL'),
  theme TEXT NOT NULL DEFAULT 'system' CHECK(theme IN ('light', 'dark', 'system')),
  hide_amounts BOOLEAN NOT NULL DEFAULT FALSE,
  auth_version INTEGER NOT NULL DEFAULT 1 CHECK(auth_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_phone_aliases (
  phone_number TEXT PRIMARY KEY CHECK(phone_number ~ '^[1-9][0-9]{9,14}$'),
  account_id TEXT NOT NULL REFERENCES customer_accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS customer_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  account_version INTEGER NOT NULL,
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS customer_auth_challenges (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES customer_accounts(id) ON DELETE CASCADE,
  account_version INTEGER,
  purpose TEXT NOT NULL CHECK(purpose IN ('login', 'phone_change_old', 'phone_change_new')),
  phone_number TEXT NOT NULL,
  source_phone TEXT,
  target_phone TEXT,
  bound_session_id TEXT,
  old_proof_id TEXT,
  code_hash TEXT NOT NULL,
  code_ciphertext TEXT,
  ip_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(delivery_status IN ('pending', 'claimed', 'sending', 'sent', 'failed', 'cancelled')),
  lease_token TEXT,
  leased_until TIMESTAMPTZ
);
`;

export const CUSTOMER_ACCOUNTS_MIGRATIONS_SQL = `
ALTER TABLE customer_accounts ADD COLUMN IF NOT EXISTS time_zone_source TEXT NOT NULL DEFAULT 'legacy';
`;

export const CUSTOMER_ACCOUNTS_INDEXES_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_phone_current
  ON customer_phone_aliases(account_id) WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_customer_sessions_account
  ON customer_sessions(account_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_customer_otp_phone
  ON customer_auth_challenges(phone_number, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_otp_ip
  ON customer_auth_challenges(ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_otp_delivery
  ON customer_auth_challenges(delivery_status, created_at) WHERE delivery_status IN ('pending', 'claimed', 'sending');
`;
