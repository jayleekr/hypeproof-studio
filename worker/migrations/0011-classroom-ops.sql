-- Remote classroom operations R1 (#751): run roster snapshot, pairing/connection
-- grants, latest seat state and durable observation events.
-- Additive only. Never reads or changes session logs, usage_log, tokens,
-- liveness KV or the voluntary classroom_shares tables.
-- Every *_at column in these tables is unix milliseconds.
-- Enumerations are validated in code, not CHECKed: later slices add kinds and
-- SQLite cannot widen a CHECK without rebuilding the table.
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
-- Issuance metadata only (never the token): lets the board tell "issued" from
-- "verified by the app". Written best-effort when the ops switch is enabled.
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
