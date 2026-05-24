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

// #174/#187 — chip option B: meta-skill (boa-search-skill-creator) drives
// 7자산 Q&A in chat. Initial rack is reduced to 1 starter chip and
// follow_up is empty. Tests T1.B.2–T1.B.7 collapsed to T1.B.2 (single
// starter chip render + dental-relevant text) + T1.B.6 (no follow_up rack
// appears after a reply).

test("T1.B.2 — single starter chip renders, dental/search-relevant text, not game vestige", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    const chips = cf.locator(".hps-chip");
    await expect(chips.first()).toBeVisible({ timeout: 10_000 });
    await expect(chips).toHaveCount(1);
    const text = (await chips.first().locator(".hps-chip-text").textContent()) ?? "";
    expect(text).toMatch(/검색 스킬|시작|search skill/i);
    expect(text).not.toMatch(GAME_WORDS);
    // No weak chip variant in option B — the meta-skill teaches Intent Clarity
    // via Phase 1 Q&A instead of a visual contrast chip.
    await expect(cf.locator(".hps-chip-weak")).toHaveCount(0);
  } finally {
    await closeApp(ctx);
  }
});

test("T1.B.6 — option B: no follow-up chip rack after an assistant reply", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    const cf = await chatFrame(ctx.win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });

    const textarea = cf.locator(".hps-input textarea").first();
    await textarea.fill("안녕");
    await textarea.press("Enter");

    const assistant = cf.locator(".hps-msg-assistant .hps-msg-body").last();
    await expect(assistant).toBeVisible({ timeout: 60_000 });
    await expect(async () => {
      const t = (await assistant.textContent()) ?? "";
      expect(t.length).toBeGreaterThan(5);
    }).toPass({ timeout: 60_000 });

    // With follow_up: [] the chip rack should not appear after a reply.
    // We allow at most the initial rack (which hides on reply by design).
    const followUpChips = cf.locator(".hps-chips-rack .hps-chip");
    await expect(followUpChips).toHaveCount(0, { timeout: 5_000 });
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
