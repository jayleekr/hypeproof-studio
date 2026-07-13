-- Migration 0001 — trace hardening (#255, remainder of #33).
--
-- For EXISTING databases (prod). Fresh databases get the same shape from
-- schema.sql (kept in sync — see the matching columns/index there).
--
-- ALTER TABLE ADD COLUMN has no IF NOT EXISTS in SQLite/D1, so this file is
-- NOT idempotent: apply exactly once per database. Verify first:
--   npx wrangler d1 execute hypeproof-studio --remote \
--     --command "PRAGMA table_info(turns)"
-- If `status` is already listed, this migration has been applied.
--
-- Local verify (throwaway state dir):
--   npx wrangler d1 execute hypeproof-studio --local --file=schema.sql        # old schema
--   npx wrangler d1 execute hypeproof-studio --local --file=migrations/0001-trace-hardening.sql
--
-- Prod apply (HUMAN-GATED — do not autopilot; see #255):
--   npx wrangler d1 execute hypeproof-studio --remote --file=migrations/0001-trace-hardening.sql

-- Failed turns are currently invisible: chat.ts only writes a turn row on a
-- successful upstream round-trip, so Iteration Depth can't distinguish "one
-- clean turn" from "one turn after three upstream failures". These columns
-- give the (follow-up) error-path writes somewhere to land.
--   status: 'ok' | 'error'  — row-level outcome of the turn
--   error_kind: NULL when ok; coarse class when not (e.g. 'upstream',
--   'stream', 'translate') — never raw provider prose (#257).
ALTER TABLE turns ADD COLUMN status TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE turns ADD COLUMN error_kind TEXT;

-- A#6: let usage rows attribute to a trial. Nullable — chat calls without
-- trial headers (opt-in tracing) keep writing NULL, no backfill needed.
ALTER TABLE usage_log ADD COLUMN trial_id TEXT;

-- Per-user trial timelines within a cohort. idx_trials_cohort covers
-- cohort-wide scans; scoring queries filter (cohort_id, user_id) and order
-- by started_at DESC — this composite serves them without a temp sort.
CREATE INDEX IF NOT EXISTS idx_trials_cohort_user
  ON trials(cohort_id, user_id, started_at DESC);
