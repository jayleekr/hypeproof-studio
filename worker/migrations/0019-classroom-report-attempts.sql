-- Remote classroom operations (#751) — evaluation attempts and retry pacing for report jobs.
-- Additive only. One row per job that was handed out and came back unfinished (provider
-- trouble, evaluator not configured, …). `next_attempt_at` keeps such a job from being picked
-- again immediately, so it cannot starve the jobs queued behind it. Unix ms.
CREATE TABLE IF NOT EXISTS classroom_report_job_attempts (
 job_id TEXT PRIMARY KEY,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 last_reason TEXT NOT NULL DEFAULT '',
 updated_at INTEGER NOT NULL
);
