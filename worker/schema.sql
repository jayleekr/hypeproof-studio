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

-- Delegation is an explicit budget grant, separate from an instructor token.
CREATE TABLE IF NOT EXISTS budget_delegations (
  account_id TEXT NOT NULL REFERENCES budget_accounts(id),
  issuer_id TEXT NOT NULL,
  cohort_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  max_concurrent INTEGER NOT NULL CHECK(max_concurrent>0),
  limits TEXT NOT NULL,
  PRIMARY KEY(account_id,issuer_id)
);
CREATE TABLE IF NOT EXISTS budget_requests (
  id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL REFERENCES access_periods(id),
  account_id TEXT NOT NULL REFERENCES budget_accounts(id),
  subject_key TEXT NOT NULL,
  cohort_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  note TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','resolved')),
  resolution TEXT,
  resolved_by TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS budget_one_pending_request ON budget_requests(period_id,subject_key) WHERE state='pending';

-- ── migrations/0011-classroom-ops.sql (remote classroom operations R1, #751) ──
CREATE TABLE IF NOT EXISTS class_run_ops (
 class_run_id TEXT PRIMARY KEY,
 cohort_id TEXT NOT NULL,
 profile_id TEXT NOT NULL,
 flags_json TEXT NOT NULL DEFAULT '{}',
 lesson_json TEXT NOT NULL DEFAULT '{}',
 roster_revision INTEGER NOT NULL DEFAULT 0,
 roster_writer TEXT NOT NULL DEFAULT '',
 starts_at INTEGER NOT NULL,
 ends_at INTEGER NOT NULL,
 created_by TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS class_run_ops_cohort ON class_run_ops(cohort_id,created_at);
CREATE TABLE IF NOT EXISTS class_run_seats (
 class_run_id TEXT NOT NULL,
 seat_id TEXT NOT NULL,
 seat_revision INTEGER NOT NULL,
 student_id TEXT NOT NULL,
 roster_revision INTEGER NOT NULL,
 changed_by TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 replaced_at INTEGER,
 replaced_reason TEXT,
 PRIMARY KEY(class_run_id,seat_id,seat_revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS class_run_seats_active ON class_run_seats(class_run_id,seat_id) WHERE replaced_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS class_run_seats_student ON class_run_seats(class_run_id,student_id) WHERE replaced_at IS NULL;
CREATE TABLE IF NOT EXISTS ops_grants (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL,
 class_run_id TEXT NOT NULL,
 cohort_id TEXT NOT NULL,
 profile_id TEXT NOT NULL,
 seat_id TEXT NOT NULL,
 seat_revision INTEGER NOT NULL,
 student_id TEXT NOT NULL,
 secret_hash TEXT,
 state TEXT NOT NULL,
 connection_epoch INTEGER NOT NULL DEFAULT 0,
 device_registration_id TEXT,
 parent_grant_id TEXT,
 issuer_id TEXT NOT NULL,
 issuer_jti TEXT,
 revision INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 used_at INTEGER,
 revoked_at INTEGER,
 revoked_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ops_grants_secret ON ops_grants(secret_hash) WHERE secret_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ops_grants_seat ON ops_grants(class_run_id,seat_id,kind,state);
CREATE INDEX IF NOT EXISTS ops_grants_issuer ON ops_grants(issuer_jti,state);
CREATE INDEX IF NOT EXISTS ops_grants_student ON ops_grants(cohort_id,student_id,kind,state);
CREATE TABLE IF NOT EXISTS ops_device_connections (
 grant_id TEXT NOT NULL REFERENCES ops_grants(id) ON DELETE CASCADE,
 app_instance_id TEXT NOT NULL,
 boot_id TEXT NOT NULL,
 protocol INTEGER NOT NULL,
 capabilities_json TEXT NOT NULL DEFAULT '[]',
 app_version TEXT NOT NULL DEFAULT '',
 contiguous_seq INTEGER NOT NULL DEFAULT 0,
 first_seen_at INTEGER NOT NULL,
 last_seen_at INTEGER NOT NULL,
 PRIMARY KEY(grant_id,app_instance_id,boot_id)
);
CREATE TABLE IF NOT EXISTS ops_latest_state (
 class_run_id TEXT NOT NULL,
 seat_id TEXT NOT NULL,
 seat_revision INTEGER NOT NULL,
 grant_id TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 state_json TEXT NOT NULL DEFAULT '{}',
 last_received_at INTEGER NOT NULL,
 PRIMARY KEY(class_run_id,seat_id)
);
CREATE TABLE IF NOT EXISTS ops_events (
 grant_id TEXT NOT NULL,
 boot_id TEXT NOT NULL,
 seq INTEGER NOT NULL,
 event_id TEXT NOT NULL,
 class_run_id TEXT NOT NULL,
 seat_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 actor TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 disposition TEXT NOT NULL DEFAULT 'applied',
 observed_at INTEGER NOT NULL,
 received_at INTEGER NOT NULL,
 PRIMARY KEY(grant_id,boot_id,seq)
);
CREATE INDEX IF NOT EXISTS ops_events_run ON ops_events(class_run_id,seat_id,received_at);
CREATE TABLE IF NOT EXISTS ops_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 class_run_id TEXT NOT NULL,
 seat_id TEXT NOT NULL DEFAULT '',
 actor_kind TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 action TEXT NOT NULL,
 detail_json TEXT NOT NULL DEFAULT '{}',
 at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ops_audit_run ON ops_audit(class_run_id,at);
CREATE TABLE IF NOT EXISTS ops_token_issues (
 jti TEXT PRIMARY KEY,
 cohort_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 profile_id TEXT NOT NULL,
 issued_by TEXT NOT NULL,
 issued_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ops_token_issues_student ON ops_token_issues(cohort_id,student_id,issued_at);

-- ── migrations/0012-classroom-ops-commands.sql (remote classroom operations R2, #751) ──
CREATE TABLE IF NOT EXISTS ops_commands (
 id TEXT PRIMARY KEY,
 class_run_id TEXT NOT NULL,
 cohort_id TEXT NOT NULL,
 action TEXT NOT NULL,
 args_json TEXT NOT NULL DEFAULT '{}',
 payload_hash TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 issued_by TEXT NOT NULL,
 issuer_jti TEXT,
 reason_code TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 cancelled_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ops_commands_idempotency ON ops_commands(class_run_id,idempotency_key);
CREATE TABLE IF NOT EXISTS ops_command_targets (
 command_id TEXT NOT NULL REFERENCES ops_commands(id) ON DELETE CASCADE,
 class_run_id TEXT NOT NULL,
 seat_id TEXT NOT NULL,
 seat_revision INTEGER NOT NULL,
 grant_id TEXT NOT NULL DEFAULT '',
 connection_epoch INTEGER NOT NULL DEFAULT 0,
 mutating INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL,
 result_code TEXT NOT NULL DEFAULT '',
 lease_generation INTEGER NOT NULL DEFAULT 0,
 lease_instance TEXT NOT NULL DEFAULT '',
 receipt_json TEXT NOT NULL DEFAULT '{}',
 expires_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(command_id,seat_id)
);
CREATE INDEX IF NOT EXISTS ops_command_targets_pending ON ops_command_targets(class_run_id,seat_id,state,expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS ops_command_targets_one_mutation ON ops_command_targets(class_run_id,seat_id) WHERE mutating=1 AND state IN ('queued','leased','accepted','running');
CREATE TABLE IF NOT EXISTS ops_seat_leases (
 grant_id TEXT PRIMARY KEY REFERENCES ops_grants(id) ON DELETE CASCADE,
 app_instance_id TEXT NOT NULL,
 generation INTEGER NOT NULL DEFAULT 1,
 renewed_at INTEGER NOT NULL
);

-- ── migrations/0013-classroom-ops-control.sql (remote classroom operations R3, #751) ──
CREATE TABLE IF NOT EXISTS class_run_control (
 class_run_id TEXT PRIMARY KEY,
 cohort_id TEXT NOT NULL,
 paused INTEGER NOT NULL DEFAULT 0,
 control_revision INTEGER NOT NULL DEFAULT 0,
 updated_by TEXT NOT NULL,
 updated_at INTEGER NOT NULL
);

-- ── migrations/0014-classroom-ops-evidence-review.sql (#751 evidence review state) ──
CREATE TABLE IF NOT EXISTS ops_event_reviews (
 grant_id TEXT NOT NULL,
 boot_id TEXT NOT NULL,
 seq INTEGER NOT NULL,
 class_run_id TEXT NOT NULL,
 seat_id TEXT NOT NULL,
 state TEXT NOT NULL,
 reviewer_id TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(grant_id,boot_id,seq)
);
CREATE INDEX IF NOT EXISTS ops_event_reviews_run ON ops_event_reviews(class_run_id,seat_id);

-- ── migrations/0015-classroom-collection.sql (remote classroom operations R4, #751) ──
CREATE TABLE IF NOT EXISTS classroom_consents (
 id TEXT PRIMARY KEY,
 class_run_id TEXT NOT NULL,
 cohort_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 purpose TEXT NOT NULL,
 notice_version TEXT NOT NULL,
 basis TEXT NOT NULL,
 evidence_ref TEXT NOT NULL DEFAULT '',
 recorded_by TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS classroom_consents_student ON classroom_consents(class_run_id,student_id,purpose);
CREATE TABLE IF NOT EXISTS classroom_collect_batches (
 id TEXT PRIMARY KEY,
 class_run_id TEXT NOT NULL,
 cohort_id TEXT NOT NULL,
 profile_id TEXT NOT NULL,
 roster_revision INTEGER NOT NULL,
 purpose TEXT NOT NULL,
 notice_version TEXT NOT NULL,
 dry_run INTEGER NOT NULL DEFAULT 1,
 idempotency_key TEXT NOT NULL,
 created_by TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 upload_until INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_collect_batches_key ON classroom_collect_batches(class_run_id,idempotency_key);
CREATE TABLE IF NOT EXISTS classroom_collect_items (
 batch_id TEXT NOT NULL REFERENCES classroom_collect_batches(id) ON DELETE CASCADE,
 seat_id TEXT NOT NULL,
 seat_revision INTEGER NOT NULL,
 student_id TEXT NOT NULL,
 state TEXT NOT NULL,
 reason TEXT NOT NULL DEFAULT '',
 consent_id TEXT NOT NULL DEFAULT '',
 input_revision INTEGER NOT NULL DEFAULT 0,
 manifest_digest TEXT NOT NULL DEFAULT '',
 integrity TEXT NOT NULL DEFAULT '',
 coverage TEXT NOT NULL DEFAULT '',
 receipt_id TEXT NOT NULL DEFAULT '',
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(batch_id,seat_id)
);
CREATE INDEX IF NOT EXISTS classroom_collect_items_student ON classroom_collect_items(batch_id,student_id);
CREATE TABLE IF NOT EXISTS classroom_snapshots (
 batch_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 state TEXT NOT NULL,
 files_json TEXT NOT NULL DEFAULT '[]',
 manifest_digest TEXT NOT NULL DEFAULT '',
 integrity TEXT NOT NULL DEFAULT '',
 coverage TEXT NOT NULL DEFAULT '',
 receipt_id TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL,
 sealed_at INTEGER,
 PRIMARY KEY(batch_id,student_id,revision)
);
CREATE TABLE IF NOT EXISTS classroom_job_outbox (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 kind TEXT NOT NULL,
 dedupe_key TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',
 created_at INTEGER NOT NULL,
 processed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_job_outbox_dedupe ON classroom_job_outbox(kind,dedupe_key);
CREATE TABLE IF NOT EXISTS classroom_collect_tombstones (
 class_run_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 reason TEXT NOT NULL,
 created_by TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(class_run_id,student_id)
);

-- ── migrations/0016-classroom-report-jobs.sql (remote classroom operations R5, #751) ──
CREATE TABLE IF NOT EXISTS classroom_report_jobs (
 id TEXT PRIMARY KEY,
 job_key TEXT NOT NULL,
 batch_id TEXT NOT NULL,
 class_run_id TEXT NOT NULL,
 cohort_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 input_manifest_digest TEXT NOT NULL,
 input_revision INTEGER NOT NULL,
 snapshot_revision INTEGER NOT NULL,
 input_coverage TEXT NOT NULL,
 capability_model TEXT NOT NULL,
 rubric TEXT NOT NULL,
 evaluator TEXT NOT NULL,
 renderer_revision TEXT NOT NULL,
 state TEXT NOT NULL,
 reason TEXT NOT NULL DEFAULT '',
 lease_owner TEXT NOT NULL DEFAULT '',
 lease_generation INTEGER NOT NULL DEFAULT 0,
 lease_expires_at INTEGER NOT NULL DEFAULT 0,
 draft_digest TEXT NOT NULL DEFAULT '',
 summary_json TEXT NOT NULL DEFAULT '{}',
 revision INTEGER NOT NULL DEFAULT 1,
 reviewed_by TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_report_jobs_key ON classroom_report_jobs(job_key);
CREATE INDEX IF NOT EXISTS classroom_report_jobs_batch ON classroom_report_jobs(batch_id,state);

-- ── migrations/0017-classroom-delivery.sql (remote classroom operations R6, #751) ──
CREATE TABLE IF NOT EXISTS classroom_recipients (
 class_run_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 recipient_ref TEXT NOT NULL,
 channel TEXT NOT NULL,
 address TEXT NOT NULL,
 revision INTEGER NOT NULL,
 source_ref TEXT NOT NULL,
 imported_by TEXT NOT NULL,
 imported_at INTEGER NOT NULL,
 PRIMARY KEY(class_run_id,student_id,recipient_ref)
);
CREATE TABLE IF NOT EXISTS classroom_delivery_approvals (
 id TEXT PRIMARY KEY,
 batch_id TEXT NOT NULL,
 class_run_id TEXT NOT NULL,
 template_revision TEXT NOT NULL,
 channel TEXT NOT NULL,
 scope_hash TEXT NOT NULL,
 scope_json TEXT NOT NULL,
 approved_by TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS classroom_report_deliveries (
 delivery_key TEXT PRIMARY KEY,
 batch_id TEXT NOT NULL,
 class_run_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 recipient_ref TEXT NOT NULL,
 job_id TEXT NOT NULL,
 report_digest TEXT NOT NULL,
 recipient_revision INTEGER NOT NULL,
 channel TEXT NOT NULL,
 template_revision TEXT NOT NULL,
 approval_id TEXT NOT NULL,
 adapter TEXT NOT NULL,
 state TEXT NOT NULL,
 provider_message_id TEXT NOT NULL DEFAULT '',
 attempts INTEGER NOT NULL DEFAULT 0,
 link_id TEXT NOT NULL DEFAULT '',
 detail TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS classroom_report_deliveries_batch ON classroom_report_deliveries(batch_id,state);
CREATE INDEX IF NOT EXISTS classroom_report_deliveries_provider ON classroom_report_deliveries(provider_message_id);
CREATE TABLE IF NOT EXISTS classroom_report_links (
 id TEXT PRIMARY KEY,
 token_hash TEXT NOT NULL,
 job_id TEXT NOT NULL,
 class_run_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 recipient_ref TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 revoked_at INTEGER,
 views INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_report_links_token ON classroom_report_links(token_hash);
CREATE TABLE IF NOT EXISTS classroom_delivery_events (
 provider_event_id TEXT PRIMARY KEY,
 provider_message_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 received_at INTEGER NOT NULL
);
-- ── migrations/0018-classroom-snapshot-binding.sql (remote classroom operations review F1, #751) ──
CREATE TABLE IF NOT EXISTS classroom_snapshot_bindings (
 batch_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 class_run_id TEXT NOT NULL,
 cohort_id TEXT NOT NULL,
 profile_id TEXT NOT NULL,
 seat_id TEXT NOT NULL,
 grant_id TEXT NOT NULL,
 consent_id TEXT NOT NULL,
 spool_session_id TEXT NOT NULL,
 attribution TEXT NOT NULL,
 activity_json TEXT NOT NULL DEFAULT 'null',
 range_json TEXT NOT NULL DEFAULT 'null',
 malformed_lines INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(batch_id,student_id,revision)
);
-- ── migrations/0019-classroom-report-attempts.sql (remote classroom operations, report job retry pacing, #751) ──
CREATE TABLE IF NOT EXISTS classroom_report_job_attempts (
 job_id TEXT PRIMARY KEY,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 last_reason TEXT NOT NULL DEFAULT '',
 updated_at INTEGER NOT NULL
);
-- ── migrations/0020-classroom-viewer-check.sql (remote classroom operations R6, link viewer check, #751) ──
CREATE TABLE IF NOT EXISTS classroom_recipient_checks (
 class_run_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 recipient_ref TEXT NOT NULL,
 kind TEXT NOT NULL,
 salt TEXT NOT NULL,
 check_hash TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(class_run_id,student_id,recipient_ref)
);
CREATE TABLE IF NOT EXISTS classroom_link_attempts (
 link_id TEXT PRIMARY KEY,
 failed INTEGER NOT NULL DEFAULT 0,
 locked_at INTEGER,
 updated_at INTEGER NOT NULL
);
-- ── migrations/0021-classroom-erasure-log.sql (remote classroom operations, erasure progress, #751) ──
CREATE TABLE IF NOT EXISTS classroom_erasure_log (
 class_run_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 reason TEXT NOT NULL,
 state TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT NOT NULL DEFAULT '',
 started_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(class_run_id,student_id)
);
CREATE INDEX IF NOT EXISTS classroom_erasure_log_state ON classroom_erasure_log(state,updated_at);

-- ── migrations/0022-classroom-collect-scope.sql (remote classroom operations, immutable collection scope, #751) ──
CREATE TABLE IF NOT EXISTS classroom_collect_scopes (
 batch_id TEXT PRIMARY KEY,
 class_run_id TEXT NOT NULL,
 scope TEXT NOT NULL,
 mode TEXT NOT NULL,
 targets_json TEXT NOT NULL DEFAULT '[]',
 request_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS classroom_collect_scopes_run ON classroom_collect_scopes(class_run_id,created_at);

-- ── migrations/0023-classroom-distribution.sql (remote classroom operations, targeted distribution, #751 U2) ──
-- Remote classroom operations (#751, U2) — targeted distribution of notices and materials. Additive only; *_at is unix ms.
-- DISTRIBUTION (`ops_distribute`, capability `distribute`) puts an instructor's text into the inbox of SELECTED learners
-- during class. It is not DELIVERY (`ops_delivery`, `deliver`, classroom_report_deliveries), which sends reports.
-- Content is immutable per (object, revision); a distribution run and its targets are a separate, participant-bound ledger;
-- the card a learner's device currently holds is a third fact. None of these tables holds anything a learner wrote.
CREATE TABLE IF NOT EXISTS classroom_content_objects (
 object_id TEXT PRIMARY KEY,
 class_run_id TEXT NOT NULL,
 cohort_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 latest_revision INTEGER NOT NULL DEFAULT 0,
 event_seq INTEGER NOT NULL DEFAULT 0,
 retired_at INTEGER,
 retired_by TEXT,
 retire_seq INTEGER,
 created_by TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS classroom_content_objects_run ON classroom_content_objects(class_run_id,created_at);
CREATE TABLE IF NOT EXISTS classroom_content_revisions (
 object_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 class_run_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 title TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 content_schema TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 created_by TEXT NOT NULL,
 issuer_jti TEXT,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(object_id,revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_content_revisions_idempotency ON classroom_content_revisions(class_run_id,idempotency_key);
CREATE TABLE IF NOT EXISTS classroom_distributions (
 id TEXT PRIMARY KEY,
 class_run_id TEXT NOT NULL,
 cohort_id TEXT NOT NULL,
 object_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 content_hash TEXT NOT NULL,
 seq INTEGER NOT NULL,
 roster_revision INTEGER NOT NULL,
 targets_json TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 created_by TEXT NOT NULL,
 issuer_jti TEXT,
 created_at INTEGER NOT NULL,
 revoked_at INTEGER,
 revoked_by TEXT,
 revoke_reason TEXT,
 revoke_seq INTEGER,
 row_revision INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_distributions_idempotency ON classroom_distributions(class_run_id,idempotency_key);
CREATE INDEX IF NOT EXISTS classroom_distributions_object ON classroom_distributions(class_run_id,object_id,created_at);
CREATE INDEX IF NOT EXISTS classroom_distributions_issuer ON classroom_distributions(issuer_jti) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS classroom_distribution_targets (
 distribution_id TEXT NOT NULL,
 class_run_id TEXT NOT NULL,
 seat_id TEXT NOT NULL,
 seat_revision INTEGER NOT NULL,
 student_id TEXT NOT NULL,
 object_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 state TEXT NOT NULL,
 result_code TEXT NOT NULL DEFAULT '',
 device_generation INTEGER NOT NULL DEFAULT 0,
 device_registration_id TEXT NOT NULL DEFAULT '',
 grant_id TEXT NOT NULL DEFAULT '',
 connection_epoch INTEGER NOT NULL DEFAULT 0,
 offer_key TEXT NOT NULL DEFAULT '',
 offers INTEGER NOT NULL DEFAULT 0,
 next_offer_at INTEGER NOT NULL DEFAULT 0,
 first_offered_at INTEGER,
 received_at INTEGER,
 reflected_at INTEGER,
 pending INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(distribution_id,seat_id)
);
-- What an idle sync probes: nothing to say for this seat = nothing scanned.
CREATE INDEX IF NOT EXISTS classroom_distribution_targets_pending ON classroom_distribution_targets(class_run_id,seat_id) WHERE pending=1;
CREATE INDEX IF NOT EXISTS classroom_distribution_targets_student ON classroom_distribution_targets(class_run_id,student_id,object_id);
-- The card one participant's CURRENT device holds for one object: which revision, and whether a withdrawal is owed to it.
-- Delivery evidence stays on the target rows; this is only "is it there now".
CREATE TABLE IF NOT EXISTS classroom_distribution_cards (
 class_run_id TEXT NOT NULL,
 seat_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 object_id TEXT NOT NULL,
 seat_revision INTEGER NOT NULL,
 device_registration_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 content_hash TEXT NOT NULL,
 seq INTEGER NOT NULL,
 state TEXT NOT NULL,
 withdraw_seq INTEGER,
 withdraw_reason TEXT NOT NULL DEFAULT '',
 withdraw_key TEXT NOT NULL DEFAULT '',
 withdraw_offers INTEGER NOT NULL DEFAULT 0,
 next_withdraw_at INTEGER NOT NULL DEFAULT 0,
 pending INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(class_run_id,seat_id,student_id,object_id)
);
CREATE INDEX IF NOT EXISTS classroom_distribution_cards_pending ON classroom_distribution_cards(class_run_id,seat_id) WHERE pending=1;
CREATE INDEX IF NOT EXISTS classroom_distribution_cards_object ON classroom_distribution_cards(class_run_id,object_id,state);
-- The D1 copy of "this issuer token was revoked". KV revocation can lag other locations; distribution reads this instead.
-- Holds a token id and a reason — never a token or a scope.
CREATE TABLE IF NOT EXISTS ops_issuer_fences (
 issuer_jti TEXT PRIMARY KEY,
 state TEXT NOT NULL,
 reason TEXT NOT NULL DEFAULT '',
 recorded_by TEXT NOT NULL DEFAULT '',
 revision INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);

-- ── #751 U3: targeted lesson settings (migration 0024) ──
-- Append-only history per participant. The CURRENT row is the highest binding_seq of (class_run_id, student_id); the
-- primary key serves both that lookup and the compare-and-swap of the next INSERT. Only the evidence columns are ever
-- updated (write-once), and nothing is deleted.
CREATE TABLE IF NOT EXISTS classroom_lesson_bindings (
 class_run_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 binding_seq INTEGER NOT NULL,
 seat_id TEXT NOT NULL,
 seat_revision INTEGER NOT NULL,
 binding_key TEXT NOT NULL,
 source TEXT NOT NULL,
 distribution_id TEXT NOT NULL,
 object_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 content_hash TEXT NOT NULL,
 course_id TEXT NOT NULL,
 version TEXT NOT NULL,
 lesson_sha256 TEXT NOT NULL,
 base_lesson_sha256 TEXT NOT NULL,
 steps_json TEXT NOT NULL DEFAULT '[]',
 runtime TEXT NOT NULL DEFAULT '',
 grant_id TEXT NOT NULL DEFAULT '',
 connection_epoch INTEGER NOT NULL DEFAULT 0,
 device_registration_id TEXT NOT NULL DEFAULT '',
 app_instance_id TEXT NOT NULL DEFAULT '',
 activated_at INTEGER NOT NULL,
 first_dispatched_at INTEGER,
 first_completed_at INTEGER,
 last_failure_kind TEXT NOT NULL DEFAULT '',
 last_failure_at INTEGER,
 PRIMARY KEY(class_run_id,student_id,binding_seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_lesson_bindings_distribution ON classroom_lesson_bindings(distribution_id,seat_id);

-- A turn the Service admitted, and the execution snapshot it runs under until the host closes it. Keyed by the turn id
-- the App already sends on every request of a turn. admitted_at is never refreshed.
CREATE TABLE IF NOT EXISTS classroom_lesson_turns (
 class_run_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 turn_id TEXT NOT NULL,
 token_jti TEXT NOT NULL,
 binding_seq INTEGER NOT NULL,
 binding_key TEXT NOT NULL,
 course_id TEXT NOT NULL,
 version TEXT NOT NULL,
 lesson_sha256 TEXT NOT NULL,
 admitted_at INTEGER NOT NULL,
 closed_at INTEGER,
 close_outcome TEXT NOT NULL DEFAULT '',
 first_dispatched_at INTEGER,
 first_dispatch_request TEXT NOT NULL DEFAULT '',
 runtime TEXT NOT NULL DEFAULT '',
 model TEXT NOT NULL DEFAULT '',
 first_completed_at INTEGER,
 last_failure_kind TEXT NOT NULL DEFAULT '',
 last_failure_status INTEGER,
 last_failure_at INTEGER,
 PRIMARY KEY(class_run_id,student_id,turn_id)
);

-- One row per provider request the Service PERMITTED under enforcement, written BEFORE the provider is called: which
-- request, which turn, which lesson. When the usage ledger row of that request is stored, its id is written here in the
-- same batch. A usage row of this participant that no row here points at is a request the Service cannot attribute to a
-- lesson (enforcement was off, or the link was lost) — the collection seal holds such an input instead of counting.
CREATE TABLE IF NOT EXISTS classroom_lesson_requests (
 class_run_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 turn_id TEXT NOT NULL DEFAULT '',
 binding_seq INTEGER NOT NULL DEFAULT 0,
 lesson_sha256 TEXT NOT NULL,
 permitted_at INTEGER NOT NULL,
 usage_row_id INTEGER,
 PRIMARY KEY(class_run_id,student_id,request_id)
) WITHOUT ROWID;

-- How many lesson bases a sealed collection input was produced under. Written inside the seal batch, immutable after.
CREATE TABLE IF NOT EXISTS classroom_input_basis (
 batch_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 class_run_id TEXT NOT NULL,
 basis TEXT NOT NULL,
 lessons INTEGER NOT NULL DEFAULT 0,
 turns INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(batch_id,student_id,revision)
);

-- One setting object per class run: every change of version is the next revision of that one object, so the per-object
-- event order of U2 is a total order per participant. No row of kind 'setting' exists before this migration.
CREATE UNIQUE INDEX IF NOT EXISTS classroom_content_objects_setting ON classroom_content_objects(class_run_id) WHERE kind='setting';

-- ── migrations/0025-classroom-collect-kinds.sql (remote classroom operations, collection kinds, #751 U1b) ──
-- Remote classroom operations (#751, U1b) — WHICH kinds of the learner's class record a selected collection asked for.
-- Additive only, stored once with the batch and never updated. A batch without a row asked for no kinds: it is the U1 (or
-- earlier) request — the current session's whole record, schema /1–/2 — exactly as before this table. A row names
-- ["record"], ["prompts"], ["artifacts"] or ["artifacts","prompts"]; such a batch is sealed only as schema /3 (every session
-- of the learner in the class window, one part per session). Holds kind names — never learner content.
CREATE TABLE IF NOT EXISTS classroom_collect_kinds (
 batch_id TEXT PRIMARY KEY,
 class_run_id TEXT NOT NULL,
 kinds_json TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS classroom_collect_kinds_run ON classroom_collect_kinds(class_run_id,created_at);
