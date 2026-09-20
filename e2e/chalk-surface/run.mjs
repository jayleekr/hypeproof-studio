// #1184 — does the 강사 surface actually appear in a real Studio window, and
// does it actually stay out of a student's?
//
// Runs the REAL app (Electron, CDP) twice with nothing different but the
// seeded token, plus a third pass that deletes the issuer token mid-session.
//
//   negative control  student token only  → no view, no 강사 commands
//   positive control  issuer token        → view with its 4 actions + subtitle
//   transition        forget issuer token → view disappears without a reload
//
// Both controls are the point (.claude/rules/verification.md §2): an assertion
// that only ever runs against the passing sample cannot tell a working gate
// from no gate at all.
//
// Self-contained: a throwaway /v1/profile server on an ephemeral port stands in
// for the Service, because the app parks on the entry screen until a profile
// resolves and the surface lives behind that screen. NO worker code is in this
// branch's diff, so no `wrangler dev` pairing is claimed — and nothing here
// touches another session's server or the installed app.
//
//   HPS_APP_PATH='/path/to/HypeProof Studio Dev.app' node chalk-surface/run.mjs

import { _electron as electron } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "../test-results/chalk-surface");
fs.mkdirSync(out, { recursive: true });

const appRoot = process.env.HPS_APP_PATH?.trim();
if (!appRoot) throw new Error("HPS_APP_PATH must point at the .app to drive");
const APP = appRoot.includes("/Contents/MacOS/")
  ? appRoot
  : path.join(appRoot, "Contents/MacOS/HypeProof Studio");

const COHORT = "boah-dental-2026-a";
const PROFILE = "boah-dental-teaser-2026-s1";
const mint = (p) => Buffer.from(JSON.stringify(p)).toString("base64url") + ".devsig";
const EXP = Math.floor(Date.now() / 1000) + 86_400;
const STUDENT = mint({ u: "student-01", c: COHORT, p: PROFILE, exp: EXP });
// Unsigned on purpose: the surface gate is an UNVERIFIED local decode by
// design, so a signature would prove nothing about it. What the Service does
// with this token is #1185's subject, not this one's.
const ISSUER = mint({
  role: "issuer", c: "__issuer__", p: "__issuer__", exp: EXP,
  scopes: [{ cohort: COHORT, profiles: [PROFILE] }],
});

// ── stand-in Service ────────────────────────────────────────────────
// `activity_id` must be 64 hex or ActivityConnections.commit() refuses the
// connection and the window stays on the entry screen — with only a generic
// "참여 코드를 연결하지 못했습니다" banner to say so. The first version of this
// runner omitted it, and both windows silently parked on the entry screen
// while the view assertions "passed" for the student purely because nothing
// had mounted yet. A negative control that passes for the wrong reason is not
// a control (.claude/rules/verification.md §6).
const ACTIVITY_ID = "a".repeat(64);
const profileBody = {
  activity_id: ACTIVITY_ID,
  activity_kind: "course",
  profile_id: PROFILE, display_name: "보아치과 v4", language: "ko",
  series_index: 1, series_total: 1,
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
};
const server = http.createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("content-type", "application/json");
  if (req.url?.includes("/profile")) return void res.end(JSON.stringify(profileBody));
  if (req.url?.includes("/activity")) return void res.end(JSON.stringify({ activity_id: ACTIVITY_ID }));
  if (req.url?.includes("/health")) return void res.end(JSON.stringify({ ok: true }));
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not mocked" }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PROXY = `http://127.0.0.1:${server.address().port}/v1`;

// ── one app run ─────────────────────────────────────────────────────
async function launch({ issuerToken }) {
  const udd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hps-1184-")));
  const userDir = path.join(udd, "User");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({
    "hypeproofChat.proxyUrl": PROXY,
    "window.dialogStyle": "custom",
    "workbench.startupEditor": "none",
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "workbench.tips.enabled": false,
  }, null, 2));
  fs.writeFileSync(path.join(userDir, "hps-test-state.json"),
    JSON.stringify(issuerToken ? { token: STUDENT, issuerToken } : { token: STUDENT }));
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
  // Keep the window off every physical display — a local run must not steal
  // the screen. CDP still sees the renderer.
  await app.evaluate(({ app: a, BrowserWindow }) => {
    try { a.dock?.hide(); } catch {}
    const stash = (w) => { try { w.setFocusable(false); w.setPosition(-4000, -4000); w.showInactive(); } catch {} };
    for (const w of BrowserWindow.getAllWindows()) stash(w);
    a.on("browser-window-created", (_e, w) => stash(w));
  });
  const win = await app.firstWindow({ timeout: 60_000 });
  await win.waitForSelector(".monaco-workbench", { timeout: 60_000 });
  return { app, win, udd };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Walk past the entry screen so the chat container (and our view) can mount. */
