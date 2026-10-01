// cr-skills (#1396) — "커리큘럼 스킬" in the Studio APP (Playwright e2e layer).
//
// Evidence class: live-host for the App (a prepared copy of the shipped shell with this branch's
// extension and webview injected), synthetic for the Service and the model (app-service.mjs with
// `publish`: the real Service router over SQLite D1, an in-memory R2; the model is the scripted
// agent, which answers a skill prompt only from what the prompt carried).
//
//   CR-T02 in-app   switch off: "HypeProof: 커리큘럼 스킬" is not in the palette and no panel appears.
//                   switch on: the command is in the palette and the panel lists the served skills.
//   CR-T42 in-app   a run of the Experiment skill goes through the coach route with the skill tag and
//                   a capability and no model; the Service answers with the tag recorded; the panel
//                   shows the accepted result. A planted rule-breaking answer ("[cr:skill-bad]") is
//                   refused by the Service and the panel shows the problem, nothing stored.
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
const SKILLS = "HypeProof: 커리큘럼 스킬";
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
  const out = path.join(repo, "e2e/test-results/cr-app/skills-result.json");
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

test("CR-T02 in-app, switch off: the skills command is not reachable", async () => {
  await svc.start(false, "publish");
  ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  await send(ctx.win, "안녕");
  await expect.poll(async () => (await svc.state()).requests.length, { timeout: 60_000 }).toBeGreaterThan(0);
  const control = await paletteRows(ctx.win, PREVIEW);
  expect(control.some((r) => r.includes("HTML 미리보기")), "control: the palette instrument finds an existing command").toBe(true);
  const rows = await paletteRows(ctx.win, SKILLS);
  expect(rows.some((r) => r.includes("커리큘럼 스킬")), "the command is hidden with the switch off").toBe(false);
  await expect((await chatFrame(ctx.win)).locator('[data-testid="skills-panel"]')).toHaveCount(0);
  record["CR-T02-off"] = { rows };
});

test("CR-T02 on + CR-T42 in-app: the Experiment skill runs through the coach route with its tag and capability; a planted bad answer is refused", async () => {
  const { win, chat } = await publishKiosk();
  const rows = await paletteRows(win, SKILLS);
  expect(rows.some((r) => r.includes("커리큘럼 스킬")), "switch on: the command is in the palette").toBe(true);
  await runCommand(win, SKILLS);
  await focusChat(win);
  const panel = chat.locator('[data-testid="skills-panel"]');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(chat.locator('[data-testid="skills-list"] li')).toHaveCount(7, { timeout: 20_000 });
  await expect(chat.locator('[data-testid="skills-week"]')).toContainText("주차 질문:");

  await chat.locator('[data-testid="skill-experiment"]').check();
  await chat.locator('textarea[aria-label="스킬에 줄 내용"]').fill("주문 버튼이 잘 보이는지");
  await chat.locator('[data-testid="skill-run"]').click();
  const result = chat.locator('[data-testid="skill-result"]');
  await expect(result).toHaveAttribute("data-ok", "true", { timeout: 60_000 });
  await expect(result).toHaveAttribute("data-tag", "experiment@1.0.0");
  await expect(result).toContainText("성공 기준");
  const st = (await svc.state()) as unknown as { skills: Array<{ tag: string; context_keys: string[] }>; skillHeaders: Array<{ sent: { skill: string; capability: string; model_in_body: unknown }; answered: { status: number; skill: string; capability: string; model: string | null } }> };
  expect(st.skillHeaders.length).toBe(1);
  expect(st.skillHeaders[0].sent).toEqual({ skill: "experiment@1.0.0", capability: "reasoning.high", model_in_body: null });
  expect(st.skillHeaders[0].answered.skill).toBe("experiment@1.0.0");
  expect(st.skillHeaders[0].answered.capability).toBe("reasoning.high");
  expect(st.skillHeaders[0].answered.model, "the lesson model policy picked the model").toBeTruthy();
  expect(st.skills[0].context_keys).toEqual(["curriculum_week", "experiments", "hypotheses", "problem", "register"]);

  // Planted: the scripted model breaks the skill's rule (an uncountable success criterion).
  await chat.locator('textarea[aria-label="스킬에 줄 내용"]').fill("[cr:skill-bad]");
  await chat.locator('[data-testid="skill-run"]').click();
  await expect(result).toHaveAttribute("data-ok", "false", { timeout: 60_000 });
  await expect(chat.locator('[data-testid="skill-problems"]')).toContainText("not_countable");
  await expect(result).toContainText("아무것도 저장하지 않았어요");
  record["CR-T42-app"] = { headers: st.skillHeaders, skills: st.skills };
});
