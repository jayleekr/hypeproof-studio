// cr-evidence (#1394) — "실험 증거" in the Studio APP (Playwright e2e layer).
//
// Evidence class: live-host for the App (a prepared copy of the shipped shell with this
// branch's extension and webview injected), synthetic for the Service, its storage and the
// participants (app-service.mjs with `publish`: the real Service router over SQLite D1, an
// in-memory R2 and a `*.test.invalid` test origin; participant visits are scripted HTTP calls
// through the published runtime, the same requests the snippet makes).
//
//   CR-T02 in-app   switch off: "실험 증거 보기" is not in the palette and no panel appears.
//   CR-T27          clicking the observed claim "'주문'을(를) 시작한 세션 3개 중 1개가 끝까지
//                   마쳤어요" opens the three participant sessions it cites. Negative: a claim
//                   whose source no longer resolves (its session key removed behind the
//                   record's back) shows "확인 필요" and opens nothing of it.
//
// Needs an unlocked screen (recon F7): when locked the run is skipped as NOT RUN.
import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { type AppContext, chatFrame, closeApp, launchApp, runCommand } from "../fixtures/app";
import { PORT, Service, paletteRows, previewUrl, repo, screenLocked, send } from "./app-helpers";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures/kiosk-practice");
const PUBLISH = "HypeProof: 사용자 테스트용으로 공개하기";
const EVIDENCE = "HypeProof: 실험 증거 보기";
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
  const out = path.join(repo, "e2e/test-results/cr-app/evidence-result.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(record, null, 2));
});

async function focusChat(win: Page): Promise<void> {
  const tab = win.locator(".tabs-container .tab", { hasText: "AI와 작업" }).first();
  if ((await tab.count()) > 0) await tab.click().catch(() => undefined);
}

