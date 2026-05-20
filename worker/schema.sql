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

-- ====================================================================
-- Trace persistence (#9): raw signals for HypeProof Score (5/6 metrics)
-- Trial → Turn → Validation/HumanAction. Bodies in R2 (turns.body_ref);
-- D1 holds structured metadata for queryable scoring later.
-- Apply (additive, IF NOT EXISTS — safe to re-run):
--   wrangler d1 execute hypeproof-studio --remote --file=schema.sql
-- ====================================================================

CREATE TABLE IF NOT EXISTS trials (
  id           TEXT PRIMARY KEY,        -- uuid; one Challenge attempt by one user
  session_id   TEXT REFERENCES sessions(id),
  cohort_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  profile_id   TEXT NOT NULL,
  task_label   TEXT,                    -- free-text Challenge identifier
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_trials_user ON trials(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_trials_cohort ON trials(cohort_id, started_at DESC);

CREATE TABLE IF NOT EXISTS turns (
  id              TEXT PRIMARY KEY,     -- uuid
  trial_id        TEXT NOT NULL REFERENCES trials(id),
  turn_idx        INTEGER NOT NULL,     -- 0-based position in trial
  prompt_chars    INTEGER NOT NULL DEFAULT 0,
  response_chars  INTEGER NOT NULL DEFAULT 0,
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  latency_ms      INTEGER,
  model           TEXT,
  body_ref        TEXT,                  -- R2 key when log_user_messages=true; else NULL
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_trial_idx ON turns(trial_id, turn_idx);
CREATE INDEX IF NOT EXISTS idx_turns_trial_time ON turns(trial_id, created_at);

CREATE TABLE IF NOT EXISTS validations (
  id            TEXT PRIMARY KEY,        -- uuid
  trial_id      TEXT NOT NULL REFERENCES trials(id),
  turn_id       TEXT REFERENCES turns(id),  -- nullable
  outcome       TEXT NOT NULL,           -- pass | fail | partial | error
  errors_found INTEGER NOT NULL DEFAULT 0,
  errors_fixed INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_validations_trial ON validations(trial_id);

CREATE TABLE IF NOT EXISTS human_actions (
  id            TEXT PRIMARY KEY,        -- uuid
  trial_id      TEXT NOT NULL REFERENCES trials(id),
  turn_id       TEXT REFERENCES turns(id),  -- nullable
  kind          TEXT NOT NULL,           -- accept | reject | edit | replace
  diff_chars    INTEGER,                  -- nullable; size of edit/replace if applicable
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_human_actions_trial ON human_actions(trial_id);
