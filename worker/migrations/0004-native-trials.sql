-- Opt-in individual trial grants only. No transcript or participant content.
CREATE TABLE IF NOT EXISTS native_trials (
 id TEXT PRIMARY KEY,
 token_jti TEXT UNIQUE NOT NULL,
 cohort_id TEXT NOT NULL,
 profile_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 issued_expires_at INTEGER NOT NULL,
 duration_ms INTEGER NOT NULL CHECK(duration_ms>0),
 started_at INTEGER,
 expires_at INTEGER,
 revoked INTEGER NOT NULL DEFAULT 0,
 request_limit INTEGER NOT NULL CHECK(request_limit>0),
 requests_used INTEGER NOT NULL DEFAULT 0,
 lease_id TEXT,
 UNIQUE(cohort_id,profile_id,user_id)
);
CREATE TABLE IF NOT EXISTS native_trial_requests (
 id TEXT PRIMARY KEY,
 trial_id TEXT NOT NULL REFERENCES native_trials(id),
 status TEXT NOT NULL CHECK(status IN ('reserved','completed','failed')),
 created_at INTEGER NOT NULL,
 finished_at INTEGER
);
-- Reservation + counter + lock is ONE atomic SQLite statement/transaction.
CREATE TRIGGER IF NOT EXISTS native_trial_reserve AFTER INSERT ON native_trial_requests
BEGIN
 UPDATE native_trials SET requests_used=requests_used+1,lease_id=NEW.id WHERE id=NEW.trial_id;
END;
CREATE INDEX IF NOT EXISTS native_trial_owner ON native_trials(cohort_id,owner_id);
-- Settlement and lock release cannot be separated by a process crash.
CREATE TRIGGER IF NOT EXISTS native_trial_settle AFTER UPDATE OF status ON native_trial_requests
WHEN OLD.status='reserved' AND NEW.status IN ('completed','failed')
BEGIN
 UPDATE native_trials SET lease_id=NULL WHERE lease_id=NEW.id;
END;