async function enterActivity(win) {
  const end = Date.now() + 45_000;
  while (Date.now() < end) {
    const frames = win.locator("iframe.webview.ready");
    for (let i = 0; i < (await frames.count()); i++) {
      const f = win.frameLocator("iframe.webview.ready").nth(i).frameLocator("#active-frame");
      if (await f.locator(".studio-start").isVisible().catch(() => false)) {
        const btn = f.getByRole("button", { name: /^(?:이어서 하기|수업 시작하기)$/ });
        if (await btn.isVisible().catch(() => false)) { await btn.click(); return true; }
      }
    }
    await sleep(250);
  }
  throw new Error("entry screen never yielded — the window never reached the workspace");
}

/** Is the chat view container actually mounted? Without this the whole run can
 *  "pass" its absence assertions because NOTHING mounted (measured, #1184). */
async function containerMounted(win) {
  return win.evaluate(() =>
    [...document.querySelectorAll(".pane-header")].some((h) => /Chat/i.test(h.innerText)));
}

/**
 * Every command the palette offers under "HypeProof" — ALL of them.
 *
 * Two instrument traps live here, both of which report a shorter list than
 * reality and therefore fail toward "pass":
 *
 * 1. `state: "visible"`, not the default "attached". VS Code leaves the widget
 *    in the DOM with display:none after it closes, so an attached-only wait
 *    returns instantly against a CLOSED palette and the rows read back are the
 *    previous invocation's.
 * 2. The list is **virtualized** — `querySelectorAll` returns only the rendered
 *    rows. Measured on this app: 23 commands exist for a student window and 17
 *    render. The first version of this file scraped the DOM, saw 17, and called
 *    it the whole list; the absence assertion below was then made against a
 *    truncated view. It happened to be true (re-verified exhaustively), but the
 *    evidence did not establish it. #1205 is where this surfaced: a genuinely
 *    registered command was reported "not in the palette".
 *
 * So: read `aria-setsize` for the real total and walk it with ArrowDown. The
 * focused row is always rendered, virtualization or not.
 */
async function paletteCommands(win) {
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
  const rows = [];
  const first = await focused();
  if (first) rows.push(first);
  for (let i = 1; i < (total || 200); i++) {
    await win.keyboard.press("ArrowDown");
    await sleep(40);
    const t = await focused();
    if (!t) break;
    if (!total && rows.length && t === rows[0]) break; // wrapped
    rows.push(t);
  }
  // The scan must reach the declared total, or the list below is partial and
  // every "is absent" assertion made from it is worthless.
  if (total && rows.length !== total) {
    throw new Error(`palette scan incomplete: ${rows.length}/${total}`);
  }
  return { rows, total, close: () => win.keyboard.press("Escape") };
}

/**
 * Run a palette command by a substring of its title. Keyboard only — a click
 * on the list row does not register on an off-screen window (measured).
 *
 * It walks the list itself instead of reusing `paletteCommands`' output and
 * counting ArrowDowns from row 0. That shortcut broke the moment
 * `paletteCommands` became an exhaustive scan: the scan leaves focus on the
 * LAST row, so a relative walk from there selects the wrong command. The
 * mounted-container control check caught it immediately, which is what it is
 * for. Selecting by what is actually focused has no such assumption.
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
      await sleep(2500);
      return true;
    }
    await win.keyboard.press("ArrowDown");
    await sleep(40);
  }
  await win.keyboard.press("Escape");
  return false;
}

/** What the 강사 surface looks like right now, as the window renders it. */
async function readSurface(win) {
  return win.evaluate(() => {
    // offsetParent: a pane that exists but is not laid out is not "there".
    const pane = [...document.querySelectorAll(".pane")].find((p) =>
      p.offsetParent !== null && p.querySelector(".pane-header")?.innerText?.includes("강사 작업"));
    return {
      present: !!pane,
      header: pane?.querySelector(".pane-header")?.innerText?.replace(/\s+/g, " ").trim() ?? null,
      rows: pane
        ? [...pane.querySelectorAll(".monaco-list-row")].map((r) => r.innerText.replace(/\s+/g, " ").trim())
        : [],
    };
  });
}

