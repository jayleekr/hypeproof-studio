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

-- New, voluntary shares only. Never reads or changes existing session logs.
CREATE TABLE IF NOT EXISTS classroom_shares (
 id TEXT PRIMARY KEY,
 cohort_id TEXT NOT NULL,
 profile_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 recipient_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('help','submission')),
 content_json TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','reviewing','answered','resolved')),
 feedback TEXT NOT NULL DEFAULT '',
 next_action TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS classroom_shares_recipient ON classroom_shares(cohort_id,recipient_id,expires_at);
CREATE INDEX IF NOT EXISTS classroom_shares_student ON classroom_shares(cohort_id,student_id,expires_at);
CREATE TABLE IF NOT EXISTS classroom_share_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 share_id TEXT NOT NULL REFERENCES classroom_shares(id) ON DELETE CASCADE,
 actor_id TEXT NOT NULL,
 action TEXT NOT NULL,
 at INTEGER NOT NULL
);

-- Metadata of the request actually sent after course/model normalization.
-- Same D1 as usage_log; no prompt, response body, credential or new billing ledger.
CREATE TABLE IF NOT EXISTS usage_request_settings (
  request_id TEXT PRIMARY KEY,
  cohort_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  lesson_scope TEXT NOT NULL,
  client_turn_id TEXT NOT NULL,
  model TEXT NOT NULL,
  requested TEXT,
  applied TEXT,
  reason TEXT NOT NULL,
  status INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_request_settings_turn
  ON usage_request_settings(cohort_id,user_id,profile_id,lesson_scope,client_turn_id);

-- Request admission/measurement for the opt-in adult multi-provider proxy.
-- usage_log remains the existing historical token ledger. No prompt or key.
CREATE TABLE IF NOT EXISTS model_usage_requests (
  request_id TEXT PRIMARY KEY,
  cohort_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  returned_model TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  status INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cache_read INTEGER,
  cache_write INTEGER,
  reported_total INTEGER,
  unclassified_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS model_usage_seat ON model_usage_requests(cohort_id,user_id,session_id,state);

-- Opt-in commercial contracts. No prices, grants or production defaults.
CREATE TABLE IF NOT EXISTS access_plans (
  revision TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  document TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS access_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0,1))
);
-- A cohort-local user is not a global account. Only an operator may link them.
CREATE TABLE IF NOT EXISTS access_seats (
  cohort_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES access_accounts(id),
  PRIMARY KEY(cohort_id,user_id)
);
CREATE TABLE IF NOT EXISTS access_organizations (
  id TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS access_org_members (
  organization_id TEXT NOT NULL REFERENCES access_organizations(id),
  account_id TEXT NOT NULL REFERENCES access_accounts(id),
  PRIMARY KEY(organization_id,account_id)
);
CREATE TABLE IF NOT EXISTS access_org_cohorts (
  organization_id TEXT NOT NULL REFERENCES access_organizations(id),
  cohort_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY(organization_id,cohort_id)
);
CREATE TABLE IF NOT EXISTS access_events (
  event_id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK(source_version > 0),
  digest TEXT NOT NULL,
  document TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE(contract_id,source_version)
);
CREATE TABLE IF NOT EXISTS access_contracts (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('account','cohort','organization')),
  subject_id TEXT NOT NULL,
  payer_kind TEXT NOT NULL CHECK(payer_kind IN ('account','organization','sponsor','external')),
  payer_id TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  event_id TEXT NOT NULL REFERENCES access_events(event_id),
  state TEXT NOT NULL CHECK(state IN ('active','suspended','ended')),
  period_id TEXT NOT NULL,
  document TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS access_periods (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES access_contracts(id),
  plan_revision TEXT NOT NULL REFERENCES access_plans(revision),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK(ends_at > starts_at),
  UNIQUE(contract_id,starts_at)
);
CREATE INDEX IF NOT EXISTS access_contract_subject ON access_contracts(subject_kind,subject_id);
CREATE TABLE IF NOT EXISTS access_course_policies (
  cohort_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision > 0),
  required INTEGER NOT NULL CHECK(required IN (0,1)),
  allow_personal INTEGER NOT NULL CHECK(allow_personal IN (0,1))
);

