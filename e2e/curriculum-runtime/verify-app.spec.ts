// cr-verify (#1392) — "내 제품 테스트" in the Studio APP (Playwright e2e layer).
//
// Evidence class: live-host for the App (a prepared copy of the shipped shell with this
// branch's extension and webview injected), synthetic for the Service account and the
// model (app-service.mjs: the real Service router, a scripted agent that hands the runner
// one plan per criterion). The verdicts are the runner's, read off the App's own preview.
//
//   CR-T02 in-app   switch off: the command is not in the palette and neither verify tool
//                   is offered; switch on: both tools are offered and the command opens
//                   the panel.
//   CR-T12          zero criteria are refused; an unconfirmed coach proposal starts no run;
//                   three typed criteria start one and are tested one by one.
//   CR-T63 (runner) the page outline is painted while the runner acts and gone after; the
//                   panel says "테스트 중" during the run.
//   CR-T76 (app)    "검증됨" appears only for the version whose report is all pass; a file
//                   change turns it into "다시 테스트" with the earlier result kept.
//   CR-T14          "같은 조건으로 다시 테스트" gives the same verdicts; a planted flaky page
//                   is reported "결과가 매번 달라요".
//   CR-T16          a failed criterion → fix request with report, criterion and version →
//                   the re-test on the fixed version passes as retest_confirmed.
//   CR-T11 (runner) a criterion whose plan leaves for an external origin is not verified,
//                   with the reason, and the browser never loads it.
//   CR-T57 (Studio half) ten re-tests of the five-step order criterion, timed.
//
// Needs an unlocked screen (recon F7): when locked the run is skipped as NOT RUN.
import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type AppContext, chatFrame, closeApp, launchApp, runCommand } from "../fixtures/app";
import { PORT, Service, paletteRows, previewUrl, repo, screenLocked, send, startOutlineSampler, stopOutlineSampler } from "./app-helpers";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures/kiosk-practice");
const TEST = "HypeProof: 내 제품 테스트하기";
const PREVIEW = "HypeProof: HTML 미리보기 (옆 패널)";
const VERIFY_TOOLS = ["verify_criterion", "verify_propose_criteria"];

type VerifyLog = Array<{ kind: string; id?: string; text?: string; isError?: boolean; at?: number }>;
const verifyLog = async (): Promise<VerifyLog> => ((await (await fetch(`http://127.0.0.1:${PORT}/__cr/state`)).json()) as { verify: VerifyLog }).verify;

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
  const out = path.join(repo, "e2e/test-results/cr-app/verify-result.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(record, null, 2));
});

/** The unified chat is an editor tab and the preview can cover it; bring it forward (as send() does). */
async function focusChat(): Promise<void> {
  const tab = ctx!.win.locator(".tabs-container .tab", { hasText: "AI와 작업" }).first();
  if ((await tab.count()) > 0) await tab.click().catch(() => undefined);
}

/** Launch with the switch on, the kiosk fixture in the workspace and its preview open. */
async function openKiosk(): Promise<{ win: Page; chat: FrameLocator }> {
  await svc.start(true);
  ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  const { app, win, wsDir } = ctx;
  fs.cpSync(FIXTURE, wsDir, { recursive: true });
  await send(win, "안녕");
  await expect.poll(async () => (await svc.state()).requests.length, { timeout: 60_000 }).toBeGreaterThan(0);
  record["CR-T02-on-tools"] = (await svc.state()).requests[0].tools;
  for (const t of VERIFY_TOOLS) expect((await svc.state()).requests[0].tools, `${t} offered with the switch on`).toContain(t);
  await win.locator(".monaco-workbench .part.titlebar").first().click({ position: { x: 10, y: 10 }, force: true });
  await win.keyboard.press("Meta+P");
  await win.locator(".quick-input-widget input.input").first().fill("index.html");
  await win.waitForTimeout(600);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(800);
  await runCommand(win, PREVIEW);
  await expect.poll(() => previewUrl(app), { timeout: 30_000 }).not.toBeNull();
  await runCommand(win, TEST);
  await focusChat();
  const chat = await chatFrame(win);
  await expect(chat.locator('[data-testid="verify-panel"]')).toBeVisible({ timeout: 20_000 });
  return { win, chat };
}

/** Replace the panel's criteria with `texts` (typed by the student). */
async function typeCriteria(chat: FrameLocator, texts: string[]): Promise<void> {
  await focusChat();
  const inputs = chat.locator('[data-testid="verify-criterion-input"]');
  // Every earlier row goes, a coach proposal included (typing a proposal's own text again
  // does not confirm it: an unchanged input fires no change).
  while ((await inputs.count()) > 0) await chat.locator('button[aria-label="이 조건 빼기"]').last().click();
  while ((await inputs.count()) < texts.length) await chat.locator("button", { hasText: "조건 더하기" }).click();
  for (let i = 0; i < texts.length; i++) await inputs.nth(i).fill(texts[i]);
}

