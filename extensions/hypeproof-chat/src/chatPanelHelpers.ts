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
  const parsed = decodeTokenPayloadUnverified(token);
  const c = parsed?.c;
  return typeof c === "string" && c.trim() ? c : undefined;
}

/** Decode the (unverified) payload half of `<base64url(payload)>.<sig>`. */
export function decodeTokenPayloadUnverified(
  token: string | null | undefined,
): Record<string, unknown> | undefined {
  try {
    if (!token) return undefined;
    const parts = token.split(".");
    if (parts.length !== 2) return undefined;
    const payload = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * #381 — is this an issuer (instructor) token pasted into the participant
 * token box? Instructor tokens carry `role: "issuer"` and a placeholder
 * cohort/profile, so the server's answer is `unknown profile` — historically
 * shown as the same "확인이 안 돼요" as every other failure.
 *
 * DIAGNOSIS ONLY — never a gate (same contract as looksLikeWorkshopToken).
 * Signature is not checked, so this can only make the message better; the
 * server still decides what the token may do. Catching it client-side also
 * means the message is right against a worker that predates the `wrong_role`
 * code, and before any network call at all.
 */
export function looksLikeIssuerTokenUnverified(token: string | null | undefined): boolean {
  const payload = decodeTokenPayloadUnverified(token);
  if (!payload) return false;
  if (payload.role === "issuer") return true;
  // Belt-over-braces: issueIssuer() stamps these placeholders (worker
  // lib/tokens.ts), so an older issuer token without an explicit role still
  // gets named correctly.
  return payload.c === "__issuer__" || payload.p === "__issuer__";
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

// ─── AI disclosure at session start (#320, REQ-C14) ─────────────────────────

/**
 * #320 — mandatory AI disclosure copy. Anthropic Usage Policy requires
 * consumer-facing chat products to disclose "you are interacting with AI" at
 * minimum at the start of a session; the second sentence (don't rely on
 * outputs without checking) also satisfies ToS §D.3 and embodies the
 * verification_reflex asset (docs/seven-assets.md). Kid-friendly Korean —
 * keep both sentences if you edit.
 */
export const AI_DISCLOSURE_TEXT =
  "🤖 AI 코치와 대화하고 있어요. AI의 답은 틀릴 수 있으니 중요한 내용은 꼭 확인해요!";

/**
 * Session gate for the AI disclosure notice (#320). The webview has no memory
 * across hide/show remounts (WebviewView lacks retainContextWhenHidden — React
 * state resets every time), so the HOST decides when the notice is due, same
 * provider-side idiom as pendingPageNotice (#308/#310):
 *
 * - first webview "ready" of a session → show once;
 * - later "ready"s (hide/show remounts) within the same session → silent;
 * - history clear starts a NEW session → show again immediately.
 *
 * A "session" here is one extension-host run of the Studio, re-segmented by
 * every history clear — which is exactly when the conversation restarts from
 * the kid's point of view. Pure (no vscode) so the gating contract is locked
 * by a smoke test.
 */
export class AiDisclosureGate {
  private shown = false;

  /** Called on webview "ready". Returns the notice text only the first time per session. */
  noticeForReady(): string | null {
    if (this.shown) return null;
    this.shown = true;
    return AI_DISCLOSURE_TEXT;
  }

  /**
   * Called right after a history clear — a new session starts and the notice
   * is due again NOW (the caller posts it immediately; the gate stays "shown"
   * so subsequent remounts within this new session are silent).
   */
  noticeForHistoryClear(): string {
    this.shown = true;
    return AI_DISCLOSURE_TEXT;
  }
}

/**
 * #476 — agent-sdk 런타임을 요청한 코호트가 프록시로 떨어졌을 때 **참가자에게**
 * 보이는 한 줄.
 *
 * 왜 필요한가: 폴백 자체는 의도된 설계다(#387 — 미시딩 머신에서도 수업이 죽지
 * 않게). 문제는 그 사실이 아무에게도 안 보인다는 것이었다. 학생은 코치가 왜
 * 파일을 못 찾는지 모르고, 강사는 그 교실의 절반이 능력 없는 코치로 도는 걸
 * 모른다.
 *
 * 문구 원칙 두 가지:
 *  1. **할 수 없는 것을 구체적으로** 말한다. "문제가 생겼어요" 류는 참가자가
 *     자기가 뭘 잘못했다고 느끼게 만들고, 무엇을 포기해야 하는지도 안 알려준다.
 *  2. **여전히 되는 것을 같이** 말한다. 오늘의 핵심(페이지를 만들고 눈으로
 *     확인하기)은 프록시에서도 끝까지 된다 — 그걸 안 말하면 참가자가 수업을
 *     통째로 포기한다.
 */
export const COACH_DEGRADED_NOTICE =
  "지금 코치는 파일 저장·명령 실행 도구 없이 돌고 있어요 — 만들기와 미리보기는 그대로 되지만, " +
  "저장소·배포는 이 상태에서 안 돼요. 스태프를 불러주세요.";

/**
 * 개발자 로그 한 줄 (#476). `console.warn` 을 대신한다 — 확장에
 * `createOutputChannel` 이 없어 그 줄은 어디에도 안 남았고, 사고 당일
 * `exthost.log` 에서 `[coach]` 가 0건이었다.
 *
 * 사유(어떤 후보가 없었는지)를 그대로 싣는다. `SdkUnavailableError` 의 메시지가
 * 이미 해석 후보 4개를 나열하므로 재가공하지 않는다 — 요약하면 진단이 사라진다.
 */
export function sdkFallbackLogLine(reason: string, at: Date): string {
  return `[${at.toISOString()}] agent-sdk → proxy fallback: ${reason}`;
}

/**
 * #278 Phase 3 — a compact action-log line (icon + Korean label) for a browser
 * tool call, shown in the chat panel as the coach drives the browser. Pure so
 * it's unit-testable. Truncates long inputs; extracts the host for navigate.
 */
export function browserToolLogLine(
  name: string,
  input: Record<string, unknown>,
): { icon: string; label: string } {
  const clip = (v: unknown, n = 24): string => {
    const t = String(v ?? "");
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  switch (name) {
    case "browser_navigate": {
      const raw = String(input.url ?? "");
      let host = raw;
      try {
        host = new URL(/^\w+:\/\//.test(raw) ? raw : `https://${raw}`).host || raw;
      } catch {
        /* keep raw */
      }
      return { icon: "🔗", label: `${host} 로 이동` };
    }
    case "browser_read":
      return { icon: "👀", label: "페이지 읽는 중" };
    case "browser_screenshot":
      return { icon: "📸", label: "화면 캡처" };
    case "browser_click":
      return { icon: "👆", label: `${clip(input.ref)} 클릭` };
    case "browser_type":
      return { icon: "⌨️", label: `입력: "${clip(input.text)}"` };
    case "browser_back":
      return { icon: "◀", label: "뒤로" };
    case "browser_forward":
      return { icon: "▶", label: "앞으로" };
    case "browser_dialog":
      return { icon: "💬", label: `대화상자 ${clip(input.action)}` };
    default:
      return { icon: "🤖", label: name };
  }
}

/**
 * Normalize whatever the instructor actually pasted into the token box (#427).
 *
 * The workshop token is base64url segments joined by ".", so its alphabet is
 * [A-Za-z0-9_-.] — no whitespace, no colon. Anything else in the box is
 * packaging picked up on the way from the console to the app, and every form
 * of it used to produce a silent 401:
 *
 * - "jiwoong: eyJ…"  the console's bulk-copy format (이름: 토큰). This is the
 *                    one that actually bit us — the ONLY copy button used to
 *                    emit this shape, so the natural action produced a token
 *                    the app rejected.
 * - "Bearer eyJ…"    copied out of a curl invocation or the network tab.
 * - "eyJ…\n  …kCk"   relayed through KakaoTalk / a doc that hard-wrapped it;
 *                    the quick input joins the lines but keeps the indent.
 * - quoted/backticked when copied out of a chat message or code fence.
 *
 * Pure + exported so the parsing is locked by unit tests rather than by
 * retrying a lecture-day paste.
 */
export function sanitizeWorkshopToken(raw: string): string {
  // All whitespace, not just the ends — a wrapped paste carries the wrap indent
  // INSIDE the string, which `trim()` alone leaves behind.
  let s = raw.replace(/\s+/g, "");
  // The wrappers nest, and in no fixed order — 'jiwoong: "Bearer eyJ…"' is one
  // real paste. Peel until nothing changes instead of assuming an order; every
  // rule strictly shortens, so this terminates (the bound is belt-over-braces).
  for (let i = 0; i < 8; i++) {
    const before = s;
    // "<name>: <token>". A colon cannot occur inside base64url, so keeping only
    // what follows the LAST one is safe and never truncates a real token.
    const lastColon = s.lastIndexOf(":");
    if (lastColon !== -1) s = s.slice(lastColon + 1);
    // Quotes/backticks from a chat message or code fence.
    s = s.replace(/^["'`]+/, "").replace(/["'`]+$/, "");
    // "Bearer <token>" — whitespace is already gone, so match the bare prefix.
    // No base64url payload starts with "bearer" (ours all start "eyJ").
    s = s.replace(/^bearer/i, "");
    if (s === before) break;
  }
  return s;
}

/**
 * Does this look like a workshop token at all? `<base64url>.<base64url>`, the
 * same shape check the instructor console applies to its issuer box (#65).
 *
 * DIAGNOSIS ONLY — never a gate. The server owns validity; this just lets the
 * failure toast say "붙여넣기가 잘렸어요" instead of a generic "확인 안 됨",
 * which was the other half of why #427 cost a session. Because it never blocks,
 * a future token format cannot be false-rejected on the client.
 */
export function looksLikeWorkshopToken(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

/**
 * 어느 코치 런타임으로 갈 것인가 — 미성년은 어느 경로로도 SDK 에 닿지 않는다.
 *
 * 2026-08-11 실측에서 드러난 비대칭: 이 판단이 인라인이었을 때 프로필 경로만
 * 미성년을 걸렀고 **머신 설정 경로는 안 걸렀다.**
 *
 *   const profileWantsSdk = profile?.coach_runtime === "agent-sdk" && profile?.minor_cohort !== true;
 *   const runtime = settingRuntime === "agent-sdk" || profileWantsSdk ? "agent-sdk" : "proxy";
 *                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ 미성년 검사 없음
 *
 * 워커는 미성년 프로필의 coach_runtime 을 무조건 "proxy" 로 강제하는데
 * (routes/chat.ts, REQ-O 계열), `hypeproofChat.coachRuntime` 을 agent-sdk 로
 * 둔 기기에서는 그 핀이 우회됐다.
 *
 * **권한 침해는 아니다** — 도구는 프로필이 소유하고(permittedToolsFor),
 * 미성년 코호트는 sdk_tools 를 두지 않으므로 빈 배열이 나가며, write 는 minor
 * tier 에서 한 번 더 스트립된다. 하지만 결과가 나쁘다: 도구 0개로 SDK 루프가
 * 돌면서 **툴 호출 원문이 아이 화면에 그대로 렌더되고, 쓰지도 않은 파일을
 * 썼다고 단언**한다(R0 위반). 실기기에서 관측했다.
 *
 * 원 주석이 선언한 belt-and-suspenders 의도를 실제로 지킨다 — 미성년 검사를
 * 두 경로의 **합집합 바깥**에 둔다.
 */
export function resolveCoachRuntime(args: {
  /** 머신 스코프 설정 `hypeproofChat.coachRuntime`. */
  settingRuntime: "proxy" | "agent-sdk";
  /** 워커가 내려준 프로필의 요청 런타임 (없으면 proxy). */
  profileRuntime?: "proxy" | "agent-sdk";
  /** 워커가 내려준 minor_cohort. 모르면 undefined — 그 경우 막지 않는다(기존 동작). */
  minorCohort?: boolean;
}): "proxy" | "agent-sdk" {
  const wantsSdk = args.settingRuntime === "agent-sdk" || args.profileRuntime === "agent-sdk";
  if (!wantsSdk) return "proxy";
  // 미성년이면 어느 경로로 요청했든 proxy. fail-closed 는 아니다 —
  // minorCohort 를 모르는 상태(구 워커 응답)에서 기존 동작을 깨지 않는다.
  return args.minorCohort === true ? "proxy" : "agent-sdk";
}
