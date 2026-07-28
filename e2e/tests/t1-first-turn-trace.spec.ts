// T1 — 첫 턴 하나를 현미경으로 본다.
//
//   "https://boaclinic.com/  치과 홈페이지를 만들껀데 이런 스타일로 만들어줘"
//
// 큐시트 19:30 Reference First 의 실제 첫 입력이다. 이 한 턴이 오늘 고친 것을
// 전부 지나간다 — 브라우저 열기·읽기(#457) · 파일 쓰기 · cwd(#428/#457) ·
// 승인 모달 빈도(#437) · 디자인 품질바닥(#410) · 턴/시간 예산(maxTurns).
//
// 흩어진 스펙 여러 개보다 이 하나가 낫다는 판단이다: 항목별로 재면 항목 사이의
// 상호작용을 못 본다. 여기서는 **무엇을 생각하고 → 어떤 도구를 → 성공했는지 →
// 얼마나 걸렸는지**를 시간축 하나에 기록한다. 잠재 버그는 그 틈에서 보인다.
//
// 활동 로그는 webview React 상태(toolLog)라 DB 에 안 남는다. 그래서 **도는 동안
// DOM 을 샘플링**한다 — 사후에 뽑을 수 없는 정보다.
//
//   cd e2e && HPS_APP_PATH="/Applications/HypeProof Studio.app" \
//     HPS_E2E_PROXY_URL="https://api.hypeproof-ai.xyz/v1" \
//     npx playwright test t1-first-turn --reporter=line

import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import { launchApp, closeApp, openChatContainer, type AppContext } from "../fixtures/app.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { scoreDesignFloor } from "../scoring.ts";

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

