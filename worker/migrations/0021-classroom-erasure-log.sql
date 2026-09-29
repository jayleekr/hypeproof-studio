-- Remote classroom operations (#751) — progress of an erasure (withdrawal or retention), per learner and run.
-- Additive only. The tombstone says "nothing new may be stored"; this row says whether the stored CONTENT is
-- actually gone yet. `started` without `done` means a step failed (for example R2 was unavailable): the
-- scheduled retention run picks exactly those up again. Holds ids, counts and an error code — never content.
CREATE TABLE IF NOT EXISTS classroom_erasure_log (
 class_run_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 reason TEXT NOT NULL,
 state TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT NOT NULL DEFAULT '',
 started_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(class_run_id,student_id)
);
CREATE INDEX IF NOT EXISTS classroom_erasure_log_state ON classroom_erasure_log(state,updated_at);
