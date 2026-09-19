-- Remote classroom operations R5 (#751): report draft jobs, runner lease, review queue.
-- Additive only; *_at is unix milliseconds. `usage_jobs` is the billing ledger and is not reused.
-- Draft bodies (they quote the learner) live in private R2; this table holds states and digests.
CREATE TABLE IF NOT EXISTS classroom_report_jobs (
 id TEXT PRIMARY KEY,
 job_key TEXT NOT NULL,
 batch_id TEXT NOT NULL,
 class_run_id TEXT NOT NULL,
 cohort_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 input_manifest_digest TEXT NOT NULL,
 input_revision INTEGER NOT NULL,
 snapshot_revision INTEGER NOT NULL,
 input_coverage TEXT NOT NULL,
 capability_model TEXT NOT NULL,
 rubric TEXT NOT NULL,
 evaluator TEXT NOT NULL,
 renderer_revision TEXT NOT NULL,
 state TEXT NOT NULL,
 reason TEXT NOT NULL DEFAULT '',
 lease_owner TEXT NOT NULL DEFAULT '',
 lease_generation INTEGER NOT NULL DEFAULT 0,
 lease_expires_at INTEGER NOT NULL DEFAULT 0,
 draft_digest TEXT NOT NULL DEFAULT '',
 summary_json TEXT NOT NULL DEFAULT '{}',
 revision INTEGER NOT NULL DEFAULT 1,
 reviewed_by TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_report_jobs_key ON classroom_report_jobs(job_key);
CREATE INDEX IF NOT EXISTS classroom_report_jobs_batch ON classroom_report_jobs(batch_id,state);
