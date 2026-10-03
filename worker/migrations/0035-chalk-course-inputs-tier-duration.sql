-- #1306: audience_tier, duration_min 를 별도 표에 저장.
-- CREATE TABLE IF NOT EXISTS — 재실행 안전, additive.
-- AT-33 대상. classroom d1-check(LAST=29) 제외.
-- 운영 D1 적용은 J2(JY 결정) 전에는 하지 않음.
CREATE TABLE IF NOT EXISTS chalk_course_input_options (
  cohort_id     TEXT NOT NULL,
  course_id     TEXT NOT NULL,
  audience_tier TEXT,
  duration_min  INTEGER,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (cohort_id, course_id),
  FOREIGN KEY (cohort_id, course_id) REFERENCES authoring_drafts(cohort_id, course_id)
);
