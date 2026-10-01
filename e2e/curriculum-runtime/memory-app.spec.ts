// cr-memory (#1395) — "프로젝트 기억" in the Studio APP (Playwright e2e layer).
//
// Evidence class: live-host for the App (a prepared copy of the shipped shell with this branch's
// extension and webview injected), synthetic for the Service and its storage (app-service.mjs
// with `publish`: the real Service router over SQLite D1, an in-memory R2, a `*.test.invalid`
// test origin).
//
//   CR-T02 in-app   switch off: "프로젝트 기억 보기" is not in the palette and no panel appears.
//   CR-T36          publish (hypothesis, experiment, version), record a team decision in the
//                   panel, chat with the coach; close the app, delete every workspaceState of the
//                   workspace (the chat history and the remembered Project with it), reopen: the
//                   chat is empty and the panel shows the same hypotheses, experiments, decisions
//                   and versions. Negative: a reconstruction that mixes in the chat is caught by
//                   the same comparison.
//
// Needs an unlocked screen (recon F7): when locked the run is skipped as NOT RUN.
import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type AppContext, chatFrame, closeApp, launchApp, runCommand } from "../fixtures/app";
import { Service, paletteRows, previewUrl, repo, screenLocked, send } from "./app-helpers";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures/kiosk-practice");
const PUBLISH = "HypeProof: 사용자 테스트용으로 공개하기";
const MEMORY = "HypeProof: 프로젝트 기억 보기";
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
  const out = path.join(repo, "e2e/test-results/cr-app/memory-result.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(record, null, 2));
});

async function focusChat(win: Page): Promise<void> {
  const tab = win.locator(".tabs-container .tab", { hasText: "AI와 작업" }).first();
  if ((await tab.count()) > 0) await tab.click().catch(() => undefined);
}

async function publishKiosk(): Promise<{ win: Page; chat: FrameLocator }> {
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
  const chat = await chatFrame(win);
  await runCommand(win, PUBLISH);
  await focusChat(win);
  const form = chat.locator('[data-testid="publish-form"]');
  await expect(form).toBeVisible({ timeout: 20_000 });
  await form.locator('textarea[aria-label="가설"]').fill("처음 쓰는 사람도 혼자 주문할 수 있다");
  await form.locator('input[aria-label="질문"]').fill("도움 없이 주문을 마칠 수 있나?");
  await form.locator('textarea[aria-label="성공 기준"]').fill("5명 중 3명이 주문 완료");
  await chat.locator('[data-testid="publish-expiry-3"]').check();
  await chat.locator('[data-testid="publish-submit"]').click();
  await expect(chat.locator('[data-testid="publish-share-url"]')).toBeVisible({ timeout: 30_000 });
  return { win, chat };
}

/** What CR-36 names, read from the panel: hypotheses, experiments, decisions and versions by id. */
async function snapshot(chat: FrameLocator): Promise<string> {
  const ids = async (testid: string) => (await chat.locator(`[data-testid="${testid}"]`).evaluateAll((els) => els.map((e) => `${e.getAttribute("data-id")}|${(e.textContent ?? "").trim()}`))).sort();
  return JSON.stringify({ hypotheses: await ids("memory-hypothesis"), experiments: await ids("memory-experiment"), decisions: await ids("memory-decision"), versions: await ids("memory-version") });
}

async function openMemory(win: Page, chat: FrameLocator): Promise<void> {
  await runCommand(win, MEMORY);
  await focusChat(win);
  await expect(chat.locator('[data-testid="memory-panel"]')).toBeVisible({ timeout: 20_000 });
  await expect(chat.locator('[data-testid="memory-hypothesis"]').first()).toBeVisible({ timeout: 20_000 });
}

test("CR-T02 in-app, switch off: the memory command is not reachable", async () => {
  await svc.start(false, "publish");
  ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  await send(ctx.win, "안녕");
  await expect.poll(async () => (await svc.state()).requests.length, { timeout: 60_000 }).toBeGreaterThan(0);
  const control = await paletteRows(ctx.win, PREVIEW);
  expect(control.some((r) => r.includes("HTML 미리보기")), "control: the palette instrument finds an existing command").toBe(true);
  const rows = await paletteRows(ctx.win, MEMORY);
  expect(rows.some((r) => r.includes("프로젝트 기억 보기")), "the command is hidden with the switch off").toBe(false);
  await expect((await chatFrame(ctx.win)).locator('[data-testid="memory-panel"]')).toHaveCount(0);
  record["CR-T02-off"] = { rows };
});

test("CR-T36 in-app: close, delete chat history, reopen — the same hypotheses, experiments, decisions and versions", async () => {
  const first = await publishKiosk();
  const rows = await paletteRows(first.win, MEMORY);
  expect(rows.some((r) => r.includes("프로젝트 기억 보기")), "switch on: the command is in the palette").toBe(true);
  await openMemory(first.win, first.chat);
  // The team's decision, recorded in the panel (no evidence yet: it must say so).
  await first.chat.locator('[data-testid="memory-decision-form"] summary').click();
  await first.chat.locator('textarea[aria-label="결정"]').fill("옵션 선택을 한 단계로 줄인다");
  await first.chat.locator('[data-testid="memory-decide"]').click();
  await expect(first.chat.locator('[data-testid="memory-decision"]')).toHaveCount(1, { timeout: 20_000 });
  await expect(first.chat.locator('[data-testid="memory-no-evidence"]')).toHaveCount(1);
  const before = await snapshot(first.chat);
  const chatBefore = await first.chat.locator("text=안녕").count();
  expect(chatBefore, "control: the chat history holds the earlier message before the deletion").toBeGreaterThan(0);

  // Close without removing the profile, delete every workspaceState of the workspace, reopen.
  const userDataDir = ctx!.userDataDir;
  await ctx!.app.close();
  ctx = undefined;
  const storage = path.join(userDataDir, "User", "workspaceStorage");
  expect(fs.existsSync(storage), "control: the chat history store exists before the deletion").toBe(true);
  fs.rmSync(storage, { recursive: true, force: true });
  ctx = await launchApp({ reuseUserDataDir: userDataDir, preseedToken: true, preseedCoach: { name: "코치" } });
  const chat = await chatFrame(ctx.win);
  await focusChat(ctx.win);
  await expect(chat.locator("text=안녕"), "the chat history is gone").toHaveCount(0, { timeout: 20_000 });
  await openMemory(ctx.win, chat);
  await expect(chat.locator('[data-testid="memory-decision"]')).toHaveCount(1, { timeout: 20_000 });
  const after = await snapshot(chat);
  expect(after, "the reopened project shows the same learning state").toBe(before);
  // CR-78: a timeline entry opens its stored record in the panel; no entry is left without one.
  const entry = chat.locator('[data-testid="memory-timeline-entry"]').first();
  await entry.locator("summary").click();
  await expect(entry.locator('[data-testid="memory-record"]')).toBeVisible();
  await expect(chat.locator('[data-testid="memory-timeline-entry"][data-found="no"]')).toHaveCount(0);

  // The negative control for this comparison is not here: a planted MemorySession that also
  // reads the chat is run through the same before/after comparison and caught in
  // extensions/hypeproof-chat/test/cr-memory.smoke.mjs (CR-T36 App unit). This test's own
  // controls are that the chat history existed before the deletion and is gone after it.
  record["CR-T36"] = { before: JSON.parse(before), after: JSON.parse(after), chat_before: chatBefore };
});
