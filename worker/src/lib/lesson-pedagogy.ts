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
// 주석에는 **조항 ID·파일 경로·짧은 인용까지만** 남긴다. 규칙 본문을 옮겨 오면 정본이
// 둘이 되고 둘은 반드시 어긋난다 — 위키 CLAUDE.md가 직접 금지하는 바다.
//
// 조항 대조: 2026-09-17 커리큘럼 위키 세션(`hypeproof_kids_edu@89e50e2`) 조사 결과를
// 반영했다. 넷 중 셋은 조항이 확인됐고, 하나(lesson_prerequisites)는 **제품에서의
// 의미가 갈려 아직 확정 못 한다** — 아래 해당 검사 주석 참조.
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

// ─── 조항 좌표 ────────────────────────────────────────────────────────────────
//
// 값은 API 응답에 실리므로 짧게 — 조항 ID와 위치만 담는다. 근거 인용은 각 상수 위
// 주석에 있고, 규칙 본문은 위키에만 있다.

/** 아직 어느 조항인지 확정 못 한 검사. 지어낸 조항 번호를 넣지 않는다. */
export const UNVERIFIED_SOURCE = 'hypeproof_kids_edu 커리큘럼 위키 (조항 미확정)';

// source: curriculum_wiki/design/lesson-plan-quality-checklist.md 관문2-2
//   "성취기준이 관찰 가능한 동사로 쓰였다"
//   근거: design/lesson-plan-authoring-guide.md §1-② — "이해한다/알게 된다는 관찰
//         불가능하므로 쓰지 않는다. 기준: 다른 강사가 같은 기준으로 채점할 수 있는가"
// ⚠️ 원 조항은 차시(lesson) 단위 성취기준이다. 이 검사는 단계(step) 단위로 내려
//    적용한 **파생이며 직역이 아니다.** 커리큘럼 위키에 단계별 완료 기준 조항은 없고,
//    activity 스키마에도 acceptance에 해당하는 필드가 없다.
// 참고: rules/prohibited-moves.md §페이딩 사다리 — "기준이 명시적으로 주어질 때만 작동한다"
const SRC_STEP_ACCEPTANCE = '관문2-2 (파생: 차시→단계 층위 확장) · curriculum_wiki/design/lesson-plan-quality-checklist.md';

// ⚠️ 정본 미확정. studio의 `prerequisites`가 무엇이냐에 따라 조항이 갈리는데,
//    위키만으로는 판별되지 않는다. 둘을 나란히 두고 제품에서의 의미가 확정되면
//    하나로 좁힌다. (PO 판단 대기 — 2026-09-18 기준)
//
//   (a) 학습자의 선행 지식이라면
//       curriculum_wiki/methods/methods-index.md §선택가이드 2단계
//       "이 단계를 건너뛰는 것이 교수 설계의 가장 흔한 실패다 /
//        안내의 양은 선행지식에 반비례해야 한다"
//       → 이 해석이면 검사는 '비어있음'을 넘어 audience·방법론과 교차 검증 대상이 된다.
//
//   (b) 이 수업 앞에 와야 할 다른 수업·자산이라면
//       curriculum_wiki/design/lesson-plan-quality-checklist.md 관문2-6
//       "활동 requires 선행 조건이 트랙 내 앞 차시에서 충족된다"
//       유형 정의: rules/placement-rules.md — requires = "이 활동 전에 반드시
//                  선행되어야 함", 위반 시 컴파일 에러
//       → 이 해석이면 steps[].requires[] 필드가 생겨야 실제 의존성 해석이 된다.
//
// 참고: rules/placement-rules.md C-7 — "앞당기면 환각 생성기가 된다"
const SRC_PREREQUISITES = UNVERIFIED_SOURCE;

// source: curriculum_wiki/rules/curriculum-schema.md Lint 규칙 2
//   "evidence가 빈 activity → 경고"
//   대상(활동 원자 = step)·검사 방식(필드 비어있음)·수준(경고)이 그대로 대응한다.
//   필드 정의: evidence: ""  # 이 활동이 남기는 증거물 1개
//   주석: "증거물이 없는 활동은 만들지 않는다. Evidence에 적재될 것이 없으면
//         그 시간은 상품 가치를 만들지 않는다"
// 참고(미구현): 관문2-1 "평가 증거가 있고, 제3자가 볼 수 있는 물건이다
//   (성찰·소감은 증거가 아님)" — 차단 축이다. acceptance는 판정 기준이고 evidence는
//   남는 물건이라, steps[].evidence 필드가 생기기 전에는 양성 판정을 할 수 없다.
const SRC_STEP_EVIDENCE = 'lint 2 · curriculum_wiki/rules/curriculum-schema.md';

