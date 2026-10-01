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
  -- The student who created it: the per-student bound on Projects (one conditional insert).
  creator    TEXT,
  doc        TEXT NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cr_projects_cohort ON cr_projects(cohort_id);
CREATE INDEX IF NOT EXISTS idx_cr_projects_creator ON cr_projects(cohort_id, creator);

CREATE TABLE IF NOT EXISTS cr_hypotheses (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES cr_projects(id),
  doc        TEXT NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 1,
  -- The statement while the hypothesis is open (NULL once it is not): two starts sent at the
  -- same time with the same statement store one hypothesis (unique per Project).
  open_statement TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cr_hypotheses_project ON cr_hypotheses(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cr_hypotheses_open_statement ON cr_hypotheses(project_id, open_statement);

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
  -- The digest of the start's fields while the experiment is running with no link yet (NULL
  -- after its first link): starts sent at the same time with the same fields store one row.
  open_start_key     TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cr_experiments_project ON cr_experiments(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cr_experiments_open_start ON cr_experiments(project_id, open_start_key);

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
