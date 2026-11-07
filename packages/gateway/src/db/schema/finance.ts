/** Financial tables from historical migrations 021 and 033.
 * Bundled in initializeSchema so new and existing PostgreSQL installations
 * always have the tables used by expenses and LLM usage tracking.
 * Idempotent: safe to execute at every gateway boot.
 */
export const FINANCE_TABLES_SQL = `
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
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
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
`;

export const FINANCE_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_user_category ON expenses(user_id, category);
CREATE INDEX IF NOT EXISTS idx_usage_records_timestamp ON usage_records(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_usage_records_user_timestamp ON usage_records(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_usage_records_provider ON usage_records(provider);
`;
