/** Financial tables from historical migrations 021 and 033.
 * Bundled in initializeSchema so new and existing PostgreSQL installations
 * always have the tables used by expenses and LLM usage tracking.
 * Idempotent: safe to execute at every gateway boot.
 */
export const FINANCE_TABLES_SQL = `
-- Customer and WhatsApp transactions share expenses; categories have stable
-- identities and are scoped to the same server-resolved data user.
CREATE TABLE IF NOT EXISTS customer_categories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  color TEXT NOT NULL,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  legacy_key TEXT,
  request_fingerprint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, id),
  UNIQUE (user_id, type, name_key),
  UNIQUE (user_id, type, legacy_key)
);
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default',
  date TEXT NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'BRL',
  category TEXT NOT NULL DEFAULT 'other',
  description TEXT NOT NULL,
  payment_method TEXT,
  tags JSONB DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  receipt_image TEXT,
  notes TEXT,
  transaction_type TEXT NOT NULL DEFAULT 'expense' CHECK (transaction_type IN ('income', 'expense')),
  status TEXT NOT NULL DEFAULT 'settled' CHECK (status IN ('settled', 'pending')),
  category_id TEXT,
  request_fingerprint TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- Transport deduplication for settling an existing pending record. Amounts
-- remain exclusively in expenses; this table records only consumed message IDs.
CREATE TABLE IF NOT EXISTS customer_finance_operations (
  user_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  transaction_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('settle')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, source_key)
);
-- A financing is a liability, not a new expense. Historical amounts already
-- paid are opening balance only, avoiding duplicate monthly expenses.
CREATE TABLE IF NOT EXISTS finance_obligations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  principal_cents BIGINT NOT NULL CHECK (principal_cents > 0),
  opening_paid_cents BIGINT NOT NULL DEFAULT 0 CHECK (opening_paid_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT finance_obligations_opening_range CHECK (opening_paid_cents <= principal_cents),
  UNIQUE (user_id, name_key)
);
CREATE TABLE IF NOT EXISTS finance_obligation_payments (
  id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES finance_obligations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE RESTRICT,
  source_key TEXT NOT NULL UNIQUE,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost DECIMAL(10, 6) DEFAULT 0,
  latency_ms DECIMAL(10, 2) DEFAULT 0,
  request_type TEXT DEFAULT 'chat',
  error TEXT,
  session_id TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);
`;

export const FINANCE_MIGRATIONS_SQL = `
ALTER TABLE expenses ALTER COLUMN currency SET DEFAULT 'BRL';
-- Existing rows remain settled expenses without copying or recreating them.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS transaction_type TEXT NOT NULL DEFAULT 'expense'
  CHECK (transaction_type IN ('income', 'expense'));
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'settled'
  CHECK (status IN ('settled', 'pending'));
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS category_id TEXT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE customer_categories ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_customer_category_scope') THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_customer_category_scope
      FOREIGN KEY (user_id, category_id) REFERENCES customer_categories(user_id, id) ON DELETE RESTRICT;
  END IF;
END $$;
`;

export const FINANCE_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_user_category ON expenses(user_id, category);
CREATE INDEX IF NOT EXISTS idx_customer_categories_user ON customer_categories(user_id, type, archived);
CREATE INDEX IF NOT EXISTS idx_expenses_customer_category ON expenses(user_id, category_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_customer_status ON expenses(user_id, transaction_type, status, date DESC);
CREATE INDEX IF NOT EXISTS idx_finance_obligations_user ON finance_obligations(user_id);
CREATE INDEX IF NOT EXISTS idx_finance_payments_account ON finance_obligation_payments(obligation_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_finance_payments_user ON finance_obligation_payments(user_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_records_timestamp ON usage_records(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_usage_records_user_timestamp ON usage_records(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_usage_records_provider ON usage_records(provider);
`;
