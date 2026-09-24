-- #1295: chalk plan file storage and course input records.
-- chalk_plan_files: one row per (cohort, course, ref_kind, ref, file). Never updated.
-- chalk_course_inputs: one row per (cohort, course). Latest inputs only.
-- Both tables use IF NOT EXISTS for safe re-application.

CREATE TABLE IF NOT EXISTS chalk_plan_files (
  cohort_id         TEXT NOT NULL,
  course_id         TEXT NOT NULL,
  ref_kind          TEXT NOT NULL,         -- 'draft' | 'version'
  ref               TEXT NOT NULL,         -- draft: revision as text, version: version string
  file              TEXT NOT NULL,         -- 'lesson' | 'ops' | 'runbook' | 'handout'
  html              TEXT NOT NULL,
  sha256            TEXT NOT NULL,
  knowledge_version INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (cohort_id, course_id, ref_kind, ref, file),
  FOREIGN KEY (cohort_id, course_id) REFERENCES authoring_drafts(cohort_id, course_id)
);

CREATE TABLE IF NOT EXISTS chalk_course_inputs (
  cohort_id       TEXT NOT NULL,
  course_id       TEXT NOT NULL,
  revision        INTEGER NOT NULL,        -- authoring_drafts revision at write time
  audience        TEXT NOT NULL,
  assets_json     TEXT NOT NULL,           -- JSON: string[] subset of ASSETS constant
  teaching_style  TEXT NOT NULL,
  requirements    TEXT NOT NULL,
  format          TEXT NOT NULL,           -- 'workshop' | 'track'
  family_session  INTEGER NOT NULL DEFAULT 0,  -- 1=true; drives parent column in skeleton
  vocab_json      TEXT,                    -- JSON: {goals, conditions, learner_level, has_guidance} | null
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (cohort_id, course_id),
  FOREIGN KEY (cohort_id, course_id) REFERENCES authoring_drafts(cohort_id, course_id)
);
