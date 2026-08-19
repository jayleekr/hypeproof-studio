// #580 — 세션 로그 로컬 스풀. 앱 없이, 밀리초.
//
// 이 모듈은 질문 원문·토큰 usage·행동 이벤트를 디스크에 남긴다. 잘못 쓰면
// 두 방향으로 죽는다: (a) 이벤트가 새거나 순서가 섞이면 분석이 조용히 틀리고,
// (b) dedupe 가 깨지면 비용이 과대계상된다. 대조군을 양쪽으로 붙인다:
//   양성 — 정상 이벤트는 한 파일에 순서대로, 스키마 버전과 함께 남아야 한다
//   음성 — 키 없는 usage · 중복 requestKey · 쓰기 실패는 **기록을 만들면 안 된다**
//
// Run: node --experimental-strip-types test/session-spool.smoke.mjs

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const {
  SessionSpool,
  SPOOL_SCHEMA_VERSION,
  SPOOL_MAX_TEXT_CHARS,
  resolveSpoolSessionsRoot,
  spoolIdentityFromToken,
} = await import("../src/sessionSpool.ts");

const FIXED_NOW = new Date("2026-08-19T05:00:00.000Z");

function makeSpool(root, opts = {}) {
  let n = 0;
  return new SessionSpool({
    root,
    appVersion: "0.1.5-test",
    os: { platform: "darwin", release: "25.1.0", arch: "arm64" },
    now: () => FIXED_NOW,
    newSessionId: () => `session-${++n}`,
    ...opts,
  });
}

