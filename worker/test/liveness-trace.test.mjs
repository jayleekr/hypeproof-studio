// Task E (docs/plan/dag.yaml) — heartbeat + artifactChanged trace events.
//
// This task spans two deploy targets with different release cadences: the
// worker deploys in 30 seconds, the app takes 1–2 hours plus a participant
// reinstall. So **an old client hitting a new worker is the normal path**, not
// an edge case, and the controls below are built around that:
//
//   양성 대조군 (positive) — a request carrying NONE of the new headers and
//     none of the new event types behaves *exactly* as it did before this
//     landed. This is the one most likely to be got wrong.
//   음성 대조군 (negative) — a malformed artifactChanged is rejected 400 and
//     the chat path keeps working.
//   드리프트 락 (drift lock) — the payload shape is asserted identically on
//     the client and worker sides. Idiom copied from logs-upload.test.mjs.
//
// Run: node --experimental-strip-types test/liveness-trace.test.mjs

import assert from "node:assert/strict";
import {
  bootApp,
  createMockEnv,
  makeCtx,
  withMockUpstream,
  openAIJsonBody,
  COHORT,
  PROFILE,
  USER,
  TEST_SECRET,
} from "./harness/index.mjs";

const app = await bootApp();
const { issue } = await import("../src/lib/tokens.ts");
const { token: TOKEN } = await issue({ u: USER, c: COHORT, p: PROFILE }, 1, TEST_SECRET);
const AUTH = `Bearer ${TOKEN}`;

const {
  parseEvent,
  HEARTBEAT_EVENT_KEYS,
  ARTIFACT_CHANGED_EVENT_KEYS,
} = await import("../src/routes/trace.ts");
const liveness = await import("../src/lib/liveness.ts");

const SHA_A = "a".repeat(64);
const SHA_B = "0123456789abcdef".repeat(4);

function traceRequest(body, { headers = {}, auth = AUTH } = {}) {
  return new Request("https://api.test/v1/trace/event", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth, ...headers },
    body: JSON.stringify(body),
  });
}

const livenessKeys = (env) => [...env._kv.keys()].filter((k) => k.startsWith("live:"));

