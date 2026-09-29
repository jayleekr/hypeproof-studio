-- Additive migration: instructor-owned drafts and frozen session-design documents.
-- deploy-worker.yml re-applies this file to production D1 on every non-dry-run deploy,
-- before the Worker is deployed. Every statement must stay idempotent (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS authoring_drafts (
  cohort_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  content_json TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (cohort_id, course_id)
);
CREATE TABLE IF NOT EXISTS authoring_versions (
  cohort_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  version TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  module_json TEXT NOT NULL,
  PRIMARY KEY (cohort_id, course_id, version),
  FOREIGN KEY (cohort_id, course_id) REFERENCES authoring_drafts(cohort_id, course_id)
);
-- #1006 IC-02: a course created independent of customer profiles. Written in the same
-- batch as the draft insert; absence means a profile-bound course. Safe to re-apply.
CREATE TABLE IF NOT EXISTS authoring_independent_courses (
  cohort_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  PRIMARY KEY (cohort_id, course_id),
  FOREIGN KEY (cohort_id, course_id) REFERENCES authoring_drafts(cohort_id, course_id)
);
-- #1006 IC-B: a class opened from a reviewed execution template. The class cohort id owns
-- its own roster, session and pause keys. This row alone lets it run on the template profile.
CREATE TABLE IF NOT EXISTS authoring_openings (
  class_cohort TEXT PRIMARY KEY,
  template_cohort TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  version TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (template_cohort, owner_id, operation_id),
  FOREIGN KEY (template_cohort, course_id) REFERENCES authoring_drafts(cohort_id, course_id)
);
