// #1205 — 강사가 진짜 앱에서 리허설을 시작하고, 학생 조건으로 들어가고, 돌아오는가.
//
// 이 파일이 재는 것은 **앱이 실제로 내보낸 요청**이다. 스텁 서버가 곧 관측점이라
// "좌석 토큰을 싣는다"를 모형이 아니라 전선에서 읽는다.
//
// ⚠️ 통과 쪽으로 틀리기 쉬운 자리 둘을 먼저 막았다:
//   1. "issuer 를 안 실었다" 는 **아무 요청도 안 나갔을 때도 참**이다.
//      → 헤더를 보기 전에 **전환이 실제로 일어났는지**(좌석 토큰으로 프로필을
//        가져갔는지)를 대조군으로 단언한다. 81 이 서버 쪽 §0 에 넣은 것과 같은 형태다.
//   2. mock `/v1/profile` 에 `activity_id`(64 hex)가 없으면 `commit()` 이 거절해
//      창이 진입 화면에 멈추고, 그 상태가 조용히 "확인됨"으로 통과한다.
//      → #1204 에서 실제로 밟았다. 여기서는 처음부터 넣는다.
//
// 서버는 스텁이다. 계약은 짐작하지 않고 81 의 실제 코드
// (`worker/src/routes/rehearsal.ts`, `feat/1189-rehearsal-entry-survey`)를 읽어서 맞췄다:
//   POST /v1/authoring/:c/:course/versions/:v/rehearsal-tickets  → issuer Bearer, {ticket}
//   POST /v1/rehearsal/redeem  → **인증 헤더 없음**, {ticket} → {token,seat,lesson,expires_at}
// 이 브랜치 diff 에 worker 변경은 0건이므로 `wrangler dev` 짝을 주장하지 않는다.
//
//   HPS_APP_PATH='/path/to/HypeProof Studio Dev.app' node rehearsal-surface/run.mjs

import { _electron as electron } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "../test-results/rehearsal-surface");
fs.mkdirSync(out, { recursive: true });

const appRoot = process.env.HPS_APP_PATH?.trim();
if (!appRoot) throw new Error("HPS_APP_PATH must point at the .app to drive");
const APP = appRoot.includes("/Contents/MacOS/")
  ? appRoot : path.join(appRoot, "Contents/MacOS/HypeProof Studio");

/**
 * 짝 실행 모드. `HPS_PAIR_UPSTREAM` 이 있으면 로컬 서버는 **스텁이 아니라 기록하는
 * 중계기**가 된다 — 진짜 worker 로 그대로 넘기고 오가는 것을 적는다.
 *
 * 왜 필요한가: 스텁은 **내가 기대하는 서버**를 흉내내므로 내 오해까지 같이
 * 흉내낸다. 실제로 그랬다 — 교환권 발급 경로를 `/v1/authoring/...` 로 잘못 알고
 * 있었는데 스텁이 느슨하게 맞춰 받아 줬고, 실물(`/admin/cohorts/...`)에 물려 보고서야
 * 드러났다. 81 쪽에서도 같은 방향으로 결함이 하나 나왔다(리허설 좌석의 `/v1/profile`
 * 이 403 이었는데 채팅 한 표면만 재고 있어서 초록이었다).
 *
 * 중계기로 두면 **행동은 진짜 서버가 정하고 관측은 내가** 한다. 어긋나면 빨개진다.
 */
const UPSTREAM = process.env.HPS_PAIR_UPSTREAM?.replace(/\/$/, "");

// ⚠️ 만료 시각을 쓰게 되면 **`credential_expires_at` 만** 읽어라. `expires_at` 은
// 발급 응답에서는 **교환권**(24h) 수명이고 교환 응답에서는 **좌석** 수명이라
// 읽는 위치에 따라 뜻이 바뀐다 — 같은 이름으로 읽으면 이미 죽은 좌석을 24시간
// 살아 있다고 띄운다. 81 이 재서 잡았고 두 응답 모두에 `credential_expires_at` 을
// 넣어 뒀다(`f7cce6f`). 지금 이 파일은 만료를 쓰지 않는다.
const COHORT = process.env.HPS_PAIR_COHORT || "boah-dental-2026-a";
const COURSE = process.env.HPS_PAIR_COURSE || "dental-home";
const VERSION = process.env.HPS_PAIR_VERSION || "m2026.09.21-1";
const PROFILE = "boah-dental-teaser-2026-s1";
const TICKET = "Ab3-_dEfGhIjKlMnOpQr";

