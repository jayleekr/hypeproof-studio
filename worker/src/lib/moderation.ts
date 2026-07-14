// Gateway moderation layer for MINOR cohorts (#320, REQ-O1..O5).
//
// Anthropic's minors-guide requires organizations serving minors through the
// API to run their own content moderation in addition to model-side safety
// (see the 2026-07-13 licensing comment on #282). This module is that layer:
// a deterministic, conservative token/pattern screen applied by the worker
// gateway — NOT a model call, so it is cheap, auditable, and cannot be
// prompt-injected.
//
// Scope & posture:
//   - MINOR cohorts only (isMinorCohort). Adult cohorts skip this module
//     entirely — zero behavior change for them.
//   - Inbound: the latest user message text, screened BEFORE any upstream
//     call (blocked turns cost zero tokens and never reach the model).
//   - Outbound: the assistant text of NON-STREAMING responses. Streaming
//     outbound moderation is a documented follow-up — we deliberately do NOT
//     buffer streams (buffering would break the realtime UX for every turn
//     to catch a case the system prompt already defends), so the stream path
//     relies on the inbound screen + the cohort child-safety system prompt.
//   - Conservative = low false-positive: block only unambiguous matches.
//     Korean tokens are MULTI-CHAR ONLY — a single-char Korean regex matches
//     compounds (bare 색 matches 검색; known project trap) — and ambiguous
//     multi-char tokens are excluded too (야한 matches 이야기한, 섹스 matches
//     유니섹스 → lookbehind-guarded).
//
// Log hygiene (REQ-O5): the matched user text is NEVER logged verbatim.
// console.error + Analytics carry only the category, the rule id (rule ids
// name OUR public patterns, not user data) and a short FNV-1a hash of the
// matched substring (dedupe/debugging without content).

import type { Env } from "../env";
import type { Profile } from "../profiles/types";
import { logModeration } from "./analytics";

export type ModerationDirection = "inbound" | "outbound";

export type ModerationCategory =
  | "sexual_content"
  | "self_harm"
  | "graphic_violence"
  | "pii_solicitation";

export interface ModerationRule {
  id: string;
  category: ModerationCategory;
  re: RegExp; // NO /g flag — lastIndex state would make matching order-dependent
}

export interface ModerationHit {
  rule_id: string;
  category: ModerationCategory;
  /** FNV-1a hex of the matched substring — safe to log, not the text itself. */
  match_hash: string;
}

/**
 * Kid-friendly Korean block message (REQ-O2). Shown by the chat panel's error
 * banner; must never sound punitive, and must point at the human in the room.
 */
export const MODERATION_BLOCK_MESSAGE_KO =
  "앗, 이 이야기는 우리 워크숍에서 함께 다룰 수 없는 내용이에요. " +
  "대신 만들고 싶은 게임이나 궁금한 것을 물어봐 줄래요? " +
  "걱정되는 일이나 도움이 필요한 일이 있으면 옆에 계신 선생님께 꼭 이야기해 주세요.";

// ---------------------------------------------------------------------------
// Rules — keep this list SHORT and unambiguous. Every addition must pass the
// false-positive regression list in worker/test/moderation.test.mjs
// (검색/색상/이야기한/유니섹스/게임 속 몬스터 처치/사이트 주소 등).
// ---------------------------------------------------------------------------

