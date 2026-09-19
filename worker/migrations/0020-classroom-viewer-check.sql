-- Remote classroom operations R6 (#751) — who may open a delivered report link.
-- Additive only. Possession of the link (the mail) is one factor; this is the second: a value the
-- operator agreed with the recipient out of band and imported with the recipient list. Only a salted
-- HMAC is stored — never the value. `classroom_link_attempts` bounds guessing per link. Unix ms.
CREATE TABLE IF NOT EXISTS classroom_recipient_checks (
 class_run_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 recipient_ref TEXT NOT NULL,
 kind TEXT NOT NULL,
 salt TEXT NOT NULL,
 check_hash TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(class_run_id,student_id,recipient_ref)
);
CREATE TABLE IF NOT EXISTS classroom_link_attempts (
 link_id TEXT PRIMARY KEY,
 failed INTEGER NOT NULL DEFAULT 0,
 locked_at INTEGER,
 updated_at INTEGER NOT NULL
);
