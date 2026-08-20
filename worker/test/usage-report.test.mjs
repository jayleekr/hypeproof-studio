// usage-report 스크립트 — 입력 검증·SQL 생성·출력 포맷.
//
// 이 테스트가 지키는 것은 편의가 아니라 **경계**다. 워크플로가 받는 입력이 그대로
// SQL 에 들어가는 구조라(D1 `--command` 는 바인딩 파라미터를 안 받는다), 검증이
// 뚫리면 프로덕션 DB 에 임의 질의가 나간다. 같은 DB 에 수업 트레이스와 수강생
// 발화가 있으므로 그건 집계 권한이 대화 열람 권한으로 번지는 경로다.
//
// D1 은 부르지 않는다 — 순수 함수만 검증한다.
import assert from "node:assert/strict";
import { parseArgs, validate, buildSql, toMarkdown } from "../scripts/usage-report.mjs";

// --- 1. 정상 경로 ------------------------------------------------------------
{
  assert.deepEqual(
    validate(parseArgs(["--days", "7", "--by", "model"])),
    { days: 7, by: "model", cohort: null },
  );
  assert.deepEqual(
    validate(parseArgs(["--days", "30", "--by", "cohort", "--cohort", "sk-biopharm-2026-a"])),
    { days: 30, by: "cohort", cohort: "sk-biopharm-2026-a" },
  );
  console.log("✅ 정상 입력이 통과한다");
}

// --- 2. 거부돼야 하는 입력 ---------------------------------------------------
{
  // 하나라도 통과하면 그 값이 SQL 에 그대로 들어간다.
  const rejected = [
    ["--days", "0"],
    ["--days", "999"],
    ["--days", "7.5"],
    ["--days", "7; DROP TABLE usage_log"],
    ["--by", "created_at"],                                   // allowlist 밖
    ["--by", "model, user_id"],                               // 컬럼 추가 시도
    ["--days", "7", "--by", "model", "--cohort", "a' OR '1'='1"],
    ["--days", "7", "--by", "model", "--cohort", "a;b"],
    ["--days", "7", "--by", "model", "--cohort", "'"],
    ["--nope", "1"],                                          // 모르는 인자
  ];
  for (const argv of rejected) {
    assert.throws(
      () => validate(parseArgs(argv)),
      undefined,
      `거부돼야 한다: ${argv.join(" ")}`,
    );
  }
  console.log(`✅ 거부: ${rejected.length}종 (SQL 인젝션·allowlist 이탈·범위 초과)`);
}

// --- 3. 생성된 SQL 이 집계만 한다 --------------------------------------------
{
  const sql = buildSql({ days: 30, by: "day", cohort: "sk-biopharm-2026-a" });
  assert.match(sql, /date\(created_at\) AS dim/);
  assert.match(sql, /cohort_id = 'sk-biopharm-2026-a'/);
  assert.match(sql, /-30 days/);
  assert.match(sql, /GROUP BY dim/, "집계 없이 행이 나가면 안 된다");

  // 발화·본문·개인 식별자는 이 경로로 절대 나가지 않는다.
  for (const forbidden of [/prompt/i, /\bbody\b/i, /user_id/, /\bturns\b/i, /session_id/]) {
    assert.doesNotMatch(sql, forbidden, `${forbidden} 이 쿼리에 있으면 안 된다`);
  }
  console.log("✅ SQL: 집계 전용 — 발화·본문·user_id 가 나가지 않는다");
}

// --- 4. 빈 결과와 0 을 구분한다 ----------------------------------------------
{
  // 빈 표를 내면 "사용량이 0" 과 "쿼리가 아무것도 못 봤다" 가 같아 보인다.
  const empty = toMarkdown([], { days: 7, by: "model", cohort: null });
  assert.match(empty, /기록이 \*\*없습니다\.\*\*/);
  assert.match(empty, /쿼리는 정상 실행됐습니다/);
  console.log("✅ 빈 결과가 '0' 으로 오해되지 않는다");
}

// --- 5. 캐시 적중률 ----------------------------------------------------------
{
  const md = toMarkdown(
    [{
      dim: "claude-sonnet-4-6", requests: 10, tokens_in: 1000, tokens_out: 500,
      cache_read: 3000, cache_write: 0, avg_latency_ms: 812, errors: 1,
    }],
    { days: 7, by: "model", cohort: null },
  );
  // 3000 / (3000 + 1000) = 75%. "캐싱이 실제로 비용을 줄이고 있나" 에 답하는 줄이다.
  assert.match(md, /적중률 75\.0%/);
  assert.match(md, /달러 환산은 하지 않습니다/, "단가의 두 번째 정본이 되면 안 된다");
  console.log("✅ 캐시 적중률 · 달러 환산 안 함");
}

console.log("\n5/5 passed");
