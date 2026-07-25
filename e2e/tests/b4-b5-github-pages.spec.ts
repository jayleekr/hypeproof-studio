// B4 + B5(Pages) — 큐시트 20:35 블록 전체. 저장소와 영구 배포 주소.
//
// 루브릭: docs/rubric-boah-cuesheet-runthrough.md
//   R0  지어낸 주소 금지 — 테스트가 독립 검증
//   B4  저장소 — git 호출 0회, gh API로 생성·업로드, 실재 확인
//   B5  배포 URL — Pages 활성 → 200 → 내 페이지인지 확인
//
// 실제 GitHub 저장소를 만든다. 이름에 날짜와 목적이 드러나게 지어서 나중에
// 지울 수 있게 한다. 토큰에 delete_repo 스코프가 없어 자동 삭제는 못 한다.
//
//   cd e2e && HPS_APP_PATH="/Applications/HypeProof Studio.app" \
//     HPS_E2E_PROXY_URL="https://api.hypeproof-ai.xyz/v1" \
//     npx playwright test b4-b5 --reporter=line

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
  // #429 — 진행 표시는 스트리밍 중인 메시지에만 붙는다. 그 소멸이 종료 신호.
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
  if (Date.now() >= deadline) console.log("[ask] ⚠ 타임아웃 — 턴이 안 끝났다");
  return last;
}

function httpStatus(url: string): number {
  try {
    return parseInt(execFileSync("curl",
      ["-sIL", "-m", "25", "-o", "/dev/null", "-w", "%{http_code}", url],
      { encoding: "utf8" }).trim(), 10) || 0;
  } catch { return 0; }
}

