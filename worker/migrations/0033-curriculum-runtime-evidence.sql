-- cr-evidence (#1394; recon R6, §6; CR-23, CR-69, CR-70) — policy and rate state, no evidence.
--
-- Participant events, manual records and evidence drafts stay in the measurement-core record
-- on R2 (recon R6, SX-48); nothing here holds or copies them.
--
-- cr_link_rates: one fixed window per test link and kind (`open` for participant session opens,
-- `event` for participant event batches), so a scripted client cannot fill a link's session
-- bound or flood its events (recon §6 "Rate limits per link"). A counter, not a log.
--
-- cr_cohort_controls: the admin's per-cohort data controls and team budget ceilings (CR-70),
-- one hps-venture/1 `cohort_controls` document per cohort with a revision.
--
-- cr_experiment_records: the time of an experiment's last manual record or draft, so the
-- automatic deletion (decision 6) counts it as part of when the experiment ended.
--
-- Additive and re-runnable. Applying it in production is Jay's decision (recon §9).

CREATE TABLE IF NOT EXISTS cr_link_rates (
  link_id      TEXT NOT NULL REFERENCES cr_test_links(id),
  kind         TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (link_id, kind)
);

CREATE TABLE IF NOT EXISTS cr_cohort_controls (
  cohort_id  TEXT PRIMARY KEY,
  doc        TEXT NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- cr_experiment_records: when an experiment's last manual record, draft or draft review was
-- written (decision 6). An experiment ends at the later of this and its last link's end; one
-- with no row and no link holds nothing to delete and is never swept. A time, never a copy.
CREATE TABLE IF NOT EXISTS cr_experiment_records (
  experiment_id  TEXT PRIMARY KEY REFERENCES cr_experiments(id),
  last_record_at INTEGER NOT NULL
);
