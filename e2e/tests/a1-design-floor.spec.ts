// A1 — 디자인 품질 바닥. 원장이 요구하지 않아도 코치가 스스로 통과시키는가.
//
// 루브릭: docs/rubric-boah-cuesheet-runthrough.md A1
// 기준선 (HANDOFF-design-skill-ablation.md, 2026-07-24 · 체크리스트 이식 전):
//     우리 copyclone  품질바닥 0.3/4 · 아이콘 이모지
//     uiuxpm          품질바닥 4.0/4 · 아이콘 SVG
// #410에서 체크리스트를 이식했고, 오늘 그 81줄을 design-craft 스킬로 옮겼다.
// 이 스펙은 그 둘의 합산 효과를 산출물로 잰다 — 프로덕션을 건드리는 ablation 없이.
//
//   cd e2e && HPS_APP_PATH="/Applications/HypeProof Studio.app" \
//     HPS_E2E_PROXY_URL="https://api.hypeproof-ai.xyz/v1" \
//     npx playwright test a1-design --reporter=line

import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import { launchApp, closeApp, openChatContainer, type AppContext } from "../fixtures/app.ts";
import * as fs from "node:fs";
import * as path from "node:path";

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
  // 진행 표시는 두 형태다 (ChatPanel.tsx AssistantContent 확인):
  //   content 비었을 때  → "생각하는 중… ✨" 텍스트만, 칩 없음
  //   content 있을 때    → .hps-code-progress 칩
  // 칩만 보면 첫 형태를 "안정된 텍스트"로 읽어 18초에 종료 오판한다(실제로 겪음).
  const THINKING = "생각하는 중";
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
  if (Date.now() >= deadline) console.log("[ask] ⚠ 타임아웃 — 턴이 안 끝났다 (stall 의심)");
  return last;
}

