-- #1306: audience_tier(lv1|lv2|adult), duration_min(분) 입력 칸 추가.
-- AT-33 대상(classroom-ops-commands.test.mjs:118). classroom d1-check(LAST=29) 제외.
-- 운영 D1 적용은 J2(JY 결정) 전에는 하지 않음.
ALTER TABLE chalk_course_inputs ADD COLUMN audience_tier TEXT;
ALTER TABLE chalk_course_inputs ADD COLUMN duration_min INTEGER;
