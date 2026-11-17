/** Additive private investment books; existing financial and customer rows are preserved. */
export const CUSTOMER_INVESTMENTS_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS customer_investment_books (
  user_id TEXT PRIMARY KEY REFERENCES customer_accounts(data_user_id) ON DELETE RESTRICT,
  state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  state_hash TEXT NOT NULL CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  storage_version BIGINT NOT NULL DEFAULT 0 CHECK (storage_version BETWEEN 0 AND 9007199254740991),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
