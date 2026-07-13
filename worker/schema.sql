-- D1 schema for HypeProof Studio Worker.
-- Apply (fresh database): wrangler d1 execute hypeproof-studio --file=schema.sql
--
-- EXISTING databases: CREATE TABLE IF NOT EXISTS never alters a table that
-- already exists — column additions land via worker/migrations/NNNN-*.sql,
-- applied once each, in order. Keep this file and the migrations in sync:
-- a fresh schema.sql install must equal (old schema + all migrations).

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
  trial_id     TEXT,                    -- #255 (A#6): optional trial attribution; NULL when chat ran without trial headers
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
-- #255: per-user trial timelines within a cohort (scoring filters
-- (cohort_id, user_id) and orders by started_at DESC).
CREATE INDEX IF NOT EXISTS idx_trials_cohort_user ON trials(cohort_id, user_id, started_at DESC);

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
  status          TEXT NOT NULL DEFAULT 'ok',  -- #255: 'ok' | 'error' — failed turns feed Iteration Depth
  error_kind      TEXT,                  -- #255: NULL when ok; coarse class ('upstream' | 'stream' | 'translate'), never raw provider prose (#257)
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

-- ====================================================================
-- In-app bug reports (#64): POST /v1/report → D1 + Discord webhook.
-- Discord-first triage; admin resolution may link to a GitHub issue.
-- Anonymous flow supported (jti_hash nullable for the "I can't even auth" case).
-- ts is unix seconds (vs ISO8601 elsewhere) — easier for ordering + TTL math
-- against the rate-limit KV. attachments_json holds version/OS/etc as opaque
-- JSON so we can evolve the auto-attached metadata blob without DDL.
-- ====================================================================

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,           -- "rep_<base32>"
  ts INTEGER NOT NULL,           -- unix seconds, created at
  jti_hash TEXT,                 -- sha256(jti)[:16], nullable for anon
  profile_id TEXT,
  request_id TEXT,               -- correlates with PR #49 request_id middleware
  description TEXT NOT NULL,
  attachments_json TEXT,         -- JSON-encoded metadata blob (version, OS, etc)
  contact TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'resolved'
  resolved_at INTEGER,
  resolution_note TEXT,
  github_issue_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_status_ts ON reports(status, ts DESC);
