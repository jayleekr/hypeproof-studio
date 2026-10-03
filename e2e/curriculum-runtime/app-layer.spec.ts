// cr-browser (#1391) — the Experiment Browser in the Studio APP (Playwright e2e layer).
//
// Evidence class: live-host for the App (a copy of the shipped shell with this branch's
// extension and webview injected, e2e/README "Driving a different .app"), synthetic for
// the Service account and the model (app-service.mjs: real Service router over HTTP, a
// scripted agent as the provider). Every browser action runs in the App's integrated
// browser through the App's own proxy loop; the agent only sees what the App sent back.
//
//   CR-T02 in-app   switch off: no CR command in the palette, no CR tool in the request;
//                   switch on: both commands and all five tools appear. CR-02's one listed
//                   exception, the delete command for stored screens: hidden before anything
//                   is stored, shown once bytes are stored, still shown after a relaunch with
//                   the switch off (results and pick hidden), and gone after "지우기".
//   CR-T07          five-step kiosk flow reaches the order screen; planted disabled step 4
//                   stops at step 4.
//   CR-T08          planted console error in flow step 3 reported once, at the step index of
//                   the action that raised it (action 4: the opening navigate is action 1),
//                   checked on the raw tool results; a following request that does not
//                   navigate reads it as "이전 요청" and reports no failure at its own steps;
//                   the clean and the chatty (console.log/info) flows report none.
//   CR-T63          the page outline is painted while agent steps run and gone after; the
//                   chat-panel tool line is "running" during a step and none is after.
//   CR-T09          a pick in the integrated browser queues the element (ref, snippet, crop,
//                   index.html:<line>) and the next request carries exactly that; a
//                   script-made element is "찾지 못함"; a removed element sends nothing.
//   CR-T10 (app)    the stored results read back through hypeproof-chat.browserResults
//                   labelled "현재 버전", and "이전 버전" after the file changes; their bytes
//                   are on the local record.
//
// Needs an unlocked screen (recon F7): when locked the run is skipped as NOT RUN.
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type AppContext, chatFrame, closeApp, launchApp, runCommand } from "../fixtures/app";
import { Service, paletteRows, previewUrl, screenLocked, send, sendLost, startOutlineSampler, stopOutlineSampler, waitRun } from "./app-helpers";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const FIXTURE = path.join(here, "fixtures/kiosk-practice");
const CR_TOOLS = ["browser_observe", "browser_select", "browser_scroll", "browser_hover", "browser_reload"];
const PICK = "HypeProof: 화면에서 요소 골라 코치에게 묻기";
const RESULTS = "HypeProof: 실험 브라우저 결과 기록 보기";
/** CR-02's listed exception: shown, whatever the switch, only while the person has bytes stored. */
const CLEAR = "HypeProof: 저장된 실험 브라우저 화면 지우기";
const PREVIEW = "HypeProof: HTML 미리보기 (옆 패널)";

let ctx: AppContext | undefined;
const svc = new Service();
const record: Record<string, unknown> = {};