const mint = (p) => Buffer.from(JSON.stringify(p)).toString("base64url") + ".devsig";
const EXP = Math.floor(Date.now() / 1000) + 86_400;
// 짝 실행에서는 **서명된 진짜 토큰**을 쓴다. 합성 토큰은 실물 worker 가 401 로 거절한다.
const STUDENT = process.env.HPS_PAIR_STUDENT_TOKEN
  || mint({ u: "student-01", c: COHORT, p: PROFILE, exp: EXP });
const ISSUER = process.env.HPS_PAIR_ISSUER_TOKEN
  || mint({ role: "issuer", c: "__issuer__", p: "__issuer__", exp: EXP,
            scopes: [{ cohort: COHORT, profiles: [PROFILE] }] });
// 좌석 토큰. 서명은 무의미하다 — 이 실행에서 서버는 스텁이고, 서명 검증은 81 의
// 시험 15종이 잰다. 여기서 재는 것은 **앱이 어느 토큰을 싣는가**다.
const SEAT = mint({ u: "rehearsal-jay-a1b2", c: COHORT, p: PROFILE, exp: EXP, rehearsal: true });

const ACTIVITY_ID = "b".repeat(64);
const profileBody = (seat) => ({
  activity_id: seat ? "c".repeat(64) : ACTIVITY_ID,
  activity_kind: "course",
  profile_id: PROFILE,
  display_name: seat ? `리허설 · ${COURSE}` : "보아치과 v4",
  language: "ko", series_index: 1, series_total: 1,
  welcome: { greeting_md: "", example_prompts: [] },
  ux: {
    coach: { naming_mode: "fixed", fallback_name: "코치", naming_prompt_md: "", personality_prompt_md: "" },
    suggestions: { initial: [], follow_up: [] },
    hints: { short_input: { enabled: false, min_chars: 0, message_md: "" },
             roll_input_button: { enabled: false, label: "", probe_md: "" } },
    retry_button: { enabled: false, show_counter: false },
  },
  publishing: { enabled: false, strategy: "none" },
  preview: { type: "iframe", auto_start: false },
  workspace_start: "empty",
});

/** 전선에서 본 것. 판정은 전부 여기서 나온다. */
const seen = [];
const authOf = (req) => req.headers["authorization"];
const bodyOf = (req) => new Promise((r) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b));
});