const RULES: ModerationRule[] = [
  // --- explicit sexual content ---------------------------------------------
  // (?<!유니) guards 유니섹스(unisex); 야한 is deliberately absent (matches
  // 이야기한 — the 검색/색 trap class).
  { id: "sex-ko-1", category: "sexual_content", re: /성관계|(?<!유니)섹스|포르노|음란물/ },
  { id: "sex-en-1", category: "sexual_content", re: /\bporn(?:ography)?\b|\bhentai\b/i },

  // --- self-harm instruction ------------------------------------------------
  // Instruction-seeking patterns only. Bare ideation phrases are NOT blocked
  // here — the cohort child-safety system prompt handles empathetic redirect,
  // and blocking a cry for help with an error banner would be worse.
  { id: "harm-ko-1", category: "self_harm", re: /(자살|자해)\s*(하는\s*)?(방법|하는\s*법)/ },
  { id: "harm-ko-2", category: "self_harm", re: /(내가|스스로)\s*죽는\s*(방법|법)/ },
  { id: "harm-ko-3", category: "self_harm", re: /목\s*(을\s*)?매(는|다는)\s*(방법|법)/ },
  {
    id: "harm-en-1",
    category: "self_harm",
    re: /how\s+to\s+(kill\s+myself|commit\s+suicide|self[\s-]?harm)|\bsuicide\s+methods?\b/i,
  },

  // --- graphic violence -------------------------------------------------------
  // Requires a human target (사람/살인/고문). "몬스터를 죽이는 방법" is normal
  // game-design talk for this product and must pass.
  { id: "viol-ko-1", category: "graphic_violence", re: /사람(을|들을)?\s*(잔인하게\s*)?죽이는\s*(방법|법)/ },
  { id: "viol-ko-2", category: "graphic_violence", re: /(살인|고문)\s*(하는\s*)?(방법|법)/ },
  {
    id: "viol-en-1",
    category: "graphic_violence",
    re: /how\s+to\s+(kill|murder)\s+(a\s+person|someone|people)|how\s+to\s+torture\b/i,
  },

  // --- PII solicitation (전화번호/집주소/주민번호 asks) ------------------------
  // Both directions: an assistant asking a kid for PII (outbound) or a kid
  // fishing for someone's PII (inbound). 집주소 not bare 주소 — "사이트 주소
  // 알려줘" is a benign everyday request. Phone requires an explicit
  // give-it-to-me verb so "전화번호 입력 화면 만들어줘" (UI building) passes.
  { id: "pii-ko-1", category: "pii_solicitation", re: /(주민\s*등록\s*번호|주민번호)[^\n]{0,16}(알려|보내|말해|입력|적어)/ },
  { id: "pii-ko-2", category: "pii_solicitation", re: /(전화\s*번호|휴대폰\s*번호|핸드폰\s*번호)[^\n]{0,12}(알려\s*줘|알려\s*주|보내\s*줘|보내\s*주|말해\s*줘|말해\s*주)/ },
  { id: "pii-ko-3", category: "pii_solicitation", re: /집\s*주소[^\n]{0,12}(알려|보내|말해|적어)/ },
  {
    id: "pii-en-1",
    category: "pii_solicitation",
    re: /\b(give|send|tell)\s+me\s+your\s+(phone\s+number|home\s+address|social\s+security\s+number)\b|\bwhat(?:'|’)?s\s+your\s+(phone\s+number|home\s+address)\b/i,
  },
];

/**
 * Is this cohort a minors cohort? Fail-safe by design (REQ-O1, minor-safety
 * invariant): the explicit `minor_cohort: true` flag OR an audience age_range
 * whose upper bound is under 18 marks the cohort as minor — so forgetting the
 * flag on a future kids profile cannot silently disable moderation.
 */
export function isMinorCohort(profile: Profile): boolean {
  if (profile.minor_cohort === true) return true;
  const upper = profile.audience.age_range?.[1];
  return typeof upper === "number" && upper < 18;
}

/**
 * Screen a piece of text against the rule list. Returns the first hit or
 * null. Deterministic, synchronous, no state.
 */
export function screenText(text: string): ModerationHit | null {
  if (!text) return null;
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (m) {
      return { rule_id: rule.id, category: rule.category, match_hash: fnv1aHex(m[0]) };
    }
  }
  return null;
}

export interface ModerationContext {
  cohort_id: string;
  user_id: string;
  profile_id: string;
  direction: ModerationDirection;
}

/**
 * Log a moderation block: console.error (wrangler tail / observability) +
 * Analytics Engine datapoint. Never includes the matched text (REQ-O5).
 */
export function reportModerationHit(
  env: Env,
  requestId: string | undefined,
  ctx: ModerationContext,
  hit: ModerationHit,
): void {
  console.error(
    `[${requestId ?? "no-request-id"}] moderation_block cohort=${ctx.cohort_id} user=${ctx.user_id} ` +
      `profile=${ctx.profile_id} direction=${ctx.direction} category=${hit.category} ` +
      `rule=${hit.rule_id} match_fnv=${hit.match_hash}`,
  );
  logModeration(env, {
    cohort_id: ctx.cohort_id,
    user_id: ctx.user_id,
    profile_id: ctx.profile_id,
    direction: ctx.direction,
    category: hit.category,
    rule_id: hit.rule_id,
    match_hash: hit.match_hash,
  });
}

/** Tiny non-cryptographic hash — dedupe/debugging without logging content. */
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