/** Start a run and wait until the agent has called the runner once per criterion and answered. */
async function startRun(chat: FrameLocator, texts: string[]): Promise<{ run: string }> {
  const before = (await verifyLog()).length;
  await typeCriteria(chat, texts);
  await chat.locator('[data-testid="verify-start"]').click();
  try {
    await expect.poll(async () => (await verifyLog()).slice(before).filter((e) => e.kind === "result").length, { timeout: 120_000 }).toBe(texts.length);
  } catch (e) {
    const diag = {
      texts,
      error: await chat.locator('[data-testid="verify-error"]').allInnerTexts().catch(() => []),
      ai: await chat.locator('[data-testid="verify-ai-badge"]').allInnerTexts().catch(() => []),
      log: (await verifyLog()).slice(before),
      lastRequests: (await svc.state()).requests.slice(-3).map((r) => r.userText.slice(0, 400)),
      bubbles: await chat.locator(".hps-msg-user .hps-msg-body").allInnerTexts().catch(() => []),
      notices: await chat.locator(".hps-page-notice").allInnerTexts().catch(() => []),
    };
    // Written straight away: Playwright restarts the worker after a failure, so `record` is lost.
    fs.mkdirSync(path.join(repo, "e2e/test-results/cr-app"), { recursive: true });
    fs.writeFileSync(path.join(repo, `e2e/test-results/cr-app/verify-start-diag-${Date.now()}.json`), JSON.stringify(diag, null, 2));
    throw e;
  }
  const report = chat.locator('[data-testid="verify-report"]');
  await expect(report.locator('[data-testid="verify-result"]')).toHaveCount(texts.length, { timeout: 30_000 });
  await expect(chat.locator('[data-testid="verify-running"]')).toHaveCount(0, { timeout: 30_000 });
  return { run: (await report.getAttribute("data-run"))! };
}
const statuses = async (chat: FrameLocator) => chat.locator('[data-testid="verify-result"]').evaluateAll((els) => els.map((e) => [e.getAttribute("data-status"), e.getAttribute("data-test-kind")]));
const state = async (chat: FrameLocator) => chat.locator('[data-testid="verify-status"]').getAttribute("data-state");
async function retest(chat: FrameLocator, previousRun: string): Promise<{ run: string; ms: number }> {
  await focusChat();
  const t0 = Date.now();
  await chat.locator('[data-testid="verify-retest"]').click();
  await expect.poll(async () => chat.locator('[data-testid="verify-report"]').getAttribute("data-run"), { timeout: 120_000 }).not.toBe(previousRun);
  await expect(chat.locator('[data-testid="verify-running"]')).toHaveCount(0, { timeout: 60_000 });
  return { run: (await chat.locator('[data-testid="verify-report"]').getAttribute("data-run"))!, ms: Date.now() - t0 };
}

test("CR-T02 in-app, switch off: no verify command or tool is reachable", async () => {
  await svc.start(false);
  ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  await send(ctx.win, "안녕");
  await expect.poll(async () => (await svc.state()).requests.length, { timeout: 60_000 }).toBeGreaterThan(0);
  const tools = (await svc.state()).requests[0].tools;
  expect(tools, "control: the existing browser tools are still offered").toContain("browser_navigate");
  for (const t of VERIFY_TOOLS) expect(tools, `${t} must not be offered with the switch off`).not.toContain(t);
  const control = await paletteRows(ctx.win, PREVIEW);
  expect(control.some((r) => r.includes("HTML 미리보기")), "control: the palette instrument finds an existing command").toBe(true);
  const rows = await paletteRows(ctx.win, TEST);
  expect(rows.some((r) => r.includes("내 제품 테스트하기")), "the command is hidden with the switch off").toBe(false);
  await expect((await chatFrame(ctx.win)).locator('[data-testid="verify-panel"]')).toHaveCount(0);
  record["CR-T02-off"] = { tools };
});