const report = { app: APP, proxy: PROXY, cases: {} };
let failed = 0;
const step = (name, fn) => fn().then(
  () => console.log(`✅ ${name}`),
  (e) => { failed++; console.error(`❌ ${name}\n   ${e.message}`); });

try {
  // ─── negative control: a student window ──────────────────────────
  {
    const { app, win } = await launch({ issuerToken: null });
    try {
      await enterActivity(win);
      await sleep(4000);
      await runPalette(win, "Focus on Chat View");
      await sleep(2500);
      await step("student window: the chat container is mounted (control check)", async () =>
        assert.equal(await containerMounted(win), true,
          "nothing mounted — the absence assertions below would be vacuous"));
      const { rows, close } = await paletteCommands(win);
      await close();
      const surface = await readSurface(win);
      await win.screenshot({ path: path.join(out, "student-palette.png") });
      report.cases.student = { commands: rows, surface };
      await step("student window: 강사 작업 view is absent", async () =>
        assert.equal(surface.present, false));
      await step("student window: no 강사 command in the palette", async () => {
        const leaked = rows.filter((r) => /강사 작업|Focus on 강사/.test(r));
        assert.deepEqual(leaked, []);
      });
      await step("student window: the chat path is untouched", async () =>
        assert.ok(rows.some((r) => r.includes("Focus on Chat View")), "chat view missing"));
      await step("student window: the mint bootstrap stays reachable", async () =>
        assert.ok(rows.some((r) => r.includes("학생 토큰 발급")),
          "gating the bootstrap would lock a 강사 out of their first mint"));
    } finally { await app.close(); }
  }

  // ─── positive control + transition: an instructor window ─────────
  {
    const { app, win } = await launch({ issuerToken: ISSUER });
    try {
      await enterActivity(win);
      await sleep(4000);
      await runPalette(win, "Focus on Chat View");
      await sleep(2500);
      const { rows, close } = await paletteCommands(win);
      await close();
      report.cases.issuerCommands = rows;
      await step("instructor window: the palette offers the surface", async () =>
        assert.ok(rows.some((r) => r.includes("강사 작업 면 열기")), "open command missing"));

      const opened = await runPalette(win, "강사 작업 면 열기");
      assert.ok(opened, "could not run the open command");
      await sleep(2500);
      const surface = await readSurface(win);
      await win.screenshot({ path: path.join(out, "instructor-surface.png") });
      report.cases.instructor = surface;
      report.cases.instructorDom = await win.evaluate(() => ({
        paneHeaders: [...document.querySelectorAll('.pane-header')].map(e => e.innerText.replace(/\s+/g,' ').trim()),
        parts: [...document.querySelectorAll('.monaco-workbench .part')].map(e => ({ cls: e.className, w: e.clientWidth, h: e.clientHeight })).filter(x => x.w > 0),
        auxTitle: document.querySelector('.part.auxiliarybar .composite.title')?.innerText?.replace(/\s+/g,' ').trim() ?? null,
        sidebarTitle: document.querySelector('.part.sidebar .composite.title')?.innerText?.replace(/\s+/g,' ').trim() ?? null,
        bodyHasChalk: document.body.innerText.includes('강사 작업'),
      }));
      await step("instructor window: the view is there", async () =>
        assert.equal(surface.present, true));
      await step("instructor window: the subtitle names the cohort", async () =>
        assert.match(surface.header ?? "", new RegExp(`강사 · ${COHORT}`)));
      await step("instructor window: all four actions render", async () => {
        for (const label of ["수업 지도안 열기", "학생 토큰 발급", "Chalk 웹에서 확인", "저장된 issuer 토큰 지우기"]) {
          assert.ok(surface.rows.some((r) => r.includes(label)), `missing action: ${label}`);
        }
      });

      // ─── the surface follows the token, with no reload ────────────
      await runPalette(win, "저장된 issuer 토큰 지우기");
      await sleep(3000);
      const after = await readSurface(win);
      await win.screenshot({ path: path.join(out, "instructor-after-forget.png") });
      report.cases.afterForget = after;
      await step("forgetting the issuer token removes the view in place", async () =>
        assert.equal(after.present, false));
    } finally { await app.close(); }
  }
} finally {
  await new Promise((r) => server.close(r));
}

report.pass = failed === 0;
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(`\n${failed === 0 ? "PASS" : "FAIL"} chalk-surface — evidence in ${out}`);
process.exit(failed === 0 ? 0 : 1);
