-- Remote classroom operations R6 (#751): approved recipients, approval binding,
-- delivery ledger, protected report links. Additive only; *_at is unix milliseconds.
-- Contact details live only in classroom_recipients, apart from reports and analysis.
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
