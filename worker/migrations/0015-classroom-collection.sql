-- Remote classroom operations R4 (#751): consented class-record collection.
-- Additive only; *_at is unix milliseconds. The existing manual upload path
-- (routes/logs.ts, studio-logs/ prefix, 90-day policy) is not read or changed.
-- A row here never grants an instructor access to raw content.
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
-- A withdrawal or deletion leaves a tombstone so a late device outbox cannot recreate what was removed.
CREATE TABLE IF NOT EXISTS classroom_collect_tombstones (
 class_run_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 reason TEXT NOT NULL,
 created_by TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(class_run_id,student_id)
);
