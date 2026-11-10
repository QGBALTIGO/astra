/** Portal metadata only. Financial, calendar and task records remain in their existing tables. */
export const CUSTOMER_PORTAL_TABLES_SQL = `
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
CREATE INDEX IF NOT EXISTS idx_customer_agenda_reminder ON customer_agenda_links(reminder_id);
CREATE INDEX IF NOT EXISTS idx_customer_agenda_request_created ON customer_agenda_requests(created_at);
`;