-- Extends the existing model_usage_requests attempt identity, not a second token ledger.
CREATE TABLE IF NOT EXISTS usage_price_revisions (
  revision TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  document TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_jobs (
  id TEXT PRIMARY KEY,
  subject_key TEXT NOT NULL,
  contract_id TEXT NOT NULL REFERENCES access_contracts(id),
  period_id TEXT NOT NULL REFERENCES access_periods(id),
  policy_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_attempt_costs (
  request_id TEXT PRIMARY KEY REFERENCES model_usage_requests(request_id),
  job_id TEXT NOT NULL REFERENCES usage_jobs(id),
  price_revision TEXT REFERENCES usage_price_revisions(revision),
  document TEXT NOT NULL,
  digest TEXT NOT NULL,
  execution_state TEXT NOT NULL DEFAULT 'reserved',
  evidence_version INTEGER NOT NULL DEFAULT 0,
  evidence_id TEXT,
  pricing_state TEXT NOT NULL DEFAULT 'unpriced',
  amount_micro INTEGER,
  currency TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_attempt_job ON usage_attempt_costs(job_id);
CREATE TABLE IF NOT EXISTS usage_cost_evidence (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES usage_attempt_costs(request_id),
  version INTEGER NOT NULL CHECK(version > 0),
  digest TEXT NOT NULL,
  document TEXT NOT NULL,
  cost_document TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE(request_id,version)
);
CREATE TABLE IF NOT EXISTS usage_invoice_adjustments (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES usage_attempt_costs(request_id),
  invoice_ref TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_micro INTEGER NOT NULL,
  reason TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Explicit per-period resources. No production amounts or automatic renewals.
CREATE TABLE IF NOT EXISTS budget_accounts (
  id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL REFERENCES access_periods(id),
  parent_id TEXT REFERENCES budget_accounts(id),
  kind TEXT NOT NULL CHECK(kind IN ('pool','allocation','cap')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('root','cohort','subject')),
  scope_id TEXT NOT NULL,
  max_concurrent INTEGER NOT NULL CHECK(max_concurrent > 0),
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  mutation_id TEXT,
  guard INTEGER NOT NULL DEFAULT 1 CHECK(guard=1),
  UNIQUE(period_id,parent_id,scope_kind,scope_id)
);
CREATE TABLE IF NOT EXISTS budget_limits (
  account_id TEXT NOT NULL REFERENCES budget_accounts(id),
  meter TEXT NOT NULL,
  granted INTEGER NOT NULL CHECK(granted >= 0),
  PRIMARY KEY(account_id,meter)
);
CREATE TABLE IF NOT EXISTS budget_roots (
  period_id TEXT PRIMARY KEY REFERENCES access_periods(id),
  account_id TEXT NOT NULL UNIQUE REFERENCES budget_accounts(id),
  subject_concurrency INTEGER NOT NULL CHECK(subject_concurrency > 0),
  revision INTEGER NOT NULL DEFAULT 1,
  document TEXT NOT NULL,
  digest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS budget_runtime_prices (
  root_id TEXT NOT NULL REFERENCES budget_accounts(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  protocol TEXT NOT NULL,
  price_revision TEXT NOT NULL REFERENCES usage_price_revisions(revision),
  PRIMARY KEY(root_id,provider,model,protocol)
);
CREATE TABLE IF NOT EXISTS budget_reservations (
  request_id TEXT PRIMARY KEY REFERENCES usage_attempt_costs(request_id),
  root_id TEXT NOT NULL REFERENCES budget_accounts(id),
  leaf_id TEXT NOT NULL REFERENCES budget_accounts(id),
  subject_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  document TEXT NOT NULL,
  admitted INTEGER NOT NULL CHECK(admitted=1)
);
CREATE INDEX IF NOT EXISTS budget_subject_requests ON budget_reservations(root_id,subject_key);
CREATE TABLE IF NOT EXISTS budget_reservation_lines (
  request_id TEXT NOT NULL REFERENCES budget_reservations(request_id),
  account_id TEXT NOT NULL REFERENCES budget_accounts(id),
  meter TEXT NOT NULL,
  bound INTEGER NOT NULL CHECK(bound >= 0),
  PRIMARY KEY(request_id,account_id,meter)
);
CREATE TABLE IF NOT EXISTS budget_reservation_scopes (
  request_id TEXT NOT NULL REFERENCES budget_reservations(request_id),
  account_id TEXT NOT NULL REFERENCES budget_accounts(id),
  PRIMARY KEY(request_id,account_id)
);
CREATE INDEX IF NOT EXISTS budget_scopes_account ON budget_reservation_scopes(account_id);
CREATE INDEX IF NOT EXISTS budget_lines_account ON budget_reservation_lines(account_id,meter);
CREATE INDEX IF NOT EXISTS usage_invoice_attempt ON usage_invoice_adjustments(request_id,currency);
CREATE TABLE IF NOT EXISTS budget_changes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES budget_accounts(id),
  actor TEXT NOT NULL,
  document TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- Derive from the latest evidence; duplicate reports cannot spend again.
-- Unknown work keeps its original exposure even after a timeout.
CREATE VIEW IF NOT EXISTS budget_line_balances AS
WITH observations AS (
  SELECT l.*,a.execution_state,a.pricing_state,
    CASE WHEN l.meter='requests:count' THEN CASE WHEN a.execution_state IN ('reserved','not_sent') THEN 0 ELSE 1 END
      WHEN l.meter LIKE 'currency:%' THEN CASE WHEN l.meter='currency:'||a.currency||':micro' AND a.amount_micro IS NOT NULL
        THEN a.amount_micro+COALESCE((SELECT SUM(x.amount_micro) FROM usage_invoice_adjustments x WHERE x.request_id=l.request_id AND x.currency=a.currency),0) END
      WHEN a.execution_state='not_sent' THEN 0
      ELSE CAST(json_extract(e.document,'$.meters."'||l.meter||'"') AS INTEGER) END AS observed,
    CASE WHEN l.meter='requests:count' THEN CASE WHEN a.execution_state='reserved' THEN 0 ELSE 1 END
      WHEN a.execution_state='not_sent' THEN CASE WHEN l.meter LIKE 'currency:%' AND EXISTS(SELECT 1 FROM usage_invoice_adjustments x WHERE x.request_id=l.request_id AND x.amount_micro<>0) THEN 0 ELSE 1 END
      WHEN a.execution_state<>'ended' THEN 0
      WHEN l.meter LIKE 'currency:%' THEN CASE WHEN a.pricing_state='priced' AND l.meter='currency:'||a.currency||':micro' AND a.amount_micro IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM usage_invoice_adjustments x WHERE x.request_id=l.request_id AND x.currency<>a.currency) THEN 1 ELSE 0 END
      WHEN json_extract(e.document,'$.complete')=1 AND json_extract(e.document,'$.meters."'||l.meter||'"') IS NOT NULL THEN 1 ELSE 0 END AS final
  FROM budget_reservation_lines l JOIN usage_attempt_costs a ON a.request_id=l.request_id
  LEFT JOIN usage_cost_evidence e ON e.id=a.evidence_id
)
SELECT *,MAX(0,COALESCE(observed,0)) AS spent,
  CASE WHEN final=1 THEN 0 ELSE MAX(0,bound-MAX(0,COALESCE(observed,0))) END AS held,
  MAX(0,COALESCE(observed,0)-bound) AS overrun,
  MIN(0,COALESCE(observed,0)) AS unapplied_credit
FROM observations;
-- Dedicated children consume allocation once; cap children consume usage only.
CREATE VIEW IF NOT EXISTS budget_account_balances AS
WITH balances AS (
  SELECT l.account_id,l.meter,l.granted,
    COALESCE((SELECT SUM(v.granted) FROM budget_accounts c JOIN budget_limits v ON v.account_id=c.id
      WHERE c.parent_id=l.account_id AND c.kind='allocation' AND v.meter=l.meter),0) AS allocated,
    COALESCE((SELECT SUM(b.spent) FROM budget_line_balances b WHERE b.account_id=l.account_id AND b.meter=l.meter),0) AS spent,
    COALESCE((SELECT SUM(b.held) FROM budget_line_balances b WHERE b.account_id=l.account_id AND b.meter=l.meter),0) AS held,
    COALESCE((SELECT SUM(b.overrun) FROM budget_line_balances b WHERE b.account_id=l.account_id AND b.meter=l.meter),0) AS overrun,
    COALESCE((SELECT SUM(b.unapplied_credit) FROM budget_line_balances b WHERE b.account_id=l.account_id AND b.meter=l.meter),0) AS unapplied_credit,
    (SELECT COUNT(*) FROM budget_line_balances b WHERE b.account_id=l.account_id AND b.meter=l.meter AND b.final=0) AS unresolved
  FROM budget_limits l
)
SELECT *,granted-allocated-spent-held AS available FROM balances;
