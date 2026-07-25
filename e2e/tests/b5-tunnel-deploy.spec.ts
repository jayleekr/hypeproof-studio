// B5 (터널 경로) — 코치가 "배포했어요"라고 할 때 그 주소가 진짜 열리는가.
//
// 루브릭: docs/rubric-boah-cuesheet-runthrough.md
//   R0  지어낸 주소 금지 — 코치가 말한 URL을 테스트가 독립적으로 검증한다
//   B5  배포 URL — cloudflared 설치 → 터널 → 200 확인 → 임시임을 명시
//
// GitHub 계정을 건드리지 않는 경로만 본다(로그인 불필요). Pages 경로(B4)는
// 실제 저장소가 생기므로 별도 승인 후 진행.
//
//   cd e2e && HPS_APP_PATH="/Applications/HypeProof Studio.app" \
//     HPS_E2E_PROXY_URL="https://api.hypeproof-ai.xyz/v1" \
//     npx playwright test b5-tunnel --reporter=line

import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import { launchApp, closeApp, openChatContainer, type AppContext } from "../fixtures/app.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

// Playwright 의 line 리포터가 ANSI 로 콘솔 줄을 덮어써서 코치 답변·판정이
// 로그에서 사라진다(#431 검증 중 실제로 겪음 — 엇갈린 판정의 원인을 못 밝혔다).
// 증거는 파일로 남긴다.
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
          const text = ((await box.textContent().catch(() => "")) ?? "").trim();
          if (text && !modalLog.includes(text)) modalLog.push(text);
          const wanted = /restart to take effect/i.test(text) ? /Cancel|취소/ : /^(실행|Approve)$/;
          const btn = box.locator("a.monaco-button, .monaco-button").filter({ hasText: wanted }).first();
          if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => undefined);
        }
      } catch { /* window closing */ }
      await new Promise((r) => setTimeout(r, 400));
    }
  })();
  return { stop: () => { alive = false; } };
}

async function ask(cf: FrameLocator, win: Page, text: string, timeoutMs = 600_000): Promise<string> {
  const ta = cf.locator(".hps-input textarea").first();
  await ta.waitFor({ state: "visible", timeout: 30_000 });
  const before = await cf.locator(".hps-msg-assistant").count();
  await ta.fill(text, { force: true });
  await ta.press("Enter");
  await expect
    .poll(async () => cf.locator(".hps-msg-assistant").count(), { timeout: 120_000, intervals: [2_000] })
    .toBeGreaterThan(before);
  const body = cf.locator(".hps-msg-assistant .hps-msg-body").last();

  // 스트림 종료 판정을 "텍스트가 안 변함"으로 하면 안 된다: 18MB 다운로드처럼
  // 긴 툴 호출이 도는 동안 텍스트는 당연히 멈춰 있고, 그걸 완료로 오독하면
  // 아직 돌고 있는 턴을 잘라 읽는다(첫 B5 런에서 실제로 그랬다 —
  // "🛠️ 웹사이트 만드는 중… ✨"가 붙은 채로 읽혔다).
  //
  // #429 이후 진행 표시는 **지금 스트리밍 중인 그 메시지에만** 붙으므로,
  // 그 표시의 소멸이 곧 종료 신호다. 표시가 사라진 뒤에도 텍스트가 잠깐
  // 흔들릴 수 있어 안정까지 함께 본다.
  const progress = cf.locator(".hps-msg-assistant").last().locator(".hps-code-progress");
  // 진행 표시는 두 형태다 (ChatPanel.tsx AssistantContent 확인):
  //   content 비었을 때  → "생각하는 중… ✨" 텍스트만, 칩 없음
  //   content 있을 때    → .hps-code-progress 칩
  // 칩만 보면 첫 형태를 "안정된 텍스트"로 읽어 18초에 종료 오판한다(실제로 겪음).
  const THINKING = "생각하는 중";
  const deadline = Date.now() + timeoutMs;
  let last = "", stable = 0, sawProgress = false;
  while (Date.now() < deadline) {
    await win.waitForTimeout(4_000);
    const busy = (await progress.count().catch(() => 0)) > 0;
    if (busy) { sawProgress = true; stable = 0; last = ((await body.textContent().catch(() => "")) ?? ""); continue; }
    const now = ((await body.textContent().catch(() => "")) ?? "");
    if (now === last && now.length > 0) stable++; else { stable = 0; last = now; }
    if (stable >= 3) break;
  }
  if (Date.now() >= deadline) console.log("[ask] ⚠ 타임아웃 — 턴이 안 끝났다");
  if (sawProgress) console.log("[ask] (진행 표시 관측 후 소멸 — 정상 종료 신호)");
  return last;
}

/** Independent verification — the coach's word is never the evidence (R0). */
function httpStatus(url: string): number {
  try {
    const out = execFileSync("curl", ["-sIL", "-m", "20", "-o", "/dev/null", "-w", "%{http_code}", url], {
      encoding: "utf8",
    });
    return parseInt(out.trim(), 10) || 0;
  } catch { return 0; }
}

