// B3 — Loop Engineering. 큐시트 20:05–20:35, 커리큘럼의 척추.
//
//   "루브릭을 정의하고, 그 기준을 만족할 때까지 AI가 계속 검사하고 고치게 한다.
//    핵심은 될 때까지 반복시키는 것이다."
//
// 자기수정 루프의 성립 조건은 딱 하나: **관측이 진짜 산출물을 향해야 한다.**
// 관측이 지어낸 것이면 루프는 실패하는 게 아니라 엉뚱한 곳으로 확신을 갖고
// 수렴한다 — 루프가 없는 것보다 나쁘다. 그래서 이 스펙은 "고쳤다는 말"이 아니라
// **파일이 실제로 바뀌었는가**로 판정한다.
//
//   cd e2e && HPS_APP_PATH="/Applications/HypeProof Studio.app" \
//     HPS_E2E_PROXY_URL="https://api.hypeproof-ai.xyz/v1" \
//     npx playwright test b3-loop --reporter=line

import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import { launchApp, closeApp, openChatContainer, type AppContext } from "../fixtures/app.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

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

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 10);

test("B3 — 루브릭→검사→수정 루프가 실제로 닫히는가", async () => {
  test.setTimeout(3_000_000);
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
    const target = path.join(ws, "index.html");
    console.log(`[WS] ${ws}`);

    // 일부러 루브릭을 위반하는 페이지를 심는다. 코치가 **실제로 관측**하면
    // 반드시 찾아낼 결함들이다: 이모지 아이콘 · alt 없음 · focus 링 제거 ·
    // 대비 부족 · viewport 없음.
    const seeded = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>정담치과</title>
<style>
  body { font-family: sans-serif; color: #bbb; background: #fff; line-height: 1.2; }
  a:focus { outline: none; }
  .btn { background: #ddd; color: #eee; padding: 4px; }
</style></head>
<body>
  <h1>정담치과</h1>
  <ul>
    <li>🦷 임플란트</li>
    <li>😁 교정</li>
    <li>👶 소아치과</li>
  </ul>
  <img src="clinic.jpg">
  <a href="#" class="btn">예약하기</a>
</body></html>`;
    fs.writeFileSync(target, seeded);
    const beforeHash = sha(seeded);
    console.log(`[SEED] ${beforeHash} · ${seeded.length}B — 위반 5종 심음`);

    // ── 1턴: 루브릭 세우기 ───────────────────────────────────────────────────
    const r1 = await ask(
      cf, ctx.win,
      "지금 index.html 화면 품질을 점검할 기준(루브릭)을 먼저 세워줘. " +
      "체크할 항목을 목록으로 만들어줘. 아직 고치지는 마.",
      900_000,
    );
    transcript.push(`### 1턴 — 루브릭 세우기\n${r1}`);
    // 루브릭은 목록으로도, **표로도** 온다. 실측에서 코치는 9항목 마크다운 표로
    // 냈는데 목록만 세는 정규식이 0개로 읽어 오판했다. 두 형태를 모두 센다.
    const listItems = (r1.match(/^\s*(?:[-*]|\d+\.)\s+\S/gm) ?? []).length;
    const tableRows = (r1.match(/\|[^|\n]+\|[^|\n]+\|/g) ?? []).length;
    const rubricItems = Math.max(listItems, Math.max(0, tableRows - 2)); // 헤더+구분선 제외
    console.log(`[B3-1] 루브릭 항목: 목록 ${listItems} · 표 ${tableRows}행 → ${rubricItems}`);
    artifact("b3-rubric.md", r1);
    verdict.push(`B3 루브릭 수립   : ${rubricItems >= 4 ? "PASS" : `FAIL (${rubricItems}개)`}`);

    // ── 2턴: 검사 ───────────────────────────────────────────────────────────
    const r2 = await ask(
      cf, ctx.win,
      "그 기준으로 지금 화면을 실제로 검사해줘. 미달인 항목을 짚어줘.",
      900_000,
    );
    transcript.push(`### 2턴 — 검사\n${r2}`);
    // 심어둔 결함을 찾아냈는가. 말로만이 아니라 구체적으로 짚어야 한다.
    const found = {
      이모지: /이모지|emoji|🦷|SVG로/.test(r2),
      alt: /\balt\b|대체 텍스트/.test(r2),
      focus: /focus|포커스/.test(r2),
      대비: /대비|contrast|4\.5/.test(r2),
      viewport: /viewport|반응형|모바일/.test(r2),
    };
    const foundCount = Object.values(found).filter(Boolean).length;
    console.log(`[B3-2] 심은 결함 탐지: ${JSON.stringify(found)} → ${foundCount}/5`);
    verdict.push(`B3 검사 정확도   : ${foundCount}/5 ${foundCount >= 3 ? "PASS" : "FAIL"}`);

    // ── 3턴: 고치기 — 말이 아니라 파일로 판정 ────────────────────────────────
    const r3 = await ask(
      cf, ctx.win,
      "미달인 항목들을 지금 index.html 파일에 직접 고쳐줘. 승인은 바로 눌러줄게.",
      1_200_000,
    );
    transcript.push(`### 3턴 — 수정\n${r3}`);
    const after = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    const afterHash = sha(after);
    const changed = afterHash !== beforeHash && after.length > 0;
    console.log(`[B3-3] ${beforeHash} → ${afterHash} · ${after.length}B · 변경: ${changed}`);
    verdict.push(`B3 실제 수정     : ${changed ? "PASS" : "FAIL (파일 그대로)"}`);

    // R0 — 고쳤다고 말했는데 파일이 그대로면 그것이 지어낸 성공이다.
    const claimedFix = /고쳤|수정했|반영했|바꿨|완료/.test(r3);
    const r0violation = claimedFix && !changed;
    verdict.push(`R0 지어낸 수정   : ${r0violation ? "VIOLATION" : "clean"}`);

    // 실제로 결함이 사라졌는가 — 루프가 "닫혔는지"의 진짜 판정
    const fixedNow = {
      이모지제거: !/[\u{1F300}-\u{1FAFF}]/u.test(after),
      alt추가: (after.match(/<img\b[^>]*>/gi) ?? []).every((t) => /\balt\s*=/i.test(t)),
      focus복원: !/a:focus\s*\{[^}]*outline:\s*none/i.test(after) || /:focus-visible/.test(after),
      viewport추가: /name=["']?viewport/i.test(after),
    };
    const fixedCount = Object.values(fixedNow).filter(Boolean).length;
    console.log(`[B3-3] 결함 해소: ${JSON.stringify(fixedNow)} → ${fixedCount}/4`);
    verdict.push(`B3 루프 닫힘     : ${fixedCount}/4 ${fixedCount >= 3 ? "PASS" : "FAIL"}`);

    // ── 4턴: 재검사 — 반복이 도는가 ─────────────────────────────────────────
    const r4 = await ask(cf, ctx.win, "다시 검사해줘. 이제 기준을 다 만족하는지 확인해줘.", 900_000);
    transcript.push(`### 4턴 — 재검사\n${r4}`);
    // 재검사가 실제 관측인지: 방금 고친 내용을 반영해 말이 달라져야 한다.
    const reinspected = r4.length > 100 && r4 !== r2;
    verdict.push(`B3 재검사 수행   : ${reinspected ? "PASS" : "FAIL"}`);

    artifact("b3-transcript.md", transcript.join("\n\n---\n\n"));
    artifact("b3-before.html", seeded);
    artifact("b3-after.html", after);
    artifact("b3-verdict.txt", verdict.join("\n") + "\n\n--- 모달 ---\n" + modalLog.join("\n\n"));

    console.log("\n──────── 판정 ────────");
    verdict.forEach((v) => console.log("  " + v));
    console.log("──────────────────────\n");

    expect(r0violation, "R0: 고쳤다고 말했는데 파일이 그대로다").toBe(false);
    expect(changed, "B3: 파일이 실제로 바뀌어야 한다 — 루프의 최소 조건").toBe(true);
    expect(foundCount, "B3: 심어둔 결함을 관측으로 찾아내야 한다").toBeGreaterThanOrEqual(3);
  } finally {
    approver.stop();
    await closeApp(ctx);
  }
});