// source: curriculum_wiki/design/lesson-plan-quality-checklist.md 관문2-9
//   "활동 duration_min 합계가 회차 길이와 ±10분 내"  ← 허용 오차가 조항에 명시돼 있다.
//   임계값을 제품에서 새로 정하지 않는다. **칸이 생기면 ±10분으로 판정한다.**
//   필드 정의: rules/curriculum-schema.md — activity.duration_min (30/45/60 단위만)
// 참고: design/lesson-plan-authoring-guide.md §시간규칙 —
//   "duration_min >= 45인 활동은 내부 단계 구분 필수, 각 단계 15~30분 이내"
// note: 이 검사는 curriculum-schema.md의 lint 1~12 목록에도 **없다.** 커리큘럼 쪽도
//   기계화한 적이 없는 자리이므로, 필드가 생기면 studio가 먼저 기계화하게 된다.
const SRC_DURATION = '관문2-9 (±10분) · curriculum_wiki/design/lesson-plan-quality-checklist.md';

/** 관문2-9가 명시한 허용 오차(분). 칸이 생기면 이 값으로 판정한다. */
export const DURATION_TOLERANCE_MIN = 10;

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
        remedy:
          '이 단계가 끝났다고 판단할 조건을 관측 가능한 동사로 한 줄 적으세요. "이해한다/알게 된다"는 관찰할 수 없습니다.',
        source: SRC_STEP_ACCEPTANCE,
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
      source: SRC_PREREQUISITES,
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
          '안내 본문에 "제출 증거: <파일명 또는 산출물>" 한 줄을 추가하세요. 제3자가 볼 수 있는 물건이어야 하며 소감·성찰은 증거가 아닙니다.',
        source: SRC_STEP_EVIDENCE,
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
      `단계 시간 검사를 켜려면 steps[]에 시간 필드가 필요합니다. 칸이 생기면 ±${DURATION_TOLERANCE_MIN}분으로 판정합니다. 필드 추가는 저작 화면의 미확인 필드 보존(#1036)이 먼저입니다.`,
    source: SRC_DURATION,
  });

  return findings;
}

/** 확정을 막는 판정만. skip은 절대 포함되지 않는다(fail이 아니므로). */
export function blockingPedagogyFindings(findings: readonly PedagogyFinding[]): PedagogyFinding[] {
  return findings.filter((f) => f.severity === 'fail');
}

// ─── 후속 후보 (이번 범위 아님) ────────────────────────────────────────────────
//
// 2026-09-17 조항 매핑 조사에서, **스키마 변경 없이 지금 문자열 판정만으로** 붙일 수
// 있는 검사 7건이 나왔다. v0에는 넣지 않는다. 검사 대상 텍스트는 title + objective +
// starter + steps[].{title,instructions,hint,acceptance}가 된다.
//
//   1. 자격 표현 금칙어      관문1 A-2  — 자격증·인증서·국가공인 (허용: 수료증·이수증)
//   2. 또래 비교 어휘        관문1 A-4  — 뒤처·늦었·또래보다·남들보다·따라잡
//   3. 순위·시상             관문1 B-1  — 순위·등수·랭킹·리더보드·상위 %·1등·시상
//   4. 총점·종합등급         관문1 B-2  — 종합 점수·총점·종합 등급·합산
//   5. 진단 어휘(필드명)     관문1 B-5  — diagnosis·profile·assessment 필드명 금지.
//                                        현행 스키마는 통과 — 회귀 검사로 걸어 두면 싸다
//   6. 흐릿한 목표 동사      관문2-2   — objective·acceptance의 이해한다·알게 된다·
//                                        익힌다·배운다 탐지
//   7. 확인만 구하는 발문    관문3     — instructions·hint의 그렇지?·맞죠?·~아닌가요?
//                                        근거: "「그렇지?」로 끝나는 확인 질문은
//                                        발문이 아니라 유도다"
//
// ⚠️ **1~4를 켜기 전에 대상 층 분리 판정이 선행돼야 한다.** 커리큘럼 헌법(관문1)은
//    아동·청소년을 전제로 쓰였는데 studio의 실제 범위에는 성인 전문직 수업(치과의사
//    홈페이지 과정)이 있다. 지금 켜면 성인 수업이 아동용 조항에 걸려 통째로 막힌다.
//    `audience` 문자열만으로는 부족하고 명시적 층 구분 값이 필요하다 — 정확도 문제가
//    아니라 정합성 문제다. (커리큘럼 위키 쪽 요구 `CR-EDU-08` "교육 원칙을 공통층/
//    대상별층 2층으로 분리" — **studio 레지스트리에는 없는 ID다.** 이 repo에서 찾지 말 것.)
//
// 새 필드가 생겨야 열리는 것들(우선순위 순): steps[].prohibited_moves[] (관문2-4,
// 유일한 "필수. 없으면 미완성" 항목) · steps[].duration_min + session.duration_min
// (관문2-9, 위 duration_consistency를 여는 유일한 열쇠) · session.scope (관문1 적용
// 층 스위치) · steps[].evidence (관문2-1 양성 판정) · steps[].requires[]/forbids[]
// (관문2-6·2-7) · session.ip_owner (lint 1·8·9).
