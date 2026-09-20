// #1205 — 리허설 진입/복귀의 클라이언트 불변식.
//
// 이 파일이 고정하는 것은 하나다: **리허설 중 나가는 요청이 좌석 토큰을 싣고
// issuer 를 안 싣는다.** 집행은 서버가 한다(양방향, `#1188` + chat-gate) — 여기는
// 클라이언트가 실수하지 않는 것을 잡는다.
//
// ⚠️ 통과 쪽으로 틀리기 쉬운 자리라 **대조군을 먼저 세운다.**
// "issuer 를 안 실었다" 는 **아무 요청도 안 나갔을 때도 참**이다. 그래서 헤더를
// 재기 전에 **요청이 실제로 나갔는지**부터 단언한다. 81 이 서버 쪽 통함 시험에
// 같은 형태를 넣었고(§0 대조군), 같은 이유다.

import assert from "node:assert/strict";
import fs from "node:fs";

const H = await import("../src/rehearsalSessionHelpers.ts");
const E = await import("../src/rehearsalEntryHelpers.ts");

const REF = { cohort: "boah-dental-2026-a", course: "dental-home", version: "m2026.09.21-1" };
const ISSUER = "issuer-token-value";
const SEAT = "seat-token-value";
const TICKET = "Ab3-_dEfGhIjKlMnOp";

/** 나가는 요청을 전부 받아 적는 가짜 fetch. 모양까지 검사하려고 응답을 직접 만든다. */
function recorder(responder) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responder(String(url), init ?? {});
  };
  return { calls, impl };
}
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
/** 헤더를 대소문자 무시하고 읽는다 — 이걸 안 하면 `Authorization` 을 놓친다. */
const headerOf = (init, name) => {
  const h = init.headers ?? {};
  for (const k of Object.keys(h)) if (k.toLowerCase() === name.toLowerCase()) return h[k];
  return undefined;
};

// ─── 경로와 모양 ──────────────────────────────────────────────────────
{
  assert.equal(
    H.ticketPath(REF),
    "/v1/authoring/boah-dental-2026-a/dental-home/versions/m2026.09.21-1/rehearsal-tickets",
  );
  // 좌표에 슬래시가 들어와도 경로를 쪼개지 못한다.
  assert.ok(!H.ticketPath({ ...REF, course: "a/b" }).includes("a/b"));
  console.log("✅ ticketPath: #1164 의 경로 · 좌표는 인코딩된다");
}

// ─── 대조군 먼저: 요청이 실제로 나가는가 ──────────────────────────────
{
  const rec = recorder(() => json(200, { ticket: TICKET, expires_at: 123 }));
  const out = await H.requestRehearsalTicket({
    proxyUrl: "https://api.example.test/v1", issuerToken: ISSUER, ref: REF, fetchImpl: rec.impl,
  });
  assert.equal(out.ok, true);
  // 대조군 — 이게 0이면 아래 헤더 단언은 전부 공짜로 통과한다.
  assert.equal(rec.calls.length, 1, "발급 요청이 나가지 않았다 — 아래 단언이 헛돈다");
  assert.equal(rec.calls[0].init.method, "POST");
  assert.equal(
    rec.calls[0].url,
    "https://api.example.test/v1/authoring/boah-dental-2026-a/dental-home/versions/m2026.09.21-1/rehearsal-tickets",
  );
  console.log("✅ 발급: POST 1건이 실제로 나간다 (대조군)");
}

// ─── 세 구간의 자격 — 81 과 합의한 표 ─────────────────────────────────
{
  // ① 교환권 받기 = 저작 API → issuer Bearer
  const t = recorder(() => json(200, { ticket: TICKET }));
  await H.requestRehearsalTicket({
    proxyUrl: "https://api.example.test/v1", issuerToken: ISSUER, ref: REF, fetchImpl: t.impl,
  });
  assert.equal(headerOf(t.calls[0].init, "authorization"), `Bearer ${ISSUER}`);

  // ② 교환 = 인증 헤더 없음. 교환권 자체가 자격증명이다.
  const r = recorder(() => json(200, { token: SEAT, seat: "rehearsal-x", expires_at: 9 }));
  const red = await E.redeemRehearsalTicket({
    proxyUrl: "https://api.example.test/v1", ticket: TICKET, fetchImpl: r.impl,
  });
  assert.equal(red.ok, true);
  assert.equal(r.calls.length, 1, "교환 요청이 나가지 않았다");
  assert.equal(r.calls[0].url, "https://api.example.test/v1/rehearsal/redeem");
  assert.equal(headerOf(r.calls[0].init, "authorization"), undefined,
    "교환에 Authorization 을 실으면 ARC-02 가 막으려던 것이 되살아난다");
  // 교환권은 본문에만 — URL 에 흔적이 없어야 한다.
  assert.ok(!r.calls[0].url.includes(TICKET), "교환권이 URL 에 실렸다");
  assert.deepEqual(JSON.parse(r.calls[0].init.body), { ticket: TICKET });

  // ③ 그 뒤 채팅·도구 = 좌석 토큰
  let s = H.begin(REF, { token: "previous-student-token" });
  s = H.activate(s, SEAT, "rehearsal-x");
  assert.equal(H.rehearsalAuthToken(s), SEAT);
  assert.notEqual(H.rehearsalAuthToken(s), ISSUER);
  console.log("✅ 세 구간의 자격: issuer → 없음 → 좌석 토큰");
}

