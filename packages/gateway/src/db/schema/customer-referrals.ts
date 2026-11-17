/** Server-owned invitation attribution and manual subscription/Pix review. */
export const CUSTOMER_REFERRALS_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS customer_referral_codes (
  account_id TEXT PRIMARY KEY REFERENCES customer_accounts(id) ON DELETE RESTRICT,
  code TEXT NOT NULL UNIQUE CHECK(code ~ '^AST-[A-F0-9]{16}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS customer_referral_visits (
  token_hash TEXT PRIMARY KEY,
  code TEXT NOT NULL REFERENCES customer_referral_codes(code) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_account_id TEXT REFERENCES customer_accounts(id) ON DELETE RESTRICT,
  claimed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS customer_referrals (
  id TEXT PRIMARY KEY,
  referrer_account_id TEXT NOT NULL REFERENCES customer_accounts(id) ON DELETE RESTRICT,
  referee_account_id TEXT NOT NULL UNIQUE REFERENCES customer_accounts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'registered' CHECK(status IN ('registered','approved','requested','paid','rejected')),
  reward_cents INTEGER CHECK(reward_cents BETWEEN 2000 AND 10000 AND reward_cents % 100 = 0),
  cycle_key TEXT CHECK(cycle_key ~ '^[0-9]{4}-[0-9]{2}$'),
  subscription_reference TEXT UNIQUE,
  decision_note TEXT NOT NULL DEFAULT '',
  pix_key TEXT,
  payout_reference TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  requested_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(referrer_account_id <> referee_account_id),
  CHECK((status IN ('registered','rejected') AND reward_cents IS NULL AND cycle_key IS NULL)
     OR (status IN ('approved','requested','paid') AND reward_cents IS NOT NULL AND cycle_key IS NOT NULL AND subscription_reference IS NOT NULL)),
  CHECK(status <> 'paid' OR (payout_reference IS NOT NULL AND paid_at IS NOT NULL)),
  CHECK(status NOT IN ('requested','paid') OR pix_key IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS customer_referral_audit (
  id TEXT PRIMARY KEY,
  referral_id TEXT NOT NULL REFERENCES customer_referrals(id) ON DELETE RESTRICT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('registered','approved','requested','paid','rejected')),
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
export const CUSTOMER_REFERRALS_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_customer_referrals_owner ON customer_referrals(referrer_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_referrals_cycle ON customer_referrals(referrer_account_id, cycle_key);
CREATE INDEX IF NOT EXISTS idx_customer_referrals_review ON customer_referrals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_customer_referral_visits_expiry ON customer_referral_visits(expires_at);
CREATE INDEX IF NOT EXISTS idx_customer_referral_audit_record ON customer_referral_audit(referral_id, created_at);
`;
