// Pure helpers for the instructor (Chalk) surface (#1184). vscode-free so they
// unit-test under plain Node — mirrors mintStudentTokenHelpers.ts.
//
// The surface's own registration lives in chalkSurface.ts. Anything here that
// a test should be able to assert on — the action list, the web entry URL, the
// lesson-plan seed — must stay on this side of the line, or the test quietly
// skips and reports green. (.claude/rules/verification.md §4.)

import { adminBaseFor } from "./mintStudentTokenHelpers.ts";

export const CHALK_VIEW_ID = "hypeproof-chat.chalk";
export const LESSON_PLAN_FILENAME = "수업-지도안.md";

/** One row of the tree. */
export interface ChalkAction {
  label: string;
  detail: string;
  /** A built-in codicon id — never a `media/` asset. The Dev launcher copies
   *  only `dist/`, `webview-ui/dist` and `package.json`, so an SVG added under
   *  `media/` renders blank in the Dev app and nowhere else. */
  icon: string;
  command: string;
}

/** Order is the order a 강사 does them. */
export const CHALK_ACTIONS: readonly ChalkAction[] = [
  {
    // #1205 — 강사가 리허설을 시작할 자리. 데모 다섯 칸 중 4번.
    label: "학생 조건으로 리허설",
    detail: "고정된 버전을 학생처럼 돌려 봅니다 — 끝나면 돌아옵니다",
    icon: "play-circle",
    command: "hypeproof-chat.chalk.startRehearsal",
  },
  {
    label: "수업 지도안 열기",
    detail: "마크다운 파일로 엽니다 — 없으면 만듭니다",
    icon: "notebook",
    command: "hypeproof-chat.chalk.openLessonPlan",
  },
  {
    label: "학생 토큰 발급",
    detail: "내 issuer 토큰으로 참여 코드를 만듭니다",
    icon: "key",
    command: "hypeproof-chat.mintStudentToken",
  },
  {
    label: "Chalk 웹에서 확인",
    detail: "진입·버전·결과 조회 — 인증은 URL에 담지 않습니다",
    icon: "link-external",
    command: "hypeproof-chat.chalk.openWeb",
  },
  {
    label: "저장된 issuer 토큰 지우기",
    detail: "이 Studio에서 강사 자격을 내려놓습니다",
    icon: "sign-out",
    command: "hypeproof-chat.forgetIssuerToken",
  },
];

/**
 * `https://api.…/v1` → `https://api.…/console`.
 *
 * ARC-02: 인증을 URL 에 넣지 않는다. The Service 302s `/console` to the Chalk
 * origin (worker/src/index.ts) carrying no query and no fragment, so the
 * instructor authenticates on Chalk's own page. Building the link off the
 * configured proxyUrl also means a local `wrangler dev` window opens the local
 * Chalk, not production.
 */
export function chalkConsoleUrl(proxyUrl: string): string {
  return `${adminBaseFor(proxyUrl)}/console`;
}

/** Seed text for a brand-new lesson plan. Prose, not a form. */
export function lessonPlanTemplate(): string {
  return [
    "# 수업 지도안",
    "",
    "> 이 파일이 수업입니다. 폼이 아니라 글로 적고, 그대로 고치세요.",
    "",
    "## 누구와 · 얼마나 (CH-01)",
    "",
    "- 대상:",
    "- 시간:",
    "- 선수 조건:",
    "",
    "## 이 수업이 끝나면 학생이 할 수 있는 것",
    "",
    "1. ",
    "",
    "## 단계 (CH-04)",
    "",
    "| 단계 | 하는 일 | 완료 기준 |",
    "|---|---|---|",
    "|  |  |  |",
    "",
    "## 학생이 직접 판단할 것 (EDU-01)",
    "",
    "- ",
    "",
    "## 리허설에서 확인한 것 (RUN-01)",
    "",
    "- 학생 조건으로 돌려본 날짜:",
    "- 막힌 지점:",
    "",
  ].join("\n");
}