function readEvents(dir) {
  return fs
    .readFileSync(path.join(dir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

function readMeta(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "session.meta.json"), "utf8"));
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hps-spool-"));

// ─── 양성 대조군 — 이벤트는 단일 events.jsonl 에 순서대로 ───────────────────
{
  const root = tmp();
  const spool = makeSpool(root);
  spool.noteIdentity({ u: "kid01", c: "test-cohort", p: "prof-1" });
  spool.recordPrompt({ turnId: "t-1", runtime: "agent-sdk", text: "버튼 색 바꿔줘", imagesCount: 1 });
  spool.recordUsage({
    turnId: "t-1", source: "sdk", requestKey: "msg_A", model: "claude-sonnet-5",
    inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 400, cacheCreationInputTokens: 5,
  });
  spool.recordWorkflow({ turnId: "t-1", event: "preview_reveal" });
  spool.recordTurnEnd({ turnId: "t-1", status: "ok", runtime: "agent-sdk", totalCostUsd: 0.01 });
  await spool.flush();

  const dir = spool.currentSessionDir();
  assert.ok(dir, "세션 디렉토리가 생겼다");
  // 디렉토리 = <root>/<로컬 yyyy-mm-dd>/<session-id> (날짜는 로컬 기준)
  const rel = path.relative(root, dir).split(path.sep);
  assert.equal(rel.length, 2);
  assert.match(rel[0], /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(rel[1], "session-1");

  const events = readEvents(dir);
  assert.deepEqual(events.map((e) => e.type), ["prompt", "usage", "workflow", "turn_end"], "순서 보존");
  for (const e of events) {
    assert.equal(e.schema_version, SPOOL_SCHEMA_VERSION, "레코드마다 schema_version");
    assert.equal(e.ts, FIXED_NOW.toISOString(), "ts 는 ISO UTC");
  }
  const [prompt, usage, wf, end] = events;
  assert.equal(prompt.text, "버튼 색 바꿔줘");
  assert.equal(prompt.images_count, 1);
  assert.equal(usage.request_key, "msg_A");
  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.cache_read_input_tokens, 400);
  assert.equal(usage.cache_creation_input_tokens, 5);
  assert.equal(wf.event, "preview_reveal");
  assert.equal(end.status, "ok");
  assert.equal(end.total_cost_usd, 0.01);

  const meta = readMeta(dir);
  assert.equal(meta.schema_version, SPOOL_SCHEMA_VERSION);
  assert.equal(meta.session_id, "session-1");
  assert.deepEqual(meta.user, { u: "kid01", c: "test-cohort", p: "prof-1" });
  assert.equal(meta.app_version, "0.1.5-test");
  assert.equal(meta.started_at, FIXED_NOW.toISOString());
  console.log("✓ 양성 — 단일 events.jsonl, 순서·스키마·meta");
}

// ─── 음성 대조군 — dedupe: 같은 requestKey 는 1건, 키 없으면 0건 ────────────
{
  const spool = makeSpool(tmp());
  // #503 실측 재현: 같은 API 응답이 thinking/text/tool_use 3개 메시지로 쪼개져
  // 같은 usage 가 3번 도착한다.
  for (let i = 0; i < 3; i++) {
    spool.recordUsage({
      turnId: "t-1", source: "sdk", requestKey: "msg_dup", model: "m",
      inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    });
  }
  // dedupe 키가 없는 usage — 기록하면 과대계상이므로 버려야 한다.
  spool.recordUsage({
    turnId: "t-1", source: "sdk", requestKey: null, model: "m",
    inputTokens: 999, outputTokens: 999, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
  });
  await spool.flush();
  const events = readEvents(spool.currentSessionDir());
  assert.equal(events.length, 1, "중복 3건 → 1건, 키 없는 1건 → 0건");
  assert.equal(events[0].input_tokens, 10);
  console.log("✓ 음성 — requestKey dedupe · 키 없는 usage 미기록 (과대계상 방지)");
}

// ─── 신원 후착 — 세션 유지, meta 만 갱신 (started_at 보존) ──────────────────
{
  const spool = makeSpool(tmp());
  spool.recordPrompt({ turnId: "t-1", runtime: "proxy", text: "토큰 넣기 전 질문" });
  await spool.flush();
  const dir = spool.currentSessionDir();
  assert.equal(readMeta(dir).user, null, "신원 없이 시작");
  spool.noteIdentity({ u: "kid02", c: "test-cohort" });
  await spool.flush();
  assert.equal(spool.currentSessionDir(), dir, "세션 유지");
  const meta = readMeta(dir);
  assert.deepEqual(meta.user, { u: "kid02", c: "test-cohort" });
  assert.equal(meta.started_at, FIXED_NOW.toISOString(), "재작성이 started_at 을 지우지 않는다");
  console.log("✓ 신원 후착 — meta 갱신, 세션·started_at 유지");
}

// ─── 신원 교체 — 새 세션으로 회전 (세션당 신원 1개 불변식, #580 D3) ─────────
{
  const spool = makeSpool(tmp());
  spool.noteIdentity({ u: "kid01", c: "cohort-a" });
  spool.recordPrompt({ turnId: "t-1", runtime: "proxy", text: "first" });
  await spool.flush();
  const first = spool.currentSessionDir();
  spool.noteIdentity({ u: "kid09", c: "cohort-a" }); // 같은 PC, 다른 학생
  spool.recordPrompt({ turnId: "t-2", runtime: "proxy", text: "second" });
  await spool.flush();
  const second = spool.currentSessionDir();
  assert.notEqual(second, first, "다른 신원 → 다른 세션 디렉토리");
  assert.deepEqual(readMeta(first).user, { u: "kid01", c: "cohort-a" });
  assert.deepEqual(readMeta(second).user, { u: "kid09", c: "cohort-a" });
  assert.equal(readEvents(first).length, 1);
  assert.equal(readEvents(second).length, 1);
  // 같은 신원 재통지는 회전하지 않는다.
  spool.noteIdentity({ u: "kid09", c: "cohort-a" });
  spool.recordPrompt({ turnId: "t-3", runtime: "proxy", text: "third" });
  await spool.flush();
  assert.equal(spool.currentSessionDir(), second, "같은 신원 → 세션 유지");
  console.log("✓ 신원 교체 — 세션 회전, 이전 파일 보존");
}

// ─── 신원 전이 인터리빙 — flush 없이도 이벤트가 제 세션에 귀속된다 ──────────
// (리뷰 실증 리프로 A: 첫 구현은 큐 밖 동기 전이라 회전이 아예 사라지고
//  두 학생의 프롬프트가 뒷 학생 meta 아래 한 세션에 섞였다.)
{
  const spool = makeSpool(tmp());
  spool.noteIdentity({ u: "kidA", c: "co" });
  spool.recordPrompt({ turnId: "t-a", runtime: "proxy", text: "A의 질문" });
  spool.noteIdentity({ u: "kidB", c: "co" });
  spool.recordPrompt({ turnId: "t-b", runtime: "proxy", text: "B의 질문" });
  await spool.flush();
  const dirB = spool.currentSessionDir();
  assert.deepEqual(readMeta(dirB).user, { u: "kidB", c: "co" });
  assert.deepEqual(readEvents(dirB).map((e) => e.text), ["B의 질문"]);
  const dirA = path.join(path.dirname(dirB), "session-1");
  assert.deepEqual(readMeta(dirA).user, { u: "kidA", c: "co" });
  assert.deepEqual(readEvents(dirA).map((e) => e.text), ["A의 질문"]);
  console.log("✓ 인터리빙 — flush 없는 신원 전이에도 프롬프트가 제 세션으로");
}

// ─── 턴 피닝 — 회전을 가로지르는 턴 이벤트는 프롬프트의 세션으로 (리프로 B) ──
{
  const spool = makeSpool(tmp());
  spool.noteIdentity({ u: "kidA", c: "co" });
  spool.recordPrompt({ turnId: "t-a", runtime: "agent-sdk", text: "A의 턴" });
  spool.noteIdentity({ u: "kidB", c: "co" });
  spool.recordPrompt({ turnId: "t-b", runtime: "proxy", text: "B의 턴" });
  // A 의 스트림이 늦게 끝나 usage·turn_end 가 회전 뒤에 도착한다.
  spool.recordUsage({
    turnId: "t-a", source: "sdk", requestKey: "msg_late", model: "m",
    inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
  });
  spool.recordTurnEnd({ turnId: "t-a", status: "ok", runtime: "agent-sdk" });
  await spool.flush();
  const dirB = spool.currentSessionDir();
  const dirA = path.join(path.dirname(dirB), "session-1");
  assert.deepEqual(
    readEvents(dirA).map((e) => e.type),
    ["prompt", "usage", "turn_end"],
    "A 턴의 늦은 이벤트가 A 세션에 붙는다",
  );
  assert.deepEqual(readEvents(dirB).map((e) => e.type), ["prompt"], "B 세션은 오염되지 않는다");
  console.log("✓ 턴 피닝 — 회전 뒤 도착한 턴 이벤트도 프롬프트의 세션으로");
}

// ─── 긴 텍스트 캡 — 자르되, 잘렸다고 남긴다 (no silent caps) ─────────────────
{
  const spool = makeSpool(tmp());
  spool.recordPrompt({ turnId: "t-1", runtime: "proxy", text: "가".repeat(SPOOL_MAX_TEXT_CHARS + 500) });
  spool.recordPrompt({ turnId: "t-2", runtime: "proxy", text: "짧은 질문" });
  await spool.flush();
  const [long, short] = readEvents(spool.currentSessionDir());
  assert.equal(long.text.length, SPOOL_MAX_TEXT_CHARS);
  assert.equal(long.text_truncated, true, "잘림 표식");
  assert.equal(long.text_original_chars, SPOOL_MAX_TEXT_CHARS + 500, "원래 길이");
  assert.equal(short.text_truncated, undefined, "안 잘린 레코드엔 표식 없음");
  console.log("✓ text 캡 — 절단 + text_truncated/text_original_chars 표식");
}

// ─── workflow payload 문자열 캡 — 웹뷰발 자유 텍스트 방어 ───────────────────
{
  const spool = makeSpool(tmp());
  spool.recordWorkflow({ event: "trialStart", payload: { task_label: "y".repeat(600), n: 3 } });
  await spool.flush();
  const [e] = readEvents(spool.currentSessionDir());
  assert.equal(e.payload.task_label.length, 500);
  assert.equal(e.payload.n, 3, "문자열 아닌 값은 그대로");
  console.log("✓ workflow payload — 문자열 값 500자 캡");
}

// ─── dev 표식 — F5 개발 호스트 런은 meta 로 걸러낼 수 있다 ──────────────────
{
  const spool = makeSpool(tmp(), { devHost: true });
  spool.recordPrompt({ turnId: "t-1", runtime: "proxy", text: "dev run" });
  await spool.flush();
  assert.equal(readMeta(spool.currentSessionDir()).dev, true);
  console.log("✓ dev 표식 — devHost 런의 meta 에 dev: true");
}

// ─── 보존 캡 — 오래된 세션부터 삭제, 현재 세션은 보호 (#580 D7) ─────────────
{
  const root = tmp();
  // 이전 실행들이 남긴 세션 3개 (각 ~1KB, mtime 이 곧 나이).
  for (let i = 1; i <= 3; i++) {
    const dir = path.join(root, "2026-08-0" + i, `old-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "events.jsonl"), "x".repeat(1024));
    const t = new Date(`2026-08-0${i}T00:00:00Z`);
    fs.utimesSync(path.join(dir, "events.jsonl"), t, t);
  }
  const spool = makeSpool(root, { maxTotalBytes: 2 * 1024 + 100 });
  spool.recordPrompt({ turnId: "t-1", runtime: "proxy", text: "현재 세션" });
  await spool.flush();
  await spool.sweepRetention();
  const current = spool.currentSessionDir();
  assert.ok(fs.existsSync(current), "현재 세션은 삭제하지 않는다");
  assert.ok(!fs.existsSync(path.join(root, "2026-08-01", "old-1")), "가장 오래된 것부터 삭제");
  assert.ok(!fs.existsSync(path.join(root, "2026-08-01")), "빈 날짜 디렉토리도 정리");
  console.log("✓ 보존 캡 — 오래된 세션 삭제, 현재 세션 보호");
}

// ─── 음성 대조군 — 쓰기 실패는 채팅을 죽이지 않는다 ─────────────────────────
{
  // 루트가 파일이면 mkdir 이 실패한다 — 스풀의 모든 호출은 그래도 조용해야 한다.
  const bogus = path.join(tmp(), "not-a-dir");
  fs.writeFileSync(bogus, "file, not dir");
  const spool = makeSpool(bogus);
  const origWarn = console.warn;
  let warns = 0;
  console.warn = () => { warns += 1; };
  try {
    spool.recordPrompt({ turnId: "t-1", runtime: "proxy", text: "x" });
    spool.recordUsage({
      turnId: "t-1", source: "proxy", requestKey: "r", model: "m",
      inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    });
    spool.recordTurnEnd({ turnId: "t-1", status: "ok", runtime: "proxy" });
    await spool.flush(); // reject 하면 여기서 터진다
    await spool.sweepRetention();
  } finally {
    console.warn = origWarn;
  }
  assert.equal(warns, 1, "경고는 세션당 1회");
  console.log("✓ 음성 — 쓰기 실패 삼킴 (스풀은 제품을 죽이지 않는다)");
}

// ─── spoolIdentityFromToken — 토큰 payload → 신원 ───────────────────────────
{
  const payload = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url") + ".sig";
  assert.deepEqual(
    spoolIdentityFromToken(payload({ u: "kid01", c: "sk-biopharm-kids-s1", p: "prof", exp: 1 })),
    { u: "kid01", c: "sk-biopharm-kids-s1", p: "prof" },
  );
  assert.deepEqual(spoolIdentityFromToken(payload({ u: "kid01", c: "co" })), { u: "kid01", c: "co" });
  // 음성 — u/c 없거나 깨진 토큰은 null (신원을 지어내지 않는다).
  assert.equal(spoolIdentityFromToken(payload({ u: "kid01" })), null);
  assert.equal(spoolIdentityFromToken(payload({ c: "co" })), null);
  assert.equal(spoolIdentityFromToken("garbage"), null);
  assert.equal(spoolIdentityFromToken(null), null);
  console.log("✓ spoolIdentityFromToken — u·c 필수, 깨진 토큰은 null");
}

// ─── resolveSpoolSessionsRoot — 플랫폼별 고정 경로 (seeded SDK 와 같은 규율) ─
{
  assert.equal(
    resolveSpoolSessionsRoot({ platform: "darwin", homeDir: "/Users/kid" }),
    "/Users/kid/Library/Application Support/HypeProof-Studio/logs/sessions",
  );
  assert.equal(
    resolveSpoolSessionsRoot({ platform: "win32", homeDir: "C:\\Users\\kid", env: { APPDATA: "C:\\Users\\kid\\AppData\\Roaming" } }),
    "C:\\Users\\kid\\AppData\\Roaming\\HypeProof-Studio\\logs\\sessions",
  );
  assert.equal(
    resolveSpoolSessionsRoot({ platform: "linux", homeDir: "/home/kid", env: {} }),
    "/home/kid/.config/HypeProof-Studio/logs/sessions",
  );
  assert.equal(
    resolveSpoolSessionsRoot({ platform: "linux", homeDir: "/home/kid", env: { XDG_CONFIG_HOME: "/xdg" } }),
    "/xdg/HypeProof-Studio/logs/sessions",
  );
  // win32 에서 APPDATA 가 비어 있는 비정상 환경 — homeDir 폴백 분기.
  assert.equal(
    resolveSpoolSessionsRoot({ platform: "win32", homeDir: "C:\\Users\\kid", env: {} }),
    "C:\\Users\\kid\\AppData\\Roaming\\HypeProof-Studio\\logs\\sessions",
  );
  console.log("✓ 스풀 루트 — darwin/win32(+APPDATA 폴백)/linux 고정 경로");
}

console.log("session-spool.smoke.mjs — all green");

// ─── error_kind — 실패 턴에 "왜"가 남는다 (첫 실기기 검증에서 걸린 공백) ─────
{
  const spool = makeSpool(tmp());
  spool.recordTurnEnd({ turnId: "t-e", status: "error", runtime: "proxy", errorKind: "auth:missing" });
  spool.recordTurnEnd({ turnId: "t-ok", status: "ok", runtime: "proxy" });
  await spool.flush();
  const [errEnd, okEnd] = readEvents(spool.currentSessionDir());
  assert.equal(errEnd.error_kind, "auth:missing");
  assert.equal(okEnd.error_kind, undefined, "성공 턴엔 키 자체가 없다");
  console.log("✓ error_kind — 실패 분류값 기록, 성공 턴엔 부재");
}

// ─── classifyTurnError — 분류값만, 원문 산문 금지 ───────────────────────────
{
  const { classifyTurnError } = await import("../src/chatPanelHelpers.ts");
  assert.equal(classifyTurnError({ kind: "session_inactive", friendly: "..." }), "auth:session_inactive");
  assert.equal(classifyTurnError({ kind: "missing" }), "auth:missing");
  assert.equal(classifyTurnError({ name: "CoachStallError" }), "stall");
  assert.equal(classifyTurnError({ name: "AbortError" }), "aborted");
  assert.equal(classifyTurnError({ requestId: undefined, message: "stream interrupted" }), "transport");
  assert.equal(classifyTurnError(new TypeError("boom")), "TypeError");
  assert.equal(classifyTurnError(new Error("아무 산문")), "error", "원문이 그대로 새지 않는다");
  assert.equal(classifyTurnError("string"), "unknown");
  assert.equal(classifyTurnError(null), "unknown");
  console.log("✓ classifyTurnError — 덕 타이핑 분류, 산문 미유출");
}
