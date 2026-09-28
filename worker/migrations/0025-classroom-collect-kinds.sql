-- Remote classroom operations (#751, U1b) — WHICH kinds of the learner's class record a selected collection asked for.
-- Additive only, stored once with the batch and never updated. A batch without a row asked for no kinds: it is the U1 (or
-- earlier) request — the current session's whole record, schema /1–/2 — exactly as before this table. A row names
-- ["record"], ["prompts"], ["artifacts"] or ["artifacts","prompts"]; such a batch is sealed only as schema /3 (every session
-- of the learner in the class window, one part per session). Holds kind names — never learner content.
CREATE TABLE IF NOT EXISTS classroom_collect_kinds (
 batch_id TEXT PRIMARY KEY,
 class_run_id TEXT NOT NULL,
 kinds_json TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS classroom_collect_kinds_run ON classroom_collect_kinds(class_run_id,created_at);