// ─── 헤더 조립기 자체 ─────────────────────────────────────────────────
{
  assert.equal(H.redeemRequestHeaders().authorization, undefined);
  assert.deepEqual(Object.keys(H.redeemRequestHeaders()), ["content-type"]);
  assert.equal(H.ticketRequestHeaders(ISSUER).authorization, `Bearer ${ISSUER}`);
  console.log("✅ redeemRequestHeaders 에는 authorization 이 없다");
}

// ─── 상태기계: 돌아올 자리를 잃지 않는다 ──────────────────────────────
{
  const prev = { token: "previous-student-token" };
  let s = H.IDLE;
  assert.equal(H.isRehearsing(s), false);
  assert.equal(H.rehearsalAuthToken(s), undefined);

  s = H.begin(REF, prev);
  assert.equal(s.phase, "starting");
  assert.equal(H.isRehearsing(s), false, "교환 전에는 리허설 중이 아니다");
  assert.equal(H.rehearsalAuthToken(s), undefined, "좌석이 없는데 자격을 내면 안 된다");

  // 교환이 실패해도 돌아갈 자리가 남는다 — 실패 후 어정쩡한 상태가 제일 나쁘다.
  const failed = H.abort(s);
  assert.equal(failed.phase, "returning");
  assert.deepEqual(failed.previous, prev);

  s = H.activate(s, SEAT);
  assert.equal(H.isRehearsing(s), true);
  const done = H.finish(s);
  assert.equal(done.phase, "returning");
  assert.deepEqual(done.previous, prev, "돌아갈 자리가 리허설을 지나 살아남아야 한다");
  assert.equal(H.isRehearsing(H.settled()), false);

  // 붙어 있던 곳이 없던 경우도 복원할 상태다.
  assert.deepEqual(H.finish(H.activate(H.begin(REF, {}), SEAT)).previous, {});
  console.log("✅ 상태기계: 실패·성공 양쪽에서 돌아갈 자리가 남는다");
}

// ─── 순서를 건너뛰면 좌석이 생기지 않는다 ─────────────────────────────
{
  // idle 에서 바로 activate 하면 무시된다 — 좌석은 교환을 통해서만 생긴다.
  assert.equal(H.activate(H.IDLE, SEAT).phase, "idle");
  assert.equal(H.rehearsalAuthToken(H.activate(H.IDLE, SEAT)), undefined);
  console.log("✅ 교환을 건너뛰고 좌석을 손에 쥘 수 없다");
}

// ─── 실패 분류: 81 의 표 그대로 ───────────────────────────────────────
{
  const cases = [
    [400, { error: "malformed_ticket" }, "server"],
    [410, { error: "not_found" }, "not_found"],
    [410, { error: "ticket_expired" }, "expired"],
    [409, { error: "content_changed" }, "content_changed"],
    [409, { error: "already_used" }, "already_used"],
  ];
  for (const [status, body, expected] of cases) {
    assert.equal(E.classifyRedeemFailure(status, JSON.stringify(body)).code, expected,
      `${status} ${JSON.stringify(body)}`);
  }
  // 라우트가 없는 배포: error 가 **객체**라 문자열 분기에 안 걸리고 unsupported 가 된다.
  assert.equal(
    E.classifyRedeemFailure(404, JSON.stringify({ error: { type: "not_found" } })).code,
    "unsupported",
    "구버전 앱 감지가 깨지면 강사가 멀쩡한 링크를 버리고 새로 만들러 간다",
  );
  console.log("✅ 실패 분류 6건 — 81 의 서버 표와 일치");
}

// ─── 앱이 "이미 냈다" 고 스스로 판단해 막지 않는다 ────────────────────
{
  // 멱등 창(120초) 안의 재제출은 서버가 **같은 토큰**으로 200 을 준다. 앱이 미리
  // 걸러 버리면 같은 판정이 두 곳에 생기고 둘이 갈린다 (ARC-01).
  let n = 0;
  const rec = recorder(() => { n++; return json(200, { token: SEAT }); });
  for (let i = 0; i < 2; i++) {
    const out = await E.redeemRehearsalTicket({
      proxyUrl: "https://api.example.test/v1", ticket: TICKET, fetchImpl: rec.impl,
    });
    assert.equal(out.ok, true);
    assert.equal(out.token, SEAT);
  }
  assert.equal(n, 2, "두 번째 교환을 앱이 스스로 막았다 — 판정은 서버 몫이다");
  console.log("✅ 재제출을 앱이 가로막지 않는다 (판정은 서버)");
}

