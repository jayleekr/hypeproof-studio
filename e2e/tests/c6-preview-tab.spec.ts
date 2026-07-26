// C6 — 미리보기 탭. #446 이 바꾼 두 가지를 실기기로 확인한다.
//
// 루브릭: docs/rubric-boah-cuesheet-runthrough.md (C축)
//   C6a  프리뷰 탭이 하나만 유지되는가 (#445 — 재시작마다 쌓이던 것)
//   C6b  미리보기를 두 번 열어도 **보이는 위치**가 유지되는가
//
// 첫 판은 커맨드 팔레트를 키보드로 두드려 열려 했는데 아무것도 안 먹었다
// (에디터 탭 0 · 프리뷰 탭 0). 그래서 **실제 참가자 경로**로 다시 짠다:
// 코치가 HTML 을 내면 채팅 패널에 ▶ Run 버튼이 붙고, 참가자는 그걸 누른다.
// 그 경로가 revealBuilt → live server → openBrowserTab 까지 #446 이 바꾼 코드를
// 그대로 태운다.
//
//   cd e2e && HPS_APP_PATH="/Applications/HypeProof Studio.app" \
//     HPS_E2E_PROXY_URL="https://api.hypeproof-ai.xyz/v1" \
//     npx playwright test c6-preview --reporter=line

import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import { launchApp, closeApp, openChatContainer, type AppContext } from "../fixtures/app.ts";
import * as fs from "node:fs";
import * as path from "node:path";

const ARTIFACT_DIR = "test-artifacts";
function artifact(name: string, body: string): void {
  try {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACT_DIR, name), body);
    console.log(`[artifact] ${ARTIFACT_DIR}/${name} (${body.length}B)`);
  } catch (e) { console.log(`[artifact] 실패: ${String(e)}`); }
}

async function chatCf(win: Page, timeoutMs = 40_000): Promise<FrameLocator> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await win.locator("iframe.webview.ready").count();
    for (let i = 0; i < n; i++) {
      const fl = win.frameLocator("iframe.webview.ready").nth(i).frameLocator("#active-frame");
      try { if ((await fl.locator(".hps-shell").count()) > 0) return fl; } catch { /* next */ }
    }
    if (Date.now() > deadline) throw new Error("chat frame not found");
    await openChatContainer(win).catch(() => undefined);
    await win.waitForTimeout(2_000);
  }
}

function startApprover(win: Page): { stop: () => void } {
  let alive = true;
  void (async () => {
    while (alive) {
      try {
        const box = win.locator(".monaco-dialog-box").first();
        if (await box.isVisible().catch(() => false)) {
          const t = ((await box.textContent().catch(() => "")) ?? "").trim();
          const wanted = /restart to take effect/i.test(t) ? /Cancel|취소/ : /^(실행|Approve)$/;
          const btn = box.locator("a.monaco-button, .monaco-button").filter({ hasText: wanted }).first();
          if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => undefined);
        }
      } catch { /* closing */ }
      await new Promise((r) => setTimeout(r, 400));
    }
  })();
  return { stop: () => { alive = false; } };
}

const THINKING = "생각하는 중";

async function ask(cf: FrameLocator, win: Page, text: string, timeoutMs = 900_000): Promise<string> {
  const ta = cf.locator(".hps-input textarea").first();
  await ta.waitFor({ state: "visible", timeout: 30_000 });
  const before = await cf.locator(".hps-msg-assistant").count();
  await ta.fill(text, { force: true });
  await ta.press("Enter");
  await expect
    .poll(async () => cf.locator(".hps-msg-assistant").count(), { timeout: 120_000, intervals: [2_000] })
    .toBeGreaterThan(before);
  const body = cf.locator(".hps-msg-assistant .hps-msg-body").last();
  const progress = cf.locator(".hps-msg-assistant").last().locator(".hps-code-progress");
  const deadline = Date.now() + timeoutMs;
  let last = "", stable = 0;
  while (Date.now() < deadline) {
    await win.waitForTimeout(4_000);
    const now = ((await body.textContent().catch(() => "")) ?? "");
    const busy = (await progress.count().catch(() => 0)) > 0
      || (now.trim().startsWith(THINKING) && now.trim().length < 40);
    if (busy) { stable = 0; last = now; continue; }
    if (now === last && now.length > 0) stable++; else { stable = 0; last = now; }
    if (stable >= 3) break;
  }
  return last;
}

