// #747 (E1 — AE-07 "표시 일관성") — ONE resolver for the AI's display identity,
// shared by the extension host and the webview.
//
// Why a separate file: `chatPanelHelpers.ts` uses `Buffer`, so the webview
// cannot import it and used to hand-mirror the fixed-name rule in
// `ChatPanel.tsx` (REQ-M33). This module is vscode-free and Buffer-free — the
// same precedent as `chatTimeline.ts` / `nativeObservationContract.ts` — so
// both sides import the same rule and the mirror is gone.
//
// Rule (unchanged from #140): a `fixed` cohort shows `fallback_name` and
// ignores any stored student name/personality (a lesson-fixed name arrives the
// same way — the Service projects it onto ux.coach, ADR-0005). Otherwise the
// student's stored name wins, then `fallback_name`, then "코치".
//
// The Korean particle helpers exist so every sentence that names the AI
// ("코치가 파일을 저장하려고 해요", "코치와 작업을 시작하세요") reads correctly
// for "별똥별" (받침) as well as "제작 파트너". With the default name "코치" every
// helper reproduces today's literal strings byte for byte.

export interface CoachIdentityState {
  name: string;
  personality: string;
}
export interface CoachIdentityProfile {
  ux: { coach: { naming_mode: string; fallback_name: string } };
}
export interface CoachIdentity {
  name: string;
  personality: string;
  /** true when the name is cohort/lesson-fixed and the student cannot rename it. */
  fixed: boolean;
}

export const DEFAULT_COACH_NAME = "코치";

export function resolveCoachIdentity(
  state: CoachIdentityState | null | undefined,
  profile: CoachIdentityProfile | null | undefined,
  defaultFallback = DEFAULT_COACH_NAME,
): CoachIdentity {
  const naming = profile?.ux.coach.naming_mode;
  const fallback = profile?.ux.coach.fallback_name || defaultFallback;
  if (naming === "fixed") return { name: fallback, personality: "", fixed: true };
  const name = state?.name?.trim() || fallback;
  const personality = state?.personality?.trim() ?? "";
  return { name, personality, fixed: false };
}

// ─── Korean particles ────────────────────────────────────────────────
// A Hangul syllable (U+AC00..U+D7A3) has a final consonant (받침) when
// (code − 0xAC00) % 28 ≠ 0. Names ending in anything else (Latin, digits,
// emoji, closing quote/bracket) take the vowel form, which is how mixed-script
// names are usually written. The last *letter* is used: a trailing closing
// bracket or quote is skipped.

function lastHangul(name: string): number | null {
  const chars = [...name.trim()];
  for (let i = chars.length - 1; i >= 0; i--) {
    const code = chars[i].codePointAt(0)!;
    if (/[\s)\]}>"'`»”’]/u.test(chars[i])) continue;
    if (code >= 0xac00 && code <= 0xd7a3) return code;
    return null;
  }
  return null;
}
const hasFinalConsonant = (name: string): boolean => {
  const code = lastHangul(name);
  return code !== null && (code - 0xac00) % 28 !== 0;
};

/** 주격 — 코치가 / 별똥별이 */
export const subjectParticle = (name: string): string => (hasFinalConsonant(name) ? "이" : "가");
/** 공동격 — 코치와 / 별똥별과 */
export const withParticle = (name: string): string => (hasFinalConsonant(name) ? "과" : "와");
/** 주제 — 코치는 / 별똥별은 */
export const topicParticle = (name: string): string => (hasFinalConsonant(name) ? "은" : "는");
/** 목적격 — 코치를 / 별똥별을 */
export const objectParticle = (name: string): string => (hasFinalConsonant(name) ? "을" : "를");

export const asSubject = (name: string): string => `${name}${subjectParticle(name)}`;
export const asCompanion = (name: string): string => `${name}${withParticle(name)}`;
export const asTopic = (name: string): string => `${name}${topicParticle(name)}`;
export const asObject = (name: string): string => `${name}${objectParticle(name)}`;

// ─── Sentences that name the AI ───────────────────────────────────────
// Kept here (not scattered) so a rename is one place and the default-name
// output is locked against today's strings by test/coach-identity.smoke.mjs.

/** Approval modal titles per request kind (host, VS Code modal). */
export function approvalCopyFor(name: string): Record<string, { title: string; verb: string }> {
  const s = asSubject(name);
  return {
    writeFile: { title: `${s} 파일을 저장하려고 해요:`, verb: "저장" },
    readFile: { title: `${s} 파일을 읽으려고 해요:`, verb: "읽기" },
    webSearch: { title: `${s} 웹에서 찾아보려고 해요:`, verb: "검색" },
    delegateAgent: { title: `${s} 다른 에이전트에게 맡기려고 해요:`, verb: "맡기기" },
    browserType: { title: `${s} 페이지에 입력하려고 해요:`, verb: "입력" },
  };
}
export const approvalFallbackTitle = (name: string): string => `${asSubject(name)} 작업을 하려고 해요`;
export const shellApprovalTitle = (name: string): string => `${asSubject(name)} 명령을 실행하려고 해요:`;
export const browserApprovalTitle = (name: string): string => `${asSubject(name)} 브라우저를 열려고 해요:`;

/** #476 in-panel notice when the SDK runtime fell back to the proxy. */
export const coachDegradedNotice = (name: string): string =>
  `지금 ${asTopic(name)} 파일 저장·명령 실행 도구 없이 돌고 있어요 — 만들기와 미리보기는 그대로 되지만, ` +
  "저장소·배포는 이 상태에서 안 돼요. 스태프를 불러주세요.";

/** #308 page-attach inline notice. */
export const pageAttachedNotice = (name: string, withShot: boolean, label: string): string =>
  `${withShot ? "🖼 화면과 내용을" : "📄 내용을"} ${name}에게 붙였어요 — ${label}. 이제 질문을 입력해 보내세요.`;

/** Start page copy (webview). `name` falls back to "코치" before a profile is known. */
export const startPageCopy = (name: string = DEFAULT_COACH_NAME) => ({
  startedTitle: `${asCompanion(name)} 작업을 시작하세요`,
  startedDescription: `${name} 채팅을 열었습니다. 채팅 입력창에 만들고 싶은 것을 적어주세요.`,
  confirmDescription: `수업과 ${asObject(name)} 확인한 뒤 작업을 시작하세요.`,
  continueButton: `${asCompanion(name)} 계속 작업하기`,
  stepTwo: `${asCompanion(name)} 작은 시도부터.`,
  disconnectedLead: `수업을 연결하면 이곳에서\n내 ${asCompanion(name)} 작업을 이어갈 수 있습니다.`,
  coachRowLabel: "AI 이름",
});

/** Observation panel intro (webview). */
export const observationIntro = (name: string): string =>
  `내가 요청한 내용과 ${name}·도구가 수행한 일을 나누어 확인합니다.`;
