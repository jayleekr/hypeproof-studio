#!/usr/bin/env node
// D1 `usage_log` 집계 리포트 — 프로덕션 토큰 사용량을 **개인 토큰 없이** 보는 길.
//
// ## 왜 스크립트인가 (자유 SQL 이 아니라)
//
// "D1 을 보고 싶다" 의 가장 쉬운 답은 `wrangler d1 execute --command "$INPUT"` 을
// 워크플로 입력으로 받는 것이다. 그건 **프로덕션 DB 셸**이다. 같은 DB 에 수업
// 트레이스(`turns`)와 수강생 발화가 들어 있어서, 집계를 보려던 권한이 대화 열람
// 권한이 된다. 그래서 차원(GROUP BY)과 기간만 고르게 하고 질의문은 여기서 만든다.
//
// 나가는 것은 **합계뿐이다** — 개별 행도, 발화도, user_id 도 나가지 않는다.
//
// ## 달러로 환산하지 않는다
//
// hypeproof-studio#580 의 D4 와 같은 이유다: 레코드에는 토큰 수만 남기고 단가
// 곱셈은 분석 시점에 한다. 여기서 환산하면 단가가 바뀔 때 과거 리포트가 조용히
// 틀린 값이 되고, 이 스크립트가 단가의 두 번째 정본이 된다.
//
// 사용:
//   node worker/scripts/usage-report.mjs --days 7 --by model
//   node worker/scripts/usage-report.mjs --days 30 --by cohort --cohort sk-biopharm-2026-a
//
// 필요한 것: CLOUDFLARE_API_TOKEN (D1 Read). CI 에서는 repo 시크릿이 준다.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DB = "hypeproof-studio";

// 차원 allowlist. 값이 그대로 SQL 에 들어가므로 **여기 없는 것은 못 쓴다.**
// 사용자 입력을 식별자 자리에 흘리지 않기 위한 유일한 방어선이다.
const DIMENSIONS = {
  model: "model",
  cohort: "cohort_id",
  profile: "profile_id",
  day: "date(created_at)",
};

function parseArgs(argv) {
  const out = { days: 7, by: "model", cohort: null };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--days") out.days = v;
    else if (k === "--by") out.by = v;
    else if (k === "--cohort") out.cohort = v;
    else throw new Error(`unknown argument: ${k}`);
  }
  return out;
}

function validate(args) {
  const days = Number(args.days);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error(`--days must be an integer 1..365 (got: ${args.days})`);
  }
  if (!(args.by in DIMENSIONS)) {
    throw new Error(`--by must be one of ${Object.keys(DIMENSIONS).join(", ")} (got: ${args.by})`);
  }
  // 코호트 id 는 SQL 리터럴에 들어가므로 문자 집합을 좁힌다. 실제 id 는
  // `sk-biopharm-2026-a` 같은 슬러그다.
  if (args.cohort !== null && !/^[a-zA-Z0-9_-]{1,64}$/.test(args.cohort)) {
    throw new Error(`--cohort must match [a-zA-Z0-9_-]{1,64} (got: ${args.cohort})`);
  }
  return { days, by: args.by, cohort: args.cohort };
}

function buildSql({ days, by, cohort }) {
  const dim = DIMENSIONS[by];
  const where = [`created_at >= datetime('now', '-${days} days')`];
  if (cohort) where.push(`cohort_id = '${cohort}'`);
  // #684 — usage_log holds FAILED turns too (before #684 the table only ever
  // held successes, so summing blindly was safe). This is the billing report,
  // so its aggregates must follow the SAME two decoupled predicates as
  // lib/analytics.ts (dag task L):
  //
  //   BILLING = "tokens were actually spent upstream". NOT "status < 400".
  //     A turn can fail AND cost money — an outbound moderation block (the
  //     model answered and charged us; the child got a refusal) or a
  //     mid-stream interruption. Billing on status wrote that real spend off.
  //     Turns that never reached upstream carry zero tokens, so they add
  //     nothing here by arithmetic — no status filter is needed to keep the
  //     gateway from billing its own outages.
  //
  //   HEALTH  = status. `requests` counts turns that actually helped a
  //     student, `errors` the ones that did not; requests + errors = attempts.
  //
  // Kept as literals rather than importing lib/analytics.ts's USAGE_BILLABLE:
  // this script is plain .mjs run by an operator with no TS loader. Both
  // copies are pinned by test/usage-log-status.test.mjs, which runs THIS SQL.
  const BILLABLE = "(tokens_in + tokens_out + cache_read + cache_write) > 0";
  const OK = "status < 400";
  return `
    SELECT ${dim} AS dim,
           COUNT(*) AS records,
           SUM(CASE WHEN NOT (${BILLABLE}) THEN 1 ELSE 0 END) AS zero_token_records,
           SUM(CASE WHEN status >= 400 AND ${BILLABLE} THEN 1 ELSE 0 END) AS failed_with_tokens,
           SUM(CASE WHEN ${OK} THEN 1 ELSE 0 END) AS requests,
           SUM(CASE WHEN ${BILLABLE} THEN tokens_in   ELSE 0 END) AS tokens_in,
           SUM(CASE WHEN ${BILLABLE} THEN tokens_out  ELSE 0 END) AS tokens_out,
           SUM(CASE WHEN ${BILLABLE} THEN cache_read  ELSE 0 END) AS cache_read,
           SUM(CASE WHEN ${BILLABLE} THEN cache_write ELSE 0 END) AS cache_write,
           CAST(ROUND(AVG(CASE WHEN ${OK} THEN latency_ms END)) AS INTEGER) AS avg_latency_ms,
           SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
    FROM usage_log
    WHERE ${where.join(" AND ")}
    GROUP BY dim
    ORDER BY tokens_out DESC
  `.replace(/\s+/g, " ").trim();
}