/** 좌석 토큰. 짝 실행에서는 진짜 서버가 정하므로 교환 응답에서 배운다. */
let SEAT_OBSERVED;

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "";
  const body = req.method === "POST" ? await bodyOf(req) : "";
  seen.push({ method: req.method, url, auth: authOf(req), body });
  res.setHeader("access-control-allow-origin", "*");

  if (UPSTREAM) {
    // 기록하는 중계기. 판정은 진짜 서버가 하고 우리는 전선만 읽는다.
    const target = UPSTREAM.replace(/\/v1$/, "") + url;
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (["host", "connection", "content-length"].includes(k.toLowerCase())) continue;
      headers[k] = v;
    }
    let up;
    try {
      up = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
    } catch (e) {
      res.statusCode = 502;
      res.setHeader("content-type", "application/json");
      seen[seen.length - 1].upstreamError = String(e);
      return void res.end(JSON.stringify({ error: "pair_upstream_unreachable" }));
    }
    const text = await up.text();
    seen[seen.length - 1].status = up.status;
    // 좌석 토큰을 교환 응답에서 배운다 — 합성하지 않는다.
    if (url.includes("/rehearsal/redeem") && up.ok) {
      try { SEAT_OBSERVED = JSON.parse(text).token; } catch { /* 본문이 JSON 이 아니다 */ }
    }
    res.statusCode = up.status;
    const ct = up.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);
    return void res.end(text);
  }

  res.setHeader("content-type", "application/json");

  if (url.includes("/rehearsal-tickets")) {
    if (authOf(req) !== `Bearer ${ISSUER}`) { res.statusCode = 403; return void res.end(JSON.stringify({ error: "not an issuer" })); }
    return void res.end(JSON.stringify({ ticket: TICKET, expires_at: EXP }));
  }
  if (url.includes("/rehearsal/redeem")) {
    let t; try { t = JSON.parse(body).ticket; } catch { t = undefined; }
    if (t !== TICKET) { res.statusCode = 410; return void res.end(JSON.stringify({ error: "not_found" })); }
    return void res.end(JSON.stringify({
      token: SEAT, seat: "rehearsal-jay-a1b2",
      lesson: { course_id: COURSE, version: VERSION, sha256: "d".repeat(64) },
      expires_at: EXP,
    }));
  }
  if (url.includes("/profile")) {
    const tok = (authOf(req) ?? "").replace(/^Bearer /, "");
    return void res.end(JSON.stringify(profileBody(tok === SEAT)));
  }
  if (url.includes("/activity")) {
    const tok = (authOf(req) ?? "").replace(/^Bearer /, "");
    return void res.end(JSON.stringify({ activity_id: tok === SEAT ? "c".repeat(64) : ACTIVITY_ID }));
  }
  if (url.includes("/health")) return void res.end(JSON.stringify({ ok: true }));
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { type: "not_found" } }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PROXY = `http://127.0.0.1:${server.address().port}/v1`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const udd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hps-1205-")));
  const userDir = path.join(udd, "User");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({
    "hypeproofChat.proxyUrl": PROXY, "window.dialogStyle": "custom",
    "workbench.startupEditor": "none", "telemetry.telemetryLevel": "off",
    "update.mode": "none", "workbench.tips.enabled": false,
  }, null, 2));
  fs.writeFileSync(path.join(userDir, "hps-test-state.json"),
    JSON.stringify({ token: STUDENT, issuerToken: ISSUER }));
  const ws = path.join(udd, "ws");
  fs.mkdirSync(ws, { recursive: true });
  const app = await electron.launch({
    executablePath: APP,
    env: { ...process.env, HPS_TEST_E2E: "1", ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
    timeout: 60_000,
    args: [
      `--user-data-dir=${udd}`, `--extensions-dir=${path.join(udd, "extensions")}`,
      "--disable-workspace-trust", "--use-inmemory-secretstorage", "--disable-updates",
      "--skip-welcome", "--skip-release-notes", "--no-sandbox",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--folder-uri", pathToFileURL(ws).href,
    ],
  });
  await app.evaluate(({ app: a, BrowserWindow }) => {
    try { a.dock?.hide(); } catch {}
    const stash = (w) => { try { w.setFocusable(false); w.setPosition(-4000, -4000); w.showInactive(); } catch {} };
    for (const w of BrowserWindow.getAllWindows()) stash(w);
    a.on("browser-window-created", (_e, w) => stash(w));
  });
  const win = await app.firstWindow({ timeout: 60_000 });
  await win.waitForSelector(".monaco-workbench", { timeout: 60_000 });
  return { app, win };
}

async function enterActivity(win) {
  const end = Date.now() + 45_000;
  while (Date.now() < end) {
    const frames = win.locator("iframe.webview.ready");
    for (let i = 0; i < (await frames.count()); i++) {
      const f = win.frameLocator("iframe.webview.ready").nth(i).frameLocator("#active-frame");
      if (await f.locator(".studio-start").isVisible().catch(() => false)) {
        const btn = f.getByRole("button", { name: /^(?:이어서 하기|수업 시작하기)$/ });
        if (await btn.isVisible().catch(() => false)) { await btn.click(); return; }
      }
    }
    await sleep(250);
  }
  throw new Error("entry screen never yielded");
}

/**
 * 팔레트의 항목 전체. **DOM 을 긁지 않고 키보드로 훑는다.**
 *
 * VS Code 의 quick-input 리스트는 **가상화**돼 있어서 `querySelectorAll` 은
 * 보이는 행만 준다. 항목이 17개일 때는 전부 보여서 티가 안 났는데(#1204),
 * 명령이 늘자 **화면 밖 항목이 "없는 것"으로 읽혔다** — 실제로 이 이슈의 첫
 * 실행이 멀쩡한 명령을 "팔레트에 없음"으로 보고했다. 전형적인 거짓 판정이다.
 *
 * 그래서 `aria-setsize` 로 전체 개수를 읽고 그만큼 ArrowDown 하며 **포커스된
 * 행**을 모은다. 포커스는 가상화와 무관하게 항상 렌더된다.
 */
