// cr-publish (#1393) — "사용자 테스트용으로 공개" in the Studio APP (Playwright e2e layer).
//
// Evidence class: live-host for the App (a prepared copy of the shipped shell with this
// branch's extension and webview injected), synthetic for the Service account, storage and
// model (app-service.mjs with `publish`: the real Service router over SQLite D1, an in-memory
// R2 and a `*.test.invalid` test origin; a scripted agent).
//
//   CR-T02 in-app   switch off: the publish command is not in the palette and no panel
//                   appears; switch on: the command opens the panel.
//   CR-T17 (app)    the publish action shows "검증됨" only after an all-pass "내 제품 테스트"
//                   on this exact version and "검증 안 됨" before it and after a file change;
//                   one action publishes, starts the test and issues a link with the chosen
//                   expiry; the share URL serves the product from its test origin.
//   CR-T18 (app)    the panel shows the share URL with its QR image; the URL answers 200 with
//                   the product and no login (the 390 px phone check is publish-runtime.real.mjs).
//
// Needs an unlocked screen (recon F7): when locked the run is skipped as NOT RUN.
import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { type AppContext, chatFrame, closeApp, launchApp, runCommand } from "../fixtures/app";
import { PORT, Service, paletteRows, previewUrl, repo, screenLocked, send } from "./app-helpers";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures/kiosk-practice");
const PUBLISH = "HypeProof: 사용자 테스트용으로 공개하기";
const TEST = "HypeProof: 내 제품 테스트하기";
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
  const out = path.join(repo, "e2e/test-results/cr-app/publish-result.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(record, null, 2));
});

async function focusChat(win: Page): Promise<void> {
  const tab = win.locator(".tabs-container .tab", { hasText: "AI와 작업" }).first();
  if ((await tab.count()) > 0) await tab.click().catch(() => undefined);
}

/** GET a share URL the way a phone would reach it: its own Host, on this machine. */
function openShare(url: string): Promise<{ status: number; body: string; location: string | null }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: Number(u.port), path: u.pathname, headers: { host: u.host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, location: (res.headers.location as string | undefined) ?? null }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function openKiosk(): Promise<{ win: Page; chat: FrameLocator }> {
  await svc.start(true, "publish");
  ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  const { app, win, wsDir } = ctx;
  fs.cpSync(FIXTURE, wsDir, { recursive: true });
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
  return { win, chat: await chatFrame(win) };
}

test("CR-T02 in-app, switch off: the publish command is not reachable", async () => {
  await svc.start(false, "publish");
  ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  await send(ctx.win, "안녕");
  await expect.poll(async () => (await svc.state()).requests.length, { timeout: 60_000 }).toBeGreaterThan(0);
  const control = await paletteRows(ctx.win, PREVIEW);
  expect(control.some((r) => r.includes("HTML 미리보기")), "control: the palette instrument finds an existing command").toBe(true);
  const rows = await paletteRows(ctx.win, PUBLISH);
  expect(rows.some((r) => r.includes("사용자 테스트용으로 공개하기")), "the command is hidden with the switch off").toBe(false);
  await expect((await chatFrame(ctx.win)).locator('[data-testid="publish-panel"]')).toHaveCount(0);
  record["CR-T02-off"] = { rows };
});

