// Pure helpers for the chat panel. Kept vscode-free so they can be unit-tested
// under plain Node — mirrors mintStudentTokenHelpers.ts / reportProblemHelpers.ts.

export interface CoachStateForResolve {
  name: string;
  personality: string;
}
export interface CoachProfileForResolve {
  ux: { coach: { naming_mode: string; fallback_name: string } };
}

export const LEGACY_HISTORY_KEY = "hypeproofChat.history";
export const LEGACY_COACH_KEY = "hypeproofChat.coach";
export const LEGACY_COACH_RITUAL_DONE_KEY = "hypeproofChat.coachRitualDone";
export const HISTORY_MIGRATION_DONE_KEY = "hypeproofChat.historyMigratedToCohort";
export const COACH_MIGRATION_DONE_KEY = "hypeproofChat.coachMigratedToCohort";

/**
 * Local state is segmented by cohort. Keep the raw cohort id visible in the
 * key so support logs are readable, but constrain surprising characters.
 */
export function stateBucketId(cohortId: string | null | undefined): string | null {
  const id = cohortId?.trim();
  if (!id) return null;
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

export function historyKeyForCohort(cohortId: string | null | undefined): string {
  const bucket = stateBucketId(cohortId);
  return bucket ? `${LEGACY_HISTORY_KEY}:${bucket}` : LEGACY_HISTORY_KEY;
}

export function coachKeyForCohort(cohortId: string | null | undefined): string {
  const bucket = stateBucketId(cohortId);
  return bucket ? `${LEGACY_COACH_KEY}:${bucket}` : LEGACY_COACH_KEY;
}

export function coachRitualDoneKeyForCohort(cohortId: string | null | undefined): string {
  const bucket = stateBucketId(cohortId);
  return bucket ? `${LEGACY_COACH_RITUAL_DONE_KEY}:${bucket}` : LEGACY_COACH_RITUAL_DONE_KEY;
}

/**
 * HypeProof participant tokens are `<base64url(payload)>.<sig>`, where payload
 * includes `c` (cohort). The token has already been verified by /v1/profile
 * before the value is used for state isolation; this helper only chooses a
 * local storage bucket and never grants access.
 */
export function extractCohortIdUnverified(token: string | null | undefined): string | undefined {
  try {
    if (!token) return undefined;
    const parts = token.split(".");
    if (parts.length !== 2) return undefined;
    const payload = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json) as { c?: unknown };
    return typeof parsed.c === "string" && parsed.c.trim() ? parsed.c : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pick the coach name + personality to send to the proxy / show in the UI.
 *
 * For cohorts with `naming_mode === "fixed"` (e.g. boah-dental), any
 * user-supplied name carried over from a different cohort's user-data-dir
 * must be ignored — fallback_name wins, no personality bleed. (#140)
 *
 * For other modes, use whatever the user set; fall back to the profile
 * fallback if empty.
 */
export function resolveCoach(
  state: CoachStateForResolve | null | undefined,
  profile: CoachProfileForResolve | null | undefined,
  defaultFallback = "코치",
): { name: string; personality: string } {
  const naming = profile?.ux.coach.naming_mode;
  const fallback = profile?.ux.coach.fallback_name || defaultFallback;

  if (naming === "fixed") {
    return { name: fallback, personality: "" };
  }
  const name = state?.name?.trim() || fallback;
  const personality = state?.personality?.trim() ?? "";
  return { name, personality };
}

// ─── App tone (game vs search-webapp UI copy) (#159) ──────────────────

export interface ProfileToneShape {
  game?: { template_tier?: string };
}

export type AppTone = "game" | "search" | "site";

/**
 * Pick the UI tone for hard-coded chat-panel labels.
 *
 * `search-webapp` tier (e.g. boah-dental teaser) → "search" tone (검색엔진 어휘).
 * `website` tier (보아치과 원장 copyclone) → "site" tone (웹사이트 어휘).
 * Anything else (kids-basic, etc.) → "game" tone — the legacy default.
 *
 * Centralized so both the host extension and the webview render consistent
 * copy without each one redoing the tier check.
 */
export function appToneOf(profile: ProfileToneShape | null | undefined): AppTone {
  const tier = profile?.game?.template_tier;
  if (tier === "search-webapp") return "search";
  if (tier === "website") return "site";
  return "game";
}

/** Hard-coded copy table keyed by tone. */
export const TONE_LABELS = {
  game: {
    buildingLabel: "게임 만드는 중",
    namingEmoji: "🎮",
    previewTitle: "🎮 내 게임",
    previewPlaceholder: "게임이 여기에 나와요",
    tokenConfirmTail: "같이 만들어봐요 🎮",
    showIntentReply: "오른쪽 창에 게임을 열었어요! 🎮 한번 해보세요.",
    aboutTitle: "🎮 내 첫 게임",
    aboutSubtitle: '채팅에서 "게임 만들어줘"라고 말해보세요!',
  },
  search: {
    buildingLabel: "검색엔진 만드는 중",
    namingEmoji: "🔍",
    previewTitle: "🔍 내 검색엔진",
    previewPlaceholder: "검색엔진이 여기에 나와요",
    tokenConfirmTail: "같이 만들어봐요 🔍",
    showIntentReply: "오른쪽 창에 검색엔진을 띄웠어요! 🔍 한번 검색해보세요.",
    aboutTitle: "🔍 내 첫 검색엔진",
    aboutSubtitle: '채팅에서 "V1 짜줘"라고 말해보세요!',
  },
  site: {
    buildingLabel: "웹사이트 만드는 중",
    namingEmoji: "🌐",
    previewTitle: "🌐 내 웹사이트",
    previewPlaceholder: "웹사이트가 여기에 나와요",
    tokenConfirmTail: "같이 만들어봐요 🌐",
    showIntentReply: "오른쪽 창에 웹사이트를 띄웠어요! 🌐 한번 살펴보세요.",
    aboutTitle: "🌐 내 웹사이트",
    aboutSubtitle: '채팅에서 "이 화면처럼 만들어줘"라고 말해보세요!',
  },
} as const;

export function labelsForProfile(profile: ProfileToneShape | null | undefined) {
  return TONE_LABELS[appToneOf(profile)];
}

/** workspaceState ceiling — oldest turns dropped beyond this. */
export const HISTORY_MAX = 200;

/** Coach name length ceiling (REQ-F3). */
export const COACH_NAME_MAX = 40;

/** Coach personality length ceiling (REQ-F3). */
export const COACH_PERSONALITY_MAX = 200;

/**
 * Sanitize coach name + personality input from the webview. Trim, clamp to
 * length ceilings, fall back to profile-provided name when empty.
 */
export function sanitizeCoachInput(
  name: string,
  personality: string,
  fallbackName: string,
): { name: string; personality: string } {
  return {
    name: (name.trim() || fallbackName).slice(0, COACH_NAME_MAX),
    personality: personality.trim().slice(0, COACH_PERSONALITY_MAX),
  };
}

/**
 * Abort every active stream + clear the map. Wired into the webview view's
 * onDidDispose so closing the chat panel doesn't leave SSE connections
 * dangling. Extracted so it's unit-testable without spinning up a webview
 * (REQ-L3).
 */
export function abortAllStreams(
  streams: Map<string, { abort: () => void }>,
): void {
  for (const ctrl of streams.values()) {
    try {
      ctrl.abort();
    } catch { /* best-effort */ }
  }
  streams.clear();
}

/**
 * Append new turns and clamp to the last HISTORY_MAX. Pure so the clamp
 * contract is testable without spinning up VS Code.
 */
export function clampHistory<T>(current: T[], append: T[], max: number = HISTORY_MAX): T[] {
  if (max <= 0) return [];
  return [...current, ...append].slice(-max);
}

/**
 * Does the kid's message mean "(just) show/open/run the existing game"?
 *
 * Tight on purpose: a message that *describes* a game ("별이 떨어지는 게임
 * 보여줘") is a CREATE request, not a show request. So we only match short
 * messages that have no create/modify verbs and no descriptive content.
 *
 * Korean regex single-char trap: do NOT collapse the create-verb alternation
 * to bare single characters (e.g. /색/) — that would match "검색" and break
 * the dental cohort's 슈퍼서치엔진 prompts. Multi-char tokens or word-boundary
 * forms only.
 */
export function isShowIntent(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[!.?~\s]+$/g, "");
  if (t.length > 14) return false;
  // Creation/modification words → it's a new request, not "show it".
  // Multi-char tokens to avoid the "색" matches "검색" trap.
  if (/(만들|추가|바꿔|바꾸|그려|넣어|없애|지워|색깔|색을|색이|색상|소리|빠르|느리|크게|작게)/.test(t)) {
    return false;
  }
  return /^(그거\s*)?(게임\s*)?(보여|열어|실행|돌려|켜|플레이|미리\s*보기|다시\s*보여|run|play|open|show)(줘|봐|해|해줘|해봐|해주세요|보자)?$/.test(
    t,
  );
}