test.beforeEach(() => {
  const locked = screenLocked();
  test.skip(locked !== false, `NOT RUN: the macOS screen is ${locked === null ? "in an unknown lock state (Quartz missing)" : "locked"}; the integrated browser paints no frames then (recon F7)`);
});
test.afterEach(async () => {
  if (ctx) await closeApp(ctx);
  ctx = undefined;
  svc.stop();
});
test.afterAll(() => {
  const out = path.join(repo, "e2e/test-results/cr-app/result.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (sendLost.length) record["send-lost"] = sendLost;
  fs.writeFileSync(out, JSON.stringify(record, null, 2));
});

test("CR-T02 in-app, switch off: no CR command or tool is reachable; the existing browser tools stay", async () => {
  await svc.start(false);
  ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  await send(ctx.win, "안녕");
  await expect.poll(async () => (await svc.state()).requests.length, { timeout: 60_000 }).toBeGreaterThan(0);
  const tools = (await svc.state()).requests[0].tools;
  expect(tools, "control: the coach's existing browser tools are still offered").toContain("browser_navigate");
  for (const t of CR_TOOLS) expect(tools, `${t} must not be offered with the switch off`).not.toContain(t);
  const control = await paletteRows(ctx.win, PREVIEW);
  expect(control.some((r) => r.includes("HTML 미리보기")), "control: the palette instrument finds an existing command").toBe(true);
  for (const title of [PICK, RESULTS]) expect((await paletteRows(ctx.win, title)).some((r) => r.includes(title.replace("HypeProof: ", ""))), `${title} hidden`).toBe(false);
  expect(hasRow(await paletteRows(ctx.win, CLEAR), CLEAR), "the delete exception is hidden with nothing stored").toBe(false);
  record["CR-T02-off"] = { tools };
});

const hasRow = (rows: string[], title: string) => rows.some((r) => r.includes(title.replace("HypeProof: ", "")));
/** Stored browser-result bytes on a user data dir's local record (keys under `blobs/`). */
function storedBlobs(userDataDir: string): number {
  const storage = path.join(userDataDir, "User/globalStorage");
  if (!fs.existsSync(storage)) return 0;
  const recordDir = fs.readdirSync(storage).map((d) => path.join(storage, d, "local-review-v1")).find((d) => fs.existsSync(d));
  const files = recordDir ? fs.readdirSync(recordDir).filter((f) => /^[a-f0-9]{64}\.json$/.test(f)) : [];
  // The App writes and deletes while this reads: a file gone between the listing and the read is skipped.
  const keyOf = (f: string): string => {
    try { return JSON.parse(fs.readFileSync(path.join(recordDir!, f), "utf8")).key as string; } catch { return ""; }
  };
  return files.map(keyOf).filter((k) => k.startsWith("blobs/")).length;
}

test("CR-T02 exception in-app: the delete command for stored screens across the switch (MC-27)", async () => {
  await svc.start(true);
  ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  const { app, win, wsDir } = ctx;
  fs.cpSync(FIXTURE, wsDir, { recursive: true });
  const preClear = hasRow(await paletteRows(win, CLEAR), CLEAR);
  await send(win, "안녕");
  await expect.poll(async () => (await svc.state()).requests.length, { timeout: 60_000 }).toBeGreaterThan(0);
  await win.locator(".monaco-workbench .part.titlebar").first().click({ position: { x: 10, y: 10 }, force: true });
  await win.keyboard.press("Meta+P");
  await win.locator(".quick-input-widget input.input").first().fill("index.html");
  await win.waitForTimeout(600);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(800);
  await runCommand(win, PREVIEW);
  await expect.poll(() => previewUrl(app), { timeout: 30_000 }).not.toBeNull();
  await send(win, "[cr:flow] 주문 시작부터 주문 완료까지 눌러보고 오류가 있으면 몇 번째 단계였는지 알려줘");
  const clean = await waitRun(svc, "clean", win);
  expect(clean.failedAt).toBeNull();
  await expect.poll(() => storedBlobs(ctx!.userDataDir), { timeout: 10_000 }).toBeGreaterThan(0);
  const onBlobs = storedBlobs(ctx.userDataDir);
  const onClear = hasRow(await paletteRows(win, CLEAR), CLEAR);
  // The same student, the switch now off (a tier change), on the same user data dir.
  const udd = ctx.userDataDir;
  await app.close(); // not closeApp: that removes the user data dir this relaunch reuses
  ctx = undefined;
  svc.stop();
  await new Promise((r) => setTimeout(r, 1500));
  await svc.start(false);
  ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" }, reuseUserDataDir: udd });
  await ctx.win.waitForTimeout(3000);
  const off = {
    clear: hasRow(await paletteRows(ctx.win, CLEAR), CLEAR),
    results: hasRow(await paletteRows(ctx.win, RESULTS), RESULTS),
    pick: hasRow(await paletteRows(ctx.win, PICK), PICK),
  };
  let dialog: string | null = null;
  if (off.clear) {
    await runCommand(ctx.win, CLEAR);
    const btn = ctx.win.locator(".monaco-dialog-box .monaco-button", { hasText: "지우기" }).first();
    await btn.waitFor({ state: "visible", timeout: 15_000 });
    dialog = await ctx.win.locator(".monaco-dialog-box").first().innerText().catch(() => null);
    await btn.click();
  }
  await expect.poll(() => storedBlobs(udd), { timeout: 10_000 }).toBe(0);
  const afterClear = hasRow(await paletteRows(ctx.win, CLEAR), CLEAR);
  record["CR-T02-exception"] = { preClear, onBlobs, onClear, off, dialog, afterBlobs: storedBlobs(udd), afterClear };
  expect(preClear, "hidden before anything is stored").toBe(false);
  expect(onClear, "shown once bytes are stored (switch on)").toBe(true);
  expect(off.results, "the results command stays hidden with the switch off").toBe(false);
  expect(off.pick, "element pick stays hidden with the switch off").toBe(false);
  expect(off.clear, "the delete command is shown with the switch off while bytes are stored").toBe(true);
  expect(dialog ?? "", "the dialog says how many and that it cannot be undone").toMatch(/개를 지울까요\? 되돌릴 수 없어요/);
  expect(afterClear, "hidden again once nothing is stored").toBe(false);
});

test("CR-T02/07/08/09/10/63 in-app, switch on", async () => {
  await svc.start(true);
  ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  const { app, win, wsDir } = ctx;
  fs.cpSync(FIXTURE, wsDir, { recursive: true });

  // ── CR-T02, switch on: the surfaces appear ────────────────────────────────
  await send(win, "안녕");
  await expect.poll(async () => (await svc.state()).requests.length, { timeout: 60_000 }).toBeGreaterThan(0);
  const tools = (await svc.state()).requests[0].tools;
  for (const t of CR_TOOLS) expect(tools).toContain(t);
  for (const title of [PICK, RESULTS]) expect((await paletteRows(win, title)).some((r) => r.includes(title.replace("HypeProof: ", ""))), `${title} shown`).toBe(true);
  record["CR-T02-on"] = { tools };

  // ── the student opens the preview ─────────────────────────────────────────
  await win.locator(".monaco-workbench .part.titlebar").first().click({ position: { x: 10, y: 10 }, force: true });
  await win.keyboard.press("Meta+P");
  await win.locator(".quick-input-widget input.input").first().fill("index.html");
  await win.waitForTimeout(600);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(800);
  await runCommand(win, PREVIEW);
  await expect.poll(() => previewUrl(app), { timeout: 30_000 }).not.toBeNull();

  // ── CR-T07 / CR-T08 / CR-T63: the five-step flow ─────────────────────────
  await startOutlineSampler(app);
  const flowStart = Date.now();
  let maxRunning = 0;
  await send(win, "[cr:flow] 주문 시작부터 주문 완료까지 눌러보고 오류가 있으면 몇 번째 단계였는지 알려줘");
  const clean = await waitRun(svc, "clean", win, (n) => { maxRunning = Math.max(maxRunning, n); });
  await win.waitForTimeout(1500);
  const samples = await stopOutlineSampler(app);
  const during = samples.filter((s) => s.at >= flowStart);
  const lastQuiet = samples.slice(-5);
  record["CR-T07"] = { clean };
  record["CR-T63"] = { samples: during.length, withOutline: during.filter((s) => s.orange > 5).length, after: lastQuiet, maxRunningToolLines: maxRunning };
  expect(clean.failedAt, "CR-T07 positive: five steps, order screen").toBeNull();
  expect(clean.steps).toBe(5);
  expect(clean.failures, "CR-T08 negative: the clean flow reports no failure").toEqual([]);
  expect(during.length, "CR-T63 instrument: frames were sampled during the flow").toBeGreaterThan(5);
  expect(during.some((s) => s.orange > 5), "CR-T63: the outline was painted while agent steps ran").toBe(true);
  expect(lastQuiet.every((s) => s.orange <= 5), "CR-T63: the outline is gone after the steps").toBe(true);
  expect(maxRunning, "CR-T63 chat half: a tool line was running during a step").toBeGreaterThan(0);

  await send(win, "[cr:flow:disabled-step4] 다시 해봐");
  const disabled = await waitRun(svc, "disabled-step4", win);
  expect(disabled.failedAt, "CR-T07 negative: disabled step 4 stops at 4").toBe(4);

  await send(win, "[cr:flow:console-step3] 다시 해봐");
  const planted = await waitRun(svc, "console-step3", win);
  const at3 = planted.failures.filter((f) => /planted-step3-error/.test(f.message));
  record["CR-T08"] = { planted, disabled };
  expect(at3.length, "CR-T08: the planted error is reported once").toBe(1);
  // CR-T08 row: "단계 N" is the Nth agent action of the request, the opening navigate
  // counted, so flow step 3 ("수량 늘리기") is action 4 and the error is reported at 4.
  expect(planted.actions.indexOf("수량 늘리기") + 1, "instrument: flow step 3 is the request's fourth action").toBe(4);
  expect(at3[0].step, "CR-T08: reported at the step index of the action that raised it").toBe(4);
  expect(planted.failures.length).toBe(1);
  // The same on the raw tool results the App sent (not the agent's de-duplicated list):
  // every later observation repeats the record, always at action 4, never at another step.
  const rawPlanted = planted.lines.filter((l) => /planted-step3-error/.test(l.line));
  expect(rawPlanted.length, "instrument: the planted record reached the model").toBeGreaterThan(0);
  expect(rawPlanted.filter((l) => !/\] 단계 4 /.test(l.line)), "CR-T08 raw: the planted error appears at action 4 only").toEqual([]);

  // CR-T08 across requests: the next request does not navigate, so the executor, its step
  // count and the earlier records survive; only the per-request turn tells them apart.
  await send(win, "[cr:again] 지금 화면 다시 보고 도움말 보기 눌러봐");
  const again = await waitRun(svc, "again", win);
  record["CR-T08-again"] = again;
  expect(again.actions, "instrument: the request clicks without navigating").toEqual(["도움말 보기"]);
  expect(again.failedAt).toBeNull();
  const earlier = again.lines.filter((l) => /planted-step3-error/.test(l.line));
  expect(earlier.length, "instrument: the earlier request's error is still on this document").toBeGreaterThan(0);
  expect(earlier.filter((l) => !/\] 이전 요청 /.test(l.line)), "CR-T08: an earlier request's error reads 이전 요청, never a step of this request").toEqual([]);
  expect(again.failures, "CR-T08: no failure is attributed to a step of the current request").toEqual([]);

  await send(win, "[cr:flow:chatty] 다시 해봐");
  const chatty = await waitRun(svc, "chatty", win);
  record["CR-T08-chatty"] = chatty;
  expect(chatty.failedAt).toBeNull();
  expect(chatty.failures, "CR-T08 negative: console.log/info are not failures").toEqual([]);

  // ── CR-T09: pick an element in the integrated browser ─────────────────────
  const origin = new URL((await previewUrl(app))!).origin;
  const pick = async (id: string) => {
    await app.evaluate(async ({ webContents }, o) => {
      // The tab the agent drove (index.html); the student's own preview tab sits at "/".
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(`${o}/index.html`));
      await wc!.loadURL(`${o}/index.html`);
    }, origin);
    await win.waitForTimeout(800);
    await runCommand(win, PICK);
    await win.waitForTimeout(800);
    await app.evaluate(async ({ webContents }, a) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(`${a.o}/index.html`))!;
      const [x, y] = await wc.executeJavaScript(`(() => { const r = document.getElementById(${JSON.stringify(a.id)}).getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
      wc.sendInputEvent({ type: "mouseMove", x, y });
      wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    }, { o: origin, id });
    const chip = (await chatFrame(win)).locator('[data-testid="element-context"]');
    try {
      await expect(chip).toBeVisible({ timeout: 20_000 });
    } catch (e) {
      record["CR-T09-notice"] = await (await chatFrame(win)).locator(".hps-page-notice").allInnerTexts().catch(() => []);
      throw e;
    }
    return chip;
  };
  const chip = await pick("begin");
  const chipText = (await chip.innerText()).replace(/\s+/g, " ");
  const sentText = await (await chatFrame(win)).locator('[data-testid="element-context-sent"]').textContent();
  const hasCrop = await chip.locator("img.hps-element-crop").count();
  record["CR-T09"] = { chipText, hasCrop };
  expect(chipText, "CR-T09: the start button is mapped to its source line").toMatch(/소스 위치: index\.html:\d+/);
  expect(chipText).toMatch(/주문 시작/);
  expect(hasCrop, "CR-T09: an element crop is attached").toBe(1);
  const startClicked = await app.evaluate(async ({ webContents }, o) => webContents.getAllWebContents().find((w) => w.getURL().startsWith(`${o}/index.html`))!.executeJavaScript('document.getElementById("menu").hidden'), origin);
  expect(startClicked, "CR-T09: the inspect click picks, it does not press the product's button").toBe(true);
  const before = (await svc.state()).requests.length;
  await send(win, "[cr:ask] 이 버튼이 왜 안 돼?");
  await expect.poll(async () => (await svc.state()).requests.length, { timeout: 60_000 }).toBeGreaterThan(before);
  const asked = (await svc.state()).requests[before];
  expect(asked.userText.startsWith(sentText!.trim().slice(0, 40)), "CR-T09: the request begins with exactly the previewed element text").toBe(true);
  expect(asked.userText).toMatch(/<button id="begin"/);
  expect(asked.images, "CR-T09: the crop goes with it").toBeGreaterThan(0);

  const tipChip = await pick("tip");
  expect((await tipChip.innerText()).replace(/\s+/g, " "), "CR-T09 negative: a script-made element is unmapped").toMatch(/소스 위치: 찾지 못함/);
  await tipChip.locator(".hps-element-remove").click();
  await expect(tipChip).toHaveCount(0);
  const before2 = (await svc.state()).requests.length;
  await send(win, "[cr:ask] 그냥 질문");
  await expect.poll(async () => (await svc.state()).requests.length, { timeout: 60_000 }).toBeGreaterThan(before2);
  const removed = (await svc.state()).requests[before2];
  expect(removed.userText, "CR-T09 negative: a removed element sends nothing").not.toMatch(/도움말 보기|<button id="tip"/);
  expect(removed.images).toBe(0);

  // ── CR-T10 in the App: stored results read back, labelled by version ──────
  await win.waitForTimeout(1500);
  const current = await paletteResults(win);
  expect(current.some((r) => r.includes("현재 버전")), "CR-T10: results on the unchanged files are the current version").toBe(true);
  fs.appendFileSync(path.join(wsDir, "index.html"), "\n<!-- v1 -->\n");
  await win.waitForTimeout(500);
  const later = await paletteResults(win);
  record["CR-T10-app"] = { current: current.slice(0, 4), later: later.slice(0, 4) };
  expect(later.some((r) => r.includes("이전 버전")), "CR-T10: after the change the same results say earlier version").toBe(true);
  expect(later.some((r) => r.includes("현재 버전")), "CR-T10: nothing is still called current").toBe(false);
  const storage = path.join(ctx.userDataDir, "User/globalStorage");
  const recordDir = fs.readdirSync(storage).map((d) => path.join(storage, d, "local-review-v1")).find((d) => fs.existsSync(d));
  const files = recordDir ? fs.readdirSync(recordDir).filter((f) => /^[a-f0-9]{64}\.json$/.test(f)) : [];
  const blobs = files.map((f) => JSON.parse(fs.readFileSync(path.join(recordDir!, f), "utf8")).key as string).filter((k) => k.startsWith("blobs/"));
  record["CR-T10-app"] = { ...(record["CR-T10-app"] as object), blobs: blobs.length };
  expect(blobs.length, "CR-T10: screenshot and trace bytes are on the local record").toBeGreaterThan(0);
});

/** Run the results command and read its rows, then close the list. */
async function paletteResults(win: Page): Promise<string[]> {
  await runCommand(win, RESULTS);
  const rows = win.locator(".quick-input-list .monaco-list-row");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  const texts = (await rows.allInnerTexts()).map((r) => r.replace(/\s+/g, " ").trim());
  await win.keyboard.press("Escape");
  return texts;
}
