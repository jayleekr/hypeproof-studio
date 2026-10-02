-- cr-memory (#1395; recon R5; CR-35, CR-38, CR-41, CR-75, CR-76) — the rest of Venture Memory.
--
-- Each row holds one hps-venture/1 document (`doc`, JSON) plus the columns it is looked up by,
-- like the cr-publish tables (0032), which cr-memory extends in place: hypothesis revisions and
-- stakeholder links ride the existing cr_hypotheses / cr_experiments documents, so there is no
-- second hypothesis or experiment table (CR-39, CR-T80). Structure and references only:
-- evidence items and observations stay in the measurement-core record on R2 (recon R6, SX-48)
-- and are named by reference (`ev:<experiment>/<draft>/<item>`), never copied here.
--
-- cr_decisions:    PRD §10.3 decisions (CR-41), immutable except the one-time version link.
-- cr_stakeholders: CR-75 stakeholders and their roles.
-- cr_metrics:      CR-76 metric definitions; values are computed on read, never stored.
-- cr_deck_slides:  one immutable row per revision of each of the eight slides (cr-deck builds on it, R10).
--
-- Additive and re-runnable. Applying it in production is Jay's decision (recon §9).

CREATE TABLE IF NOT EXISTS cr_decisions (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES cr_projects(id),
  doc        TEXT NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cr_decisions_project ON cr_decisions(project_id);

CREATE TABLE IF NOT EXISTS cr_stakeholders (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES cr_projects(id),
  doc        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cr_stakeholders_project ON cr_stakeholders(project_id);

CREATE TABLE IF NOT EXISTS cr_metrics (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES cr_projects(id),
  doc        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cr_metrics_project ON cr_metrics(project_id);

CREATE TABLE IF NOT EXISTS cr_deck_slides (
  project_id TEXT NOT NULL REFERENCES cr_projects(id),
  number     INTEGER NOT NULL CHECK (number BETWEEN 1 AND 8),
  revision   INTEGER NOT NULL,
  doc        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, number, revision)
);