// ─── 양성 대조군 — 구버전 클라이언트(새 헤더·새 이벤트 없음)는 그대로 동작 ────
// 워커가 먼저 나가고 앱이 1~2시간 뒤에 따라오므로, 이 상태가 **정상 경로**다.
{
  const env = createMockEnv();
  const ctx = makeCtx();
  const r = await app.fetch(traceRequest({ type: "trialStart", task_label: "게임 만들기" }), env, ctx);
  assert.equal(r.status, 200, "구버전 trialStart → 200 (변한 것 없음)");
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.match(j.trial_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  await ctx.settle();
  assert.deepEqual(livenessKeys(env), [], "liveness 이벤트가 아닌 요청은 KV 를 건드리지 않는다");

  // 같은 요청을 x-hps-client-version 을 붙여 보내도 응답은 **동일**해야 한다.
  // (새 헤더는 순수 부가정보 — 기존 경로의 동작을 바꾸면 안 된다)
  const env2 = createMockEnv();
  const ctx2 = makeCtx();
  const r2 = await app.fetch(
    traceRequest({ type: "trialStart", task_label: "게임 만들기" }, { headers: { "x-hps-client-version": "0.9.9" } }),
    env2,
    ctx2,
  );
  assert.equal(r2.status, r.status, "헤더 유무가 상태코드를 바꾸지 않는다");
  assert.deepEqual(Object.keys(await r2.json()).sort(), ["ok", "trial_id"], "응답 모양 동일");
  await ctx2.settle();

  // 기존 이벤트 4종이 전부 예전 판정을 그대로 통과한다 (parseEvent 순수 대조).
  const TRIAL = "11111111-2222-4333-8444-555555555555";
  for (const ev of [
    { type: "trialStart" },
    { type: "trialEnd", trial_id: TRIAL },
    { type: "validationRun", trial_id: TRIAL, outcome: "pass" },
    { type: "humanAction", trial_id: TRIAL, kind: "accept" },
  ]) {
    assert.equal(parseEvent(ev).ok, true, `${ev.type} 는 여전히 유효하다`);
  }
  console.log("✓ 양성 — 구버전 클라(새 헤더·새 이벤트 없음)는 이전과 완전히 동일");
}

// ─── 양성 — heartbeat 200 + KV 기록 (서버 시계, client_version 선택) ─────────
{
  const env = createMockEnv();
  const ctx = makeCtx();
  const before = Date.now();
  const r = await app.fetch(
    traceRequest({ type: "heartbeat", state: "idle", idle_ms: 120_000 }, { headers: { "x-hps-client-version": "0.1.42" } }),
    env,
    ctx,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  await ctx.settle();

  const key = liveness.heartbeatKey(COHORT, USER);
  assert.deepEqual(livenessKeys(env), [key], "정확히 하나의 liveness 키");
  const rec = JSON.parse(env._kv.get(key));
  assert.equal(rec.state, "idle");
  assert.equal(rec.idle_ms, 120_000);
  assert.equal(rec.client_version, "0.1.42");
  assert.ok(Date.parse(rec.at) >= before, "at 은 서버 시계 (클라가 미래로 못 간다)");
  assert.equal(env._dbCalls.length, 0, "하트비트는 D1 을 건드리지 않는다 (usage_log 는 청구 원장)");

  // 헤더 없는 구버전 클라의 하트비트 — 200, client_version 만 비어 있다.
  const env2 = createMockEnv();
  const ctx2 = makeCtx();
  const r2 = await app.fetch(traceRequest({ type: "heartbeat", state: "active" }), env2, ctx2);
  assert.equal(r2.status, 200, "버전 헤더 없는 하트비트도 200");
  await ctx2.settle();
  const rec2 = JSON.parse(env2._kv.get(liveness.heartbeatKey(COHORT, USER)));
  assert.equal(rec2.client_version, undefined, "헤더 없으면 필드도 없다");
  assert.equal(rec2.idle_ms, undefined);
  console.log("✓ 양성 — heartbeat 200 · 서버 시계 · 버전 헤더는 선택");
}

// ─── 양성 — artifactChanged 200 + sha256/bytes 만 저장 ───────────────────────
{
  const env = createMockEnv();
  const ctx = makeCtx();
  const r = await app.fetch(traceRequest({ type: "artifactChanged", sha256: SHA_B, bytes: 4096 }), env, ctx);
  assert.equal(r.status, 200);
  await ctx.settle();
  const rec = JSON.parse(env._kv.get(liveness.artifactKey(COHORT, USER)));
  assert.deepEqual(Object.keys(rec).sort(), ["at", "bytes", "sha256"], "저장 필드는 셋뿐");
  assert.equal(rec.sha256, SHA_B);
  assert.equal(rec.bytes, 4096);
  assert.equal(env._r2Puts.length, 0, "본문은 어디에도 저장되지 않는다");
  console.log("✓ 양성 — artifactChanged 는 메타데이터만 남긴다");
}

// ─── 음성 대조군 — 불량 artifactChanged 는 400, 채팅 경로는 멀쩡 ─────────────
{
  const env = createMockEnv();
  for (const [body, why] of [
    [{ type: "artifactChanged", bytes: 10 }, "sha256 누락"],
    [{ type: "artifactChanged", sha256: SHA_A.toUpperCase(), bytes: 10 }, "대문자 hex"],
    [{ type: "artifactChanged", sha256: "abc", bytes: 10 }, "길이 부족"],
    [{ type: "artifactChanged", sha256: SHA_A }, "bytes 누락"],
    [{ type: "artifactChanged", sha256: SHA_A, bytes: -1 }, "음수 bytes"],
    [{ type: "artifactChanged", sha256: SHA_A, bytes: 1.5 }, "정수 아님"],
    [{ type: "artifactChanged", sha256: SHA_A, bytes: 1e12 }, "상한 초과"],
    [{ type: "heartbeat" }, "state 누락"],
    [{ type: "heartbeat", state: "vibing" }, "알 수 없는 state"],
    [{ type: "heartbeat", state: "active", idle_ms: -5 }, "음수 idle_ms"],
  ]) {
    const ctx = makeCtx();
    const r = await app.fetch(traceRequest(body), env, ctx);
    assert.equal(r.status, 400, why);
    assert.equal((await r.json()).error.type, "request", why);
    await ctx.settle();
  }
  assert.deepEqual(livenessKeys(env), [], "거부된 이벤트는 아무것도 남기지 않는다");

  // 그리고 채팅 경로는 영향을 받지 않는다.
  await withMockUpstream(
    () => new Response(JSON.stringify(openAIJsonBody({ content: "좋아요!" })), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    async () => {
      const ctx = makeCtx();
      const r = await app.fetch(
        new Request("https://api.test/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: AUTH },
          body: JSON.stringify({ model: "hypeproof-default", messages: [{ role: "user", content: "안녕" }] }),
        }),
        env,
        ctx,
      );
      assert.equal(r.status, 200, "불량 trace 이벤트 뒤에도 채팅은 200");
      await ctx.settle();
    },
  );
  console.log("✓ 음성 — 불량 페이로드 400 · 무기록 · 채팅 경로 무영향");
}

// ─── 음성 — 파일 내용을 실어 보내려는 시도는 통과해도 저장되지 않는다 ─────────
// (초과 필드를 400 으로 막지는 않는다 — 앞선 클라가 필드를 더해 올 수 있는
//  전방 호환이 필요하다. 대신 parseEvent 가 **화이트리스트로 재구성**하므로
//  본문은 어디에도 도달하지 않는다.)
{
  const SECRET = "우리 엄마 전화번호는 010-0000-0000";
  const parsed = parseEvent({ type: "artifactChanged", sha256: SHA_A, bytes: 10, content: SECRET, path: "내 게임.html" });
  assert.equal(parsed.ok, true, "초과 필드는 거부하지 않는다 (전방 호환)");
  assert.deepEqual(Object.keys(parsed.event).sort(), [...ARTIFACT_CHANGED_EVENT_KEYS].sort());
  assert.ok(!JSON.stringify(parsed.event).includes(SECRET), "본문은 이벤트에서 사라진다");
  assert.ok(!JSON.stringify(parsed.event).includes("내 게임"), "파일명도 사라진다");

  const env = createMockEnv();
  const ctx = makeCtx();
  await app.fetch(traceRequest({ type: "artifactChanged", sha256: SHA_A, bytes: 10, content: SECRET }), env, ctx);
  await ctx.settle();
  const stored = env._kv.get(liveness.artifactKey(COHORT, USER));
  assert.ok(!stored.includes(SECRET), "KV 에도 본문이 없다");
  console.log("✓ 음성 — 본문/파일명을 밀어넣어도 저장 계층에 도달하지 않는다");
}

// ─── 음성 — liveness 이벤트도 기존 게이트 전부를 통과해야 한다 ───────────────
{
  const noSession = createMockEnv({ withSession: false });
  const r1 = await app.fetch(traceRequest({ type: "heartbeat", state: "active" }), noSession, makeCtx());
  assert.equal(r1.status, 403, "세션 없으면 하트비트도 403");
  assert.equal((await r1.json()).error.type, "session_inactive");

  const noRoster = createMockEnv({ withRoster: false });
  const r2 = await app.fetch(traceRequest({ type: "heartbeat", state: "active" }), noRoster, makeCtx());
  assert.equal(r2.status, 403, "roster 밖이면 403");

  const env = createMockEnv();
  const r3 = await app.fetch(
    traceRequest({ type: "heartbeat", state: "active" }, { auth: "Bearer garbage" }),
    env,
    makeCtx(),
  );
  assert.equal(r3.status, 401, "토큰 불량 401");
  assert.deepEqual(livenessKeys(env), []);
  console.log("✓ 음성 — 하트비트는 토큰·세션·roster 게이트를 우회하지 않는다");
}

// ─── KV 계층 — TTL 이 실제로 붙는가 (하네스 mock 은 옵션을 버린다) ───────────
{
  const puts = [];
  const kv = { async put(key, val, opts) { puts.push({ key, val, opts }); } };
  await liveness.recordHeartbeat(kv, "c1", "u1", { at: "2026-09-04T00:00:00.000Z", state: "active" });
  await liveness.recordArtifactChange(kv, "c1", "u1", { at: "2026-09-04T00:00:00.000Z", sha256: SHA_A, bytes: 1 });
  assert.equal(puts[0].key, "live:hb:c1:u1");
  assert.equal(puts[0].opts.expirationTtl, liveness.HEARTBEAT_TTL_SEC);
  assert.equal(puts[1].key, "live:af:c1:u1");
  assert.equal(puts[1].opts.expirationTtl, liveness.ARTIFACT_TTL_SEC);
  // 하트비트 TTL 은 클라이언트 핑 간격보다 넉넉히 길어야 한다 — 한 번 떨어졌다고
  // 자리가 "죽음"으로 보이면 안 된다.
  const { HEARTBEAT_INTERVAL_MS } = await import("../../extensions/hypeproof-chat/src/heartbeat.ts");
  assert.ok(
    liveness.HEARTBEAT_TTL_SEC * 1000 > HEARTBEAT_INTERVAL_MS * 3,
    "TTL 이 핑 간격의 3배보다 길다",
  );
  assert.ok(HEARTBEAT_INTERVAL_MS >= 30_000 && HEARTBEAT_INTERVAL_MS <= 60_000, "핑 간격 30~60초");
  console.log("✓ KV — TTL 부착 · 핑 간격과 정합");
}

// ─── 드리프트 락 — 클라이언트 페이로드 == 워커 계약 ──────────────────────────
// 두 쪽이 서로 다른 릴리스 열차를 탄다(워커 30초, 앱 1~2시간 + 재설치). 이
// 테스트 말고는 둘을 붙들어 두는 것이 없다.
// 주의(logs-upload.test.mjs 와 동일): 이 크로스-패키지 import 는
// extensions/hypeproof-chat/package.json 에 "type" 필드가 **없어서** 동작한다.
{
  const client = await import("../../extensions/hypeproof-chat/src/heartbeat.ts");

  assert.deepEqual(
    [...client.CLIENT_LIVENESS_EVENT_KEYS.heartbeat].sort(),
    [...HEARTBEAT_EVENT_KEYS].sort(),
    "heartbeat 키 집합 일치",
  );
  assert.deepEqual(
    [...client.CLIENT_LIVENESS_EVENT_KEYS.artifactChanged].sort(),
    [...ARTIFACT_CHANGED_EVENT_KEYS].sort(),
    "artifactChanged 키 집합 일치",
  );

  // 키 이름만 맞추는 건 절반이다 — 클라가 **실제로 만드는** 페이로드를 워커의
  // 검증기에 그대로 먹인다.
  for (const built of [
    client.buildHeartbeatEvent(0),
    client.buildHeartbeatEvent(5_000),
    client.buildHeartbeatEvent(600_000),
    client.buildArtifactChangedEvent("<html>내 게임</html>"),
    client.buildArtifactChangedEvent(new Uint8Array([1, 2, 3])),
    client.buildArtifactChangedEvent(""),
  ]) {
    const p = parseEvent(built);
    assert.equal(p.ok, true, `클라가 만든 ${built.type} 를 워커가 받는다: ${JSON.stringify(built)}`);
    // 라운드트립: 워커가 재구성한 이벤트가 클라가 보낸 것과 완전히 같다.
    // (한쪽이 필드를 조용히 떨구면 여기서 잡힌다)
    assert.deepEqual(
      JSON.parse(JSON.stringify(p.event)),
      JSON.parse(JSON.stringify(built)),
      "라운드트립 동일",
    );
  }

  // 클라가 붙이는 상태 문자열 집합 == 워커가 받는 집합.
  assert.deepEqual(
    [client.heartbeatState(0), client.heartbeatState(10 ** 9)].sort(),
    [...liveness.HEARTBEAT_STATES].sort(),
    "state 어휘 일치",
  );

  // 그리고 실기기 경로 그대로 워커에 넣어 본다.
  const env = createMockEnv();
  const ctx = makeCtx();
  const ev = client.buildArtifactChangedEvent("<html>내 게임</html>");
  const r = await app.fetch(traceRequest(ev), env, ctx);
  assert.equal(r.status, 200, "클라가 만든 페이로드가 실제 라우트를 통과");
  await ctx.settle();
  assert.equal(JSON.parse(env._kv.get(liveness.artifactKey(COHORT, USER))).sha256, ev.sha256);
  console.log("✓ 드리프트 락 — 클라 페이로드가 워커 검증기·실 라우트를 그대로 통과");
}

console.log("liveness-trace.test.mjs — all green");
