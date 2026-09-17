// 교육 원칙 관문 v0 — 확정(freeze) 시점에 수업 설계를 판정한다.
//
// 형제: lesson-feature-policy.ts(#748) · lesson-model-policy.ts(#795) ·
// lesson-help-mode.ts(#1008). 같은 자리, 같은 모양의 순수 함수다. 다만 저 셋과
// 다른 점이 하나 있고 그것이 이 파일의 성격을 정한다:
//
//   저 셋은 **권한**을 다룬다 — 좁히기만 가능하고, 저장·확정·읽기 세 번 검사한다.
//   이것은 **설계 속성**을 다룬다 — 아무 권한도 주거나 뺏지 않고, 확정 1회만 본다.
//
// 그래서 lesson-delivery.ts의 readLesson()은 이 파일을 부르지 않는다. 확정된 수업은
// 이미 통과한 수업이고, 프로필이 나중에 줄어도 "완료 기준이 비었다"로 바뀌지 않는다.
// (PO 판정 2026-09-17 — 읽기 시점 재검사 없음.)
//
// ─── 규칙의 정본은 이 repo에 없다 ──────────────────────────────────────────────
//
// 교육 원칙의 정본은 **hypeproof_kids_edu 커리큘럼 위키**다. 이 파일은 그 원칙의
// v0 구현이지 원칙 자체가 아니다. 규칙 문서를 이 repo로 복사하지 않는다 — 복사하면
// 정본이 둘이 되고, 둘은 반드시 어긋난다(chalk/test/instructor-auth-drift.test.mjs가
// 존재하는 것과 같은 이유).
//
//   후속 과제: 규칙 술어를 외부 정본에서 읽어오는 구조로 바꾼다. 그때 아래 CHECKS의
//   `source` 필드가 위키 조항을 실제로 가리키게 되고, 이 파일은 엔진만 남는다.
//   (cohort-harness의 rules.yaml/validate.py 분리와 같은 모양. 단 그쪽 mini-YAML
//   파서는 list-of-maps를 못 읽으므로 규칙 표는 JSON이어야 한다.)
//
// **주의 — 아래 각 검사의 `source`는 아직 위키 조항으로 확인되지 않았다.** 이 세션은
// 해당 위키에 접근하지 않았고, 읽지 않은 문서의 조항 번호를 지어내지 않는다. 값은
// 전부 UNVERIFIED_SOURCE이며, 위키를 읽을 수 있는 사람이 채워야 한다. 조항이 붙기
// 전까지 이 관문은 "우리가 합의한 네 가지"이지 "커리큘럼 원칙"이 아니다.
//
// ─── v0에서 실제로 발화하는 검사는 둘뿐이다 (정직한 범위) ──────────────────────
//
// freeze 핸들러는 이 함수를 validateSessionDesign(content, true) **직후**에 부른다.
// 그 검증기가 이미 거르는 것은 여기서 절대 발화할 수 없다:
//
//   step_acceptance      ❌ 도달 불가 — session-design.ts가 complete=true에서
//                           `step <id>.acceptance is required to freeze a version`
//                           으로 이미 400을 낸다. 그래도 구현해 두는 이유는 이 함수가
//                           freeze 전용이 아니기 때문이다: 초안 검사, program.json
//                           설계 검사(docs/curriculum/*), CI 검사기가 같은 규칙을
//                           재사용한다. freeze 경로에서의 도달 불가를 주석 없이
//                           두면 "검사가 돈다"는 착시가 생긴다.
//   lesson_prerequisites ✅ 발화함 — prerequisites는 complete 필수 목록에 **없다**.
//                           (session-design.ts의 필수 목록은 title·audience·
//                           objective·starter 넷뿐이다. 실측 확인.)
//   step_evidence        ✅ 발화함 — 스키마에 evidence 필드가 아예 없다.
//   duration_consistency ⏭️  v0에서는 **항상 skip** — step에 시간 필드가 없다
//                           (STEP_KEYS = id·title·instructions·hint·acceptance +help).
//
// skip을 조용히 통과로 세지 않고 findings에 남기는 것은 이 repo의 규율이다
// (board의 `unknown`/`degraded[]`, native-rubric의 `unobserved`). 검사하지 못한 것은
// 통과가 아니다.

import type { SessionDesign } from './session-design.ts';

export const PEDAGOGY_CHECKS = [
  'step_acceptance',
  'lesson_prerequisites',
  'step_evidence',
  'duration_consistency',
] as const;
export type PedagogyCheck = (typeof PEDAGOGY_CHECKS)[number];

/** fail은 확정을 막는다(422). warn은 막지 않되 성공 응답에 실려 보인다. */
export type PedagogySeverity = 'fail' | 'warn';

/** 위키 조항이 확인되기 전의 자리표시자. 지어낸 조항 번호를 넣지 않는다. */
export const UNVERIFIED_SOURCE = 'hypeproof_kids_edu 커리큘럼 위키 (조항 미확인)';

