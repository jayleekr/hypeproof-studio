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
  | "kids-basic"   // 초3-4 (9-10세): canvas 2D, 한 메커니즘, 큰 이모지, 명확한 조작
  | "kids-rich"    // 초5-6 (11-12세): 여러 메커니즘, 레벨/적, 파티클, 사운드
  | "teen"         // 중등+: 물리, 상태 많음, 저장, 좀 더 코드 노출 OK
  | "pro-3d";      // 고급/성인: Three.js WebGL 3D, 씬 그래프

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
 * Every skeleton, regardless of tier, MUST satisfy this contract (enforced by
 * a build-time test, and stated in the system prompt):
 *
 *  1. Single self-contained HTML document (`<!doctype html> … </html>`).
 *  2. No external URLs / libraries (except a tier-pinned CDN for pro-3d).
 *  3. Full-viewport canvas/scene, theme-coloured gradient background.
 *  4. Title screen → play → game-over states, restart on Space/tap.
 *  5. On-screen SCORE/feedback HUD.
 *  6. **A persistent on-screen CONTROLS bar at the bottom** showing exactly
 *     how to play (e.g. "← → 움직이기 · 스페이스 점프 · R 다시"). This is the
 *     single most-requested missing piece — a kid must never wonder what to
 *     press. It is part of the skeleton, not optional.
 *  7. Mouse + touch + keyboard where it makes sense (workshop laptops vary).
 */
export const SKELETON_CONTRACT_VERSION = 1;
