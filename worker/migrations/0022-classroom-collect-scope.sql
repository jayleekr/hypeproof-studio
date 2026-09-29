-- Remote classroom operations (#751) — what a collection batch was ASKED to cover, stored once and never updated.
-- Additive only. `scope='roster'` is the class wrap-up over the whole run roster (the only kind before this table);
-- `scope='targets'` names the selected seats. `mode='collect_only'` batches never feed evaluation or delivery.
-- `request_hash` pins the normalized request (scope, seats, purpose, notice, mode, dry-run, roster revision) so the same
-- idempotency key can only ever mean the same request. A batch created before this table has no row and is read as
-- roster + finish. Holds seat ids and a hash — never learner content.
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
