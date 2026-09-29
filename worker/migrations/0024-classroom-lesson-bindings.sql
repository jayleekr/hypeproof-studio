-- Remote classroom operations (#751, U3) — targeted lesson SETTINGS: which frozen lesson version a participant of a class
-- run executes under, which turn ran under which, and how many lesson bases a sealed collection input was made under.
-- Additive: no existing table or column is touched. Contract: docs/requirements/classroom-admin.md#remote-management-u3-20260921.
--
-- The learning token keeps pinning its own lesson; nothing here rewrites a token, the run pin or the cohort module pin.
-- Rows carry identifiers, hashes and timestamps only — never a prompt, a lesson body or a token.

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
