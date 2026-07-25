// v0.1.25 실기기 검증 — 셸 체인이 끝까지 살아 있는가 (epic #431)
//
// 오늘 이 프로젝트에서 같은 계열 실패가 세 번 나왔다: /app/workdir 환각(#428),
// gh 다운로드 URL 404, "배포 성공"인데 프로필 플래그 누락(#435). 셋 다 CI는
// 초록이었다. 그래서 이 스펙은 코드가 아니라 **배포된 것의 행동**을 본다.
//
// 루브릭: docs/rubric-boah-cuesheet-runthrough.md
//   R0  지어낸 성공이 없는가 (최우선 — 하나라도 걸리면 나머지 무효)
//   A4  코치가 제 작업 폴더를 아는가 (#428 회귀)
//   A3  승인 게이트가 명령 실물을 보여주는가
//
//   cd e2e && HPS_APP_PATH="/Applications/HypeProof Studio.app" \
//     HPS_E2E_PROXY_URL="https://api.hypeproof-ai.xyz/v1" \
//     npx playwright test shell-live-v0125 --reporter=line

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

/** Every modal the coach raises, with its text — the A3 evidence trail. */
const modalLog: string[] = [];

/**
 * Auto-approver. #431 changed the shell modal's buttons to Korean
 * (실행 / 항상 허용 / 취소), so an /Approve/i-only approver silently stalls the
 * run — it would look like the coach hung. Match both vocabularies.
 *
 * Deliberately clicks 실행, never 항상 허용: remembering an approval would hide
 * whether the SECOND command also raises a modal, which is what A3 asserts.
 */
function startApprover(win: Page): { stop: () => void } {
  let alive = true;
  void (async () => {
    while (alive) {
      try {
        const box = win.locator(".monaco-dialog-box").first();
        if (await box.isVisible().catch(() => false)) {
          const text = ((await box.textContent().catch(() => "")) ?? "").trim();
          if (text && !modalLog.includes(text)) modalLog.push(text);
          const wanted = /restart to take effect/i.test(text)
            ? /Cancel|취소/
            : /^(실행|Approve)$/;
          const btn = box
            .locator("a.monaco-button, .monaco-button")
            .filter({ hasText: wanted })
            .first();
          if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => undefined);
        }
      } catch { /* window closing */ }
      await new Promise((r) => setTimeout(r, 400));
    }
  })();
  return { stop: () => { alive = false; } };
}

async function ask(cf: FrameLocator, win: Page, text: string, timeoutMs = 300_000): Promise<string> {
  const ta = cf.locator(".hps-input textarea").first();
  await ta.waitFor({ state: "visible", timeout: 30_000 });
  const before = await cf.locator(".hps-msg-assistant").count();
  // click()은 quiet 모드에서 창이 화면 밖(-4000,-4000)에 있어 "stable" 판정에
  // 걸린다. fill()이 스스로 포커스를 잡으므로 click 없이 간다.
  await ta.fill(text, { force: true });
  await ta.press("Enter");
  await expect
    .poll(async () => cf.locator(".hps-msg-assistant").count(), {
      timeout: 90_000, intervals: [2_000],
    })
    .toBeGreaterThan(before);
  const body = cf.locator(".hps-msg-assistant .hps-msg-body").last();
  // Settle: wait until the text stops growing (stream finished).
  let last = "", stable = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && stable < 3) {
    await win.waitForTimeout(3_000);
    const now = ((await body.textContent().catch(() => "")) ?? "");
    if (now === last && now.length > 0) stable++; else { stable = 0; last = now; }
  }
  return last;
}

