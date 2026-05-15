-- D1 schema for HypeProof Studio Worker.
-- Apply: wrangler d1 execute hypeproof-studio --file=schema.sql

CREATE TABLE IF NOT EXISTS cohorts (
  id           TEXT PRIMARY KEY,        -- e.g. sk-biopharm-2026-a
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at  TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,         -- e.g. kid01 (cohort-local id)
  cohort_id   TEXT NOT NULL REFERENCES cohorts(id),
  display_name TEXT NOT NULL,
  github_login TEXT,                     -- optional, set after publish wizard
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_cohort ON users(cohort_id);

-- Roster + active_session live in KV (hot path, no DB). D1 holds durable history.

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,        -- e.g. 2026-06-15-class
  cohort_id    TEXT NOT NULL REFERENCES cohorts(id),
  profile_id   TEXT NOT NULL,
  starts_at    TEXT NOT NULL,
  ends_at      TEXT NOT NULL,
  ended_at     TEXT,                     -- actual end (admin click or auto)
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_cohort ON sessions(cohort_id, starts_at DESC);

CREATE TABLE IF NOT EXISTS usage_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT REFERENCES sessions(id),
  cohort_id    TEXT,
  user_id      TEXT,
  profile_id   TEXT,
  model        TEXT,
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  cache_read   INTEGER NOT NULL DEFAULT 0,
  cache_write  INTEGER NOT NULL DEFAULT 0,
  latency_ms   INTEGER,
  status       INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_log(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_id, created_at DESC);
