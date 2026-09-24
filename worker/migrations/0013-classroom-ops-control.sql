-- Remote classroom operations R3 (#751): per-run control revision for
-- "pause new runs". Additive only; *_at is unix milliseconds.
-- The D1 primary is the authority: the KV cohort kill switch can lag other
-- locations by a minute and is left exactly as it was.
CREATE TABLE IF NOT EXISTS class_run_control (
 class_run_id TEXT PRIMARY KEY,
 cohort_id TEXT NOT NULL,
 paused INTEGER NOT NULL DEFAULT 0,
 control_revision INTEGER NOT NULL DEFAULT 0,
 updated_by TEXT NOT NULL,
 updated_at INTEGER NOT NULL
);