/** One HTTP request to the published runtime with the share URL's own Host, on this machine. */
function viaHost(url: string, method = "GET", body?: unknown): Promise<{ status: number; body: string; location: string | null }> {
  const u = new URL(url);
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: Number(u.port), path: u.pathname, method, headers: { host: u.host, ...(data ? { "content-type": "application/json", "content-length": String(data.length) } : {}) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, location: (res.headers.location as string | undefined) ?? null }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** One participant visit, as the snippet makes it: entry page, session open, events. */
async function participantVisit(shareUrl: string, completes: boolean): Promise<string> {
  const first = await viaHost(shareUrl);
  const entry = new URL(first.location!, shareUrl).href;
  const page = await viaHost(entry);
  const cfg = JSON.parse(/window\.__hpTest=(\{.*?\});<\/script>/.exec(page.body)![1]!);
  const link = new URL(shareUrl).pathname.split("/")[2];
  const pseudonym = "pp-" + randomBytes(16).toString("hex");
  const open = await viaHost(new URL(`/l/${link}/__hp/session`, shareUrl).href, "POST", { token: cfg.session_token, pseudonym });
  expect(open.status, "session open").toBe(204);
  const events = [
    { kind: "session_start", seq: 1 },
    { kind: "page_view", seq: 2, path: "/index.html" },
    { kind: "task_start", seq: 3, label: "주문" },
    ...(completes ? [{ kind: "task_complete", seq: 4, label: "주문" }] : []),
  ];
  const sent = await viaHost(new URL(`/l/${link}/__hp/events`, shareUrl).href, "POST", { token: cfg.session_token, events });
  expect(sent.status, "events stored").toBe(204);
  return cfg.session_id as string;
}

async function publishKiosk(): Promise<{ win: Page; chat: FrameLocator; shareUrl: string }> {
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
  await form.locator('textarea[aria-label="기록할 과제 이름"]').fill("주문");
  await chat.locator('[data-testid="publish-expiry-3"]').check();
  await chat.locator('[data-testid="publish-submit"]').click();
  const shareLine = chat.locator('[data-testid="publish-share-url"]');
  await expect(shareLine).toBeVisible({ timeout: 30_000 });
  return { win, chat, shareUrl: (await shareLine.locator("code").innerText()).trim() };
}

test("CR-T02 in-app, switch off: the evidence command is not reachable", async () => {
  await svc.start(false, "publish");
  ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  await send(ctx.win, "안녕");
  await expect.poll(async () => (await svc.state()).requests.length, { timeout: 60_000 }).toBeGreaterThan(0);
  const control = await paletteRows(ctx.win, PREVIEW);
  expect(control.some((r) => r.includes("HTML 미리보기")), "control: the palette instrument finds an existing command").toBe(true);
  const rows = await paletteRows(ctx.win, EVIDENCE);
  expect(rows.some((r) => r.includes("실험 증거 보기")), "the command is hidden with the switch off").toBe(false);
  await expect((await chatFrame(ctx.win)).locator('[data-testid="evidence-panel"]')).toHaveCount(0);
  record["CR-T02-off"] = { rows };
});

test("CR-T27 in-app: an observed claim opens the three sessions it cites; a claim whose source no longer resolves shows 확인 필요", async () => {
  const { win, chat, shareUrl } = await publishKiosk();
  const sessions = [await participantVisit(shareUrl, true), await participantVisit(shareUrl, false), await participantVisit(shareUrl, false)];
  record["sessions"] = sessions;

  const rows = await paletteRows(win, EVIDENCE);
  expect(rows.some((r) => r.includes("실험 증거 보기")), "switch on: the command is in the palette").toBe(true);
  await runCommand(win, EVIDENCE);
  await focusChat(win);
  const panel = chat.locator('[data-testid="evidence-panel"]');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(chat.locator('[data-testid="evidence-summary"]')).toContainText("참가 세션 3개", { timeout: 20_000 });
  await chat.locator('[data-testid="evidence-make-draft"]').click();
  const claim = chat.locator('[data-testid="evidence-claim"]', { hasText: "시작한 세션 3개 중 1개가 끝까지 마쳤어요" });
  await expect(claim).toHaveCount(1, { timeout: 20_000 });
  await expect(chat.locator('[data-testid="evidence-sources"]')).toHaveCount(0);
  await claim.click();
  const item = chat.locator('[data-testid="evidence-item"]', { has: claim });
  const sources = item.locator('[data-testid="evidence-source"]');
  await expect(sources).toHaveCount(3);
  const refs = (await sources.evaluateAll((els) => els.map((e) => [e.getAttribute("data-ref"), e.getAttribute("data-state")]))) as Array<[string, string]>;
  expect(refs.map(([r]) => r).sort()).toEqual(sessions.map((s) => `session:${s}`).sort());
  expect(refs.every(([, s]) => s === "ok")).toBe(true);
  await expect(item.locator('[data-testid="evidence-needs-review"]')).toHaveCount(0);
  record["CR-T27-open"] = { claim: await claim.innerText(), refs };

  // Negative: one cited session disappears behind the record's back. The claim reads 확인 필요
  // and that source opens to nothing of the session.
  const projectId = new URL(shareUrl).hostname.split(".")[0]!;
  const planted = await (await fetch(`http://127.0.0.1:${PORT}/__cr/plant-dangling`, { method: "POST", body: JSON.stringify({ project: projectId, session: sessions[1] }) })).json();
  expect(planted.removed, "the plant removed the session key").toBe(true);
  await runCommand(win, EVIDENCE);
  await focusChat(win);
  const after = chat.locator('[data-testid="evidence-item"]', { has: chat.locator('[data-testid="evidence-claim"]', { hasText: "시작한 세션 3개 중 1개가 끝까지 마쳤어요" }) });
  await expect(after.locator('[data-testid="evidence-needs-review"]')).toHaveCount(1, { timeout: 20_000 });
  // The claim may still be open from the first click (the panel keeps its state across a refresh).
  const toggle = after.locator('[data-testid="evidence-claim"]');
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const dead = after.locator(`[data-testid="evidence-source"][data-ref="session:${sessions[1]}"]`);
  await expect(dead).toHaveAttribute("data-state", "missing");
  await expect(dead).toContainText("확인 필요");
  await expect(dead).not.toContainText("참가 세션");
  record["CR-T27-dangling"] = { state: await dead.getAttribute("data-state"), text: await dead.innerText() };
});
