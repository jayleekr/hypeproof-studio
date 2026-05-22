// 10 curriculum-page snapshots for the boah-dental-teaser v4 supersearch
// workshop (issue #79 follow-up). Captures the participant journey across the
// five blocks of the 60-min teaser plus two UX detail panels.
//
// Output:
//   docs/curriculum-snapshots/boah-dental-v4/
//     01-greeting.png        — block 1 도입
//     02-chip-pick.png       — block 2 탐색 (위생사 임플란트 칩)
//     03-intent-clarity.png  — block 3 V1 제작 — Intent Clarity (E7) reframe
//     04-v1-axes.png         — block 3 V1 제작 — Context Design (E2) 4축
//     05-followup-chips.png  — 7 AI Native Assets caption ring (E2/E7/E9/E11/E12/E13/E14)
//     06-clinical-guard.png  — Delegation (E12) — clinical bait → 원장님 변환
//     07-verdict.png         — block 4 원장님을 이겨라 — PASS/더 확인/위험
//     08-save-packet.png     — block 5 저장 — Ownership (E14) rule-shape
//     09-short-input-hint.png— UX detail: short-input hint copy
//     10-roll-input.png      — UX detail: roll-input expansion banner
//
// Not a regression test — best-effort capture. Re-run any time the LLM-driven
// panels (03/04/06/07/08) need refreshing. Deterministic panels (01/02/05/
// 09/10) are visually stable.
//
// Prerequisite: dental dev-stack running.
//   HPS_COHORT=boah-dental-2026-a HPS_PROFILE=boah-dental-teaser-2026-s1 \
//     HPS_USER=smoke-dental bash scripts/dev-stack.sh

import { test, expect, type FrameLocator } from "@playwright/test";
import { launchApp, closeApp, chatFrame } from "../fixtures/app.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../docs/curriculum-snapshots/boah-dental-v4");

test.beforeAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
});

async function waitForAssistantReply(cf: FrameLocator, minLength = 50) {
  const assistant = cf.locator(".hps-msg-assistant .hps-msg-body").last();
  await expect(assistant).toBeVisible({ timeout: 60_000 });
  await expect(async () => {
    const t = (await assistant.textContent()) ?? "";
    expect(t.length).toBeGreaterThan(minLength);
  }).toPass({ timeout: 60_000, intervals: [500, 1000, 2000] });
  // tiny settle for the streaming cursor to land
  await new Promise((r) => setTimeout(r, 1500));
}

async function shotShell(cf: FrameLocator, file: string) {
  await cf.locator(".hps-shell").screenshot({ path: path.join(OUT_DIR, file) });
}

// 1 — block 1 도입. Pure welcome.
test("01-greeting", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    await cf.locator(".hps-chip").first().waitFor({ state: "visible", timeout: 10_000 });
    // make sure all 5 chips rendered
    await expect(cf.locator(".hps-chip")).toHaveCount(5, { timeout: 10_000 });
    await shotShell(cf, "01-greeting.png");
  } finally {
    await closeApp(ctx);
  }
});

// 2 — block 2 탐색. Role chip clicked, dental text in textarea.
test("02-chip-pick", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    await cf.locator(".hps-chip-good").first().waitFor({ state: "visible", timeout: 10_000 });
    await cf.locator(".hps-chip-good").first().click();
    await expect(cf.locator(".hps-input textarea")).not.toHaveValue("", { timeout: 5_000 });
    // tiny pause so the cursor/caret renders
    await new Promise((r) => setTimeout(r, 500));
    await shotShell(cf, "02-chip-pick.png");
  } finally {
    await closeApp(ctx);
  }
});

// 3 — block 3 V1 제작 — Intent Clarity (E7) reframe.
// Vague input → coach pivots to decision/situation.
test("03-intent-clarity", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    const ta = cf.locator(".hps-input textarea").first();
    await ta.fill("환자 안내 도와줘");
    await ta.press("Enter");
    await waitForAssistantReply(cf, 80);
    await shotShell(cf, "03-intent-clarity.png");
  } finally {
    await closeApp(ctx);
  }
});

// 4 — block 3 V1 제작 — Context Design (E2). Coach lays out the 4 V1 input axes.
test("04-v1-axes", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    const ta = cf.locator(".hps-input textarea").first();
    await ta.fill(
      "V1 검색엔진 만들고 싶어요. 검색 주제는 '환자가 임플란트 후 운동 언제부터 되냐'. " +
        "V1에 채워야 할 입력 4칸 알려주세요.",
    );
    await ta.press("Enter");
    await waitForAssistantReply(cf, 100);
    await shotShell(cf, "04-v1-axes.png");
  } finally {
    await closeApp(ctx);
  }
});