/** design-craft 스킬의 「내보내기 전 체크리스트」를 산출물에서 기계 검사. */
function scoreDesignFloor(html: string) {
  const emojiIcon = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(
    html.replace(/<!--[\s\S]*?-->/g, ""),
  );
  const checks: Array<[string, boolean]> = [
    ["아이콘이 인라인 SVG (이모지 아님)", /<svg[\s>]/i.test(html) && !emojiIcon],
    ["cursor: pointer", /cursor\s*:\s*pointer/i.test(html)],
    // 패턴 매칭 대신 **값을 뽑아 범위로 판정**한다. 실제 산출물은 `.15s`/`.2s`
    // 로 쓰는데 ms 만 보는 정규식은 통과한 디자인을 미달로 오판했고(실측),
    // 단위별 정규식을 덧대는 방식도 `\b` 경계 때문에 또 틀렸다. 숫자를 꺼내
    // ms 로 환산하면 표기 방식과 무관하게 옳다.
    ["150~300ms 상태 전환", (() => {
      const decls = html.match(/transition[^;}]*/gi) ?? [];
      return decls.some((d) =>
        [...d.matchAll(/(\d*\.?\d+)\s*(ms|s)\b/gi)]
          .map((m) => (m[2].toLowerCase() === "s" ? parseFloat(m[1]) * 1000 : parseFloat(m[1])))
          .some((v) => v >= 150 && v <= 300),
      );
    })()],
    ["모든 이미지에 alt", (() => {
      const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
      return imgs.length === 0 || imgs.every((t) => /\balt\s*=/i.test(t));
    })()],
    [":focus-visible 링", /:focus-visible/i.test(html)],
    ["prefers-reduced-motion 존중", /prefers-reduced-motion/i.test(html)],
    ["viewport meta", /<meta[^>]+name=["']?viewport/i.test(html)],
    [":root CSS 색 변수", /:root[^{]*\{[^}]*--/is.test(html)],
    ["본문 line-height ≥ 1.5", /line-height\s*:\s*(1\.[5-9]|[2-9])/i.test(html)],
  ];
  const passed = checks.filter(([, ok]) => ok).length;
  return { checks, passed, total: checks.length };
}

test("A1 — 디자인 품질 바닥을 코치가 스스로 통과시키는가", async () => {
  test.setTimeout(1_800_000);
  const ctx: AppContext = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  const approver = startApprover(ctx.win);

  try {
    await ctx.win.waitForTimeout(5_000);
    await openChatContainer(ctx.win);
    let cf = await chatCf(ctx.win);
    await cf.locator(".hps-input textarea").first().waitFor({ state: "visible", timeout: 30_000 });
    await ctx.win.waitForTimeout(4_000);
    await openChatContainer(ctx.win);
    cf = await chatCf(ctx.win);
    await ctx.win.waitForTimeout(3_000);

    const wsAns = await ask(cf, ctx.win, "내 작업 폴더 절대경로만 딱 한 줄로.", 240_000);
    const ws = (wsAns.match(/\/(?:Users|private|var|tmp)[^\s`'"]*/g) ?? [])
      .map((p) => p.replace(/[.,)\]]+$/, "")).filter((p) => fs.existsSync(p))[0] ?? ctx.wsDir;

    const target = path.join(ws, "index.html");
    if (fs.existsSync(target)) fs.rmSync(target);

    // 품질 요구를 일절 하지 않는다 — A1의 핵심은 "요구하지 않아도" 통과시키는가.
    // 저수준 결정(폰트·페이지 수)도 주지 않는다: A2가 그걸 되묻는지 본다.
    const t0 = Date.now();
    const ans = await ask(
      cf, ctx.win,
      "우리 치과 홈페이지 첫 버전을 만들어줘. 병원 이름은 정담치과, " +
      "따뜻하고 편안한 느낌이면 좋겠어. 진료는 임플란트·교정·소아치과 세 개야. " +
      "index.html 로 저장해줘. 승인은 바로 눌러줄게.",
      1_500_000,
    );
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`\n[A1] 첫 턴 소요: ${elapsed}초`);
    console.log(`[A1] 코치 답변 (앞 1800자):\n${ans.slice(0, 1800)}\n`);

    // 산출물은 두 경로 중 하나로 온다. 파일만 기대하면 안 된다 — 코호트
    // 프롬프트의 기본 출력 방식은 채팅의 ```html 펜스이고(“본문은 html 블록
    // 안에 완전한 단일 문서로”), Studio가 ▶ Run 으로 미리보기한다. 파일 쓰기는
    // 참가자가 저장을 요청했을 때의 경로다. A1이 재는 것은 **산출물의 품질**이지
    // 저장 방식이 아니므로 둘 다 받는다.
    let html = "";
    let source = "";
    if (fs.existsSync(target)) {
      html = fs.readFileSync(target, "utf8");
      source = "파일(index.html)";
    } else {
      const m = ans.match(/<!doctype html[\s\S]*?<\/html>/i) ?? ans.match(/<html[\s\S]*?<\/html>/i);
      if (m) { html = m[0]; source = "채팅 펜스"; }
    }
    console.log(`[A1] 산출물 경로: ${source || "없음"} · ${html.length.toLocaleString()} chars`);
    expect(html.length, "A1: 산출물이 파일이든 펜스든 나와야 한다").toBeGreaterThan(200);

    const { checks, passed, total } = scoreDesignFloor(html);
    console.log("\n──── A1 품질 바닥 ────");
    checks.forEach(([label, ok]) => console.log(`  ${ok ? "✓" : "✗"}  ${label}`));
    console.log(`  ────────────────────`);
    console.log(`  ${passed}/${total}`);
    console.log(`  기준선(2026-07-24, 이식 전): 0.3/4 · 이모지 아이콘`);

    // A2 — 저수준 결정을 되물었는가 (프롬프트가 금지한 것)
    const lowLevel = /폰트.*(?:뭐|어떤|골라|선택)|몇 페이지|색.*(?:뭐로|어떤 걸)|어떤 폰트/.test(ans);
    console.log(`\n[A2] 저수준 질문: ${lowLevel ? "있음 (FAIL)" : "없음 (PASS)"}`);

    // D1 — 시키지도 않았는데 배포/저장소를 꺼냈는가 (희석 증상)
    const pushedDeploy = /배포|GitHub|깃허브|저장소|주소로 만들/.test(ans);
    console.log(`[D1] 배포/저장소 선제 언급: ${pushedDeploy ? "있음 (희석 의심)" : "없음"}`);

    console.log(`\n[stall] 첫 턴 ${elapsed}초 — 프롬프트 ~12.7k 토큰 기준`);

    // 기준선(0.3/4 ≒ 8%)보다 확실히 나아야 한다. 절반 미만이면 이식이 안 먹은 것.
    expect(passed / total, `A1: 품질 바닥 ${passed}/${total} — 기준선 대비 개선 없음`)
      .toBeGreaterThan(0.5);
  } finally {
    approver.stop();
    await closeApp(ctx);
  }
});
