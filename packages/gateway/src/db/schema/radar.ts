/** Additive Radar schema. Public source cache is physically separate from private follows/outbox. */
export const RADAR_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS radar_resources (
 id TEXT PRIMARY KEY,
 source TEXT NOT NULL CHECK(source IN ('weather','ptax','currency','football','news','series','gazettes','energy','releases')),
 target TEXT NOT NULL, label TEXT NOT NULL, query TEXT,
 snapshot JSONB, next_poll_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 lease_token TEXT, leased_until TIMESTAMPTZ,
 failures INTEGER NOT NULL DEFAULT 0, error_code TEXT,
 updated_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS radar_provider_limits (
 provider TEXT PRIMARY KEY, next_request_at TIMESTAMPTZ NOT NULL,
 blocked_until TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS radar_http_cache (
 key TEXT PRIMARY KEY, body TEXT, expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 lease_token TEXT, leased_until TIMESTAMPTZ, touched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS customer_radar_preferences (
 user_id TEXT PRIMARY KEY REFERENCES customer_accounts(data_user_id) ON DELETE CASCADE CHECK(user_id <> 'default'),
 preferences JSONB NOT NULL DEFAULT '{"enabled":false,"time":"07:00","quietStart":"22:00","quietEnd":"07:00"}',
 revision INTEGER NOT NULL DEFAULT 1,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS customer_radar_interests (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES customer_accounts(data_user_id) ON DELETE CASCADE CHECK(user_id <> 'default'),
 resource_id TEXT NOT NULL REFERENCES radar_resources(id),
 input JSONB NOT NULL, label TEXT NOT NULL,
 active BOOLEAN NOT NULL DEFAULT TRUE,
 revision INTEGER NOT NULL DEFAULT 1,
 last_digest_day TEXT, threshold_state BOOLEAN, last_content_key TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(user_id,id), UNIQUE(user_id,resource_id)
);
CREATE TABLE IF NOT EXISTS customer_radar_outbox (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES customer_radar_preferences(user_id) ON DELETE CASCADE, interest_id TEXT,
 interest_revision INTEGER NOT NULL, preference_revision INTEGER NOT NULL,
 event_key TEXT NOT NULL, payload JSONB NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','sending','sent','unknown','cancelled','expired')),
 not_before TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL,
 lease_token TEXT, leased_until TIMESTAMPTZ,
 transport_id TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), sent_at TIMESTAMPTZ,
 FOREIGN KEY(user_id,interest_id) REFERENCES customer_radar_interests(user_id,id) ON DELETE CASCADE,
 UNIQUE(user_id,event_key)
);
`;
export const RADAR_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_radar_resource_due ON radar_resources(next_poll_at);
CREATE INDEX IF NOT EXISTS idx_radar_interest_resource ON customer_radar_interests(resource_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_radar_interest_user ON customer_radar_interests(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_radar_outbox_due ON customer_radar_outbox(not_before,expires_at) WHERE status IN ('pending','leased');
CREATE INDEX IF NOT EXISTS idx_radar_outbox_user ON customer_radar_outbox(user_id,created_at DESC);
`;