async function paletteItems(win) {
  const tb = win.locator(".monaco-workbench .part.titlebar").first();
  if (await tb.count()) await tb.click({ position: { x: 5, y: 5 } }).catch(() => {});
  await win.keyboard.press("Meta+Shift+P");
  await win.waitForSelector(".quick-input-widget", { state: "visible", timeout: 15_000 });
  await win.keyboard.type("HypeProof");
  await sleep(2000);
  const total = await win.evaluate(() => {
    const row = document.querySelector(".quick-input-list .monaco-list-row");
    const n = Number(row?.getAttribute("aria-setsize"));
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  const focused = () => win.evaluate(() => {
    const r = document.querySelector(".quick-input-list .monaco-list-row.focused")
      ?? document.querySelector('.quick-input-list .monaco-list-row[aria-selected="true"]');
    return r ? r.innerText.replace(/\n/g, " | ").trim() : null;
  });
  const items = [];
  const first = await focused();
  if (first) items.push(first);
  const cap = total > 0 ? total : 200;
  for (let i = 1; i < cap; i++) {
    await win.keyboard.press("ArrowDown");
    await sleep(40);
    const t = await focused();
    if (!t) break;
    if (total === 0 && items.length > 0 && t === items[0]) break; // wrap
    items.push(t);
  }
  return { items, total };
}

/**
 * 팔레트 명령 실행. 목록을 키보드로 훑어 대상에서 멈춘 뒤 Enter.
 * 화면 밖 창에서는 행 클릭이 안 먹는다(#1204 실측).
 */
async function runPalette(win, needle) {
  const tb = win.locator(".monaco-workbench .part.titlebar").first();
  if (await tb.count()) await tb.click({ position: { x: 5, y: 5 } }).catch(() => {});
  await win.keyboard.press("Meta+Shift+P");
  await win.waitForSelector(".quick-input-widget", { state: "visible", timeout: 15_000 });
  await win.keyboard.type("HypeProof");
  await sleep(2000);
  const focused = () => win.evaluate(() => {
    const r = document.querySelector(".quick-input-list .monaco-list-row.focused")
      ?? document.querySelector('.quick-input-list .monaco-list-row[aria-selected="true"]');
    return r ? r.innerText.replace(/\n/g, " | ").trim() : null;
  });
  const total = await win.evaluate(() => {
    const row = document.querySelector(".quick-input-list .monaco-list-row");
    const n = Number(row?.getAttribute("aria-setsize"));
    return Number.isFinite(n) && n > 0 ? n : 200;
  });
  for (let i = 0; i < total; i++) {
    const t = await focused();
    if (t && t.includes(needle)) {
      await win.keyboard.press("Enter");
      await sleep(1500);
      return { ran: true };
    }
    await win.keyboard.press("ArrowDown");
    await sleep(40);
  }
  await win.keyboard.press("Escape");
  return { ran: false };
}

/** 열려 있는 InputBox 에 값을 넣고 확인. */
async function answerInput(win, value) {
  await win.waitForSelector(".quick-input-widget", { state: "visible", timeout: 15_000 });
  await win.keyboard.type(value);
  await sleep(300);
  await win.keyboard.press("Enter");
  await sleep(800);
}

const report = { app: APP, proxy: PROXY, mode: UPSTREAM ? `pair:${UPSTREAM}` : "stub", cohort: COHORT, course: COURSE, version: VERSION, steps: {} };
let failed = 0;
const step = (name, fn) => fn().then(
  () => console.log(`✅ ${name}`),
  (e) => { failed++; console.error(`❌ ${name}\n   ${e.message}`); });

const profileCalls = () => seen.filter((s) => s.url.includes("/profile"));
const withToken = (t) => profileCalls().filter((s) => s.auth === `Bearer ${t}`);
/** 이 실행에서 좌석 토큰이 무엇인가. 짝 실행이면 서버가 준 것, 아니면 스텁 것. */
const seatToken = () => SEAT_OBSERVED ?? SEAT;
const withSeat = () => profileCalls().filter((s) => s.auth === `Bearer ${seatToken()}`);

try {
  const { app, win } = await launch();
  try {
    await enterActivity(win);
    await sleep(4000);
    await runPalette(win, "Focus on Chat View");
    await sleep(2000);

    // ── 대조군: 강사 면과 리허설 행동이 실제로 있는가 ────────────────
    const beforeScan = await paletteItems(win);
    await win.keyboard.press("Escape");
    const before = beforeScan.items;
    report.steps.paletteBefore = beforeScan;
    await step("강사 창이다 — 리허설 명령이 팔레트에 있다", async () =>
      assert.ok(before.some((r) => r.includes("학생 조건으로 리허설")), "리허설 명령 없음"));
    await step("아직 리허설 중이 아니다 — 끝내기는 안 보인다", async () =>
      assert.ok(!before.some((r) => r.includes("리허설 끝내기")),
        "안 돌고 있는데 끝내기가 보인다 — when 절이 안 먹는다"));

    const baselineSeat = withSeat().length;
    await step("대조군: 아직 좌석 토큰으로 나간 요청이 없다", async () =>
      assert.equal(baselineSeat, 0));

    // ── 실제로 누른다 ───────────────────────────────────────────────
    const started = await runPalette(win, "학생 조건으로 리허설");
    assert.ok(started.ran, "리허설 명령을 실행하지 못했다");
    await answerInput(win, COHORT);
    await answerInput(win, COURSE);
    await answerInput(win, VERSION);
    await sleep(8000);
    await win.screenshot({ path: path.join(out, "rehearsing.png") });
    report.steps.wire = seen.map((s) => ({ method: s.method, url: s.url, auth: s.auth ? s.auth.slice(0, 18) + "…" : null }));

    // ── 전환이 실제로 일어났는가 (대조군 — 이게 먼저다) ─────────────
    // 좌석 토큰과 학생 토큰은 **앞부분이 같다**(둘 다 `{"c":"boah-dental-…"` 로 시작).
    // 잘라 놓은 로그만 보면 구분이 안 되므로, 둘이 실제로 다른 값인지와 짝 실행에서
    // 좌석을 서버에서 배워 왔는지를 증거에 남긴다. 읽는 사람이 내 추론을 믿지
    // 않아도 되게 하는 것이 목적이다.
    report.tokens = {
      studentHead: STUDENT.slice(0, 24),
      seatHead: seatToken().slice(0, 24),
      seatLearnedFromServer: SEAT_OBSERVED !== undefined,
      seatDiffersFromStudent: seatToken() !== STUDENT,
    };
    await step("좌석 토큰이 학생 토큰과 실제로 다른 값이다", async () => {
      assert.notEqual(seatToken(), STUDENT, "좌석과 학생이 같은 토큰이면 아래는 무의미하다");
      if (UPSTREAM) {
        assert.ok(SEAT_OBSERVED, "짝 실행인데 좌석을 서버에서 못 배웠다 — 합성 값과 비교하고 있다");
      }
    });
    await step("전환이 실제로 일어났다 — 좌석 토큰으로 프로필을 가져갔다", async () =>
      assert.ok(withSeat().length > baselineSeat,
        "좌석 토큰으로 나간 요청이 0건 — 아래 헤더 단언이 전부 헛돈다"));

    // ── 세 구간의 자격 ──────────────────────────────────────────────
    await step("교환권 발급은 issuer Bearer 로 나갔다", async () => {
      const t = seen.filter((s) => s.url.includes("/rehearsal-tickets"));
      assert.equal(t.length, 1, `발급 요청 ${t.length}건`);
      assert.equal(t[0].auth, `Bearer ${ISSUER}`);
    });
    await step("교환에는 Authorization 이 없다 — 교환권은 본문에만", async () => {
      const r = seen.filter((s) => s.url.includes("/rehearsal/redeem"));
      assert.equal(r.length, 1, `교환 요청 ${r.length}건`);
      assert.equal(r[0].auth, undefined, "교환에 자격이 실렸다 — ARC-02");
      const sent = JSON.parse(r[0].body);
      assert.equal(Object.keys(sent).join(","), "ticket", "본문에 교환권 말고 다른 게 실렸다");
      assert.match(sent.ticket, /^[A-Za-z0-9_-]{16,256}$/);
      assert.ok(!r[0].url.includes(sent.ticket), "교환권이 URL 에 실렸다");
      if (!UPSTREAM) assert.equal(sent.ticket, TICKET);
    });
    await step("리허설 중 issuer 로 나간 프로필·채팅 요청이 0건이다", async () => {
      const leaked = seen.filter((s) => s.auth === `Bearer ${ISSUER}` && !s.url.includes("/rehearsal-tickets"));
      assert.deepEqual(leaked.map((s) => s.url), [], "issuer 가 저작 경로 밖으로 샜다");
    });

    // 여기서 **덜 주장한다.** "리허설 중 나가는 모든 요청이 좌석 토큰" 은 거짓이다:
    // 전환 직전에 출발한 요청이 전환 뒤에 착지할 수 있다. `loadAccess()` 는 요청을
    // 시작할 때 토큰을 읽고(`chatPanelProvider.ts` `loadAccess`), 결과만 가드로
    // 버린다 — 이미 나간 요청을 되부를 수는 없다. 실제로 이 실행에서 `/v1/access`
    // 한 건이 직전 자격으로 착지했다.
    //
    // 이것은 issuer 유출이 아니고 이 이슈가 만든 것도 아니다(참여 코드 교체에도
    // 같은 경합이 있다). 그래서 **없다고 하지 않고, 어디까지인지를 고정한다**:
    // 대화 경로는 깨끗하게 넘어갔고, 늦게 착지할 수 있는 것은 사용량 조회뿐이다.
    await step("전환 뒤 직전 자격으로 착지하는 것은 사용량 조회뿐이다 (대화 경로는 깨끗하다)", async () => {
      const switchAt = seen.findIndex((s) => s.url.includes("/rehearsal/redeem"));
      assert.ok(switchAt >= 0);
      const stale = seen
        .slice(switchAt + 1)
        .filter((s) => s.auth === `Bearer ${STUDENT}`)
        .map((s) => s.url.split("?")[0]);
      for (const u of stale) {
        assert.ok(u.includes("/access"), `대화 경로가 직전 자격으로 나갔다: ${u}`);
      }
      report.steps.staleAfterSwitch = stale;
    });

    // ── 리허설 중임이 화면에 반영됐는가 ─────────────────────────────
    const duringScan = await paletteItems(win);
    await win.keyboard.press("Escape");
    const during = duringScan.items;
    report.steps.paletteDuring = duringScan;
    await step("리허설 중이므로 '리허설 끝내기' 가 나타난다", async () =>
      assert.ok(during.some((r) => r.includes("리허설 끝내기")),
        "when 절이 안 바뀌었다 — 리허설 상태가 화면에 반영되지 않았다"));

    // ── 돌아온다 ────────────────────────────────────────────────────
    const seatBeforeReturn = withSeat().length;
    const studentBeforeReturn = withToken(STUDENT).length;
    const ended = await runPalette(win, "리허설 끝내기");
    assert.ok(ended.ran, "끝내기를 실행하지 못했다");
    await sleep(8000);
    await win.screenshot({ path: path.join(out, "returned.png") });
    await step("돌아왔다 — 이전 참여 자격으로 다시 나간 요청이 있다", async () =>
      assert.ok(withToken(STUDENT).length > studentBeforeReturn,
        "복귀 후 원래 자격으로 나간 요청이 없다"));
    // 되돌아올 때도 **같은 경합이 거울상으로** 있다. 리허설 중에 출발한 조회가
    // 복귀 뒤에 착지한다. 처음엔 "복귀 뒤 좌석으로 0건" 으로 단정했는데 한 번은
    // 통과하고 한 번은 3 !== 2 로 깨졌다 — **타이밍에 따라 갈리는 단정**이었다.
    //
    // 그래서 "더 안 나간다" 가 아니라 **"이전 자격으로 정착한다"** 를 잰다. 그것이
    // 강사가 실제로 겪는 것이고(돌아와 보니 원래 수업이다), 경합과 무관하게 참이다.
    // 늦게 착지한 좌석 조회 수는 세어서 증거에 남긴다 — 숨기지 않고 보이게 둔다.
    await step("복귀 뒤 창이 이전 자격으로 정착한다 (마지막 프로필 조회가 이전 자격)", async () => {
      const calls = profileCalls();
      const last = calls[calls.length - 1];
      assert.ok(last, "복귀 뒤 프로필 조회가 한 건도 없다");
      assert.equal(last.auth, `Bearer ${STUDENT}`,
        "창이 이전 자격으로 돌아오지 않았다 — 마지막 조회가 좌석이다");
      report.steps.lateSeatLandings = withSeat().length - seatBeforeReturn;
    });
    const afterScan = await paletteItems(win);
    await win.keyboard.press("Escape");
    const after = afterScan.items;
    report.steps.paletteAfter = afterScan;
    await step("복귀 뒤 '리허설 끝내기' 가 다시 사라진다", async () =>
      assert.ok(!after.some((r) => r.includes("리허설 끝내기"))));
  } finally { await app.close(); }
} finally { await new Promise((r) => server.close(r)); }

report.pass = failed === 0;
report.wireCount = seen.length;
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(`\n${failed === 0 ? "PASS" : "FAIL"} rehearsal-surface — evidence in ${out}`);
process.exit(failed === 0 ? 0 : 1);
