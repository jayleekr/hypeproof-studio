-- New, voluntary shares only. Never reads or changes existing session logs.
CREATE TABLE IF NOT EXISTS classroom_shares (
 id TEXT PRIMARY KEY,
 cohort_id TEXT NOT NULL,
 profile_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 recipient_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('help','submission')),
 content_json TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','reviewing','answered','resolved')),
 feedback TEXT NOT NULL DEFAULT '',
 next_action TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS classroom_shares_recipient ON classroom_shares(cohort_id,recipient_id,expires_at);
CREATE INDEX IF NOT EXISTS classroom_shares_student ON classroom_shares(cohort_id,student_id,expires_at);
CREATE TABLE IF NOT EXISTS classroom_share_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 share_id TEXT NOT NULL REFERENCES classroom_shares(id) ON DELETE CASCADE,
 actor_id TEXT NOT NULL,
 action TEXT NOT NULL,
 at INTEGER NOT NULL
);
