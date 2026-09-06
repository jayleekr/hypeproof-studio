-- Additive migration: instructor-owned drafts and frozen session-design documents.
-- Apply explicitly to local/staging first. No production migration is automatic.
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