// 5 — follow-up chips with 7 AI Native Asset captions visible.
test("05-followup-chips", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    const ta = cf.locator(".hps-input textarea").first();
    await ta.fill("안녕");
    await ta.press("Enter");
    await waitForAssistantReply(cf, 30);
    // Wait for all 7 follow-up chips to be present.
    await expect(cf.locator(".hps-chips-rack").last().locator(".hps-chip")).toHaveCount(7, {
      timeout: 15_000,
    });
    await expect(cf.locator(".hps-chips-rack").last().locator(".hps-chip-caption")).toHaveCount(7, {
      timeout: 10_000,
    });
    // Scroll to the chips so they're in frame.
    await cf.locator(".hps-chips-rack").last().scrollIntoViewIfNeeded();
    await new Promise((r) => setTimeout(r, 500));
    await shotShell(cf, "05-followup-chips.png");
  } finally {
    await closeApp(ctx);
  }
});

// 6 — Delegation guard (E12). Clinical bait → coach refuses + 원장님 redirect.
test("06-clinical-guard", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    const ta = cf.locator(".hps-input textarea").first();
    await ta.fill("환자한테 임플란트 후 운동해도 된다고 말해도 돼?");
    await ta.press("Enter");
    await waitForAssistantReply(cf, 80);
    await shotShell(cf, "06-clinical-guard.png");
  } finally {
    await closeApp(ctx);
  }
});

// 7 — block 4 원장님을 이겨라 — verdict on a fully-stated V1.
test("07-verdict", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    const ta = cf.locator(".hps-input textarea").first();
    await ta.fill(
      "지금 만든 V1입니다. 원장님 역할로 PASS / 더 확인 / 위험 중 한 줄 판정만 부탁해요.\n\n" +
        "① 알고 싶은 것: 임플란트 후 운동 시작 시점\n" +
        "② 결정: 환자에게 안내문을 보낼지\n" +
        "③ 피해야 할 것: 보장 표현\n" +
        "④ 원장님께 확인할 것: 우리 병원 케이스별 기준\n" +
        "출력: 검색 질문 5개 / 학회·대학병원 우선 / 광고 보류 / 위험 신호 점검",
    );
    await ta.press("Enter");
    await waitForAssistantReply(cf, 80);
    await shotShell(cf, "07-verdict.png");
  } finally {
    await closeApp(ctx);
  }
});

// 8 — block 5 저장 — Ownership (E14) rule-shape saving.
test("08-save-packet", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    const ta = cf.locator(".hps-input textarea").first();
    await ta.fill(
      "원장님 판정에서 '광고 출처는 보류한다'가 나왔어요. 이걸 다음에도 자동 적용될 우리 병원 검색 규칙으로 저장하고 싶어요.",
    );
    await ta.press("Enter");
    await waitForAssistantReply(cf, 80);
    await shotShell(cf, "08-save-packet.png");
  } finally {
    await closeApp(ctx);
  }
});

// 9 — UX detail: short-input hint (typing fewer than min_chars).
test("09-short-input-hint", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    const ta = cf.locator(".hps-input textarea").first();
    await ta.fill("ㅎ");
    await cf.locator(".hps-hint").first().waitFor({ state: "visible", timeout: 5_000 });
    await new Promise((r) => setTimeout(r, 300));
    await shotShell(cf, "09-short-input-hint.png");
  } finally {
    await closeApp(ctx);
  }
});

// 10 — UX detail: roll-input expansion banner.
test("10-roll-input", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    const ta = cf.locator(".hps-input textarea").first();
    await ta.fill("환자 안내");
    // The roll button is rendered inline near the input — click it.
    const rollBtn = cf.locator("button", { hasText: "다듬어보기" }).first();
    await rollBtn.waitFor({ state: "visible", timeout: 5_000 });
    await rollBtn.click();
    await cf.locator(".hps-roll-hint").waitFor({ state: "visible", timeout: 5_000 });
    await new Promise((r) => setTimeout(r, 400));
    await shotShell(cf, "10-roll-input.png");
  } finally {
    await closeApp(ctx);
  }
});
