// Run-through of ~/Downloads/boa-dental-run-through-sheet.html personas against
// the INSTALLED Studio (point HPS_APP_PATH at /Applications/HypeProof
// Studio.app) + current worker main, through the real chat UI.
//
// Purpose: NOT regression — produce evidence for the "안되는 것 리스트":
// which sheet claims (배포 스킬 · 화면검사 8항목 · 디자인 스킬 · agent.md ·
// 잘림 자기복구 · URL 정답지 · 정답지 방향 교정) actually hold in the product
// today. All probes are expect.soft-style records; the test always writes the
// transcript.
//
// Prerequisite: wrangler dev on 8787 + copyclone session + /tmp/hps-token.txt
//   (dev-stack equivalent; profile boah-dental-director-copyclone-2026-s1)
// Run:
//   cd e2e && HPS_APP_PATH="/Applications/HypeProof Studio.app" \
//     npx playwright test persona-runthrough-sheet --reporter=line

import { test, expect, type FrameLocator } from "@playwright/test";
import { launchApp, closeApp, chatFrame, openChatContainer, type AppContext } from "../fixtures/app.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(
  __dirname,
  "../../docs/curriculum-snapshots/boah-dental-runthrough-2026-07-20",
);

interface Turn {
  step: number;
  persona: string;
  intent: string;
  userMsg: string;
  assistantReply: string;
  ms: number;
  probes: Record<string, boolean>;
}
const transcript: Turn[] = [];

test.beforeAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
});

test.afterAll(() => {
  const lines: string[] = [];
  lines.push("# 보아치과 런스루 시트 페르소나 검증 — transcript\n");
  lines.push(`자동 캡처: ${new Date().toISOString()} · 앱: ${process.env.HPS_APP_PATH ?? "(build dir)"}\n`);
  for (const t of transcript) {
    lines.push(`\n---\n`);
    lines.push(`## ${t.step}. ${t.persona} — ${t.intent}`);
    lines.push(`\n**사용자**:\n\n> ${t.userMsg.replace(/\n/g, "\n> ")}\n`);
    lines.push(`\n**모델 응답** (${t.ms}ms, ${t.assistantReply.length}자):\n\n${t.assistantReply.slice(0, 4000)}\n`);
    lines.push(`\n**자동 probes**:\n`);
    for (const [k, v] of Object.entries(t.probes)) lines.push(`- ${v ? "✅" : "❌"} \`${k}\``);
  }
  fs.writeFileSync(path.join(OUT_DIR, "transcript.md"), lines.join("\n"));
});

// The copyclone flow opens the native browser + live preview mid-turn, which
// adds webview iframes (and can reload the chat webview). Never trust "first
// iframe = chat": re-resolve the chat frame BY CONTENT every time.
async function chatCf(win: import("@playwright/test").Page): Promise<FrameLocator> {
  const outer = win.locator("iframe.webview.ready");
  const n = await outer.count();
  for (let i = 0; i < n; i++) {
    const fl = win.frameLocator("iframe.webview.ready").nth(i).frameLocator("#active-frame");
    try {
      if ((await fl.locator(".hps-shell").count()) > 0) return fl;
    } catch {
      /* frame mid-navigation — try the next one */
    }
  }
  throw new Error("chat frame not found (no iframe contains .hps-shell)");
}

// FINDING (run 3): opening the native browser (URL 정답지) covered the whole
// window and the chat sidebar's webview went away — .hps-shell unfindable,
// input unactionable. Recovery: re-reveal the chat container (activity bar /
// command), which re-materializes the webview without killing the browser.
async function ensureChatInteractive(win: import("@playwright/test").Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    try {
      const cf = await chatCf(win);
      const ta = cf.locator(".hps-input textarea").first();
      if (await ta.isVisible().catch(() => false)) return;
    } catch {
      /* fallthrough to reveal */
    }
    await openChatContainer(win).catch(() => undefined);
    await win.waitForTimeout(1_500);
  }
}

