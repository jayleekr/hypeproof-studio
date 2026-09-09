-- Delegation is an explicit budget grant, separate from an instructor token.
CREATE TABLE IF NOT EXISTS budget_delegations (
  account_id TEXT NOT NULL REFERENCES budget_accounts(id),
  issuer_id TEXT NOT NULL,
  cohort_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  max_concurrent INTEGER NOT NULL CHECK(max_concurrent>0),
  limits TEXT NOT NULL,
  PRIMARY KEY(account_id,issuer_id)
);
CREATE TABLE IF NOT EXISTS budget_requests (
  id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL REFERENCES access_periods(id),
  account_id TEXT NOT NULL REFERENCES budget_accounts(id),
  subject_key TEXT NOT NULL,
  cohort_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  note TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','resolved')),
  resolution TEXT,
  resolved_by TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS budget_one_pending_request ON budget_requests(period_id,subject_key) WHERE state='pending';
