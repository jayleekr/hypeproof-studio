-- Remote classroom operations review fix F1 (#751): what a verified snapshot IS.
-- Additive only. One row per sealed snapshot revision, written in the same batch as
-- the seal: learner, cohort, profile, class run, seat, activity and consent scope the
-- Service checked the bytes against. Write-once — a sealed revision never changes.
-- `attribution` is 'bound' (device binding, schema /2) or 'metadata_run' (the spool
-- metadata itself names the run). A record that is neither is never sealed.
CREATE TABLE IF NOT EXISTS classroom_snapshot_bindings (
 batch_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 class_run_id TEXT NOT NULL,
 cohort_id TEXT NOT NULL,
 profile_id TEXT NOT NULL,
 seat_id TEXT NOT NULL,
 grant_id TEXT NOT NULL,
 consent_id TEXT NOT NULL,
 spool_session_id TEXT NOT NULL,
 attribution TEXT NOT NULL,
 activity_json TEXT NOT NULL DEFAULT 'null',
 range_json TEXT NOT NULL DEFAULT 'null',
 malformed_lines INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(batch_id,student_id,revision)
);
