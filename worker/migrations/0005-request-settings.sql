-- Metadata of the request actually sent after course/model normalization.
-- Same D1 as usage_log; no prompt, response body, credential or new billing ledger.
CREATE TABLE IF NOT EXISTS usage_request_settings (
  request_id TEXT PRIMARY KEY,
  cohort_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  lesson_scope TEXT NOT NULL,
  client_turn_id TEXT NOT NULL,
  model TEXT NOT NULL,
  requested TEXT,
  applied TEXT,
  reason TEXT NOT NULL,
  status INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_request_settings_turn
  ON usage_request_settings(cohort_id,user_id,profile_id,lesson_scope,client_turn_id);
