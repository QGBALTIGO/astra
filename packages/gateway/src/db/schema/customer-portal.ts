/** Portal metadata only. Financial, calendar and task records remain in their existing tables. */
export const CUSTOMER_PORTAL_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS customer_plans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('goal', 'budget', 'installment', 'subscription')),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  amount_cents BIGINT NOT NULL CHECK (amount_cents BETWEEN 1 AND 999999999999),
  progress_cents BIGINT NOT NULL DEFAULT 0 CHECK (progress_cents BETWEEN 0 AND 999999999999),
  category_id TEXT,
  installments_total INTEGER CHECK (installments_total BETWEEN 1 AND 360),
  installments_paid INTEGER CHECK (installments_paid BETWEEN 0 AND 360),
  next_due_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_plan_consistency CHECK (
    (kind = 'goal' AND progress_cents <= amount_cents AND installments_total IS NULL AND installments_paid IS NULL) OR
    (kind = 'budget' AND category_id IS NOT NULL AND progress_cents = 0 AND installments_total IS NULL AND installments_paid IS NULL) OR
    (kind = 'installment' AND installments_total IS NOT NULL AND installments_paid IS NOT NULL
       AND installments_paid <= installments_total AND progress_cents = 0) OR
    (kind = 'subscription' AND progress_cents = 0 AND installments_total IS NULL AND installments_paid IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS customer_agenda_links (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'task')),
  item_id TEXT NOT NULL,
  reminder_id TEXT REFERENCES channel_reminders(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, kind, item_id)
);
CREATE TABLE IF NOT EXISTS customer_agenda_requests (
  user_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, request_key)
);
`;

export const CUSTOMER_PORTAL_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_customer_plans_user ON customer_plans(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_customer_agenda_reminder ON customer_agenda_links(reminder_id);
CREATE INDEX IF NOT EXISTS idx_customer_agenda_request_created ON customer_agenda_requests(created_at);
`;
