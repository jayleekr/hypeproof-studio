// Pure helpers for the chat panel. Kept vscode-free so they can be unit-tested
// under plain Node — mirrors mintStudentTokenHelpers.ts / reportProblemHelpers.ts.

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
