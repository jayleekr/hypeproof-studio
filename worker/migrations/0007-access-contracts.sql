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
