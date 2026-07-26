// B1 · B2 · C2 · C5 — 큐시트 앞 구간과 UI 회귀. 한 세션에서 순서대로 본다.
//
// 루브릭: docs/rubric-boah-cuesheet-runthrough.md
//   B1  Reference First (19:30) — URL만으로 초안. 코치가 브라우저로 실제로 읽는가
//   B2  Context Engineering (19:45) — 맥락 주입 전후 결과가 실제로 달라지는가
//   C2  끝난 턴에 진행 표시가 안 남는가 (#429 회귀)
//   C5  응답 중에도 입력이 되는가 (#416 회귀)
//
// B1→B2 는 같은 세션에서 이어져야 의미가 있다. 맥락 주입의 효과는 "주입 전"이
// 있어야 잴 수 있으므로 한 스펙에 묶는다.
//
//   cd e2e && HPS_APP_PATH="/Applications/HypeProof Studio.app" \
//     HPS_E2E_PROXY_URL="https://api.hypeproof-ai.xyz/v1" \
//     npx playwright test b1-b2 --reporter=line

import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import { launchApp, closeApp, openChatContainer, type AppContext } from "../fixtures/app.ts";
import { resetWorkspace } from "../fixtures/workspace.ts";
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

const modalLog: string[] = [];

function startApprover(win: Page): { stop: () => void } {
  let alive = true;
  void (async () => {
    while (alive) {
      try {
        const box = win.locator(".monaco-dialog-box").first();
        if (await box.isVisible().catch(() => false)) {
          const t = ((await box.textContent().catch(() => "")) ?? "").trim();
          if (t && !modalLog.includes(t)) modalLog.push(t);
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

/** 스트리밍 중인가 — 진행 표시 두 형태를 모두 본다 (ChatPanel.tsx 렌더 분기). */
async function isBusy(cf: FrameLocator): Promise<boolean> {
  const last = cf.locator(".hps-msg-assistant").last();
  if ((await last.locator(".hps-code-progress").count().catch(() => 0)) > 0) return true;
  const t = ((await last.locator(".hps-msg-body").textContent().catch(() => "")) ?? "").trim();
  return t.startsWith(THINKING) && t.length < 40;
}

async function send(cf: FrameLocator, text: string): Promise<number> {
  const ta = cf.locator(".hps-input textarea").first();
  await ta.waitFor({ state: "visible", timeout: 30_000 });
  const before = await cf.locator(".hps-msg-assistant").count();
  await ta.fill(text, { force: true });
  await ta.press("Enter");
  return before;
}

async function settle(cf: FrameLocator, win: Page, before: number, timeoutMs = 900_000): Promise<string> {
  await expect
    .poll(async () => cf.locator(".hps-msg-assistant").count(), { timeout: 120_000, intervals: [2_000] })
    .toBeGreaterThan(before);
  const body = cf.locator(".hps-msg-assistant .hps-msg-body").last();
  const deadline = Date.now() + timeoutMs;
  let last = "", stable = 0;
  while (Date.now() < deadline) {
    await win.waitForTimeout(4_000);
    if (await isBusy(cf)) { stable = 0; last = ((await body.textContent().catch(() => "")) ?? ""); continue; }
    const now = ((await body.textContent().catch(() => "")) ?? "");
    if (now === last && now.length > 0) stable++; else { stable = 0; last = now; }
    if (stable >= 3) break;
  }
  if (Date.now() >= deadline) console.log("[settle] ⚠ 타임아웃");
  return last;
}

async function ask(cf: FrameLocator, win: Page, text: string, timeoutMs = 900_000): Promise<string> {
  return settle(cf, win, await send(cf, text), timeoutMs);
}

test("B1·B2·C2·C5 — 앞 구간과 UI 회귀", async () => {
  test.setTimeout(3_600_000);
  const ctx: AppContext = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  const approver = startApprover(ctx.win);
  const verdict: string[] = [];
  const transcript: string[] = [];

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
    resetWorkspace(ws);   // 더러운 상태로 재면 "만들었는가"와 "이미 있었는가"가 구분되지 않는다
    const target = path.join(ws, "index.html");
    if (fs.existsSync(target)) fs.rmSync(target);
    console.log(`[WS] ${ws}`);

    // ── C5 — 응답 중에도 입력이 되는가 (#416 회귀) ──────────────────────────
    // B1 요청을 보내고, 스트리밍이 도는 동안 입력창에 타이핑을 시도한다.
    const b1Before = await send(
      cf,
      "참고 사이트 https://boaclinic.com 이 화면처럼 우리 치과 홈페이지 첫 버전을 만들어줘. " +
      "스크린샷은 안 붙일게. 병원 이름은 정담치과. index.html 로 저장해줘. 승인은 바로 눌러줄게.",
    );
    // 스트리밍이 시작될 때까지 기다렸다가, 도는 중에 입력을 시도한다.
    let sawBusy = false;
    for (let i = 0; i < 30 && !sawBusy; i++) {
      await ctx.win.waitForTimeout(2_000);
      sawBusy = await isBusy(cf);
    }
    let c5typed = false;
    if (sawBusy) {
      const ta = cf.locator(".hps-input textarea").first();
      const probe = "응답 중 입력 테스트";
      await ta.fill(probe, { force: true }).catch(() => undefined);
      const got = await ta.inputValue().catch(() => "");
      c5typed = got === probe;
      await ta.fill("", { force: true }).catch(() => undefined);   // 예약 전송 방지
    }
    console.log(`[C5] 스트리밍 관측: ${sawBusy} · 입력 가능: ${c5typed}`);
    verdict.push(`C5 응답 중 입력   : ${sawBusy ? (c5typed ? "PASS" : "FAIL") : "SKIP (스트리밍 미관측)"}`);

    const b1 = await settle(cf, ctx.win, b1Before, 1_500_000);
    transcript.push(`### B1 — Reference First (URL만)\n${b1}`);

    // ── B1 — URL만으로 초안이 나오는가 + 브라우저로 실제로 읽었는가 ──────────
    const b1Made = fs.existsSync(target)
      || /<!doctype html/i.test(b1) || /<html/i.test(b1);
    const browserUsed = modalLog.some((m) => /openBrowser|브라우저 열기|boaclinic/i.test(m));
    const demandedScreenshot = /스크린샷.*(?:주|붙여|필요|없으면)/.test(b1) && !b1Made;
    console.log(`[B1] 초안 생성: ${b1Made} · 브라우저 사용: ${browserUsed} · 스크린샷 요구: ${demandedScreenshot}`);
    verdict.push(`B1 URL만으로 초안 : ${b1Made ? "PASS" : "FAIL"}`);
    verdict.push(`B1 브라우저 실사용 : ${browserUsed ? "PASS" : "FAIL (정답지를 안 읽음)"}`);

    const v1 = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : (b1.match(/<!doctype html[\s\S]*?<\/html>/i)?.[0] ?? "");
    artifact("b1-v1.html", v1);

    // ── C2 — 끝난 턴에 진행 표시가 안 남는가 (#429 회귀) ────────────────────
    // 새 턴을 시작하고, 스트리밍 중에 **이전** 메시지들에 진행 표시가 붙는지 본다.
    const c2Before = await send(cf, "방금 만든 화면에서 가장 눈에 띄는 문제 한 가지만 짧게 말해줘.");
    let staleOnOld = -1;
    for (let i = 0; i < 40; i++) {
      await ctx.win.waitForTimeout(2_000);
      if (!(await isBusy(cf))) continue;
      const all = cf.locator(".hps-msg-assistant");
      const n = await all.count();
      let stale = 0;
      for (let k = 0; k < n - 1; k++) {   // 마지막(=지금 스트리밍) 제외
        stale += await all.nth(k).locator(".hps-code-progress").count().catch(() => 0);
      }
      staleOnOld = stale;
      break;
    }
    console.log(`[C2] 이전 메시지의 진행 표시 개수: ${staleOnOld}`);
    verdict.push(`C2 끝난 턴 표시   : ${staleOnOld === 0 ? "PASS" : staleOnOld < 0 ? "SKIP (스트리밍 미관측)" : `FAIL (${staleOnOld}개 잔존)`}`);
    const c2 = await settle(cf, ctx.win, c2Before, 900_000);
    transcript.push(`### C2 턴\n${c2}`);

    // ── B2 — 맥락 주입 전후가 실제로 달라지는가 ─────────────────────────────
    const b2 = await ask(
      cf, ctx.win,
      "우리 병원 맥락을 줄게. 어필 포인트는 '야간진료와 주차 2시간 무료', " +
      "가장 밀고 싶은 진료는 '임플란트', 주요 환자층은 '40~60대 직장인', " +
      "톤은 '조용하고 신뢰감 있게', 첫 화면에서 바로 '전화 예약'이 보이면 좋겠어. " +
      "이 맥락을 반영해서 index.html 을 고쳐줘. 승인은 바로 눌러줄게.",
      1_500_000,
    );
    transcript.push(`### B2 — Context Engineering\n${b2}`);
    const v2 = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    artifact("b2-v2.html", v2);

    // 주입한 맥락이 산출물에 실제로 반영됐는가 — 말이 아니라 파일로.
    const reflected = {
      야간진료: /야간|저녁|밤/.test(v2),
      주차: /주차/.test(v2),
      임플란트강조: (v2.match(/임플란트/g) ?? []).length >= 2,
      전화예약: /전화|tel:/.test(v2),
    };
    const rn = Object.values(reflected).filter(Boolean).length;
    const changed = v1.length > 0 && v2.length > 0 && v1 !== v2;
    console.log(`[B2] 변경: ${changed} · 맥락 반영: ${JSON.stringify(reflected)} → ${rn}/4`);
    verdict.push(`B2 산출물 변화    : ${changed ? "PASS" : "FAIL (동일)"}`);
    verdict.push(`B2 맥락 반영      : ${rn}/4 ${rn >= 3 ? "PASS" : "FAIL"}`);

    artifact("b1b2-transcript.md", transcript.join("\n\n---\n\n"));
    artifact("b1b2-verdict.txt", verdict.join("\n") + "\n\n--- 모달 ---\n" + modalLog.join("\n\n"));

    console.log("\n──────── 판정 ────────");
    verdict.forEach((v) => console.log("  " + v));
    console.log("──────────────────────\n");

    expect(b1Made, "B1: URL만 줘도 초안이 나와야 한다").toBe(true);
    expect(changed, "B2: 맥락 주입 후 산출물이 달라져야 한다").toBe(true);
    expect(staleOnOld, "C2: 끝난 턴에 진행 표시가 남으면 안 된다 (#429)").toBeLessThanOrEqual(0);
  } finally {
    approver.stop();
    await closeApp(ctx);
  }
});
