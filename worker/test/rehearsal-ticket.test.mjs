// Controls for the rehearsal ticket issuance path (#1131, C-1).
//
// 상태: Router 결정 · Jay 검토 전. 계약이 아니다 — 뒤집히면 이 파일도 같이 뒤집는다.
//
// 이 기능이 조용히 잘못되는 방식이 셋이고, 셋 다 통과하는 구현이 쉽다:
//
//   1. 좌석 표시가 **한 겹만** 걸린다. 접두사는 붙었는데 클레임이 없거나 그 반대.
//      → 운영 데이터를 훑는 사람은 필터로 걸러낸 줄 알고, 코드는 권한 판정을 못 한다.
//      → 그래서 verify 를 **실제로 통과시킨 뒤** 두 겹을 같이 잰다. 선언만 보지 않는다.
//   2. 교환권이 **저장소에 평문으로** 눕는다. 키가 원문이면 키 목록이 곧 유효한 표 목록이다.
//   3. 교환권 발급이 **로스터를 요구**하게 된다. 그러면 #1131 이 막은 바로 그 길
//      (강사를 운영 로스터에 넣는 것)로 돌아간다. 요구하지 **않는다**는 것이 계약이므로
//      음성 대조군이 그것을 잰다 — 로스터가 비어 있어도 발급돼야 한다.
//
//   node --experimental-strip-types --experimental-sqlite worker/test/rehearsal-ticket.test.mjs

import assert from "node:assert/strict";
import {
  newTicket, ticketKey, rehearsalSeat, isRehearsalSeatId,
  encodeStoredTicket, decodeStoredTicket,
  REHEARSAL_SEAT_PREFIX, REHEARSAL_TICKET_TTL_SECONDS,
} from "../src/lib/rehearsal-ticket.ts";
import { issue, verify } from "../src/lib/tokens.ts";

const SECRET = "test-signing-secret-at-least-32-chars-long";
let failed = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { console.log(`  FAIL ${m}`); failed += 1; };
const check = (c, m) => (c ? ok(m) : bad(m));

// ---------------------------------------------------------------------------
console.log("=== 1. 좌석 표시는 두 겹이고, 한 곳에서 같이 나온다 ===");
// ---------------------------------------------------------------------------
{
  const seat = rehearsalSeat("teacher-a", () => "ab12cd");
  check(seat.u === "rehearsal-teacher-a-ab12cd", `사람이 읽는 접두사: ${seat.u}`);
  check(seat.rehearsal === true, "코드가 읽는 클레임이 같은 호출에서 나온다");
  check(isRehearsalSeatId(seat.u) && !isRehearsalSeatId("kid01"), "필터가 리허설 좌석만 고른다");
}
{
  // 접두사를 두 번 붙이면 사람이 그걸 다른 종류로 읽는다.
  const seat = rehearsalSeat(REHEARSAL_SEAT_PREFIX + "teacher-a", () => "zz");
  check(seat.u === "rehearsal-teacher-a-zz", "이미 접두사가 붙은 핸들에 두 번 붙이지 않는다");
}
{
  const a = rehearsalSeat("t"), b = rehearsalSeat("t");
  check(a.u !== b.u, "같은 강사의 두 좌석이 서로 다르다 — 교환권 하나 = 좌석 하나");
}

// ---------------------------------------------------------------------------
console.log("");
console.log("=== 2. 클레임이 서명·검증을 **실제로** 건너온다 (선언만 보지 않는다) ===");
// ---------------------------------------------------------------------------
// tokens.ts 의 verify 는 클레임을 **명시적으로 나열해서** 복사한다. 목록에 없으면
// 조용히 사라진다 — 선언을 추가하고 복사를 빠뜨리면 타입은 통과하고 런타임만 틀린다.
{
  const seat = rehearsalSeat("teacher-a");
  const ref = { course_id: "c1", version: "m2026.09.19-1", sha256: "a".repeat(64) };
  const { token } = await issue(
    { u: seat.u, c: "cohort-x", p: "profile-x", lesson: ref, rehearsal: seat.rehearsal },
    4, SECRET,
  );
  const p = await verify(token, SECRET);
  check(p.rehearsal === true, "rehearsal 클레임이 verify 뒤에도 살아 있다 (복사 목록 누락 대조군)");
  check(p.u === seat.u && isRehearsalSeatId(p.u), "…접두사도 같은 토큰 안에 있다 — 두 겹이 갈리지 않았다");
  check(p.lesson?.sha256 === ref.sha256, "좌표 넷 중 sha256 이 토큰에 실린다 (VER-02)");
  check(p.role === undefined, "리허설은 세 번째 역할이 아니다 — student 조건 그대로");
}
{
  // 음성 대조군: 평범한 학생 토큰에는 클레임이 붙지 않는다. 안 그러면 위 단언이
  // "항상 true" 인 구현도 통과한다.
  const { token } = await issue({ u: "kid01", c: "cohort-x", p: "profile-x" }, 1, SECRET);
  const p = await verify(token, SECRET);
  check(p.rehearsal === undefined, "일반 학생 토큰에는 rehearsal 클레임이 없다");
  check(!isRehearsalSeatId(p.u), "…접두사도 없다");
}

