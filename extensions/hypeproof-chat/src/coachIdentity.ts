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
// (code − 0xAC00) % 28 ≠ 0. Trailing punctuation, symbols and whitespace are
// skipped so the last real letter or digit decides; digits use their
// Sino-Korean reading; Latin and emoji finals keep the vowel form.

// Sino-Korean readings of the digits; those ending in a consonant take the
// 받침 form. 0 영, 1 일, 3 삼, 6 육, 7 칠, 8 팔 → 받침; 2 이, 4 사, 5 오, 9 구 → none.
const DIGIT_FINAL_CONSONANT: Record<string, boolean> = {
  "0": true, "1": true, "2": false, "3": true, "4": false,
  "5": false, "6": true, "7": true, "8": true, "9": false,
};
// Trailing decoration a student may type ("별똥별!", "별똥별 ✨", "코치(임시)") does not
// decide the particle — the last letter or digit does. Latin and emoji finals keep
// the vowel form: their Korean reading is ambiguous and a wrong 받침 reads worse.
const TRAILING_DECORATION = /[\p{P}\p{S}\p{Cf}\s]/u;

function lastMeaningful(name: string): string | null {
  const chars = [...name.trim()];
  for (let i = chars.length - 1; i >= 0; i--) {
    if (TRAILING_DECORATION.test(chars[i])) continue;
    return chars[i];
  }
  return null;
}
const hasFinalConsonant = (name: string): boolean => {
  const ch = lastMeaningful(name);
  if (ch === null) return false;
  if (ch in DIGIT_FINAL_CONSONANT) return DIGIT_FINAL_CONSONANT[ch];
  const code = ch.codePointAt(0)!;
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
};

/** 주격 — 코치가 / 별똥별이 */
export const subjectParticle = (name: string): string => (hasFinalConsonant(name) ? "이" : "가");
/** 공동격 — 코치와 / 별똥별과 */
export const withParticle = (name: string): string => (hasFinalConsonant(name) ? "과" : "와");
/** 주제 — 코치는 / 별똥별은 */
export const topicParticle = (name: string): string => (hasFinalConsonant(name) ? "은" : "는");
/** 목적격 — 코치를 / 별똥별을 */
export const objectParticle = (name: string): string => (hasFinalConsonant(name) ? "을" : "를");
/** 서술격 — 코치예요 / 별똥별이에요 */
export const copulaParticle = (name: string): string => (hasFinalConsonant(name) ? "이에요" : "예요");

export const asSubject = (name: string): string => `${name}${subjectParticle(name)}`;
export const asCompanion = (name: string): string => `${name}${withParticle(name)}`;
export const asTopic = (name: string): string => `${name}${topicParticle(name)}`;
export const asObject = (name: string): string => `${name}${objectParticle(name)}`;
export const asPredicate = (name: string): string => `${name}${copulaParticle(name)}`;

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

/**
 * Accessible name of the message box. It addresses the same AI as the header, so
 * it follows the resolved name rather than a fixed noun. With the default name it
 * is byte-identical to the literal it replaced, so fixtures whose seat resolves to
 * "코치" keep their expected accessible name.
 */
export const composerLabel = (name: string): string => `${name}에게 보낼 메시지`;

/** Observation panel intro (webview). */
export const observationIntro = (name: string): string =>
  `내가 요청한 내용과 ${name}·도구가 수행한 일을 나누어 확인합니다.`;

/** First greeting in an empty chat — 저는 코치예요 / 저는 별똥별이에요. */
export const coachIntroSentence = (name: string): string => `저는 ${asPredicate(name)}.`;

// ─── Error / notice copy that names the AI (AE-07 "오류") ──────────────
// Each keeps its previous wording for the default name, so the constant the
// SDK error path throws (SDK_STALL_FRIENDLY) and the smoke tests that compare
// it stay byte-identical. Gateway auth failure deliberately does NOT name the
// AI (#760): a rejected participation code is about the code, not the AI.

/** Stream produced nothing for the watchdog budget (#403). */
export const stallNotice = (name: string = DEFAULT_COACH_NAME): string =>
  `${name} 응답이 너무 오래 걸려요. 다시 한 번 보내주세요. 🕐`;

/** The SDK runtime was selected before the resolved profile arrived. */
export const profileNotReadyNotice = (name: string = DEFAULT_COACH_NAME): string =>
  `${name} 프로필을 아직 못 받았어요. 잠시 후 다시 시도해주세요.`;

/** Host prompt when the participant opens an image tab (#384). */
export const imageAttachPrompt = (name: string, fileName: string): string =>
  `🖼 방금 연 이미지 "${fileName}"를 ${name} 채팅에 붙일까요?`;

/**
 * Name-agnostic shape of every approval-modal title above. Observation tooling
 * must separate a coach modal from a VS Code dialog WITHOUT keying on the name:
 * the name is now per-lesson/per-student, so a literal "코치가 " prefix stops
 * matching the moment an instructor renames the AI. `e2e/observe/watch.mjs`
 * owns that classification; this pattern is the contract it should use, and
 * test/coach-identity.smoke.mjs asserts every title matches it.
 */
export const APPROVAL_TITLE_PATTERN =
  /(저장하|읽으|찾아보|맡기|입력하|실행하|열|작업을 하)려고 해요/;
