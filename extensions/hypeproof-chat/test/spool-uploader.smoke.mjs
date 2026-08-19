// #596 — 스풀 업로더. 앱 없이, 밀리초. fetch 는 주입한다.
//
// 이 모듈의 계약 셋:
//   1. manifest 는 **마지막에** — 앞 파일이 실패하면 manifest 는 안 나간다
//      (서버 기준 미완결 → 다음 트리거 전체 재시도)
//   2. 성공 세션에만 uploaded.json 마커 — 스캔이 건너뛴다
//   3. sha256 이 실제 바이트의 해시다 — 무결성 검증의 근거
//
// Run: node --experimental-strip-types test/spool-uploader.smoke.mjs

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

const {
  scanUploadableSessions, uploadSession, uploadAllPending, buildManifest,
  UPLOADED_MARKER, UPLOAD_QUIESCENT_MS,
} = await import("../src/spoolUploader.ts");

const FIXED_NOW = () => new Date("2026-08-19T09:00:00.000Z");
const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SID2 = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

// 기본은 "정지된" 세션 — events mtime 을 정지 게이트 밖(10분 전)으로 민다.
// fresh: true 로 만들면 "아직 쓰는 중"(방금 mtime) 세션이 된다.
function makeSession(root, day, sid, { meta = true, events = "e1\ne2\n", uploaded = false, fresh = false } = {}) {
  const dir = path.join(root, day, sid);
  fs.mkdirSync(dir, { recursive: true });
  if (meta) {
    const user = arguments.length > 3 && arguments[3].metaUser !== undefined ? arguments[3].metaUser : undefined;
    const body = user === undefined ? '{"schema_version":1}' : JSON.stringify({ schema_version: 1, user });
    fs.writeFileSync(path.join(dir, "session.meta.json"), body + "\n");
  }
  if (events !== null) {
    const f = path.join(dir, "events.jsonl");
    fs.writeFileSync(f, events);
    if (!fresh) {
      const t = new Date(Date.now() - UPLOAD_QUIESCENT_MS - 5 * 60 * 1000);
      fs.utimesSync(f, t, t);
    }
  }
  if (uploaded) fs.writeFileSync(path.join(dir, UPLOADED_MARKER), "{}\n");
  return dir;
}