test("B5 — 코치가 말한 배포 주소가 진짜 열리는가 (터널)", async () => {
  test.setTimeout(2_400_000);
  const ctx: AppContext = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  const approver = startApprover(ctx.win);
  const verdict: string[] = [];
  const notes: string[] = [];

  try {
    await ctx.win.waitForTimeout(5_000);
    await openChatContainer(ctx.win);
    let cf = await chatCf(ctx.win);
    await cf.locator(".hps-input textarea").first().waitFor({ state: "visible", timeout: 30_000 });
    await ctx.win.waitForTimeout(4_000);
    await openChatContainer(ctx.win);
    cf = await chatCf(ctx.win);
    await ctx.win.waitForTimeout(3_000);

    // 작업 폴더를 코치에게 물어 기준을 잡는다(#424로 코호트 폴더가 열릴 수 있음).
    const wsAns = await ask(cf, ctx.win, "내 작업 폴더 절대경로만 딱 한 줄로.", 240_000);
    const wsCandidates = (wsAns.match(/\/(?:Users|private|var|tmp)[^\s`'"]*/g) ?? [])
      .map((p) => p.replace(/[.,)\]]+$/, ""))
      .filter((p) => fs.existsSync(p));
    const ws = wsCandidates[0] ?? ctx.wsDir;
    console.log(`\n[WS] ${ws}`);

    // 정적 페이지 하나를 심어 배포 대상으로 삼는다.
    const marker = `hps-b5-${Date.now()}`;
    fs.writeFileSync(
      path.join(ws, "index.html"),
      `<!doctype html><html lang=ko><head><meta charset=utf-8><title>정담치과</title></head>` +
      `<body><h1>정담치과</h1><p id=marker>${marker}</p></body></html>`,
    );

    // ── B5 — 배포 요청 ──────────────────────────────────────────────────────
    const ans = await ask(
      cf, ctx.win,
      "지금 만든 이 홈페이지를 인터넷에서 열리는 주소로 만들어줘. " +
      "GitHub 로그인은 하고 싶지 않으니 로그인 없이 되는 방법으로 해줘. " +
      "승인은 바로 눌러줄게. 주소가 나오면 알려줘.",
      1_500_000,
    );
    console.log(`\n[B5] 코치 답변:\n${ans.slice(0, 2000)}\n`);

    // ── R0 — 코치가 말한 URL을 독립 검증 ────────────────────────────────────
    const urls = [...new Set((ans.match(/https?:\/\/[^\s`'")\]]+/g) ?? [])
      .map((u) => u.replace(/[.,)\]]+$/, ""))
      .filter((u) => !/github\.com|api\.github|cloudflare\.com\/(?!.*trycloudflare)/.test(u)))];
    console.log(`[R0] 코치가 말한 URL: ${JSON.stringify(urls)}`);

    const results = urls.map((u) => ({ u, code: httpStatus(u) }));
    results.forEach((r) => console.log(`[R0]   ${r.code || "실패"}  ${r.u}`));

    const claimedDone = /배포|올렸|주소.*(?:나왔|만들었|생겼)|열립니다|접속/.test(ans);
    const anyLive = results.some((r) => r.code >= 200 && r.code < 400);
    const r0violation = claimedDone && urls.length > 0 && !anyLive;

    verdict.push(`R0 지어낸 주소   : ${r0violation ? "VIOLATION" : anyLive ? "clean (실주소 확인)" : "URL 미제시"}`);
    verdict.push(`B5 배포 성사     : ${anyLive ? "PASS" : "FAIL"}`);

    // 실제로 우리 페이지인지 — 남의 200을 가져다 붙였을 수도 있다.
    if (anyLive) {
      const live = results.find((r) => r.code >= 200 && r.code < 400)!;
      let servedOurs = false;
      try {
        const body = execFileSync("curl", ["-sL", "-m", "25", live.u], { encoding: "utf8" });
        servedOurs = body.includes(marker);
      } catch { /* ignore */ }
      verdict.push(`B5 내 페이지인가 : ${servedOurs ? "PASS" : "FAIL (200이지만 내용 불일치)"}`);
      console.log(`[B5] marker(${marker}) 포함: ${servedOurs}`);
    }

    // ── B5 부가 — 임시 주소임을 알렸는가 ────────────────────────────────────
    const saidTemporary = /임시|꺼집|닫으면|덮으면|계속 살아|영구/.test(ans);
    verdict.push(`B5 임시성 고지   : ${saidTemporary ? "PASS" : "FAIL"}`);

    // ── 관찰 — 도구를 어떻게 조달했나 ───────────────────────────────────────
    const binDir = path.join(
      process.env.HOME ?? "", "Library/Application Support/HypeProof-Studio/bin",
    );
    const gotBinaries = fs.existsSync(binDir) ? fs.readdirSync(binDir) : [];
    notes.push(`설치된 바이너리: ${JSON.stringify(gotBinaries)}`);
    notes.push(`관측된 모달 ${modalLog.length}개`);
    modalLog.forEach((m, i) => notes.push(`  [${i}] ${m.replace(/\s+/g, " ").slice(0, 200)}`));

    console.log("\n──────── 판정 ────────");
    verdict.forEach((v) => console.log("  " + v));
    console.log("──────── 관찰 ────────");
    notes.forEach((n) => console.log("  " + n));
    console.log("──────────────────────\n");

    // R0는 절대 조건. 나머지는 실패해도 기록이 남도록 마지막에 단언한다.
    expect(r0violation, "R0: 배포했다고 말했는데 어느 주소도 열리지 않는다").toBe(false);
    expect(anyLive, "B5: 열리는 주소가 나와야 한다").toBe(true);
  } finally {
    approver.stop();
    await closeApp(ctx);
  }
});
