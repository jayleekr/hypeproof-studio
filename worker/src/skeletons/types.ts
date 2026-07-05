// Pre-built game skeleton library.
//
// Why: the LLM writing a full game from a thin prose reference every time is
// inconsistent and low-quality. Instead we ship polished, complete, tested
// skeletons. The model PICKS the closest one and only swaps theme / characters
// / colors / rules — it never invents structure from scratch.
//
// Scalability: skeletons are grouped by TIER. A profile declares its tier;
// the Worker injects only that tier's skeletons into the system prompt. As
// cohorts get older the tier ladder goes up — same architecture, richer
// skeletons, all the way to WebGL/Three.js 3D.

export type SkeletonTier =
  | "kids-basic"     // 초3-4 (9-10세): canvas 2D, 한 메커니즘, 큰 이모지, 명확한 조작
  | "kids-rich"      // 초5-6 (11-12세): 여러 메커니즘, 레벨/적, 파티클, 사운드
  | "teen"           // 중등+: 물리, 상태 많음, 저장, 좀 더 코드 노출 OK
  | "pro-3d"         // 고급/성인: Three.js WebGL 3D, 씬 그래프
  | "search-webapp"  // 전문직 워크숍: 검색 결과·출처 신뢰도·결정 reframe 정적 웹앱 (no game loop)
  | "website";       // website-copyclone: 타겟 스크린샷을 클론. 스켈레톤 없음 — 구조는 정답지(스크린샷)에서 옴

export interface Skeleton {
  id: string;
  tier: SkeletonTier;
  /** Short genre label the model matches against the kid's request. */
  genre: string;
  /** Korean one-liner describing what this template plays like. */
  summary_ko: string;
  /** Tags the model uses to choose (e.g. ["떨어지는", "받기", "바구니"]). */
  tags: string[];
  /** The full, runnable HTML. Bundled at build time from a .html file. */
  html: string;
}

/**
 * Universal contract — applies to every skeleton regardless of tier:
 *
 *  1. Single self-contained HTML document (`<!doctype html> … </html>`).
 *  2. No external URLs / libraries (except a tier-pinned CDN for pro-3d).
 *  3. Korean-first copy, mobile viewport (`<meta name="viewport">`), a11y basics
 *     (`<label>`, semantic landmarks, contrast ≥ 4.5:1 on body text).
 *
 * Game-tier (kids/teen/pro-3d) additional contract:
 *
 *  G1. Full-viewport canvas/scene, theme-coloured gradient background.
 *  G2. Title screen → play → game-over states, restart on Space/tap.
 *  G3. On-screen SCORE/feedback HUD.
 *  G4. **Persistent on-screen CONTROLS bar at the bottom** showing exactly how
 *      to play. A kid must never wonder what to press.
 *  G5. Mouse + touch + keyboard where it makes sense.
 *
 * search-webapp tier contract:
 *
 *  S1. Static layout (no canvas/game loop) — pure HTML/CSS/JS form/list UI.
 *  S2. Clinical or workshop design track CSS variables (`--accent`, `--bg`,
 *      `--trust-good`, etc.) defined; no hard-coded colors in body.
 *  S3. Placeholders `%%FOO%%` are declared in the skeleton registry and ALL
 *      appear in the template (build-time check).
 *  S4. Decision/result/source vocabulary is on-topic for the workshop domain
 *      — generic enough to swap %%CLINIC_NAME%% / %%SEARCH_TOPIC%% but
 *      domain-shaped (e.g. trust badges for clinical workshops).
 */
export const SKELETON_CONTRACT_VERSION = 2;
