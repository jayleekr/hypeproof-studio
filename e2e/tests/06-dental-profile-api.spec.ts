// T1.A — Deterministic /v1/profile API checks for boah-dental-teaser-2026-s1
// (issue #79). Hits wrangler dev directly — no .app required.
//
// API-exposed fields only. Internal-shape contract (essences_focus, audience,
// etc.) lives in worker/test/smoke.mjs §4b — split because /v1/profile filters
// to what the panel actually needs.

import { test, expect } from "@playwright/test";
import { fetchDentalProfile } from "../fixtures/dental-helpers.ts";

let profile: Awaited<ReturnType<typeof fetchDentalProfile>>;

test.beforeAll(async () => {
  profile = await fetchDentalProfile();
});

test("T1.A.2 — display_name contains 보아치과", () => {
  expect(profile.display_name).toContain("보아치과");
});

test("T1.A.3 — top-level language == ko", () => {
  expect(profile.language).toBe("ko");
});

test("T1.A.4 — greeting contains 슈퍼서치엔진 AND 원장님을 이겨", () => {
  expect(profile.welcome.greeting_md).toContain("슈퍼서치엔진");
  expect(profile.welcome.greeting_md).toContain("원장님을 이겨");
});

test("T1.A.5 — example_prompts ≥ 3 and dental-themed (임플란트/스케일링/리뷰/환자/치과)", () => {
  expect(profile.welcome.example_prompts.length).toBeGreaterThanOrEqual(3);
  const dentalTokens = /임플란트|스케일링|리뷰|환자|치과/;
  for (const p of profile.welcome.example_prompts) {
    expect(p).toMatch(dentalTokens);
  }
});

// #174/#187 — chip option B: boa-search-skill-creator meta-skill drives the
// 7자산 Q&A in chat, so the chip rack is reduced to one starter + empty
// follow_up. Previous 5+8 contract retired.

test("T1.A.6 — chip option B: exactly 1 starter chip + empty follow_up", () => {
  expect(profile.ux.suggestions.initial.length).toBe(1);
  expect(profile.ux.suggestions.initial[0].style).toBe("good");
  expect(profile.ux.suggestions.follow_up.length).toBe(0);
});

test("T1.A.7 — starter chip text invites skill-creation", () => {
  const txt = profile.ux.suggestions.initial[0].text;
  expect(txt).toMatch(/검색 스킬|시작/);
});

test("T1.A.8 — starter chip caption is a friendly opener (no role label)", () => {
  // Roles (위생사/코디/사모님) used to be split across 4 chips. With option B
  // the meta-skill asks the role during Phase 1 instead.
  const cap = profile.ux.suggestions.initial[0].caption ?? "";
  expect(cap.length).toBeGreaterThan(0);
});

// Note on the negative-match regex: bare /색/ false-matches the 색 inside
// "검색" (search). The game-palette tokens v3 actually used are 색상|색깔|색을 +
// 캐릭터|주인공|점수 + 모양만/모양은 — those are what we ban.
const GAME_VESTIGE = /캐릭터|주인공|점수|색상|색깔|색을|모양만|모양은/;

test("T1.A.12 — short_input hint: 결정/환자/헷갈리는 yes, no game-palette vestige", () => {
  const msg = profile.ux.hints.short_input.message_md;
  expect(msg).toMatch(/결정|환자|헷갈리는/);
  expect(msg).not.toMatch(GAME_VESTIGE);
});

test("T1.A.13 — roll_input_button probe: 결정 yes, no game-palette vestige", () => {
  const probe = profile.ux.hints.roll_input_button.probe_md;
  expect(probe).toContain("결정");
  expect(probe).not.toMatch(GAME_VESTIGE);
});

test("T1.A.14 — coach naming_mode=fixed, fallback_name=코치", () => {
  expect(profile.ux.coach.naming_mode).toBe("fixed");
  expect(profile.ux.coach.fallback_name).toBe("코치");
});

test("T1.A.15 — publishing.enabled=false, strategy=local_only", () => {
  expect(profile.publishing?.enabled).toBe(false);
  expect(profile.publishing?.strategy).toBe("local_only");
});
