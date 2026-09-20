-- Additive migration: where a version's rehearsal evidence lives (VER-02, #1012).
-- deploy-worker.yml re-applies every migration file on each non-dry-run deploy,
-- so every statement must stay idempotent. That is also why this is a NEW TABLE
-- and not `ALTER TABLE authoring_versions ADD COLUMN`: SQLite has no
-- `ADD COLUMN IF NOT EXISTS`, so a bare ALTER succeeds once and then fails every
-- later deploy with `duplicate column name` — taking the deploy down with it.
--
-- Evidence hangs off (cohort_id, course_id, version), which is exactly the
-- primary key of authoring_versions. That is the whole of VER-02: a frozen
-- version is immutable, so *changed content is a different version*, and a new
-- version simply has no row here. Nothing has to remember to invalidate
-- anything — the absence IS the invalidation. Code that must remember to run is
-- code that will one day not run.
--
-- Existing authoring_versions rows are untouched and have no row here. That is
-- not a defect: they were frozen before evidence had a place to live, and
-- "no evidence" is the honest answer for them.
--
-- 주의: 이 파일의 **들여쓴** 주석에는 세미콜론을 넣지 말 것. authoring-d1.test.mjs 는
-- 줄 맨 앞의 `--` 만 걷어낸 뒤 `;` 로 문장을 쪼개 실제 D1 에 실행하므로, 들여쓴 주석
-- 안의 `;` 가 CREATE TABLE 을 반토막 낸다(`D1_ERROR: incomplete input`). 실제로 한 번 났다.
CREATE TABLE IF NOT EXISTS authoring_version_rehearsals (
  cohort_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  version TEXT NOT NULL,
  -- `not_run` is NEVER stored. Absence already means "not run", and two shapes for
  -- one state is how a reader ends up asking the wrong question. One state, one shape.
  status TEXT NOT NULL CHECK (status <> 'not_run' AND length(status) > 0),
  -- When the rehearsal that produced this row ran (ISO-8601 UTC).
  ran_at TEXT NOT NULL,
  -- What was observed. The writing path owns this shape and the read path does not
  -- parse it, so adding fields there cannot break freeze or deliver responses.
  evidence_json TEXT NOT NULL,
  PRIMARY KEY (cohort_id, course_id, version),
  FOREIGN KEY (cohort_id, course_id, version)
    REFERENCES authoring_versions(cohort_id, course_id, version)
);