test("CR-T17/CR-T18 in-app: verified only after an all-pass test of this version; one action publishes and the link serves", async () => {
  const { win, chat } = await openKiosk();
  // Before any test: the publish action says 검증 안 됨.
  await runCommand(win, PUBLISH);
  await focusChat(win);
  const panel = chat.locator('[data-testid="publish-panel"]');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(chat.locator('[data-testid="publish-verified"]')).toHaveAttribute("data-state", "not_verified", { timeout: 20_000 });
  const before = await chat.locator('[data-testid="publish-version"]').getAttribute("data-version");
  record["CR-T17-before"] = { version: before, state: "not_verified" };

  // An all-pass "내 제품 테스트" on this version (the scripted agent hands one plan per criterion).
  record["palette-test"] = await paletteRows(win, TEST);
  await win.keyboard.press("Escape").catch(() => undefined);
  await runCommand(win, TEST);
  await focusChat(win);
  try {
    await expect(chat.locator('[data-testid="verify-panel"]')).toBeVisible({ timeout: 20_000 });
  } catch (e) {
    record["verify-panel-missing"] = { notices: await chat.locator(".hps-page-notice").allInnerTexts().catch(() => []), frames: win.frames().length };
    throw e;
  }
  const inputs = chat.locator('[data-testid="verify-criterion-input"]');
  await expect(inputs.first()).toBeVisible({ timeout: 20_000 });
  await inputs.first().fill("주문 시작을 누르면 음료 고르기가 보인다");
  await chat.locator('[data-testid="verify-start"]').click();
  // The first run on a freshly opened preview can read its page log as started late and
  // leave the criterion "확인 안 됨" (pre-existing on origin/main 9e0854af, recorded in the
  // plan as a cr-publish finding). "같은 조건으로 다시 테스트" re-runs the same plan on the same
  // version; only an all-pass report on this version may read 검증됨 either way.
  await expect(chat.locator('[data-testid="verify-result"]')).toHaveCount(1, { timeout: 180_000 });
  await expect(chat.locator('[data-testid="verify-running"]')).toHaveCount(0, { timeout: 60_000 });
  const firstRun = await chat.locator('[data-testid="verify-status"]').getAttribute("data-state");
  record["verify-first-run"] = firstRun;
  if (firstRun !== "verified") {
    const run = await chat.locator('[data-testid="verify-report"]').getAttribute("data-run");
    await chat.locator('[data-testid="verify-retest"]').click();
    await expect.poll(async () => chat.locator('[data-testid="verify-report"]').getAttribute("data-run"), { timeout: 120_000 }).not.toBe(run);
    await expect(chat.locator('[data-testid="verify-running"]')).toHaveCount(0, { timeout: 60_000 });
  }
  try {
    await expect(chat.locator('[data-testid="verify-status"]')).toHaveAttribute("data-state", "verified", { timeout: 60_000 });
  } catch (e) {
    const verify = ((await (await fetch(`http://127.0.0.1:${PORT}/__cr/state`)).json()) as { verify: unknown[] }).verify;
    fs.mkdirSync(path.join(repo, "e2e/test-results/cr-app"), { recursive: true });
    fs.writeFileSync(path.join(repo, `e2e/test-results/cr-app/publish-verify-diag-${Date.now()}.json`), JSON.stringify({ results: await chat.locator('[data-testid="verify-result"]').allInnerTexts().catch(() => []), panel: await chat.locator('[data-testid="verify-panel"]').innerText().catch(() => null), verify }, null, 2));
    throw e;
  }

  // The publish action now reads 검증됨 for the same version.
  await runCommand(win, PUBLISH);
  await focusChat(win);
  await expect(chat.locator('[data-testid="publish-verified"]')).toHaveAttribute("data-state", "verified", { timeout: 20_000 });
  expect(await chat.locator('[data-testid="publish-version"]').getAttribute("data-version")).toBe(before);

  // One action: hypothesis, question, criteria, channel and an explicit expiry.
  const form = chat.locator('[data-testid="publish-form"]');
  await form.locator('textarea[aria-label="가설"]').fill("처음 쓰는 사람도 혼자 주문할 수 있다");
  await form.locator('input[aria-label="질문"]').fill("도움 없이 주문을 마칠 수 있나?");
  await form.locator('textarea[aria-label="성공 기준"]').fill("5명 중 3명이 주문 완료");
  await form.locator('input[aria-label="채널"]').fill("학교 게시판");
  await expect(chat.locator('[data-testid="publish-submit"]'), "no expiry chosen yet: the action waits (CR-19)").toBeDisabled();
  await chat.locator('[data-testid="publish-expiry-3"]').check();
  const t0 = Date.now();
  await chat.locator('[data-testid="publish-submit"]').click();
  const shareLine = chat.locator('[data-testid="publish-share-url"]');
  await expect(shareLine).toBeVisible({ timeout: 30_000 });
  const publishMs = Date.now() - t0;
  const shareUrl = (await shareLine.locator("code").innerText()).trim();
  await expect(chat.locator('[data-testid="publish-qr"]')).toHaveCount(1);
  const first = await openShare(shareUrl);
  expect(first.status, "the share URL leads to the entry page").toBe(302);
  const page = await openShare(new URL(first.location!, shareUrl).href);
  expect(page.status).toBe(200);
  expect(page.body).toContain("어르신도 쉬운 키오스크");
  expect(page.body).not.toMatch(/type="password"|로그인/);
  record["CR-T17-app"] = { shareUrl, publishMs, verified: true };

  // A file change makes another version: the publish action no longer says 검증됨.
  const { wsDir } = ctx!;
  fs.appendFileSync(path.join(wsDir, "index.html"), "\n<!-- 바뀜 -->\n");
  await runCommand(win, PUBLISH);
  await focusChat(win);
  await expect(chat.locator('[data-testid="publish-verified"]')).not.toHaveAttribute("data-state", "verified", { timeout: 20_000 });
  record["CR-T17-after-change"] = { state: await chat.locator('[data-testid="publish-verified"]').getAttribute("data-state") };
  // CR-22 in the panel: the running experiment stays on the version it pinned.
  await expect(chat.locator('[data-testid="publish-experiment"]').first()).toContainText("이 실험은 계속 이 버전을 보여 줘요");
  expect(PORT).toBeGreaterThan(0);
});