/** 승인 모달: 눌린 시각·내용·소요를 남긴다. 「항상 허용」은 절대 안 누른다. */
interface ModalRecord { at: number; waitedMs: number; text: string }
function startApprover(win: Page, t0: () => number) {
  const modals: ModalRecord[] = [];
  let alive = true;
  let seenAt: number | null = null;
  let lastText = "";
  void (async () => {
    while (alive) {
      try {
        const box = win.locator(".monaco-dialog-box").first();
        if (await box.isVisible().catch(() => false)) {
          const text = ((await box.textContent().catch(() => "")) ?? "").trim();
          if (text !== lastText) { lastText = text; seenAt = Date.now(); }
          const wanted = /restart to take effect/i.test(text) ? /Cancel|취소/ : /^(실행|Approve)$/;
          const btn = box.locator("a.monaco-button, .monaco-button").filter({ hasText: wanted }).first();
          if (await btn.isVisible().catch(() => false)) {
            await btn.click().catch(() => undefined);
            if (!/restart to take effect/i.test(text)) {
              modals.push({
                at: Date.now() - t0(),
                waitedMs: seenAt ? Date.now() - seenAt : 0,
                text: text.replace(/\s+/g, " ").slice(0, 200),
              });
            }
            lastText = "";
          }
        } else { lastText = ""; }
      } catch { /* closing */ }
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  return { stop: () => { alive = false; }, modals };
}

interface TraceEntry { at: number; icon: string; label: string; state: string }

test("T1 — 첫 턴 현미경: 생각·도구·성공·소요", async () => {
  test.setTimeout(2_400_000);
  const ctx: AppContext = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  let turnStart = Date.now();
  const approver = startApprover(ctx.win, () => turnStart);
  const trace: TraceEntry[] = [];

  try {
    await ctx.win.waitForTimeout(5_000);
    await openChatContainer(ctx.win);
    let cf = await chatCf(ctx.win);
    await cf.locator(".hps-input textarea").first().waitFor({ state: "visible", timeout: 30_000 });
    await ctx.win.waitForTimeout(4_000);
    await openChatContainer(ctx.win);
    cf = await chatCf(ctx.win);
    await ctx.win.waitForTimeout(3_000);

    // 깨끗한 출발 — 이전 런의 산출물이 있으면 "만들었다"가 아니라 "이미 있었다"가 된다.
    const wsProbe = await (async () => {
      const ta = cf.locator(".hps-input textarea").first();
      await ta.fill("내 작업 폴더 절대경로만 딱 한 줄로.", { force: true });
      await ta.press("Enter");
      await ctx.win.waitForTimeout(45_000);
      return ((await cf.locator(".hps-msg-assistant .hps-msg-body").last().textContent()) ?? "");
    })();
    const ws = (wsProbe.match(/\/(?:Users|private|var|tmp)[^\s`'"]*/g) ?? [])
      .map((p) => p.replace(/[.,)\]]+$/, "")).filter((p) => fs.existsSync(p))[0] ?? ctx.wsDir;
    const target = path.join(ws, "index.html");
    if (fs.existsSync(target)) fs.rmSync(target);
    console.log(`[T1] 작업 폴더: ${ws}`);

    // ── 첫 턴 ───────────────────────────────────────────────────────────────
    const ta = cf.locator(".hps-input textarea").first();
    const before = await cf.locator(".hps-msg-assistant").count();
    turnStart = Date.now();
    await ta.fill(
      "https://boaclinic.com/\n치과 홈페이지를 만들껀데 이런 스타일로 만들어줘",
      { force: true },
    );
    await ta.press("Enter");
    await expect
      .poll(async () => cf.locator(".hps-msg-assistant").count(), { timeout: 120_000, intervals: [2_000] })
      .toBeGreaterThan(before);

    // 활동 로그를 도는 동안 샘플링한다. 렌더 구조는 ChatPanel.tsx 를 열어 확인했다:
    //   .hps-tool-log-line > .hps-tool-icon(💭/🔧) + .hps-tool-label + 상태 클래스
    //   state: running | error | (done)
    const body = cf.locator(".hps-msg-assistant .hps-msg-body").last();
    const progress = cf.locator(".hps-msg-assistant").last().locator(".hps-code-progress");
    const seen = new Map<string, TraceEntry>();
    let last = "", stable = 0, firstTextAt = 0;
    const deadline = Date.now() + 1_800_000;

    while (Date.now() < deadline) {
      await ctx.win.waitForTimeout(1_500);

      // 로그 라인 스냅샷
      const lines = await cf.locator(".hps-tool-log-line").all().catch(() => []);
      for (let i = 0; i < lines.length; i++) {
        const icon = ((await lines[i].locator(".hps-tool-icon").textContent().catch(() => "")) ?? "").trim();
        const label = ((await lines[i].locator(".hps-tool-label").textContent().catch(() => "")) ?? "").trim();
        const cls = (await lines[i].getAttribute("class").catch(() => "")) ?? "";
        const state = /hps-tool-error/.test(cls) ? "error" : /hps-tool-running/.test(cls) ? "running" : "done";
        const key = `${i}|${icon}|${label}`;
        const prev = seen.get(key);
        // 최초 등장 시각을 유지하고 상태만 갱신한다 — running → done 전이를 잡는다.
        if (!prev) seen.set(key, { at: Date.now() - turnStart, icon, label, state });
        else if (prev.state !== state) prev.state = state;
      }

      const now = ((await body.textContent().catch(() => "")) ?? "");
      if (!firstTextAt && now.trim() && !now.trim().startsWith("생각하는 중")) {
        firstTextAt = Date.now() - turnStart;
      }
      const busy = (await progress.count().catch(() => 0)) > 0
        || (now.trim().startsWith("생각하는 중") && now.trim().length < 40);
      if (busy) { stable = 0; last = now; continue; }
      if (now === last && now.length > 0) stable++; else { stable = 0; last = now; }
      if (stable >= 3) break;
    }
    const elapsed = Date.now() - turnStart;
    trace.push(...[...seen.values()].sort((a, b) => a.at - b.at));

    // ── 결과 ────────────────────────────────────────────────────────────────
    const answer = last;
    const html = fs.existsSync(target)
      ? fs.readFileSync(target, "utf8")
      : (answer.match(/<!doctype html[\s\S]*?<\/html>/i)?.[0] ?? "");
    const design = html ? scoreDesignFloor(html) : { passed: 0, total: 9, checks: [] as Array<[string, boolean]> };

    const tools = trace.filter((e) => e.icon.includes("🔧"));
    const thinks = trace.filter((e) => e.icon.includes("💭"));
    const errors = trace.filter((e) => e.state === "error");

    const lines: string[] = [
      "# T1 — 첫 턴 현미경",
      "",
      `입력: \`https://boaclinic.com/ 치과 홈페이지를 만들껀데 이런 스타일로 만들어줘\``,
      `작업 폴더: \`${ws}\``,
      "",
      "## 요약",
      "",
      `| | |`,
      `|---|---|`,
      `| 총 소요 | **${(elapsed / 1000).toFixed(0)}초** |`,
      `| 첫 텍스트까지 | ${firstTextAt ? (firstTextAt / 1000).toFixed(0) + "초" : "—"} |`,
      `| 활동 로그 항목 | ${trace.length} (🔧 ${tools.length} · 💭 ${thinks.length}) |`,
      `| 실패(⚠️) | ${errors.length} |`,
      `| 승인 모달 | ${approver.modals.length} |`,
      `| 산출물 | ${html ? html.length.toLocaleString() + "자" : "없음"} |`,
      `| 디자인 품질바닥 | ${design.passed}/${design.total} |`,
      "",
      "## 시간축",
      "",
      "```",
      ...trace.map((e) => {
        const mark = e.state === "error" ? "⚠️" : e.state === "running" ? "…" : "✓";
        return `${String((e.at / 1000).toFixed(1)).padStart(6)}s  ${mark}  ${e.icon} ${e.label}`;
      }),
      "```",
      "",
      "## 승인 모달",
      "",
      approver.modals.length === 0 ? "(없음)" : "```",
      ...approver.modals.map((m) => `${(m.at / 1000).toFixed(1)}s  ${m.text}`),
      ...(approver.modals.length ? ["```"] : []),
      "",
      "## 실패한 도구",
      "",
      errors.length === 0 ? "(없음)" : "```",
      ...errors.map((e) => `${(e.at / 1000).toFixed(1)}s  ${e.icon} ${e.label}`),
      ...(errors.length ? ["```"] : []),
      "",
      "## 디자인 품질바닥",
      "",
      ...design.checks.map(([l, ok]) => `- ${ok ? "✅" : "❌"} ${l}`),
      "",
      "## 코치 답변",
      "",
      answer,
    ];
    artifact("t1-trace.md", lines.join("\n"));
    if (html) artifact("t1-output.html", html);

    console.log(`\n──────── T1 ────────`);
    console.log(`  총 소요        ${(elapsed / 1000).toFixed(0)}초`);
    console.log(`  활동 로그      ${trace.length} (🔧 ${tools.length} · 💭 ${thinks.length})`);
    console.log(`  실패           ${errors.length}`);
    console.log(`  승인 모달      ${approver.modals.length}`);
    console.log(`  디자인 품질바닥 ${design.passed}/${design.total}`);
    console.log(`  산출물         ${html ? html.length + "자" : "없음"}`);
    console.log(`────────────────────\n`);
    trace.forEach((e) => console.log(
      `${String((e.at / 1000).toFixed(1)).padStart(6)}s  ${e.state === "error" ? "⚠️" : "✓"}  ${e.icon} ${e.label}`,
    ));

    // 이 스펙의 목적은 "재는 것"이다. 하드 단언은 최소로 — 산출물이 나왔는가만.
    expect(html.length, "T1: 첫 턴에 산출물이 나와야 한다 (파일이든 펜스든)").toBeGreaterThan(200);
  } finally {
    approver.stop();
    await closeApp(ctx);
  }
});