/** 주입용 fetch — 요청을 기록하고 대본대로 응답한다. */
function fakeFetch(script = () => ({ status: 200 })) {
  const calls = [];
  const fn = async (url, init) => {
    const call = { url: String(url), method: init.method, body: init.body, auth: init.headers.authorization };
    calls.push(call);
    const r = script(call, calls.length);
    const status = r.status ?? 200;
    const body = r.body ?? JSON.stringify({ ok: status === 200, key: `k-${calls.length}` });
    return new Response(body, { status });
  };
  return { fn, calls };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hps-upl-"));

// ─── 스캔 — 완결 세션만, 마커/현재세션/형식불량 제외 ────────────────────────
{
  const root = tmp();
  const ok = makeSession(root, "2026-08-18", SID);
  makeSession(root, "2026-08-18", SID2, { uploaded: true });          // 이미 업로드됨
  const current = makeSession(root, "2026-08-19", "cccccccc-dddd-4eee-8fff-000000000000");
  fs.mkdirSync(path.join(root, "2026-08-18", "not-a-uuid"), { recursive: true }); // 형식 불량
  fs.mkdirSync(path.join(root, "junk", SID), { recursive: true });                // 날짜 아님
  const found = scanUploadableSessions(root, { currentSessionDir: current });
  assert.deepEqual(found.map((s) => s.dir), [ok]);
  assert.equal(found[0].day, "2026-08-18");
  assert.equal(found[0].sessionId, SID);
  console.log("✓ 스캔 — 마커·현재세션·형식불량 제외");
}

// ─── 정지 게이트 — 방금 쓰인 세션(다른 창의 활성 세션)은 건너뛴다 ────────────
// (1회차 리뷰 F2: 살아있는 세션을 올리면 거짓 manifest + 마커로 꼬리 유실)
{
  const root = tmp();
  const live = makeSession(root, "2026-08-19", SID, { fresh: true });   // 방금 mtime
  makeSession(root, "2026-08-18", SID2);                                // 정지됨
  const found = scanUploadableSessions(root);
  assert.deepEqual(found.map((s) => s.sessionId), [SID2], "fresh 세션은 스캔에서 제외");
  // 봉인된 세션은 allowFresh 로 면제 — 수업 끝 직후 오늘 세션이 올라가는 경로.
  const withSealed = scanUploadableSessions(root, { allowFresh: [live] });
  assert.deepEqual(withSealed.map((s) => s.sessionId).sort(), [SID, SID2].sort());
  console.log("✓ 정지 게이트 — fresh 제외, 봉인(allowFresh)은 면제");
}

// ─── 양성 — 업로드 순서: meta → events → manifest(마지막), 마커 생성 ─────────
{
  const root = tmp();
  const dir = makeSession(root, "2026-08-18", SID, { events: "line1\nline2\n" });
  const { fn, calls } = fakeFetch();
  const r = await uploadSession({
    session: { dir, day: "2026-08-18", sessionId: SID },
    baseUrl: "https://api.test/v1", token: "tok.sig", fetchFn: fn, now: FIXED_NOW,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      `https://api.test/v1/logs/${SID}/session.meta.json?day=2026-08-18`,
      `https://api.test/v1/logs/${SID}/events.jsonl?day=2026-08-18`,
      `https://api.test/v1/logs/${SID}/manifest.json?day=2026-08-18`,
    ],
    "meta → events → manifest 순서 — manifest 가 마지막",
  );
  assert.equal(calls[0].auth, "Bearer tok.sig");
  assert.deepEqual(r.keys, ["k-1", "k-2", "k-3"]);
  // 마커가 생겼고, 다시 스캔하면 안 잡힌다.
  assert.ok(fs.existsSync(path.join(dir, UPLOADED_MARKER)));
  assert.deepEqual(scanUploadableSessions(root), []);
  // manifest 내용 검증 — sha256 이 실제 바이트의 해시.
  const manifest = JSON.parse(Buffer.from(calls[2].body).toString("utf8"));
  const eventsEntry = manifest.files.find((f) => f.name === "events.jsonl");
  assert.equal(eventsEntry.sha256, createHash("sha256").update("line1\nline2\n").digest("hex"));
  assert.equal(eventsEntry.bytes, Buffer.byteLength("line1\nline2\n"));
  assert.equal(manifest.session_id, SID);
  console.log("✓ 양성 — 순서·마커·manifest sha256");
}

// ─── 음성 — 중간 실패: manifest 미전송, 마커 없음 → 재시도 대상으로 남는다 ───
{
  const root = tmp();
  const dir = makeSession(root, "2026-08-18", SID);
  const { fn, calls } = fakeFetch((call, n) =>
    n === 2 ? { status: 503, body: '{"error":{"message":"upstream busy"}}' } : { status: 200 },
  );
  const r = await uploadSession({
    session: { dir, day: "2026-08-18", sessionId: SID },
    baseUrl: "https://api.test/v1", token: "t.s", fetchFn: fn, now: FIXED_NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.failedAt, "events.jsonl");
  assert.equal(r.status, 503);
  assert.equal(r.message, "upstream busy");
  assert.equal(calls.length, 2, "실패 지점에서 멈춘다 — manifest 는 안 나갔다");
  assert.ok(!fs.existsSync(path.join(dir, UPLOADED_MARKER)), "마커 없음");
  assert.equal(scanUploadableSessions(root).length, 1, "다음 트리거의 재시도 대상으로 남는다");
  console.log("✓ 음성 — 중간 실패 시 manifest·마커 없음 (미완결 유지)");
}

// ─── 음성 — 네트워크 예외도 구조화 실패로 (throw 전파 없음) ─────────────────
{
  const root = tmp();
  const dir = makeSession(root, "2026-08-18", SID);
  const fn = async () => { throw new Error("ECONNREFUSED"); };
  const r = await uploadSession({
    session: { dir, day: "2026-08-18", sessionId: SID },
    baseUrl: "https://api.test/v1", token: "t.s", fetchFn: fn, now: FIXED_NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.match(r.message, /ECONNREFUSED/);
  console.log("✓ 음성 — 네트워크 예외 → 구조화 실패 반환");
}

// ─── uploadAllPending — 하나 실패해도 나머지는 계속 ─────────────────────────
{
  const root = tmp();
  makeSession(root, "2026-08-17", SID);
  makeSession(root, "2026-08-18", SID2);
  let failedOnce = false;
  const { fn } = fakeFetch((call) => {
    if (call.url.includes(SID) && !failedOnce) { failedOnce = true; return { status: 500, body: "{}" }; }
    return { status: 200 };
  });
  const results = await uploadAllPending(root, {
    baseUrl: "https://api.test/v1", token: "t.s", fetchFn: fn, now: FIXED_NOW,
  });
  assert.equal(results.length, 2);
  assert.equal(results.filter((r) => r.ok).length, 1, "실패 1 + 성공 1 — 중단 없이 계속");
  console.log("✓ uploadAllPending — 부분 실패에도 나머지 진행");
}

// ─── buildManifest — meta 없는 세션(쓰기 실패 케이스)도 성립 ─────────────────
{
  const root = tmp();
  const dir = makeSession(root, "2026-08-18", SID, { meta: false });
  const { manifest } = buildManifest(dir, ["events.jsonl"], FIXED_NOW);
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.created_at, FIXED_NOW().toISOString());
  console.log("✓ buildManifest — 존재 파일만으로 성립");
}

console.log("spool-uploader.smoke.mjs — all green");

// ─── fs 소실 — 스캔과 읽기 사이 삭제는 구조화 실패 (throw 전파 없음) ─────────
{
  const root = tmp();
  const dir = makeSession(root, "2026-08-18", SID);
  const [session] = scanUploadableSessions(root);
  fs.rmSync(path.join(dir, "events.jsonl")); // 다른 창의 스윕이 지운 상황
  const { fn, calls } = fakeFetch();
  const r = await uploadSession({
    session, baseUrl: "https://api.test/v1", token: "t.s", fetchFn: fn, now: FIXED_NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.failedAt, "read");
  assert.match(r.message, /events\.jsonl missing/);
  assert.equal(calls.length, 0, "빈 manifest 로 '완결'을 주장하지 않는다");
  assert.ok(!fs.existsSync(path.join(dir, UPLOADED_MARKER)));
  console.log("✓ fs 소실 — 구조화 실패, 거짓 완결 없음");
}

// ─── N2 — 신원 필터: 이 토큰 주인의 세션만 (공용 PC 교차 업로드 방지) ─────────
{
  const root = tmp();
  const mine = makeSession(root, "2026-08-18", SID, { metaUser: { u: "kidA", c: "co" } });
  makeSession(root, "2026-08-17", SID2, { metaUser: { u: "kidB", c: "co" } });          // 남의 것
  makeSession(root, "2026-08-16", "dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb", { metaUser: null }); // 익명
  const all = scanUploadableSessions(root);
  assert.equal(all.length, 3, "필터 없으면 전부");
  const filtered = scanUploadableSessions(root, { identity: { u: "kidA", c: "co" } });
  assert.deepEqual(filtered.map((s) => s.dir), [mine], "신원 일치분만 — 남의 것·익명(user:null) 제외");
  console.log("✓ N2 — 신원 필터: 남의 세션·익명 세션은 이 토큰으로 올리지 않는다");
}

// ─── N1 — 업로드 중 events 가 자라면 마커를 쓰지 않는다 (꼬리 유실 방지) ──────
{
  const root = tmp();
  const dir = makeSession(root, "2026-08-18", SID, { events: "e1\n" });
  const { fn } = fakeFetch((call, n) => {
    if (n === 3) {
      // manifest PUT 도착 시점 = 업로드 도중 — 피닝된 늦은 턴이 append 한 상황.
      fs.appendFileSync(path.join(dir, "events.jsonl"), "late-tail\n");
    }
    return { status: 200 };
  });
  const r = await uploadSession({
    session: { dir, day: "2026-08-18", sessionId: SID },
    baseUrl: "https://api.test/v1", token: "t.s", fetchFn: fn, now: FIXED_NOW,
  });
  assert.equal(r.ok, true, "R2 전송 자체는 성공");
  assert.ok(!fs.existsSync(path.join(dir, UPLOADED_MARKER)), "크기 불일치 → 마커 미작성");
  assert.match(r.message, /grew during upload/);
  // 방금 자란 세션은 정지 게이트가 (올바르게) 잠시 숨긴다 — 마커가 없으므로
  // 게이트가 풀리는 다음 트리거에서 다시 잡힌다. allowFresh 로 그걸 실증.
  assert.equal(scanUploadableSessions(root).length, 0, "정지 게이트가 즉시 재잡기는 막는다");
  assert.equal(
    scanUploadableSessions(root, { allowFresh: [dir] }).length, 1,
    "마커가 없어 pending — 게이트만 풀리면 꼬리까지 다시 올라간다",
  );
  console.log("✓ N1 — 업로드 중 성장 감지 → 마커 보류, 재업로드 예약");
}
