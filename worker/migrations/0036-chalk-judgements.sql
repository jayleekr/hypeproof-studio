-- #1465 E2-5: context judgement store — one row per judgement, append-only
CREATE TABLE IF NOT EXISTS chalk_judgements (
  judgement_id    TEXT NOT NULL PRIMARY KEY,
  cohort_id       TEXT NOT NULL,
  course_id       TEXT NOT NULL,
  revision        INTEGER NOT NULL,
  file            TEXT NOT NULL DEFAULT 'lesson',
  plan_sha256     TEXT NOT NULL,
  item            TEXT,
  check_name      TEXT,
  at_section      TEXT,
  at_step         TEXT,
  at_key          TEXT,
  prompt_id       TEXT NOT NULL,
  prompt_version  INTEGER NOT NULL,
  model           TEXT NOT NULL,
  verdict         TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  actor           TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (cohort_id, course_id) REFERENCES authoring_drafts(cohort_id, course_id)
);
CREATE INDEX IF NOT EXISTS idx_chalk_judgements_course_sha ON chalk_judgements(cohort_id, course_id, plan_sha256);