// Long-generation-aware wait: poll until the last assistant bubble's text has
// been STABLE for 6s (HTML builds stream for minutes), cap 300s per turn.
// Frame handle is re-resolved every tick — survives added/reloaded webviews.
async function sendAndWaitStable(
  win: import("@playwright/test").Page,
  msg: string,
): Promise<{ reply: string; ms: number }> {
  await ensureChatInteractive(win);
  let cf = await chatCf(win);
  const before = await cf.locator(".hps-msg-assistant").count();
  const ta = cf.locator(".hps-input textarea").first();
  await ta.fill(msg);
  const t0 = Date.now();
  await ta.press("Enter");
  let lastFrameOkAt = Date.now();
  let prev = "";
  let stableSince = Date.now();
  const deadline = t0 + 300_000;
  for (;;) {
    try {
      cf = await chatCf(win);
      lastFrameOkAt = Date.now();
      const count = await cf.locator(".hps-msg-assistant").count();
      const cur =
        count > before
          ? (await cf.locator(".hps-msg-assistant .hps-msg-body").last().textContent({ timeout: 5_000 })) ?? ""
          : "";
      if (cur !== prev) {
        prev = cur;
        stableSince = Date.now();
      } else if (cur.length > 0 && Date.now() - stableSince > 6_000) {
        break;
      }
    } catch {
      // Chat webview gone for 20s+ (browser covered the window) — re-reveal
      // so we can keep watching the stream. Does not close the browser view.
      if (Date.now() - lastFrameOkAt > 20_000) {
        await openChatContainer(win).catch(() => undefined);
        lastFrameOkAt = Date.now();
      }
    }
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return { reply: prev, ms: Date.now() - t0 };
}

async function shot(win: import("@playwright/test").Page, name: string) {
  try {
    const cf = await chatCf(win);
    await cf.locator(".hps-shell").screenshot({ path: path.join(OUT_DIR, name) });
  } catch {
    /* window may be busy — screenshot is best-effort evidence */
  }
}

function record(
  step: number,
  persona: string,
  intent: string,
  userMsg: string,
  r: { reply: string; ms: number },
  probes: Record<string, boolean>,
) {
  transcript.push({ step, persona, intent, userMsg, assistantReply: r.reply, ms: r.ms, probes });
  for (const [k, v] of Object.entries(probes)) {
    expect.soft(v, `${step}. ${persona}: ${k}`).toBe(true);
  }
}

test("런스루 시트 페르소나 — 설치본 실채팅 검증", async () => {
  test.setTimeout(2_400_000); // 40 min — up to 9 long LLM turns
  const ctx: AppContext = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    // Installed-app first launch is slower than the dev build and does not
    // always auto-reveal the chat container — open it explicitly (idempotent).
    await ctx.win.waitForTimeout(5_000);
    await openChatContainer(ctx.win);
    const cf0 = await chatFrame(ctx.win);
    await cf0.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    await shot(ctx.win, "00-welcome.png");

    // ── 1. 정태식(58·보철): 참고 없음 → URL만 던짐 (시트: ✅ 해소 주장) ──
    {
      const msg = "https://boaclinic.com/ 이 사이트 보고 우리 병원 홈페이지 만들어줘. 스크린샷은 안 붙였어요. 병원 이름은 정담치과, 보철 전문이에요.";
      const r = await sendAndWaitStable(ctx.win, msg);
      record(1, "정태식 (URL 정답지)", "URL만으로 클론 시작", msg, r, {
        "브라우저로 열어보는 행동/발화": /열어|브라우저|직접 (보|확인)|접속/.test(r.reply),
        "V1 HTML 생성됨(코드 흔적)": /html|섹션|Hero|만들었|완성/i.test(r.reply),
        "응답이 비어있지 않음": r.reply.length > 80,
      });
      await shot(ctx.win, "01-url-reference.png");
    }

    // ── 2. 박서연(41·교정): 자기 병원 기존 홈페이지를 정답지로 (시트: 방향 교정 필요) ──
    {
      const msg = "참고로 우리 병원 지금 홈페이지가 있는데 그걸 정답지로 쓸게요. 지금 홈페이지랑 똑같이 만들어주세요. 그게 익숙해서요.";
      const r = await sendAndWaitStable(ctx.win, msg);
      record(2, "박서연 (자기 홈페이지 정답지)", "바꾸려는 대상≠정답지 방향 교정", msg, r, {
        "닮고 싶은 좋은 사이트로 교정하는 발화": /좋은 사이트|닮고 싶은|벤치마킹|바꾸(려는|고 싶은) 대상|더 나은/.test(r.reply),
      });
      await shot(ctx.win, "02-own-site-redirect.png");
    }

    // ── 3. 이도현(35·얼리어답터): 섹션 12개 (시트: 잘림 경고 최초 목격자) ──
    {
      const msg = "섹션 12개 전부 넣어주세요: Hero, 진료과목 8개 카드, 의료진 4명, 장비 소개, 시설 갤러리 8장, 전후 관리 안내, 후기 6개, 진료시간표, 주차 안내, 오시는길, FAQ 10개, 상담 폼, 푸터. 각 섹션 스타일 아주 꼼꼼하게 전부요.";
      const r = await sendAndWaitStable(ctx.win, msg);
      const truncated = /잘렸|길이 제한/.test(r.reply);
      record(3, "이도현 (섹션 12개)", "출력 예산: 완결 유지 or 잘림+복구", msg, r, {
        "완결(</html>) 또는 잘림경고 표시": /<\/html>|완결|잘렸|길이 제한/.test(r.reply),
        "조용한 실패 아님(무언가 응답)": r.reply.length > 200,
        "예산 규칙 작동(잘림 없이 완결)": !truncated,
      });
      await shot(ctx.win, "03-twelve-sections.png");
    }

    // ── 4. 최민아(38·소아): "루브릭이 뭐예요?" (시트: 템플릿 준비됨 주장) ──
    {
      const msg = "루브릭이 뭐예요? 뭘 써야 할지 모르겠어요.";
      const r = await sendAndWaitStable(ctx.win, msg);
      record(4, "최민아 (루브릭 개념)", "루브릭 설명 + 시작 가능한 항목 제시", msg, r, {
        "루브릭을 설명함": /기준|체크|항목|평가/.test(r.reply),
        "구체 항목 예시 제시": /\d+\.|①|•|-\s/.test(r.reply),
      });
      await shot(ctx.win, "04-rubric-question.png");
    }

    // ── 5. 화면검사 (시트: "루브릭 8항목 자동 검사 ✅" 주장) ──
    {
      const msg = "지금 화면 검사해줘. 기본 8항목 PASS/FAIL 표로 보여줘.";
      const r = await sendAndWaitStable(ctx.win, msg);
      record(5, "화면검사 (시트 주장 ✅)", "8항목 자동 PASS/FAIL 검사 존재 여부", msg, r, {
        "PASS/FAIL 형태 결과": /PASS|FAIL|통과|미달/i.test(r.reply),
        "실제 화면을 확인한 근거 발화": /브라우저|화면(을|에서) (확인|보)|캡처|스크린샷/.test(r.reply),
      });
      await shot(ctx.win, "05-screen-check.png");
    }

    // ── 6. Loop 부분 수정 (시트 예방 문구: "이 3개만 고치고 나머지 유지") ──
    {
      const msg = "이 3개만 고치고 나머지는 유지해줘: ① 히어로 문구를 '정성을 담는 보철, 정담치과'로 ② 전화번호 02-555-0100 추가 ③ 야간진료 목요일 표시.";
      const r = await sendAndWaitStable(ctx.win, msg);
      record(6, "Loop 부분 수정", "증분 수정이 전체 재생성 없이 완결", msg, r, {
        "완결된 문서 유지": /<\/html>|완결|반영/.test(r.reply),
        "잘림 없음": !/잘렸|길이 제한/.test(r.reply),
      });
      await shot(ctx.win, "06-incremental-edit.png");
    }

    // ── 7. 배포 (시트: "배포 스킬 ✅ URL 200 확인" 주장 / 결과물 2·3) ──
    {
      const msg = "이제 배포해줘. 오늘 안에 공개 URL이 필요해요. GitHub Pages로 올려서 주소 알려줘.";
      const r = await sendAndWaitStable(ctx.win, msg);
      record(7, "배포 (시트 주장 ✅)", "GitHub Pages 배포 + URL 확보 가능 여부", msg, r, {
        "배포를 실제로 수행하거나 URL 제공": /https?:\/\/[\w.-]+\.github\.io|배포(했|됐|가 완료)/.test(r.reply),
        "불가 시 정직한 안내(거짓 성공 없음)": !/배포(했|됐|가 완료)/.test(r.reply) || /github\.io/.test(r.reply),
      });
      await shot(ctx.win, "07-deploy.png");
    }

    // ── 8. agent.md (시트: 결과물 4 / 템플릿 준비됨 주장) ──
    {
      const msg = "agent.md 만들어줘 — 오늘 작업을 다음 AI에게 넘길 인수인계 문서로. 파일로 저장까지 해줘.";
      const r = await sendAndWaitStable(ctx.win, msg);
      record(8, "agent.md (결과물 4)", "인수인계 문서 생성 + 파일 저장", msg, r, {
        "agent.md 내용 생성": /agent\.md|인수인계|다음 AI|이어(서| )작업/.test(r.reply),
        "파일 저장 수행/시도": /저장(했|됐|할게)|파일로|워크스페이스/.test(r.reply),
      });
      await shot(ctx.win, "08-agent-md.png");
    }

    // ── 9. 디자인 스킬 (시트: "시각 품질 점검 ✅" 주장) ──
    {
      const msg = "지금 화면 어때 보여? 시각 품질 점검하고 고칠 점 3개만 집어줘.";
      const r = await sendAndWaitStable(ctx.win, msg);
      record(9, "디자인 점검 (시트 주장 ✅)", "브라우저 근거 기반 시각 품질 점검", msg, r, {
        "실제 화면 확인 근거": /브라우저|직접 (보|확인)|캡처|스크린샷/.test(r.reply),
        "구체적 개선점 제시": /\d|①|첫|두/.test(r.reply),
      });
      await shot(ctx.win, "09-design-check.png");
    }
  } finally {
    await closeApp(ctx);
  }
});