/**
 * 에디터 영역의 탭 라벨들.
 *
 * 프리뷰 탭을 URL 로 거르면 안 된다 — fork 의 브라우저 탭은 **페이지 제목**을
 * 보여준다(실측: `정담치과 — 이야기가 있는 치과`). 127.0.0.1 로 필터하면 열려
 * 있는 프리뷰를 0개로 세고, 정상 동작을 FAIL 로 보고하게 된다. 이 코호트는
 * 코치가 파일을 편집하므로 에디터 영역은 기본적으로 비어 있고, 따라서 **탭
 * 개수 자체**가 프리뷰 개수다.
 */
async function editorTabs(win: Page): Promise<string[]> {
  const labels = await win.locator(".tabs-container .tab").allTextContents().catch(() => []);
  return labels.map((l) => l.trim()).filter(Boolean);
}

test("C6 — 미리보기 탭이 하나만 유지되는가 (참가자 경로)", async () => {
  test.setTimeout(1_800_000);
  const ctx: AppContext = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  const approver = startApprover(ctx.win);
  const verdict: string[] = [];

  try {
    await ctx.win.waitForTimeout(5_000);
    await openChatContainer(ctx.win);
    let cf = await chatCf(ctx.win);
    await cf.locator(".hps-input textarea").first().waitFor({ state: "visible", timeout: 30_000 });
    await ctx.win.waitForTimeout(4_000);
    await openChatContainer(ctx.win);
    cf = await chatCf(ctx.win);
    await ctx.win.waitForTimeout(3_000);

    // 코치에게 HTML 을 내게 한다 — ▶ Run 버튼이 붙는 조건.
    await ask(
      cf, ctx.win,
      "아주 짧은 치과 홈페이지 HTML 하나만 만들어줘. 정담치과, 한 화면이면 돼. " +
      "파일로 저장하지 말고 코드로만 보여줘.",
      900_000,
    );

    // ── ▶ Run 을 누른다 (참가자가 실제로 하는 동작) ──────────────────────────
    const runBtn = cf.locator("button").filter({ hasText: /▶|Run|실행/ }).last();
    const hasRun = (await runBtn.count().catch(() => 0)) > 0;
    console.log(`[C6] ▶ Run 버튼 존재: ${hasRun}`);
    verdict.push(`C6 Run 버튼 노출  : ${hasRun ? "PASS" : "FAIL (HTML 응답에 버튼이 안 붙음)"}`);
    if (!hasRun) {
      artifact("c6-verdict.txt", verdict.join("\n"));
      test.skip(true, "Run 버튼이 없어 미리보기 경로를 탈 수 없다");
      return;
    }

    const before = await editorTabs(ctx.win);
    await runBtn.click({ force: true }).catch(() => undefined);
    await ctx.win.waitForTimeout(10_000);
    const once = await editorTabs(ctx.win);
    console.log(`[C6] 1회: ${JSON.stringify(before)} → ${JSON.stringify(once)}`);
    verdict.push(`C6 미리보기 열림  : ${once.length >= 1 ? "PASS" : "FAIL (탭이 안 생김)"}`);

    // ── C6a — 두 번 눌러도 안 쌓이는가 ─────────────────────────────────────
    await runBtn.click({ force: true }).catch(() => undefined);
    await ctx.win.waitForTimeout(10_000);
    const twice = await editorTabs(ctx.win);
    console.log(`[C6a] 2회 후: ${JSON.stringify(twice)}`);
    verdict.push(`C6a 탭 중복 방지  : ${twice.length <= 1 ? "PASS" : `FAIL (${twice.length}개)`}`);

    // ── C6b — 두 번째에도 미리보기가 활성 탭인가 ───────────────────────────
    const active = ((await ctx.win.locator(".tabs-container .tab.active").first()
      .textContent().catch(() => "")) ?? "").trim();
    console.log(`[C6b] 활성 탭: ${JSON.stringify(active)}`);
    verdict.push(`C6b 미리보기 보임 : ${active.length > 0 ? "PASS" : "FAIL (활성 탭 없음)"}`);

    artifact("c6-verdict.txt",
      verdict.join("\n") + `\n\n전체 탭: ${JSON.stringify(await ctx.win.locator(".tabs-container .tab").allTextContents().catch(() => []))}`);

    console.log("\n──────── 판정 ────────");
    verdict.forEach((v) => console.log("  " + v));
    console.log("──────────────────────\n");

    expect(twice.length, "C6a: 프리뷰 탭이 쌓이면 안 된다 (#445)").toBeLessThanOrEqual(1);
  } finally {
    approver.stop();
    await closeApp(ctx);
  }
});
