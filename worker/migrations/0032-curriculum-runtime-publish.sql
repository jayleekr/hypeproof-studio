-- cr-publish (#1393; recon R5, §6) — Venture Memory's first tables.
--
-- Each row holds one hps-venture/1 document (`doc`, JSON) plus the columns its routes look
-- it up by. Structure and references only: participant evidence stays in the
-- measurement-core record on R2 (recon R6, SX-48), and test-version file bytes are
-- content-addressed objects in R2 (`test-versions/<digest>/<path>`). cr-memory extends these
-- tables instead of adding an experiment or hypothesis table beside them (CR-35, CR-39).
-- Additive and re-runnable. Applying it in production is Jay's decision (recon §9).

CREATE TABLE IF NOT EXISTS cr_projects (
  id         TEXT PRIMARY KEY,
  cohort_id  TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  doc        TEXT NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cr_projects_cohort ON cr_projects(cohort_id);

CREATE TABLE IF NOT EXISTS cr_hypotheses (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES cr_projects(id),
  doc        TEXT NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cr_hypotheses_project ON cr_hypotheses(project_id);

CREATE TABLE IF NOT EXISTS cr_product_versions (
  project_id TEXT NOT NULL REFERENCES cr_projects(id),
  id         TEXT NOT NULL,
  doc        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS cr_experiments (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES cr_projects(id),
  hypothesis_id      TEXT NOT NULL REFERENCES cr_hypotheses(id),
  product_version_id TEXT NOT NULL,
  doc                TEXT NOT NULL,
  revision           INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cr_experiments_project ON cr_experiments(project_id);

CREATE TABLE IF NOT EXISTS cr_test_links (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES cr_projects(id),
  experiment_id TEXT NOT NULL REFERENCES cr_experiments(id),
  doc           TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  -- Participant sessions opened through this link: the per-link bound on session keys and
  -- the index of the per-channel counts (CR-73). The sessions themselves are on R2.
  sessions_opened INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cr_test_links_experiment ON cr_test_links(experiment_id);
CREATE INDEX IF NOT EXISTS idx_cr_test_links_project ON cr_test_links(project_id);