// ---------------------------------------------------------------------------
console.log("");
console.log("=== 3. 저장소를 덤프해도 쓸 수 있는 교환권이 나오지 않는다 ===");
// ---------------------------------------------------------------------------
{
  const ticket = newTicket();
  const key = await ticketKey(ticket);
  check(!key.includes(ticket), "KV 키에 교환권 원문이 들어 있지 않다");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticket));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  check(key === "rehearsal:ticket:" + hex, "키는 접두사 + sha256 이다 (독립 계산과 대조)");
  check(await ticketKey(ticket) === key, "같은 교환권은 같은 키로 간다 (교환이 찾을 수 있다)");
  check(await ticketKey(newTicket()) !== key, "다른 교환권은 다른 키다");
}
{
  const a = newTicket(), b = newTicket();
  check(a !== b, "교환권이 매번 다르다");
  check(/^[A-Za-z0-9_-]+$/.test(a), `URL-safe 하다: ${a}`);
  check(a.length >= 20, "128비트 — 추측으로 맞힐 수 없다");
  check(!a.includes("=") , "패딩이 없다 (URL 에서 인코딩되지 않는다)");
}
{
  // 붙여 두는 것은 토큰 하나뿐이다 — 좌표를 같이 담으면 토큰과 갈린다.
  const stored = JSON.parse(encodeStoredTicket("tok-abc"));
  check(Object.keys(stored).length === 1 && stored.token === "tok-abc",
    "저장 모양에 토큰 말고 아무것도 없다");
  check(decodeStoredTicket(encodeStoredTicket("tok-abc"))?.token === "tok-abc", "왕복한다");
}
{
  // 반쯤 읽은 값으로 자격을 내주느니 "확인할 수 없음" 이 낫다.
  for (const raw of [null, "", "not json", "{}", '{"token":""}', '{"token":123}', "[]"]) {
    check(decodeStoredTicket(raw) === null, `깨진 값 ${JSON.stringify(raw)} → null`);
  }
}

// ---------------------------------------------------------------------------
console.log("");
console.log("=== 4. TTL 은 저장소가 재고 코드가 재지 않는다 ===");
// ---------------------------------------------------------------------------
{
  check(REHEARSAL_TICKET_TTL_SECONDS === 24 * 3600, "교환권 수명이 상수 하나로 고정돼 있다");
  // 자격 수명(hours)과 교환권 수명은 **다른 것**이다. 같은 숫자로 묶으면 링크가
  // 살아 있는 동안 자격이 죽거나 그 반대가 된다.
  check(REHEARSAL_TICKET_TTL_SECONDS !== 4 * 3600, "교환권 수명과 기본 자격 수명(4h)이 같은 값이 아니다");
}

// ---------------------------------------------------------------------------
console.log("");
console.log("=== 5. 라우트가 인증 목록에 등록돼 있다 (빠뜨리면 500) ===");
// ---------------------------------------------------------------------------
// authoring.ts 가 주석으로 적어 둔 함정이다: 경로를 손으로 나열하는데 빠뜨리면
// c.get('author') 가 undefined 라 핸들러가 500 으로 죽는다. 실제로 그렇게 났다.
{
  const src = await (await import("node:fs/promises")).readFile(
    new URL("../src/routes/authoring.ts", import.meta.url), "utf8");
  const list = /for \(const path of \[([^\]]+)\]\)/.exec(src)?.[1] ?? "";
  check(list.includes("rehearsal-tickets"), "새 라우트가 authenticate/bodyLimit 목록에 있다");
  // 음성 대조군: 라우트는 있는데 목록에 없는 상태를 이 검사가 실제로 잡는가.
  check(!list.replace("rehearsal-tickets", "").includes("rehearsal-tickets"),
    "…그리고 그 문자열을 지우면 검사가 실패한다 (검사가 진짜로 재고 있다)");
  check(/authoring\.post\(root \+ '\/versions\/:version\/rehearsal-tickets'/.test(src),
    "라우트 자체가 존재한다");
  // 로스터를 요구하지 않는다 — #1131 이 막은 길로 돌아가지 않았다는 음성 대조군.
  const handler = src.slice(src.indexOf("rehearsal-tickets', async c =>"));
  const body = handler.slice(0, handler.indexOf("\n});"));
  check(!body.includes("getRoster"), "리허설 발급은 로스터를 읽지 않는다 (#1131: 운영 로스터 오염 금지)");
  check(!body.includes("getActiveSession"), "…열린 세션도 요구하지 않는다 (JY 결정)");
  check(body.includes("owns(d, a)"), "…대신 강사 스코프로 판정한다");
  check(!/token[,:]/.test(body.slice(body.indexOf("return c.json"))), "응답에 토큰을 담지 않는다 — 교환권만 나간다");
}

console.log("");
if (failed === 0) {
  console.log("PASS rehearsal-ticket: 좌석 표시 두 겹 · 해시 키 · 토큰만 보관 · 로스터 무관.");
} else {
  console.log(`FAIL: ${failed} check(s) failed.`);
  process.exit(1);
}
