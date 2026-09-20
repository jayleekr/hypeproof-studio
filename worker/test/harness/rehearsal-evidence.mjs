// 리허설 증거를 시험에서 심는다 (#1187, RUN-01).
//
// **왜 이게 필요해졌나.** 참여 코드 발급이 이제 "이 버전이 리허설을 통과했는가" 를
// 묻는다(`routes/authoring.ts` 의 다섯 번째 거부). 그래서 발급까지 가는 시험은
// 전부 통과 증거를 먼저 심어야 한다 — 그 시험들이 재는 것은 리허설이 아니라
// 모델 정책·기능 정책·도움 방식 같은 **그 다음** 계약이기 때문이다.
//
// **왜 한 곳에 모으나.** 이 INSERT 를 시험마다 손으로 쓰면 컬럼이 늘 때 여섯 군데가
// 따로 틀어진다. 심는 모양이 하나면 스키마가 바뀔 때 한 곳만 고친다.
//
// 증거를 **만드는 제품 경로**는 #1186 이다. 여기 있는 것은 시험용 주입이고,
// 제품 경로가 붙어도 이 헬퍼를 쓰는 시험들은 그대로 성립한다 — 그 시험들은
// "리허설이 어떻게 기록되는가" 가 아니라 "통과한 수업은 학생에게 간다" 를 잰다.

const SQL =
  'INSERT OR REPLACE INTO authoring_version_rehearsals (cohort_id,course_id,version,status,ran_at,evidence_json) VALUES (?,?,?,?,?,?)';

const row = (cohort, course, version, status, ranAt) => [
  cohort, course, version, status, ranAt,
  // 읽는 쪽은 이 JSON 을 파싱하지 않는다(`readRehearsal` 은 status 만 본다).
  // 시험이 진짜 관측 결과인 척하지 않도록 출처를 적어 둔다.
  JSON.stringify({ checks: [], planted_by: 'test-harness' }),
];

/**
 * node:sqlite(DatabaseSync) 위에 증거를 심는다. 기본은 `passed` — 호출부 대부분이
 * "리허설은 끝난 것으로 치고 그 다음을 잰다" 이기 때문이다.
 */
export function plantRehearsal(db, cohort, course, version, status = 'passed', ranAt = '2026-09-21T00:00:00Z') {
  db.prepare(SQL).run(...row(cohort, course, version, status, ranAt));
}

/** 같은 것을 D1 바인딩(miniflare/실제 D1) 위에서. */
export async function plantRehearsalD1(db, cohort, course, version, status = 'passed', ranAt = '2026-09-21T00:00:00Z') {
  await db.prepare(SQL).bind(...row(cohort, course, version, status, ranAt)).run();
}
