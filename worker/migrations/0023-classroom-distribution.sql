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