test("B4+B5 — 저장소와 영구 배포 주소가 실재하는가", async () => {
  test.setTimeout(2_400_000);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const repo = `hps-rubric-b4-${stamp}-${String(Date.now()).slice(-5)}`;
  const owner = execFileSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8" }).trim();
  const marker = `hps-b4-${Date.now()}`;
  console.log(`\n[SETUP] owner=${owner} repo=${repo} marker=${marker}`);

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

    const wsAns = await ask(cf, ctx.win, "내 작업 폴더 절대경로만 딱 한 줄로.", 240_000);
    const ws = (wsAns.match(/\/(?:Users|private|var|tmp)[^\s`'"]*/g) ?? [])
      .map((p) => p.replace(/[.,)\]]+$/, "")).filter((p) => fs.existsSync(p))[0] ?? ctx.wsDir;
    console.log(`[WS] ${ws}`);

    fs.writeFileSync(
      path.join(ws, "index.html"),
      `<!doctype html><html lang=ko><head><meta charset=utf-8><title>정담치과</title></head>` +
      `<body><h1>정담치과</h1><p id=marker>${marker}</p></body></html>`,
    );

    // ── B4 + B5 — 한 요청으로 20:35 블록 전체 ────────────────────────────────
    const ans = await ask(
      cf, ctx.win,
      `이 홈페이지를 내 GitHub 저장소에 올리고, 집에 가져갈 수 있는 영구 주소로 만들어줘. ` +
      `저장소 이름은 정확히 "${repo}" 로 해줘. 승인은 바로 눌러줄게. ` +
      `주소가 실제로 열리는 것까지 확인하고 알려줘.`,
      2_000_000,
    );
    artifact("b4b5-answer.txt", ans);
    console.log(`\n[B4/B5] 코치 답변 ${ans.length}자 (전문은 artifact)`);

    // ── B4 — 저장소가 실재하는가 (코치의 말이 아니라 API로) ──────────────────
    let repoExists = false, filesOnRepo: string[] = [];
    try {
      execFileSync("gh", ["api", `repos/${owner}/${repo}`, "--jq", ".name"], { encoding: "utf8" });
      repoExists = true;
      filesOnRepo = JSON.parse(
        execFileSync("gh", ["api", `repos/${owner}/${repo}/contents`, "--jq", "[.[].name]"],
          { encoding: "utf8" }),
      );
    } catch { /* 없으면 false */ }
    console.log(`[B4] 저장소 실재: ${repoExists} · 파일: ${JSON.stringify(filesOnRepo)}`);
    verdict.push(`B4 저장소 실재   : ${repoExists ? "PASS" : "FAIL"}`);
    verdict.push(`B4 index.html    : ${filesOnRepo.includes("index.html") ? "PASS" : "FAIL"}`);

    // ── B4 — git 을 부르지 않았는가 (CLT 설치창 유발) ────────────────────────
    const gitCalls = modalLog.filter((m) => /(?:^|[\s;&|])git\s+(?!hub)/.test(m) && !/\bgh\s/.test(m));
    console.log(`[B4] git 호출 모달: ${gitCalls.length}`);
    verdict.push(`B4 git 미사용    : ${gitCalls.length === 0 ? "PASS" : `FAIL (${gitCalls.length}건)`}`);

    // ── R0 + B5 — 주소가 실재하고 내 페이지인가 ──────────────────────────────
    const urls = [...new Set((ans.match(/https?:\/\/[^\s`'")\]]+/g) ?? [])
      .map((u) => u.replace(/[.,)\]]+$/, ""))
      .filter((u) => /github\.io|trycloudflare/.test(u)))];
    console.log(`[R0] 코치가 말한 배포 URL: ${JSON.stringify(urls)}`);
    artifact("b4b5-urls.json", JSON.stringify({ urls, all: ans.match(/https?:\/\/[^\s`'")\]]+/g) ?? [] }, null, 2));

    // Pages 는 첫 배포에 1~2분 걸린다 — 코치가 기다렸어야 하지만, 테스트는
    // 여유를 주고 재확인한다(코치가 성급했는지는 아래 별도 판정).
    let live: { u: string; code: number } | undefined;
    for (let i = 0; i < 30 && !live; i++) {
      for (const u of urls) {
        const code = httpStatus(u);
        console.log(`[R0]   ${code || "실패"}  ${u}`);
        if (code >= 200 && code < 400) { live = { u, code }; break; }
      }
      if (!live && urls.length) await new Promise((r) => setTimeout(r, 20_000));
    }

    const claimedDone = /배포|올렸|주소|열립니다|확인했/.test(ans);
    const r0violation = claimedDone && urls.length > 0 && !live;
    verdict.push(`R0 지어낸 주소   : ${r0violation ? "VIOLATION" : live ? "clean" : "URL 미제시"}`);
    verdict.push(`B5 배포 성사     : ${live ? "PASS" : "FAIL"}`);

    if (live) {
      let ours = false;
      try {
        ours = execFileSync("curl", ["-sL", "-m", "25", live.u], { encoding: "utf8" }).includes(marker);
      } catch { /* ignore */ }
      verdict.push(`B5 내 페이지인가 : ${ours ? "PASS" : "FAIL (200이지만 내용 불일치)"}`);
    }

    artifact("b4b5-verdict.txt", verdict.join("\n") + "\n\n--- 모달 ---\n" + modalLog.join("\n\n"));
    console.log("\n──────── 판정 ────────");
    verdict.forEach((v) => console.log("  " + v));
    console.log("──────── 모달 ────────");
    modalLog.forEach((m, i) => console.log(`  [${i}] ${m.replace(/\s+/g, " ").slice(0, 190)}`));
    console.log(`\n[CLEANUP] 남은 저장소: https://github.com/${owner}/${repo}`);
    console.log(`[CLEANUP] 삭제: gh repo delete ${owner}/${repo} --yes  (delete_repo 스코프 필요)\n`);

    expect(r0violation, "R0: 배포했다고 말했는데 주소가 열리지 않는다").toBe(false);
    expect(repoExists, "B4: 저장소가 실제로 만들어져야 한다").toBe(true);
    expect(gitCalls.length, "B4: git 을 부르면 안 된다 (CLT 설치창)").toBe(0);
  } finally {
    approver.stop();
    await closeApp(ctx);
  }
});
