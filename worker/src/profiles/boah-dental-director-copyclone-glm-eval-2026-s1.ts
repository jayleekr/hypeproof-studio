import type { Profile } from "./types";
import { profile as base } from "./boah-dental-director-copyclone-2026-s1.ts";

// GLM 평가 전용 쌍둥이 프로필 (hypeprooflab#549).
//
// 왜 있나: `compare-providers.mjs --via-worker` 는 벤더를 직접 고르지 못하고
// **프로필의 provider 핀**을 본다. GLM 을 copyclone UC 에서 재려면 원본 copyclone
// 과 provider 말고 전부 같은 프로필이 하나 있어야 한다. 그걸 이 파일이 제공한다:
// 원본을 그대로 spread 하고 네 가지만 덮는다 — system prompt·도구·게이트·max_tokens
// 전부 원본과 동일하므로 A/B 차이가 "provider 하나" 로 고정된다 (그래야 비교가 의미).
//
// 평가 전용이므로 강사 콘솔·토큰 발급 드롭다운에 노출하지 않는다(dashboard_hidden) —
// canary-sdk-contract 와 같은 "레지스트리에는 있지만 수업에는 안 쓰는 프로필" 패턴.
// 실제 수업은 계속 원본(boah-dental-director-copyclone-2026-s1)이 돈다.
//
// 사용: 이 프로필로 세션을 열어 학생 토큰을 받고, 원본 프로필 토큰과 나란히
//   WORKER_TOKEN_A=<원본(Sonnet)>  WORKER_TOKEN_B=<이 프로필(GLM)> \
//     node worker/scripts/compare-providers.mjs --via-worker <cases.json>
// (이 프로필로 세션을 열려면 issuer 스코프의 profiles 목록에 이 id 가 있어야 한다.)
export const profile: Profile = {
  ...base,
  id: "boah-dental-director-copyclone-glm-eval-2026-s1",
  display_name: "보아치과 카피클론 — GLM 평가 전용 (숨김)",
  // 콘솔/드롭다운에서 숨긴다. /v1/profile 해석에는 영향 없음 — 평가용 토큰은 정상 발급·해석된다.
  dashboard_hidden: true,
  // provider 만 GLM 으로 핀. 나머지 model 필드(default/fallback/max_tokens)는 원본과 동일.
  model: { ...base.model, provider: "glm" },
};