function runQuery(sql) {
  const raw = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 16 * 1024 * 1024 },
  );
  return parseQueryResult(raw);
}

function parseQueryResult(raw) {
  // A successful empty query is different from a missing/failed query result.
  // Never print raw tool output here: a failure may contain private context.
  const start = raw.indexOf("[");
  if (start < 0) throw new Error("usage query returned no result array");
  let parsed;
  try { parsed = JSON.parse(raw.slice(start)); }
  catch { throw new Error("usage query returned invalid JSON"); }
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0]?.success !== true
    || !Array.isArray(parsed[0].results)) throw new Error("usage query did not confirm success");
  return parsed[0].results;
}

const COLUMNS = [
  ["dim", "구분"],
  ["records", "저장 기록"],
  ["zero_token_records", "토큰 0 기록"],
  ["failed_with_tokens", "오류 중 토큰 기록"],
  // #684 — 실패 턴도 행을 남기게 됐으므로 "요청" 이 무엇을 세는지 이름에 박는다.
  // 성공 요청 + 오류 = 시도 횟수.
  ["requests", "성공 요청"],
  ["tokens_in", "입력"],
  ["tokens_out", "출력"],
  ["cache_read", "캐시 읽기"],
  ["cache_write", "캐시 쓰기"],
  ["avg_latency_ms", "평균 지연(ms)"],
  ["errors", "오류"],
];

function toMarkdown(rows, { days, by, cohort }) {
  const scope = cohort ? ` · 코호트 \`${cohort}\`` : "";
  const head = `### usage_log — 최근 ${days}일 · \`${by}\` 기준${scope}\n`;

  if (rows.length === 0) {
    // 빈 결과를 빈 표로 내면 "0 이다" 와 "안 돌았다" 가 구분되지 않는다.
    return `${head}\n해당 기간에 기록이 **없습니다.** 쿼리는 정상 실행됐습니다. 실제 사용량·원가가 0이라는 뜻은 아닙니다.\n`;
  }

  const fmt = (v) => (typeof v === "number" ? v.toLocaleString("en-US") : (v ?? "—"));
  const header = `| ${COLUMNS.map(([, label]) => label).join(" | ")} |`;
  const sep = `| ${COLUMNS.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((r) => `| ${COLUMNS.map(([key]) => fmt(r[key])).join(" | ")} |`)
    .join("\n");

  const total = rows.reduce(
    (a, r) => ({
      requests: a.requests + (r.requests ?? 0),
      tokens_in: a.tokens_in + (r.tokens_in ?? 0),
      tokens_out: a.tokens_out + (r.tokens_out ?? 0),
      cache_read: a.cache_read + (r.cache_read ?? 0),
      cache_write: a.cache_write + (r.cache_write ?? 0),
      errors: a.errors + (r.errors ?? 0),
    }),
    { requests: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, errors: 0 },
  );

  // Historical rows lack provider/usage-schema identity. Never derive a mixed
  // cache hit rate from fields whose inclusive/exclusive meanings differ.
  return [
    head,
    header,
    sep,
    body,
    "",
    `**저장값 합계** — 성공 ${fmt(total.requests)} · 오류 ${fmt(total.errors)} · 입력 ${fmt(total.tokens_in)} · 출력 ${fmt(total.tokens_out)} · 캐시 읽기 ${fmt(total.cache_read)} · 캐시 쓰기 ${fmt(total.cache_write)}`,
    "",
    "> 원가와 전체 기록 여부는 미확인입니다. 저장된 0에는 미보고가 섞일 수 있고, 재시도·보조 호출의 누락/중복을 이 집계로 확인할 수 없습니다. 공급자별 필드 의미가 달라 통합 캐시 적중률을 계산하지 않습니다.",
    "",
    "> 토큰 수만 냅니다. 달러 환산은 하지 않습니다 — 단가는 바뀌고, 여기서 곱하면 이 리포트가 단가의 두 번째 정본이 됩니다.",
    "",
  ].join("\n");
}

function main() {
  const args = validate(parseArgs(process.argv.slice(2)));
  const sql = buildSql(args);
  const rows = runQuery(sql);
  process.stdout.write(toMarkdown(rows, args));
}

// 직접 실행할 때만 돈다. 테스트가 검증·SQL 생성·포맷을 D1 없이 부를 수 있어야
// 하는데, import 만으로 프로덕션 쿼리가 나가면 그게 불가능하다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { parseArgs, validate, buildSql, toMarkdown, parseQueryResult };