test("CR-T12, CR-T63, CR-T76, CR-T14 positive and CR-T57 timing in-app", async () => {
  const { chat } = await openKiosk();
  const { app } = ctx!;

  // ── CR-T12 negative: zero criteria, and an unconfirmed coach proposal ──────
  await focusChat();
  await chat.locator('button[aria-label="이 조건 빼기"]').click();
  await chat.locator('[data-testid="verify-start"]').click();
  await expect(chat.locator('[data-testid="verify-error"]')).toContainText("1개에서 5개");
  await send(ctx!.win, "[cr:propose] 테스트할 조건 하나 제안해 줘");
  await expect(chat.locator('[data-testid="verify-proposal"]')).toHaveCount(1, { timeout: 60_000 });
  await focusChat();
  await chat.locator('[data-testid="verify-proposal"]').click();
  await expect(chat.locator('[data-testid="verify-ai-badge"]')).toContainText("확인 필요");
  const requestsBefore = (await svc.state()).requests.length;
  await chat.locator('[data-testid="verify-start"]').click();
  await expect(chat.locator('[data-testid="verify-error"]')).toContainText("코치가 제안한 조건은 내가 확인해야");
  await ctx!.win.waitForTimeout(1500);
  const afterRefusal = (await svc.state()).requests.slice(requestsBefore);
  expect(afterRefusal.filter((r) => /\[Studio 제품 테스트/.test(r.userText)), "CR-T12 negative: an unconfirmed proposal starts no run").toEqual([]);

  // ── CR-T12 positive + CR-T63 + CR-T76: three typed criteria ───────────────
  await startOutlineSampler(app, "^http://127\\.0\\.0\\.1:\\d+/(index\\.html)?([?#].*)?$");
  const t0 = Date.now();
  let sawRunning = false;
  const watch = (async () => {
    while (Date.now() - t0 < 90_000 && !sawRunning) {
      sawRunning = (await chat.locator('[data-testid="verify-running"]').count().catch(() => 0)) > 0;
      await ctx?.win.waitForTimeout(50);
    }
  })();
  const first = await startRun(chat, ["주문 시작을 누르면 음료 고르기가 보인다", "주문하면 주문이 완료되었어요가 보인다", "주문하는 동안 오류가 없다"]);
  await watch;
  await ctx!.win.waitForTimeout(1500);
  const samples = (await stopOutlineSampler(app)).filter((s) => s.at >= t0);
  const asked = (await svc.state()).requests.find((r) => /\[Studio 제품 테스트/.test(r.userText));
  record["CR-T12"] = { asked: asked?.userText.slice(0, 1200), statuses: await statuses(chat) };
  record["CR-T63-runner"] = { samples: samples.length, withOutline: samples.filter((s) => s.orange > 5).length, after: samples.slice(-5), sawRunning };
  expect(asked, "CR-T12: the run reached the coach with its criteria").toBeTruthy();
  // Two chat views receive every post; only the panel that asked sends the sentence (once).
  expect((await verifyLog()).filter((e) => e.kind === "start").length, "the run's sentence went to the coach once").toBe(1);
  expect(await statuses(chat)).toEqual([["pass", "test_observed"], ["pass", "test_observed"], ["pass", "test_observed"]]);
  expect(await state(chat), "CR-T76 app: all pass on this version shows 검증됨").toBe("verified");
  await expect(chat.locator('[data-testid="verify-status"]')).toContainText("검증됨");
  expect(samples.some((s) => s.orange > 5), "CR-T63 runner: the outline was painted while the runner acted").toBe(true);
  expect(samples.slice(-5).every((s) => s.orange <= 5), "CR-T63 runner: the outline is gone after the run").toBe(true);
  expect(sawRunning, "CR-T63 runner: the panel said 테스트 중 during the run").toBe(true);

  // ── CR-T14 positive: the same plans again, no model ───────────────────────
  const requestsBeforeRetest = (await svc.state()).requests.length;
  const again = await retest(chat, first.run);
  expect(await statuses(chat), "CR-T14: identical verdicts on the same version").toEqual([["pass", "test_observed"], ["pass", "test_observed"], ["pass", "test_observed"]]);
  expect((await svc.state()).requests.length, "CR-T14: a re-test makes no model call").toBe(requestsBeforeRetest);

  // ── CR-T57 (Studio half): ten re-tests of the five-step order criterion ───
  await chat.locator('[data-testid="verify-close"], button[aria-label="테스트 창 닫기"]').first().click();
  await runCommand(ctx!.win, TEST);
  await focusChat();
  const order = await startRun(chat, ["주문하면 주문이 완료되었어요가 보인다"]);
  const timings: number[] = [];
  let run = order.run;
  for (let i = 0; i < 10; i++) {
    const r = await retest(chat, run);
    run = r.run;
    timings.push(r.ms);
  }
  const sorted = [...timings].sort((a, b) => a - b);
  record["CR-T57-studio"] = { timings, median: sorted[5], max: sorted[9], provider: "none (re-test runs the stored plan; no model call)" };
  expect(sorted[9], "CR-T57 Studio half: every re-test of the five-step criterion is under 60 s").toBeLessThan(60_000);
  record["CR-T14-positive"] = { first: first.run, again: again.run };
});

test("CR-T14 negative, CR-T16, CR-T76 recheck and CR-T11 runner in-app", async () => {
  const { chat } = await openKiosk();
  const { app, wsDir } = ctx!;

  // ── CR-T11 runner: a plan that leaves for an external origin ─────────────
  await startRun(chat, ["바깥 사이트로 가도 주문이 된다"]);
  const outside = chat.locator('[data-testid="verify-result"]').first();
  expect(await outside.getAttribute("data-status")).toBe("not_verified");
  await expect(outside).toContainText("범위 밖이라 거절");
  const loadedExternal = await app.evaluate(({ webContents }) => webContents.getAllWebContents().some((w) => /example\.com/.test(w.getURL())));
  expect(loadedExternal, "CR-T11: the browser never loaded the external origin").toBe(false);

  // ── CR-T14 negative: a planted flaky page ─────────────────────────────────
  const flaky = await startRun(chat, ["흔들리는 화면에서도 주문이 완료된다"]);
  const firstFlaky = await statuses(chat);
  await retest(chat, flaky.run);
  const secondFlaky = await statuses(chat);
  record["CR-T14-negative"] = { firstFlaky, secondFlaky };
  expect(secondFlaky[0][0], "CR-T14: two runs disagree → non-reproducible, never pass").toBe("non_reproducible");
  await expect(chat.locator('[data-testid="verify-result"]').first()).toContainText("결과가 매번 달라요");
  expect(await state(chat)).not.toBe("verified");

  // ── CR-T16: fail → fix request → fixed file → re-test ────────────────────
  const failing = await startRun(chat, ["주문 시작을 누르면 음료 고르기가 보인다", "주문하면 결제 완료가 보인다"]);
  expect(await statuses(chat)).toEqual([["pass", "test_observed"], ["fail", "test_observed"]]);
  expect(await state(chat)).toBe("failed");
  const c2 = (await chat.locator('[data-testid="verify-result"]').nth(1).getAttribute("data-criterion"))!;
  const v0 = (await chat.locator('[data-testid="verify-report"]').getAttribute("data-version"))!;
  const fixesBefore = (await verifyLog()).filter((e) => e.kind === "fix").length;
  await focusChat();
  await chat.locator('[data-testid="verify-fix-text"]').fill("주문하면 결제 완료 문구도 보이게 고쳐 주세요");
  await chat.locator('[data-testid="verify-fix"]').click();
  await expect.poll(async () => (await verifyLog()).filter((e) => e.kind === "fix").length, { timeout: 60_000 }).toBe(fixesBefore + 1);
  const fix = (await verifyLog()).filter((e) => e.kind === "fix").at(-1)!;
  // What the model received: the structured context (one JSON line), then the student's own sentence.
  const fixJson = JSON.parse(fix.text!.split("\n").find((l) => l.startsWith("{"))!);
  record["CR-T16-fix"] = { report: fixJson.report, criterion: fixJson.criterion, version: fixJson.artifact_version };
  expect(fix.text!, "the student's own words go with it").toContain("주문하면 결제 완료 문구도 보이게 고쳐 주세요");
  expect([fixJson.report, fixJson.criterion.id, fixJson.artifact_version], "CR-T16: report, criterion 2 and v0").toEqual([failing.run, c2, v0]);
  // The coach's fix, applied to the workspace file (the scripted agent cannot write files).
  const indexPath = path.join(wsDir, "index.html");
  fs.writeFileSync(indexPath, fs.readFileSync(indexPath, "utf8").replace("<h2>주문이 완료되었어요</h2>", "<h2>주문이 완료되었어요</h2>\n    <p>결제 완료</p>"));
  await runCommand(ctx!.win, TEST);
  await focusChat();
  await expect.poll(() => state(chat), { timeout: 20_000 }).toBe("needs_recheck");
  await expect(chat.locator('[data-testid="verify-report"]')).toContainText("이전 버전의 테스트 결과");
  await retest(chat, failing.run);
  const fixed = await statuses(chat);
  const v1 = await chat.locator('[data-testid="verify-report"]').getAttribute("data-version");
  record["CR-T16-retest"] = { fixed, v0, v1 };
  expect(v1, "the re-test ran on the fixed version").not.toBe(v0);
  expect(fixed, "CR-T16: criterion 2 passes on v1 as retest_confirmed").toEqual([["pass", "test_observed"], ["pass", "retest_confirmed"]]);
  expect(await state(chat), "CR-T76: the fixed version is verified once its whole set passes").toBe("verified");
});
