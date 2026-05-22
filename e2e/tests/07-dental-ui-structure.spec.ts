// T1.B — Deterministic UI rendering checks for boah-dental-teaser-2026-s1
// (issue #79). Launches HypeProof Studio.app via existing app fixture; the
// dental token in /tmp/hps-token.txt is auto-seeded so the chat panel mounts
// against the dental cohort.
//
// Verifies that the v4 profile actually *reaches* the webview — catches
// hard-coded v3 strings in EmptyState etc.

import { test, expect } from "@playwright/test";
import { launchApp, closeApp, chatFrame } from "../fixtures/app.ts";

const GAME_WORDS = /공이 좌우|별이 떨어|캐릭터.*장애물|점프하는 게임|게임 만들/;

test("T1.B.1 — greeting in webview references 슈퍼서치엔진 (NOT v3 game text)", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });

    const greeting = cf.locator(".hps-empty-greeting").first();
    await expect(greeting).toBeVisible({ timeout: 10_000 });
    const text = (await greeting.textContent()) ?? "";
    // v4 contract: greeting must surface the supersearch / 원장님 framing.
    expect(text).toMatch(/슈퍼서치엔진|원장님|검색|치과/);
    // And explicitly NOT the game-making vestige.
    expect(text).not.toMatch(/만들어봐요 🎮|만들어봐요/);
  } finally {
    await closeApp(ctx);
  }
});

test("T1.B.2 — initial chips render 5 (4 good + 1 weak), weak is disabled", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    const chips = cf.locator(".hps-chip");
    await expect(chips.first()).toBeVisible({ timeout: 10_000 });
    await expect(chips).toHaveCount(5);
    await expect(cf.locator(".hps-chip-good")).toHaveCount(4);
    const weakChips = cf.locator(".hps-chip-weak");
    await expect(weakChips).toHaveCount(1);
    await expect(weakChips.first()).toBeDisabled();
  } finally {
    await closeApp(ctx);
  }
});

test("T1.B.3 — every good initial chip carries dental content", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    const goodChipTexts = await cf.locator(".hps-chip-good .hps-chip-text").allTextContents();
    expect(goodChipTexts.length).toBe(4);
    const dental = /임플란트|스케일링|리뷰|환자|치과|검색|병원/;
    for (const t of goodChipTexts) {
      expect(t).toMatch(dental);
      expect(t).not.toMatch(GAME_WORDS);
    }
  } finally {
    await closeApp(ctx);
  }
});

test("T1.B.4 — weak chip text == '치과 관련 질문 답해줘'", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    const weakText = await cf.locator(".hps-chip-weak .hps-chip-text").first().textContent();
    expect((weakText ?? "").trim()).toBe("치과 관련 질문 답해줘");
  } finally {
    await closeApp(ctx);
  }
});

test("T1.B.5 — initial chip role captions cover 위생사/코디/사모님", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    const caps = await cf.locator(".hps-chip-good .hps-chip-caption").allTextContents();
    const joined = caps.join(" ");
    expect(joined).toContain("위생사");
    expect(joined).toContain("코디");
    expect(joined).toContain("사모님");
  } finally {
    await closeApp(ctx);
  }
});

test("T1.B.6 — after assistant reply, 7 follow-up chips render", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });

    const textarea = cf.locator(".hps-input textarea").first();
    await textarea.fill("안녕");
    await textarea.press("Enter");

    const assistant = cf.locator(".hps-msg-assistant .hps-msg-body").last();
    await expect(assistant).toBeVisible({ timeout: 60_000 });
    // Wait for streaming to settle.
    await expect(async () => {
      const t = (await assistant.textContent()) ?? "";
      expect(t.length).toBeGreaterThan(5);
    }).toPass({ timeout: 60_000 });

    // Follow-up chip rack renders only after a reply lands. The initial chips
    // are now hidden so the visible rack must be the follow-up one.
    // 7 E# chips + 1 "V1 First Shot" action chip = 8 (#157).
    const racks = cf.locator(".hps-chips-rack");
    await expect(racks.last().locator(".hps-chip")).toHaveCount(8, { timeout: 15_000 });
  } finally {
    await closeApp(ctx);
  }
});

test("T1.B.7 — follow-up chips cover all 7 Essences plus the V1 First Shot action (#157)", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });

    const textarea = cf.locator(".hps-input textarea").first();
    await textarea.fill("안녕");
    await textarea.press("Enter");
    await expect(cf.locator(".hps-msg-assistant .hps-msg-body").last())
      .toBeVisible({ timeout: 60_000 });

    // Wait for the follow-up rack to settle — chip caption nodes appear after
    // streaming ends and the showFollowUpChips flag flips. 8 = 7 E# + V1 action.
    const racks = cf.locator(".hps-chips-rack");
    await expect(racks.last().locator(".hps-chip")).toHaveCount(8, { timeout: 30_000 });
    await expect(racks.last().locator(".hps-chip-caption")).toHaveCount(8, { timeout: 10_000 });

    const followCaps = await racks.last().locator(".hps-chip-caption").allTextContents();
    expect(followCaps.length).toBe(8);
    const captionRe = /E(2|7|9|11|12|13|14)\b|V1 First Shot/;
    for (const c of followCaps) {
      expect(c).toMatch(captionRe);
    }
    // All 7 essences still surfaced; V1 First Shot accounts for the 8th.
    const seen = new Set<string>();
    for (const c of followCaps) {
      const m = c.match(/E(2|7|9|11|12|13|14)\b/);
      if (m) seen.add(m[1]);
    }
    expect(seen.size).toBe(7);
    expect(followCaps.some((c) => /V1 First Shot/.test(c))).toBe(true);
  } finally {
    await closeApp(ctx);
  }
});

test("T1.B.8 — no v3 game vestige anywhere in webview DOM", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    const shellText = (await cf.locator(".hps-shell").textContent()) ?? "";
    // Banned tokens from v3 game frame.
    expect(shellText).not.toMatch(/공이 좌우|별이 떨어|장애물을 피하는|점프하는 게임/);
  } finally {
    await closeApp(ctx);
  }
});

test("T1.B.9 — short-input hint copy: 결정/환자 yes, no game-palette vestige", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });

    // Type a very short input to trigger the short-input hint (profile sets min_chars=5).
    const textarea = cf.locator(".hps-input textarea").first();
    await textarea.fill("ㅎ");

    const hint = cf.locator(".hps-hint").first();
    await expect(hint).toBeVisible({ timeout: 5_000 });
    const hintText = (await hint.textContent()) ?? "";
    expect(hintText).toMatch(/결정|환자|헷갈리는/);
    // 색 alone false-matches inside 검색 — ban only the game-palette tokens.
    expect(hintText).not.toMatch(/캐릭터|주인공|점수|색상|색깔|색을|모양만/);
  } finally {
    await closeApp(ctx);
  }
});