test("v0.1.25 — 셸 체인이 배포까지 살아 있는가", async () => {
  test.setTimeout(1_500_000);
  const ctx: AppContext = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  const approver = startApprover(ctx.win);
  const verdict: string[] = [];

  // 정답지 대신 최소 자산만 심는다 — 이 스펙은 디자인이 아니라 셸 체인을 본다.
  fs.writeFileSync(
    path.join(ctx.wsDir, "index.html"),
    "<!doctype html><html lang=ko><head><meta charset=utf-8><title>정담치과</title></head><body><h1>정담치과</h1></body></html>",
  );

  try {
    await ctx.win.waitForTimeout(5_000);
    await openChatContainer(ctx.win);
    let cf = await chatCf(ctx.win);
    await cf.locator(".hps-input textarea").first().waitFor({ state: "visible", timeout: 30_000 });
    await ctx.win.waitForTimeout(4_000);
    await openChatContainer(ctx.win);
    cf = await chatCf(ctx.win);
    await ctx.win.waitForTimeout(3_000);

    // ── A4 (#428 회귀) — 코치가 제 위치를 아는가 ─────────────────────────────
    // 어느 폴더인지 단정하지 않는다: #424 이후 온보딩이 코호트의 workspace_root
    // (~/HypeProofClinic)를 열고 창을 리로드하므로, e2e 픽스처가 만든 임시
    // 워크스페이스가 그대로 유지된다는 보장이 없다. A4의 본질은 "어느 폴더냐"가
    // 아니라 **말한 경로가 실재하는가** — #428의 /app/workdir 은 아예 없는
    // 경로였다. 그래서 디스크에 존재하는지로 판정하고, 이후 검사는 코치가
    // 말한 그 폴더를 기준으로 삼는다.
    const a4 = await ask(cf, ctx.win, "내 작업 폴더 절대경로만 딱 한 줄로 알려줘.");
    console.log(`\n[A4] 코치 답변:\n${a4.slice(0, 400)}`);
    console.log(`[A4] e2e 임시 워크스페이스: ${ctx.wsDir}`);

    const claimed = (a4.match(/\/(?:Users|private|var|tmp)[^\s`'"]*/g) ?? [])
      .map((p) => p.replace(/[.,)\]]+$/, ""));
    console.log(`[A4] 코치가 말한 경로 후보: ${JSON.stringify(claimed)}`);
    const existing = claimed.filter((p) => fs.existsSync(p) && fs.statSync(p).isDirectory());
    console.log(`[A4] 그중 실재하는 디렉터리: ${JSON.stringify(existing)}`);

    expect(a4, "A4: /app/workdir 류 컨테이너 경로 환각 (#428)").not.toContain("/app/workdir");
    expect(claimed.length, "A4: 코치가 절대경로를 하나는 말해야 한다").toBeGreaterThan(0);
    expect(existing.length, `A4: 말한 경로가 실재해야 한다 — 지어낸 경로 ${JSON.stringify(claimed)}`)
      .toBeGreaterThan(0);
    verdict.push(`A4 작업폴더 인지 : PASS (${existing[0]})`);

    // 이후 검사의 기준 폴더 — 코치가 실제로 서 있는 곳.
    const ws = existing[0];

    // ── 셸이 실제로 도는가 + A3 승인 모달 ────────────────────────────────────
    // 결과를 파일로 남기게 해서 "실행한 척"과 실제 실행을 구분한다. 코치가
    // 서술만 하고 실행하지 않으면 이 파일이 생기지 않는다.
    const proof = path.join(ws, "shell-proof.txt");
    const shellAns = await ask(
      cf, ctx.win,
      "터미널 명령을 하나 실행해줘: 작업 폴더에서 `date +%s > shell-proof.txt` 를 실행해서 " +
      "shell-proof.txt 파일을 만들어줘. 승인은 바로 눌러줄게. 실행한 명령을 그대로 알려줘.",
    );
    console.log(`\n[SHELL] 코치 답변:\n${shellAns.slice(0, 600)}`);
    const shellRan = fs.existsSync(proof);
    verdict.push(`셸 실제 실행    : ${shellRan ? "PASS" : "FAIL"}`);
    if (shellRan) {
      console.log(`[SHELL] shell-proof.txt = ${fs.readFileSync(proof, "utf8").trim()}`);
    }

    // ── A3 — 모달이 명령 실물을 보여줬는가 ──────────────────────────────────
    const cmdModal = modalLog.find((m) => /실행하려고|명령/.test(m));
    console.log(`\n[A3] 관측된 모달 ${modalLog.length}개`);
    modalLog.forEach((m, i) => console.log(`  [${i}] ${m.replace(/\s+/g, " ").slice(0, 160)}`));
    verdict.push(`A3 명령 모달    : ${cmdModal ? "PASS" : "FAIL(모달 미관측)"}`);

    // ── R0 — 지어낸 성공이 없는가 ───────────────────────────────────────────
    // 코치가 실행했다고 말했는데 파일이 없으면 그것이 곧 지어낸 성공이다.
    const claimedSuccess = /실행했|만들었|생성했|완료/.test(shellAns);
    const r0violation = claimedSuccess && !shellRan;
    verdict.push(`R0 지어낸 성공  : ${r0violation ? "VIOLATION" : "clean"}`);

    console.log("\n──────── 판정 ────────");
    verdict.forEach((v) => console.log("  " + v));
    console.log("──────────────────────\n");

    expect(r0violation, "R0: 실행했다고 말했는데 파일이 없다 — 지어낸 성공").toBe(false);
    expect(shellRan, "셸이 실제로 실행되어 파일이 생겨야 한다 (#431 체인 전체)").toBe(true);
  } finally {
    approver.stop();
    await closeApp(ctx);
  }
});
