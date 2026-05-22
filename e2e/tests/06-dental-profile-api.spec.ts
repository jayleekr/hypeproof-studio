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

test("T1.A.6 — initial suggestion chips count == 5", () => {
  expect(profile.ux.suggestions.initial.length).toBe(5);
});

test("T1.A.7 — weak chip text == '치과 관련 질문 답해줘'", () => {
  const weak = profile.ux.suggestions.initial.filter((c) => c.style === "weak");
  expect(weak.length).toBe(1);
  expect(weak[0].text).toBe("치과 관련 질문 답해줘");
});

test("T1.A.8 — initial good captions cover 위생사 + 코디 + 사모님", () => {
  const captions = profile.ux.suggestions.initial
    .filter((c) => c.style === "good")
    .map((c) => c.caption ?? "")
    .join(" ");
  expect(captions).toContain("위생사");
  expect(captions).toContain("코디");
  expect(captions).toContain("사모님");
});

test("T1.A.9 — follow_up chips include 7 Essences + V1 first-shot action (#157)", () => {
  // 7 E# chips + 1 "V1 First Shot" action chip = 8 (#157).
  expect(profile.ux.suggestions.follow_up.length).toBe(8);
});

test("T1.A.10 — each follow_up caption is either an E# or 'V1 First Shot' action (#157)", () => {
  const re = /E(2|7|9|11|12|13|14)\b|V1 First Shot/;
  for (const chip of profile.ux.suggestions.follow_up) {
    expect(chip.caption ?? "").toMatch(re);
  }
});

test("T1.A.11 — follow_up caption set still covers all 7 Essence numbers (no dup)", () => {
  const nums = new Set<string>();
  for (const chip of profile.ux.suggestions.follow_up) {
    const m = (chip.caption ?? "").match(/E(2|7|9|11|12|13|14)\b/);
    if (m) nums.add(m[1]);
  }
  expect(nums.size).toBe(7);
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