export interface PedagogyFinding {
  check: PedagogyCheck;
  severity: PedagogySeverity;
  /** 강사에게 보이는 한국어 한 줄. 무엇이 문제인지. */
  message: string;
  /**
   * **무엇을 채우면 열리는가.** 관문이 사람에게 쓸모 있으려면 거절만으로는 부족하다 —
   * 다음 행동 하나를 지목해야 한다. 데모가 보여주려는 것이 이 필드다.
   */
  remedy: string;
  /** 단계 단위 판정이면 그 단계 id. 수업 단위면 없음. */
  step_id?: string;
  /**
   * true면 "검사하지 못했다"는 뜻이고 통과도 실패도 아니다. 이유는 message에 있다.
   * 통과로 세지 않기 위해 findings에 남긴다.
   */
  skipped?: boolean;
  /** 이 규칙의 정본 위치. 위키 조항이 붙기 전까지 UNVERIFIED_SOURCE. */
  source: string;
}

/** 산문 안의 증거물 지목. 생성기가 실제로 쓰는 형태를 읽고 정한 패턴이다. */
// worker/scripts/dental-authoring.mjs compileProgram()이 step.evidence를
// `제출 증거: <값>` 한 줄로 눌러 instructions에 넣는다. docs/curriculum/
// dental-ownership/generated/drafts.json의 30단계 전부에서 이 형태를 확인했다
// (2026-09-17 실측). 스키마에 evidence 필드가 생기면 이 정규식은 사라진다.
const EVIDENCE_LINE = /^[ \t]*제출[ \t]*증거[ \t]*[:：][ \t]*\S/m;

const blank = (v: unknown): boolean => typeof v !== 'string' || !v.trim();

/**
 * 확정 직전의 수업 설계를 판정한다.
 *
 * 입력은 `validateSessionDesign`을 이미 통과한 content다 — 형태 검증은 하지 않고
 * 교육 설계만 본다. 아무것도 변경하지 않으며, 순서가 안정적인 배열을 돌려준다.
 */
export function checkLessonPedagogy(content: SessionDesign): PedagogyFinding[] {
  const findings: PedagogyFinding[] = [];
  const steps = Array.isArray(content.steps) ? content.steps : [];

  // fail 1 — 모든 단계에 완료 기준이 있는가.
  // "무엇을 하면 끝인지"가 없으면 학생은 AI가 멈추는 시점을 완료로 읽는다.
  // (freeze 경로에서는 도달 불가 — 파일 상단 주석 참조.)
  for (const step of steps) {
    if (blank(step.acceptance)) {
      findings.push({
        check: 'step_acceptance',
        severity: 'fail',
        step_id: step.id,
        message: `단계 "${step.title || step.id}"에 완료 기준이 없습니다.`,
        remedy: '이 단계가 끝났다고 판단할 관측 가능한 조건을 완료 기준에 한 줄로 적으세요.',
        source: UNVERIFIED_SOURCE,
      });
    }
  }

  // fail 2 — 수업에 선행 조건이 있는가.
  // 빈 선행 조건은 "아무나 들어도 된다"가 아니라 대개 "아직 안 정했다"다.
  // 필요 없으면 "코딩 경험 불필요"처럼 명시적으로 적는 것이 설계다.
  if (blank(content.prerequisites)) {
    findings.push({
      check: 'lesson_prerequisites',
      severity: 'fail',
      message: '수업의 선행 조건이 비어 있습니다.',
      remedy:
        '필요한 사전 역량·준비물을 적으세요. 없다면 "코딩 경험 불필요"처럼 없다는 사실을 명시적으로 적습니다.',
      source: UNVERIFIED_SOURCE,
    });
  }

  // warn 1 — 각 단계에 남는 증거물이 지목돼 있는가.
  // 산출물이 지목되지 않으면 수행 여부를 나중에 확인할 방법이 없다. 지금은 스키마에
  // 자리가 없어 산문을 읽는다 — 그래서 fail이 아니라 warn이다. 정규식 판정을 차단
  // 근거로 쓰지 않는다.
  for (const step of steps) {
    if (!EVIDENCE_LINE.test(step.instructions ?? '')) {
      findings.push({
        check: 'step_evidence',
        severity: 'warn',
        step_id: step.id,
        message: `단계 "${step.title || step.id}"에 남는 증거물이 지목되지 않았습니다.`,
        remedy:
          '안내 본문에 "제출 증거: <파일명 또는 산출물>" 한 줄을 추가하세요. (스키마 필드는 아직 없습니다.)',
        source: UNVERIFIED_SOURCE,
      });
    }
  }

  // warn 2 — 단계 시간 합계가 수업 시간과 맞는가.
  // v0에서는 항상 skip이다: hps-session-design/1의 step에 시간 필드가 없다.
  // 제목의 "(15분)" 같은 표기를 파싱할 수도 있지만, 그것은 생성기 하나의 관례이지
  // 스키마 계약이 아니다 — 짐작으로 판정 기준을 세우지 않는다
  // (.claude/rules/verification.md 규칙 1).
  findings.push({
    check: 'duration_consistency',
    severity: 'warn',
    skipped: true,
    message:
      '단계별 시간이 스키마에 없어 수업 시간과의 정합을 확인하지 못했습니다. 통과가 아니라 미확인입니다.',
    remedy:
      '단계 시간 검사를 켜려면 steps[]에 시간 필드가 필요합니다. 필드 추가는 저작 화면의 미확인 필드 보존(#1036)이 먼저입니다.',
    source: UNVERIFIED_SOURCE,
  });

  return findings;
}

/** 확정을 막는 판정만. skip은 절대 포함되지 않는다(fail이 아니므로). */
export function blockingPedagogyFindings(findings: readonly PedagogyFinding[]): PedagogyFinding[] {
  return findings.filter((f) => f.severity === 'fail');
}
