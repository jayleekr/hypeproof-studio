-- Remote classroom operations R2 (#751): command ledger, per-target state,
-- seat execution lease. Additive only; every *_at is unix milliseconds.
-- HTTP 202 on enqueue means `queued`. Only a device receipt moves a target on.
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
-- One state-changing command in flight per seat: the second instructor loses here, not on the student's PC.
CREATE UNIQUE INDEX IF NOT EXISTS ops_command_targets_one_mutation ON ops_command_targets(class_run_id,seat_id) WHERE mutating=1 AND state IN ('queued','leased','accepted','running');
CREATE TABLE IF NOT EXISTS ops_seat_leases (
 grant_id TEXT PRIMARY KEY REFERENCES ops_grants(id) ON DELETE CASCADE,
 app_instance_id TEXT NOT NULL,
 generation INTEGER NOT NULL DEFAULT 1,
 renewed_at INTEGER NOT NULL
);
