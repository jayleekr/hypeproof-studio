-- #1466 (E2-7) — Chalk feedback and revision link tables.
-- AT-33 대상. 번호는 PR 열 때 리드가 정한다. 운영 D1 적용은 J2 전에는 하지 않음.
CREATE TABLE IF NOT EXISTS chalk_feedback (
  feedback_id   TEXT PRIMARY KEY,
  cohort_id     TEXT NOT NULL,
  course_id     TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  text          TEXT NOT NULL,
  model         TEXT NOT NULL,
  actor         TEXT NOT NULL,
  request_id    TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
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
