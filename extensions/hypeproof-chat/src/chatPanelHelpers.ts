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

/**
 * "지금 열린 세상" 의 저장 키 (#649, 2026-08-20 검토).
 *
 * 메모리 필드로만 두었더니 VS Code 창을 다시 열면 index.html 은 아이가 고친 세상
 * 그대로인데 앱만 "아무 세상도 안 열림" 으로 돌아갔다 — 친구 스트립의 강조가
 * 사라지고, 러너가 ✨ 로 달리고, 대화를 지운 뒤 첫 전송에 붙던 세상 안내도 영영
 * 안 붙었다(교실에서 노트북을 닫았다 여는 흔한 경로). 히스토리와 같은 스코프
 * (코호트별 workspaceState)에 값 하나만 얹는다.
 */
export const LEGACY_OPEN_WORLD_KEY = "hypeproofChat.openWorld";

export function openWorldKeyForCohort(cohortId: string | null | undefined): string {
  const bucket = stateBucketId(cohortId);
  return bucket ? `${LEGACY_OPEN_WORLD_KEY}:${bucket}` : LEGACY_OPEN_WORLD_KEY;
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

export type AppTone = "game" | "search" | "site" | "quest";

/**
 * Pick the UI tone for hard-coded chat-panel labels.
 *
 * `search-webapp` tier (e.g. boah-dental teaser) → "search" tone (검색엔진 어휘).
 * `website` tier (보아치과 원장 copyclone) → "site" tone (웹사이트 어휘).
 * `kids-quest` tier ("게스트 퀘스트") → "quest" tone (게스트를 돕는 어휘, "게임" 없음).
 * Anything else (kids-basic, etc.) → "game" tone — the legacy default.
 *
 * 2026-08-17 — kids-world(→ 08-19 kids-quest 로 교체) 를 추가하기 전에는 이 함수가 `game` 으로 떨어뜨렸고,
 * 그래서 "게임" 이라는 낱말이 UI 8곳(만드는 중 라벨·미리보기 제목·플레이스홀더·
 * show-intent 회신·about 카드 2줄·토큰 확인 문구·이모지)에 그대로 나왔다.
 * 그 커리큘럼은 **"게임" 프레임을 금지**한다("게임이라는 말을 먼저 꺼내지
 * 마세요") — 프롬프트는 지키는데 앱이 어겼다. Windows 실기기 손 테스트에서
 * 발견됐다.
 *
 * Centralized so both the host extension and the webview render consistent
 * copy without each one redoing the tier check.
 */
export function appToneOf(profile: ProfileToneShape | null | undefined): AppTone {
  const tier = profile?.game?.template_tier;
  if (tier === "search-webapp") return "search";
  if (tier === "website") return "site";
  if (tier === "kids-quest") return "quest";
  return "game";
}

/** Hard-coded copy table keyed by tone. */
export const TONE_LABELS = {
  // "게스트 퀘스트" 트랙. 산출물은 게임이 아니라 게스트(초코·나비…)의 문제를
  // 푸는 것이다. 진행 라벨은 "생각 중…" — 만드는 대상을 이름 붙이지 않는다
  // (무엇을 만드는지는 아이가 정하는 것이고, 코치가 먼저 규정하면 프레임이 된다).
  quest: {
    buildingLabel: "생각 중…",
    namingEmoji: "✨",
    previewTitle: "✨ 친구를 도와주는 곳",
    previewPlaceholder: "여기에 나와요 — 친구가 기다리고 있어요",
    tokenConfirmTail: "같이 도와줘요 ✨",
    showIntentReply: "오른쪽 창에 띄웠어요! ✨ 한번 해보세요.",
    aboutTitle: "✨ 게스트 퀘스트",
    aboutSubtitle: '채팅에서 "초코 얘기 들려줘"라고 말해보세요!',
  },
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
  // 같은 실기기 세션 — "완성된 거 안 보여" 는 **명령이 아니라 불평**이라 아래
  // 동사 패턴에 안 걸렸고, 코치에게 넘어가 세계를 통째로 다시 그렸다.
  //
  // 프롬프트로 먼저 막아봤지만 졌다. 트랙 프롬프트의 ⚠ 최상위 규칙이 "요청에는
  // 무조건 완전한 코드를 출력" + "예외는 고장 신고뿐" 이라, 코치는 "안 보여" 를
  // 고장 신고로 읽고 **지시받은 대로** 전체를 다시 출력했다. 규칙끼리 싸우면
  // 위쪽이 이긴다. 프롬프트 쪽도 예외를 파뒀지만(예외 ②), 아이를 기다리게 만드는
  // 실패를 모델 판단에 걸어두지 않는다 — 여기서 결정적으로 끊는다.
  //
  // 답은 show-intent 와 같다: **이미 만든 것을 연다.**
  //
  // 접두사를 좁게 유지하는 것이 안전판이다. "글씨가 안 보여" 는 진짜 수정
  // 요청이므로 여기 걸리면 안 되고, 접두사 목록에 없어서 안 걸린다.
  if (
    /^(그거|저거|이거|완성(된)?\s*(거|것)?|만든\s*(거|것)?|화면|미래|그림|세계|동네|게임)?\s*(이|가|은|는)?\s*(아직\s*)?(안\s*(보여|보이|나와|나오)|어디\s*(있어|야|에\s*있어)|아직(이야|이에요|인가|야)?)(는데|네|요|어|어요|는데요)?$/.test(
      t,
    )
  ) {
    return true;
  }
  // 2026-08-17 Windows 실기기 — "띄워봐" 가 여기 없어서 show-intent 가 안 걸렸고,
  // 메시지가 코치에게 넘어가 **세계를 처음부터 다시 그렸다**("또 만드는 중이 나옴").
  // 접두사도 `게임` 뿐이라 "미래 보여줘"·"그림 보여줘" 처럼 새 트랙에서 아이가
  // 실제로 쓰는 말이 전부 빠져나갔다. 동사와 접두사를 트랙 어휘까지 넓힌다.
  return /^(그거\s*)?(게임|미래|그림|세계|동네|화면\s*)?\s*(보여|열어|띄워|띄어|실행|돌려|켜|플레이|미리\s*보기|다시\s*보여|run|play|open|show)(줘|봐|해|해줘|해봐|해주세요|보자|주세요)?$/.test(
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
  // 2026-08-11 — 프로필이 agent-sdk 를 요청하면 미성년이어도 존중한다.
  // 워커가 이미 그 판단을 했고(routes/chat.ts), 아동 코호트가 파일 도구를
  // opt-in 할 수 있게 됐다. 여기서 한 번 더 깎으면 프로필이 연 권한이 조용히
  // 사라진다.
  if (args.profileRuntime === "agent-sdk") return "agent-sdk";

  // 머신 스코프 설정은 여전히 미성년을 넘지 못한다. 프로필이 opt-in 하지 않은
  // 아동 코호트를 로컬 설정만으로 SDK 루프에 넣으면, 도구 0개 상태로 돌면서
  // 툴 호출 원문이 아이 화면에 노출되고 쓰지도 않은 파일을 썼다고 단언한다
  // (2026-08-11 실기기 관측, R0 위반). 그 경로만 막는다.
  if (args.settingRuntime === "agent-sdk") {
    return args.minorCohort === true ? "proxy" : "agent-sdk";
  }
  return "proxy";
}

/** kids-quest 세상 정의 (워커 /v1/profile 의 worlds 항목). */
export interface WorldRef { id: string; guest: string; emoji: string; chip: string; aliases: string[]; line?: string }

/**
 * 세상 전환은 **클릭만** (#649, 2026-08-20 결정). 칩 문구 정확일치만 인식한다 —
 * 이모지 포함형("🐕 초코 세상에 가볼래")과 미포함형("초코 세상에 가볼래") 두 가지.
 *
 * 왜 이름·이모지·별칭·'세상' 키워드 매칭을 통째로 버렸나 (v0.1.47/48 실기기):
 *  - "초코 세상에 다람쥐 데려와줘" → 별칭 '다람쥐' 가 걸려 **도토 세상**이 떴다.
 *  - "초코 세상에 불 대신 물" → 이름+'세상' 이 걸려 초코 원본을 다시 받는 바람에
 *    아이가 한참 고쳐 둔 index.html 을 **덮어썼다**(그 세상은 그렇게 사라졌다).
 * 이제 타이핑은 전부 코치에게 간다 — 세상은 버튼으로만 바뀐다.
 * 워커 worlds.ts 의 matchWorld 와 같은 규칙 — 두 곳을 함께 고칠 것.
 */
export function matchWorldRef(text: string, worlds: readonly WorldRef[] | undefined): WorldRef | null {
  if (!worlds?.length) return null;
  const t = text.trim();
  for (const w of worlds) {
    if (t === w.chip || t === w.chip.replace(/^\S+\s/, "")) return w;
  }
  return null;
}

/**
 * "다른 친구도 있어?" 류 — 게스트 목록은 프로필에 이미 있다(worlds). LLM 한 턴을
 * 쓰면 10~40초가 걸리는데, 아이가 기다릴 이유가 없다: 앱이 즉시 답한다.
 */
export function isGuestListRequest(text: string): boolean {
  const t = text.trim();
  if (t.length > 40) return false;
  return /다른 (친구|애|동물)|또 (누구|다른)|누가 더|친구 (목록|더)|다른 세상/.test(t);
}

/**
 * 덮어쓰기 전에 지금 세상을 넣어 두는 폴더 (작업 폴더 하위). #649, 2026-08-20.
 * 아이가 파일 탐색기에서 그대로 알아볼 수 있게 한국어 이름을 쓴다.
 */
export const WORLD_ARCHIVE_DIR = "이전 세상";

/**
 * 보관 파일 이름의 밑동 — 세상 HTML 의 `<title>`.
 * 파일명에 못 쓰는 문자는 지운다(윈도우 실기기에서 `:`·`?` 로 저장이 통째로 실패했다).
 */
export function worldArchiveTitle(html: string): string {
  // 2026-08-20 검토 — `/<title>([^<]{1,40})<\/title>/` 는 너무 좁았다: 대문자
  // `<TITLE>`·속성이 붙은 `<title id=t>`·41자 넘는 제목에서 전부 매칭에 실패해
  // 서로 다른 세상이 몽땅 '이전 세상.html' 로 뭉쳤다(아이가 자기 것을 못 찾는다).
  // 코치가 "제목 바꿔줘" 로 그 줄을 다시 쓰면 실제로 걸리는 경우다.
  // 길이는 매칭 조건이 아니라 **자르기**로 다룬다 — 긴 제목도 고유성을 잃지 않는다.
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const safe = raw
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim();
  return safe || "이전 세상";
}

/**
 * 같은 제목이 이미 보관돼 있으면 ' (2)', ' (3)' … 을 붙인다.
 * 덮어쓰지 않는 것이 핵심이다 — 보관본은 아이가 고쳐 둔 유일본이라, 한 번 덮으면
 * 되돌릴 길이 없다(#649 가 고치려는 사고 그 자체).
 */
export function worldArchiveFileName(
  title: string,
  taken: readonly string[] = [],
  now: Date = new Date(),
): string {
  const base = worldArchiveTitle(`<title>${title}</title>`);
  // 대소문자만 다른 이름도 같은 파일로 보는 파일시스템(macOS/Windows 기본)이 있다.
  const used = new Set(taken.map((n) => n.toLowerCase()));
  let name = `${base}.html`;
  for (let n = 2; used.has(name.toLowerCase()) && n <= 999; n++) name = `${base} (${n}).html`;
  // 2026-08-20 검토 — 옛 루프는 n=999 에서 **조건이 깨진 채로 빠져나와** 이미 있는
  // ' (999).html' 을 그대로 돌려줬다. 호출부는 검증 없이 writeFile 하므로 그게 곧
  // 조용한 덮어쓰기다 — #649 가 막으려던 사고 그 자체. 상한에 닿으면 반드시 유일한
  // 이름(시각, 그래도 겹치면 임의 꼬리)으로 떨어뜨린다.
  if (used.has(name.toLowerCase())) {
    const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ` +
      `${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
    name = `${base} (${stamp}).html`;
    for (let i = 0; used.has(name.toLowerCase()) && i < 50; i++) {
      name = `${base} (${stamp}-${Math.random().toString(36).slice(2, 6)}).html`;
    }
  }
  return name;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 지금 index.html 을 보관해야 하나?
 * 2026-08-20 (#649) — "같은 세상을 다시 골랐으면 건너뛴다" 는 규칙이 사고의 원인이었다:
 * 같은 세상이라도 그 사이 아이가 고쳐 둔 내용이 있으면 덮어쓰기로 사라진다.
 * 이제 판단 기준은 오직 **내용이 다른가** 다. (내용이 같으면 보관본이 쌓이기만 한다.)
 */
export function shouldArchiveWorld(current: string | null | undefined, next: string): boolean {
  if (typeof current !== "string" || current.trim() === "") return false;
  return current.trim() !== next.trim();
}

/**
 * 세상 엔진을 받을 주소 — **그 세상 것 먼저**, 안 되면 공용 (#644, 2026-08-20).
 *
 * 공용 `/worlds/engine.js` 에는 9개 세상 스프라이트가 전부 들어 있다(S_PENG 펭귄,
 * S_ICE 얼음…). 실기기(2026-08-20)에서 코치가 그 파일을 한 번 읽고 **초코 세상에서
 * 얼음 이야기**를 꺼냈다 — 아이가 보고 있는 세상에 없는 것을 코치가 말한 것이다.
 * 워커의 `/worlds/:id/engine.js` 는 그 세상이 쓰는 그림만 내려주므로 읽혀도 섞일
 * 것이 없다.
 *
 * 공용 폴백을 남기는 이유: 엔진이 없으면 화면이 아예 안 뜬다. 구버전 워커에는 세상별
 * 경로가 없으므로(404), 오염 위험보다 검은 화면이 더 나쁘다.
 */
export function worldEngineUrls(proxyUrl: string, id: string): string[] {
  const base = proxyUrl.replace(/\/+$/, "");
  return [`${base}/worlds/${encodeURIComponent(id)}/engine.js`, `${base}/worlds/engine.js`];
}

/** filterCoachVisibleFiles 가 보는 프로필의 최소 형태 (ResolvedProfile 의 부분집합). */
export interface CoachFileVisibilityProfile {
  minor_cohort?: boolean;
  game?: { template_tier?: string };
}

/**
 * 코치에게 보여 줄 작업 폴더 파일 목록 (#644, 2026-08-20).
 *
 * 아동 트랙에서 코치가 봐야 할 파일은 **index.html 하나**다. 나머지는 전부 "남의
 * 세상" 이다:
 *  - `engine.js` — 공용본이면 9개 세상 스프라이트가 다 들어 있다. 실기기에서 코치가
 *    이걸 읽고 초코 세상에 얼음을 꺼냈다(#644 의 방아쇠). 세상별 엔진으로 바꿔도
 *    코치가 읽을 이유는 없다 — 아이가 고치는 건 세상 HTML 이다.
 *  - `이전 세상/…` — 지나간 세상들의 전문(#649 보관본). 읽으면 지금 세상과 섞인다.
 *  - 루트의 다른 `*.html` — v0.1.48 이전에 루트로 보관되던 세상들이 남아 있다.
 * 목록에 뜨기만 해도 코치는 "뭐가 있나" 하고 읽는다 — 그래서 아예 안 보여 준다
 * (워커 시스템 프롬프트의 "engine.js 는 절대 읽지 마라" 는 금지 문구 한 겹 더).
 *
 * 성인 트랙은 무변경 — 작업 폴더 전체가 그들의 작업물이다.
 */
export function isWorldCohort(profile: CoachFileVisibilityProfile | null | undefined): boolean {
  // 2026-08-20 검토 — 옛 판정은 `minor_cohort === true` 단독도 아동 트랙으로 봤다.
  // 지금은 minor_cohort 를 다는 프로필이 kids-quest 둘뿐이라 실동작은 같지만,
  // kids-basic·kids-rich·teen 이 minor_cohort 로 들어오는 순간 그 아이들이 만든
  // game.js·추가 *.html 이 코치 목록에서 통째로 사라진다(코치는 '없는 파일' 로 보고
  // 새로 만든다). 이 필터의 근거는 "세상 = index.html 하나" 라는 **kids-quest 고유
  // 사실**이므로 판정도 거기에 맞춘다.
  const tier = profile?.game?.template_tier;
  return tier === "kids-quest" || (profile?.minor_cohort === true && !!tier?.startsWith("kids-"));
}

export function filterCoachVisibleFiles(
  files: readonly string[],
  profile: CoachFileVisibilityProfile | null | undefined,
): string[] {
  if (!isWorldCohort(profile)) return [...files];
  return files.filter((f) => {
    // 목록은 루트 기준 상대경로("/" 구분)지만, 윈도우발 "\" 도 같은 규칙으로 본다.
    const p = f.replace(/\\/g, "/").replace(/^\.\//, "");
    const lower = p.toLowerCase();
    if (lower.slice(lower.lastIndexOf("/") + 1) === "engine.js") return false;
    if (p === WORLD_ARCHIVE_DIR || p.startsWith(`${WORLD_ARCHIVE_DIR}/`)) return false;
    // 지금 세상만 남긴다 — 루트의 index.html 딱 하나.
    if (lower.endsWith(".html")) return lower === "index.html";
    return true;
  });
}

/**
 * Clear 뒤 첫 전송에 붙일 한 줄 (#644, 2026-08-20).
 *
 * 실기기 증상: 대화를 지우면 코치의 기억은 비는데 오른쪽 화면에는 세상이 그대로 떠
 * 있다. 그 상태로 아이가 "불 대신 물 떨어지게 해줘" 라고 하면 코치는 무슨 세상인지
 * 몰라 되묻거나 새 파일을 만들었다(아이가 고쳐 둔 index.html 과 무관한 것을).
 * 그래서 지금 열린 세상 한 줄만 모델 입력 앞에 다시 채워 준다 — 아이 말풍선에는
 * 붙이지 않는다(아이가 쓰지 않은 말이 아이 것으로 보이면 안 된다).
 *
 * 형식은 세상을 처음 열 때 붙이는 `[Studio 안내: …]` 와 같다.
 */
export function openWorldNotice(world: WorldRef | null | undefined): string {
  if (!world) return "";
  // 2026-08-20 검토 — `(문제: …)` 를 그냥 실으면 코치가 그것을 **지금 상태**로 읽는다.
  // 이 문구는 프로필의 정적 기본값(세상을 처음 열었을 때의 문제)이라, 아이가 🔥 를
  // 💧 로 바꿔 이미 해결한 뒤에도 똑같이 붙는다 — 코치가 고쳐 놓은 것을 되돌리는
  // 제안을 한다. 그래서 시점을 못박고, 현재 상태는 파일에서 확인하라고 시킨다.
  const problem = world.line?.trim() ? `(처음 문제: ${world.line.trim()} — 이미 고쳤을 수 있다)` : "";
  return (
    `[Studio 안내: 지금 열린 세상은 ${world.emoji} ${world.guest} 세상${problem} 이다. ` +
    `아이가 이 세상을 고치고 있다 — 새로 만들지 말고 작업 폴더의 index.html 을 Read 해서 ` +
    `지금 상태를 확인한 다음 고쳐라.]`
  );
}

/** 게스트 목록 안내문 (앱이 바로 띄운다). */
export function guestListMessage(worlds: readonly WorldRef[], shownChips: readonly string[] = []): string {
  const shown = new Set(shownChips);
  const rest = worlds.filter((w) => !shown.has(w.chip));
  const list = (rest.length ? rest : worlds)
    .map((w) => `- ${w.emoji} **${w.guest}** — ${w.line ?? "곤란한 일이 있대요"}`)
    .join("\n");
  // #649 — 세상 전환은 클릭만. 여기서 "누구 세상에 가볼까요?" 라고 물으면 아이가
  // 이름을 타이핑하고, 그 타이핑은 (의도대로) 매칭되지 않아 세상이 안 열린다.
  // 그래서 버튼을 가리킨다 — 친구 스트립은 작성란 바로 위, 곧 **이 말풍선보다 아래**다.
  // 2026-08-20 검토: 여기가 "위 …👆" 였다. 코드 주석의 '작성란 기준 위' 를 아이용
  // 문구로 그대로 옮기는 바람에 방향이 뒤집혀, 유일한 안내가 지나간 대화를 가리켰다.
  return `네! 이런 친구들도 있어요 😊\n\n${list}\n\n아래 친구 버튼을 눌러요 👇`;
}

/**
 * #580 — turn_end.error_kind 분류값. 에러 **원문(산문)은 절대 넣지 않는다**
 * (임의 텍스트·PII 가 로그로 흘러드는 통로가 된다) — 분류만 남겨도 "usage
 * 없는 턴"의 원인 분석(REQ-Q7)에는 충분하다. 덕 타이핑인 이유: 에러 클래스
 * import 없이 플레인 Node 스모크로 검증하기 위해 (이 파일의 규율).
 */
export function classifyTurnError(err: unknown): string {
  if (!err || typeof err !== "object") return "unknown";
  const e = err as { name?: unknown; kind?: unknown; requestId?: unknown };
  // ProxyAuthError — kind 가 원인 그 자체다 (missing/expired/session_inactive…).
  if (typeof e.kind === "string" && e.kind) return `auth:${e.kind}`;
  const name = typeof e.name === "string" ? e.name : "";
  if (name === "CoachStallError") return "stall";
  if (name === "AbortError") return "aborted";
  // ProxyTransportError — requestId 프로퍼티가 시그니처 (값은 undefined 일 수 있음).
  if ("requestId" in e) return "transport";
  return name && name !== "Error" ? name.slice(0, 60) : "error";
}
