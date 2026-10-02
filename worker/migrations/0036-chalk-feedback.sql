-- #1466 (E2-7) — Chalk feedback record and revision link tables.
-- chalk_feedback: one row per instructor feedback session (server-generated id).
-- chalk_feedback_revisions: links a plan revision to the feedback that prompted it.
-- Production D1 apply: after M2 gate only.
CREATE TABLE IF NOT EXISTS chalk_feedback (
  feedback_id   TEXT PRIMARY KEY,
  cohort_id     TEXT NOT NULL,
  course_id     TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  text          TEXT NOT NULL,
  model         TEXT NOT NULL,
  actor         TEXT NOT NULL,
  request_id    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE(cohort_id, course_id, request_id),
  FOREIGN KEY (cohort_id, course_id) REFERENCES authoring_drafts(cohort_id, course_id)
);
CREATE TABLE IF NOT EXISTS chalk_feedback_revisions (
  feedback_id TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  file        TEXT NOT NULL,
  cohort_id   TEXT NOT NULL,
  course_id   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (feedback_id, revision, file),
  FOREIGN KEY (cohort_id, course_id) REFERENCES authoring_drafts(cohort_id, course_id)
);
