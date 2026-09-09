-- Extends the existing model_usage_requests attempt identity, not a second token ledger.
CREATE TABLE IF NOT EXISTS usage_price_revisions (
  revision TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  document TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_jobs (
  id TEXT PRIMARY KEY,
  subject_key TEXT NOT NULL,
  contract_id TEXT NOT NULL REFERENCES access_contracts(id),
  period_id TEXT NOT NULL REFERENCES access_periods(id),
  policy_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_attempt_costs (
  request_id TEXT PRIMARY KEY REFERENCES model_usage_requests(request_id),
  job_id TEXT NOT NULL REFERENCES usage_jobs(id),
  price_revision TEXT REFERENCES usage_price_revisions(revision),
  document TEXT NOT NULL,
  digest TEXT NOT NULL,
  execution_state TEXT NOT NULL DEFAULT 'reserved',
  evidence_version INTEGER NOT NULL DEFAULT 0,
  evidence_id TEXT,
  pricing_state TEXT NOT NULL DEFAULT 'unpriced',
  amount_micro INTEGER,
  currency TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_attempt_job ON usage_attempt_costs(job_id);
CREATE TABLE IF NOT EXISTS usage_cost_evidence (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES usage_attempt_costs(request_id),
  version INTEGER NOT NULL CHECK(version > 0),
  digest TEXT NOT NULL,
  document TEXT NOT NULL,
  cost_document TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE(request_id,version)
);
CREATE TABLE IF NOT EXISTS usage_invoice_adjustments (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES usage_attempt_costs(request_id),
  invoice_ref TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_micro INTEGER NOT NULL,
  reason TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
