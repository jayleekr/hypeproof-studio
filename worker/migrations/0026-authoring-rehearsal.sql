-- Chalk authoring (#1012 · #751 G2) — learner-condition REHEARSAL of one immutable candidate version and the instructor's
-- deliberate CONFIRMATION of exactly that candidate. Additive: no existing table or column is touched.
-- Contract: docs/requirements/chalk-authoring.md#g2-curriculum-runtime-20260922.
--
-- A frozen authoring_versions row is the candidate: immutable, with its own sha256. A rehearsal row is created when the
-- instructor issues a learner-condition rehearsal code for that candidate; its verdict is written once, by the Service,
-- from the App's report AND the Service's own records of model requests made with that code. Rows hold identifiers,
-- hashes, tool names and short reason codes — never a prompt, a model answer, a lesson body or a token.
CREATE TABLE IF NOT EXISTS authoring_rehearsals (
 rehearsal_id TEXT PRIMARY KEY,
 cohort_id TEXT NOT NULL,
 course_id TEXT NOT NULL,
 version TEXT NOT NULL,
 lesson_sha256 TEXT NOT NULL,
 source_revision INTEGER NOT NULL,
 profile_id TEXT NOT NULL,
 learner_id TEXT NOT NULL,
 token_jti TEXT NOT NULL UNIQUE,
 policy_digest TEXT NOT NULL,
 created_by TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 request_id TEXT NOT NULL,
 report_json TEXT,
 report_hash TEXT,
 reported_at INTEGER,
 verdict TEXT,
 verdict_json TEXT,
 judged_at INTEGER,
 UNIQUE (cohort_id, course_id, request_id)
);
CREATE INDEX IF NOT EXISTS authoring_rehearsals_version ON authoring_rehearsals(cohort_id, course_id, version, created_at);

-- One row per model request the Service admitted with a rehearsal code: what ran, under which lesson, and how it ended.
CREATE TABLE IF NOT EXISTS authoring_rehearsal_turns (
 rehearsal_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 at INTEGER NOT NULL,
 lesson_sha256 TEXT NOT NULL,
 step_id TEXT NOT NULL DEFAULT '',
 help_receipt TEXT NOT NULL DEFAULT '',
 runtime TEXT NOT NULL DEFAULT '',
 model TEXT NOT NULL DEFAULT '',
 tool_names_json TEXT NOT NULL DEFAULT '[]',
 outcome TEXT NOT NULL DEFAULT '',
 status INTEGER,
 PRIMARY KEY (rehearsal_id, request_id)
);

-- The instructor's confirmation of one candidate, bound to the passed rehearsal it was confirmed on. Written once.
CREATE TABLE IF NOT EXISTS authoring_confirmations (
 cohort_id TEXT NOT NULL,
 course_id TEXT NOT NULL,
 version TEXT NOT NULL,
 lesson_sha256 TEXT NOT NULL,
 rehearsal_id TEXT NOT NULL,
 policy_digest TEXT NOT NULL,
 confirmed_by TEXT NOT NULL,
 confirmed_at INTEGER NOT NULL,
 request_id TEXT NOT NULL,
 PRIMARY KEY (cohort_id, course_id, version)
);
