-- Request admission/measurement for the opt-in adult multi-provider proxy.
-- usage_log remains the existing historical token ledger. No prompt or key.
CREATE TABLE IF NOT EXISTS model_usage_requests (
  request_id TEXT PRIMARY KEY,
  cohort_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  returned_model TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  status INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cache_read INTEGER,
  cache_write INTEGER,
  reported_total INTEGER,
  unclassified_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS model_usage_seat ON model_usage_requests(cohort_id,user_id,session_id,state);
