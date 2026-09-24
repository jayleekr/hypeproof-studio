-- Remote classroom operations (#751, 2026-09-18 added criteria): instructor review
-- state for an observed evidence event. Additive only; *_at is unix milliseconds.
-- This is NOT a second evidence store: the event stays in ops_events, this row only
-- says whether an instructor looked at it. `confirmed` is not delivery approval and
-- not lesson completion.
CREATE TABLE IF NOT EXISTS ops_event_reviews (
 grant_id TEXT NOT NULL,
 boot_id TEXT NOT NULL,
 seq INTEGER NOT NULL,
 class_run_id TEXT NOT NULL,
 seat_id TEXT NOT NULL,
 state TEXT NOT NULL,
 reviewer_id TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(grant_id,boot_id,seq)
);
CREATE INDEX IF NOT EXISTS ops_event_reviews_run ON ops_event_reviews(class_run_id,seat_id);