// ─── 구조 불변식: 채팅 경로는 issuer 키를 읽지 않는다 ─────────────────
{
  // 이것이 "issuer 를 안 싣는다" 의 진짜 근거다. 매번 지키는 규율이 아니라 구조다:
  // 채팅·도구는 참여 자격 키 하나에서만 토큰을 읽고, issuer 는 다른 키에 있다.
  const dir = new URL("../src/", import.meta.url);
  const readers = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(new URL(d, dir), { withFileTypes: true })) {
      if (e.isDirectory()) { walk(`${d}${e.name}/`); continue; }
      if (!/\.ts$/.test(e.name)) continue;
      const body = fs.readFileSync(new URL(`${d}${e.name}`, dir), "utf8");
      if (/ISSUER_TOKEN_KEY/.test(body)) readers.push(`${d}${e.name}`);
    }
  };
  walk("");
  // issuer 키를 읽어도 되는 곳과 **각각의 이유**. 숫자만 적어 두면 다음 사람이
  // 숫자를 고치고 지나간다 — 6번째가 정당한지 판단하려면 앞의 다섯이 왜 정당한지
  // 읽을 수 있어야 한다.
  const ALLOWED = {
    "mintStudentTokenHelpers.ts": "키를 선언하는 곳",
    "mintStudentToken.ts": "강사가 학생 토큰을 발급하는 흐름 — 저작 권한이 맞다",
    "extension.ts": "위 명령을 등록하고 '지우기' 를 처리한다",
    "chalkSurface.ts": "강사 면을 보일지 정하는 게이트(표시 전용, 집행은 서버)",
    "rehearsalSession.ts": "리허설 교환권을 받는 저작 호출 — 교환 자체는 무인증이다",
  };
  const unexpected = readers.filter((f) => !(f in ALLOWED));
  assert.deepEqual(unexpected, [],
    `issuer 키를 읽는 새 파일: ${unexpected.join(", ")}\n` +
    `여기 추가하려면 그 파일이 **저작 권한으로 부르는 곳**인지 먼저 답해라. ` +
    `채팅·도구·프록시 경로라면 답은 아니오다 — 좌석 토큰은 참여 자격 키에서 온다.\n` +
    `현재 허용: ${Object.entries(ALLOWED).map(([f, why]) => `${f}(${why})`).join(" · ")}`);
  const missing = Object.keys(ALLOWED).filter((f) => !readers.includes(f));
  assert.deepEqual(missing, [],
    `허용 목록에 있는데 더 이상 읽지 않는 파일: ${missing.join(", ")} — 목록을 줄여라`);
  for (const f of ["proxyClient.ts", "proxyClientHelpers.ts", "chatPanelProvider.ts", "sdkCoach.ts"]) {
    assert.ok(!readers.includes(f), `${f} 가 issuer 키를 읽는다 — 채팅 경로에 issuer 가 샌다`);
  }
  console.log(`✅ issuer 키를 읽는 파일 ${readers.length}개 — 채팅·도구 경로는 없다`);
}

// ─── 매니페스트 ───────────────────────────────────────────────────────
{
  const m = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const declared = new Set(m.contributes.commands.map((c) => c.command));
  for (const c of ["hypeproof-chat.chalk.startRehearsal", "hypeproof-chat.chalk.endRehearsal"]) {
    assert.ok(declared.has(c), `${c} 미선언`);
  }
  const pal = Object.fromEntries(m.contributes.menus.commandPalette.map((e) => [e.command, e.when]));
  assert.equal(pal["hypeproof-chat.chalk.startRehearsal"], "hypeproof-chat.canAuthor");
  // 끝내기는 리허설 중일 때만 — 안 돌 때 보이면 눌러도 아무 일이 안 난다.
  assert.equal(pal["hypeproof-chat.chalk.endRehearsal"], "hypeproof-chat.rehearsing");
  // 명령 id 에 `<viewId>.focus` 를 다시 만들지 않는다 (#1204 에서 밟았다).
  const viewIds = m.contributes.views["hypeproof-chat"].map((v) => v.id);
  for (const c of declared) {
    for (const v of viewIds) assert.notEqual(c, `${v}.focus`, `${c} 가 VS Code 내장 id 를 가린다`);
  }
  // 리허설 행동이 면에 실제로 있다.
  assert.equal(m.dependencies, undefined, "런타임 의존성 추가 금지 (Dev 런처 하드 거부)");
  console.log("✅ 매니페스트: 명령 2개 · when 절 · viewId.focus 재충돌 없음");
}

// ─── 면의 행동 목록 ───────────────────────────────────────────────────
{
  const S = await import("../src/chalkSurfaceHelpers.ts");
  const start = S.CHALK_ACTIONS.find((a) => a.command === "hypeproof-chat.chalk.startRehearsal");
  assert.ok(start, "리허설 시작이 강사 면에 없다 — 이 이슈가 만드는 자리다");
  assert.ok(!/[./]/.test(start.icon), "codicon 이 아니다 (media/ 는 Dev 런처가 복사 안 한다)");
  console.log("✅ 강사 면에 '학생 조건으로 리허설' 이 있다");
}
