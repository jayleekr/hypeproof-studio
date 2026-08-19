// #596 — PUT /v1/logs (세션 로그 업로드) 통합 테스트. 실제 앱 전체 체인 경유.
//
// 이 라우트의 존재 이유 두 가지가 핵심 어서션이다:
//   1. **세션이 닫혀 있어도** 업로드된다 — chat 이라면 session_inactive 403 인
//      상황이 이 라우트의 정상 경로다 (업로드는 수업 후에 일어난다).
//   2. R2 키의 신원 프리픽스는 **서버가 토큰에서** 조립한다 — 클라이언트가
//      남의 프리픽스에 쓸 방법이 없다.
// 그리고 opt-in 은 fail-closed: 플래그 없는 실코호트는 403 이어야 한다
// (음성 대조군 — canary 만 켜져 있다).
//
// Run: node --experimental-strip-types test/logs-upload.test.mjs

import assert from "node:assert/strict";
import {
  bootApp,
  createMockEnv,
  makeCtx,
  COHORT,
  PROFILE,
  USER,
  TEST_SECRET,
} from "./harness/index.mjs";

const { issue } = await import("../src/lib/tokens.ts");
const app = await bootApp();

// canary-sdk-contract 가 upload_session_logs: true 인 유일한 프로필 — 양성 대조군.
const CANARY_COHORT = "canary-internal";
const CANARY_PROFILE = "canary-sdk-contract";
const CANARY_USER = "canary-01";
const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DAY = "2026-08-19";

const { token: CANARY_TOKEN } = await issue(
  { u: CANARY_USER, c: CANARY_COHORT, p: CANARY_PROFILE }, 1, TEST_SECRET,
);
const { token: DEFAULT_TOKEN } = await issue({ u: USER, c: COHORT, p: PROFILE }, 1, TEST_SECRET);

/** canary 코호트 roster 만 시드 — active_session 은 일부러 안 만든다. */
function canaryEnv() {
  const env = createMockEnv();
  env._kv.set(
    `cohort:${CANARY_COHORT}:roster`,
    JSON.stringify({ users: [CANARY_USER], updated_at: new Date().toISOString() }),
  );
  return env;
}

function putReq(filename, { token = CANARY_TOKEN, sessionId = SID, day = DAY, body = '{"schema_version":1}\n', headers = {} } = {}) {
  return new Request(`https://api.test/v1/logs/${sessionId}/${filename}?day=${day}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body,
  });
}

// ─── 양성 — 세션 없이(수업 종료 후) 3파일 업로드, 키는 토큰 신원으로 ─────────
{
  const env = canaryEnv(); // canary 에 active_session 없음 — 그게 포인트
  const ctx = makeCtx();
  const events = '{"schema_version":1,"type":"prompt","text":"안녕"}\n{"schema_version":1,"type":"turn_end"}\n';
  for (const [name, body] of [
    ["session.meta.json", '{"schema_version":1,"user":{"u":"canary-01"}}'],
    ["events.jsonl", events],
    ["manifest.json", '{"schema_version":1,"files":[]}'],
  ]) {
    const r = await app.fetch(putReq(name, { body }), env, ctx);
    assert.equal(r.status, 200, `${name} → 200 (세션 없이도)`);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.key, `studio-logs/${CANARY_COHORT}/${CANARY_USER}/${DAY}/${SID}/${name}`);
  }
  assert.equal(env._r2Puts.length, 3, "R2 에 정확히 3개");
  const eventsPut = env._r2Puts.find((p) => p.key.endsWith("events.jsonl"));
  assert.equal(new TextDecoder().decode(eventsPut.value), events, "본문 바이트 보존");
  console.log("✓ 양성 — 세션 부재 상태 업로드 + 서버 조립 키 + 본문 보존");
}

// ─── 음성 — opt-in 없는 실코호트는 fail-closed 403 ──────────────────────────
{
  const env = createMockEnv(); // 기본 코호트: 세션·roster 다 있음 — 그래도 거부
  const r = await app.fetch(putReq("events.jsonl", { token: DEFAULT_TOKEN }), env, makeCtx());
  assert.equal(r.status, 403);
  const j = await r.json();
  assert.equal(j.error.type, "upload_disabled", "플래그 없는 코호트 = 서버가 거부");
  assert.equal(env._r2Puts.length, 0);
  console.log("✓ 음성 — opt-in 미설정 코호트 fail-closed (R2 무기록)");
}

// ─── 음성 — 파일명 allowlist / day / sessionId 형식 ─────────────────────────
{
  const env = canaryEnv();
  for (const [name, opts, why] of [
    ["evil.txt", {}, "allowlist 밖 파일명"],
    ["..%2F..%2Fx.json", {}, "경로 문자"],
    ["events.jsonl", { day: "2026-8-19" }, "day 형식"],
    ["events.jsonl", { day: "" }, "day 부재"],
    ["events.jsonl", { sessionId: "not-a-uuid" }, "sessionId 형식"],
  ]) {
    const r = await app.fetch(putReq(name, opts), env, makeCtx());
    assert.equal(r.status, 400, why);
  }
  assert.equal(env._r2Puts.length, 0);
  console.log("✓ 음성 — allowlist·day·sessionId 검증, 전부 400");
}

// ─── 음성 — issuer 토큰 / roster 미등록 / 빈 본문 / 크기 캡 ──────────────────
{
  const env = canaryEnv();
  const { token: issuerish } = await issue(
    { u: "t", c: CANARY_COHORT, p: CANARY_PROFILE, role: "issuer" }, 1, TEST_SECRET,
  );
  assert.equal((await app.fetch(putReq("events.jsonl", { token: issuerish }), env, makeCtx())).status, 401, "issuer 401");

  const { token: stranger } = await issue(
    { u: "not-rostered", c: CANARY_COHORT, p: CANARY_PROFILE }, 1, TEST_SECRET,
  );
  const rStranger = await app.fetch(putReq("events.jsonl", { token: stranger }), env, makeCtx());
  assert.equal(rStranger.status, 403, "roster 밖 403");
  assert.equal((await rStranger.json()).error.type, "not_in_roster");

  assert.equal((await app.fetch(putReq("events.jsonl", { body: "" }), env, makeCtx())).status, 400, "빈 본문 400");

  const rBig = await app.fetch(
    putReq("session.meta.json", { headers: { "content-length": String(10 * 1024 * 1024) } }),
    env, makeCtx(),
  );
  assert.equal(rBig.status, 413, "선언 크기 초과 413 (본문 읽기 전 차단)");
  assert.equal(env._r2Puts.length, 0);
  console.log("✓ 음성 — issuer 401 · roster 403 · 빈본문 400 · 크기 413");
}

// ─── 멱등 — 같은 키 재업로드는 덮어쓰기 (재시도 안전) ────────────────────────
{
  const env = canaryEnv();
  await app.fetch(putReq("events.jsonl", { body: "v1\n" }), env, makeCtx());
  await app.fetch(putReq("events.jsonl", { body: "v1\nv2\n" }), env, makeCtx());
  assert.equal(env._r2Puts.length, 2);
  assert.equal(env._r2Puts[0].key, env._r2Puts[1].key, "같은 키 — R2 가 덮어쓴다");
  console.log("✓ 멱등 — 재업로드는 같은 키 덮어쓰기");
}

console.log("logs-upload.test.mjs — all green");
