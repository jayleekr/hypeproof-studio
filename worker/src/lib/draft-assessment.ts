// 「이 초안이 지금 확정 가능한가」를 통째로 돌려주는 하나의 판정 (#1151, RUN-02).
//
// 고치기 전 상태: 이 판정이 `PUT …/versions/:version` 핸들러 **안에** 여섯 조각으로
// 흩어져 있었고, 확정을 누르기 전에는 아무도 그것을 물어볼 수 없었다. 강사는 눌러
// 봐야 무엇이 막는지 알았다.
//
// **여기서 규칙을 새로 만들지 않는다.** 확정 경로가 하던 검사를 같은 순서로, 같은
// 상태코드·`reason`·문구로 옮겨 담았을 뿐이다. 판정 내용이 하나라도 바뀌면 그것은
// 이 작업의 실패다 — 준비 점검 화면과 확정이 **다른 말을 하게** 되기 때문이고,
// 판정이 없는 것보다 **틀리게 있는 것**이 나쁘다.
//
// ## 왜 부수효과가 없는가
//
// 이 함수는 D1 도 `c.env` 도 읽지 않고 `content` 를 고치지도 않는다. 그래서 읽기
// 전용 점검 경로가 **아무것도 저장하지 않고** 같은 답을 받을 수 있다.
// `getProfile` 은 프로세스 안의 정적 레지스트리 조회라 이 순수성을 깨지 않는다.
//
// ## 여기 **없는** 것 — 그리고 왜 없는지
//
// 확정 경로의 모델·기능 **바인딩**(`modelBinding` · `featureBinding`)은 여기 없다.
// 그 둘은 판정이 아니라 **저장될 값을 만드는 부수효과**이고, `modelBinding` 은
// `c.env`(공급자 설정)까지 읽는다. 판정과 같이 묶으면 이 함수가 순수하지 않게 되고,
// 점검 경로가 "저장하지 않는다"는 약속을 지킬 수 없다.
//
// 그 결과 `model provider is not configured`(409)는 **확정 경로에만** 남는다.
// 점검 화면은 그 항목을 미리 말해 주지 못한다 — 아는 채로 남긴 구멍이고,
// PR 본문에 적었다. 억지로 끌어오면 점검이 환경을 읽게 된다.

import { validateSessionDesign } from './session-design';
import { checkLessonPedagogy, blockingPedagogyFindings, type PedagogyFinding } from './lesson-pedagogy';
import { validateModelSubset } from './lesson-model-policy';
import { validateFeatureSubset } from './lesson-feature-policy';
import { getProfile } from '../profiles';

export const TEMPLATE_REQUIRED = { error: 'select an execution template first', reason: 'template_required' };
export const TEMPLATE_NOT_REVIEWED = { error: 'independent course requires a reviewed execution template', reason: 'template_not_reviewed' };

/** #1006 IC-02 — 독립 강의는 **현재** 심사된 실행 템플릿만 쓸 수 있다. */
export const reviewedTemplate = (id: string) => getProfile(id)?.execution_template === true;
export const templateAdmission = (independent: boolean, profileId: string) =>
  independent && profileId !== '' && !reviewedTemplate(profileId) ? 'template_not_reviewed' : null;

/** 확정을 막는 검사의 이름. 화면이 순서를 유지하고, 시험이 어느 검사인지 지목한다. */
export type AssessCheck =
  | 'template_required'
  | 'template_not_reviewed'
  | 'session_design'
  | 'pedagogy'
  | 'model_policy'
  | 'feature_policy';

export interface AssessFinding {
  check: AssessCheck;
  /** 확정 경로가 `c.json(body, status)` 로 **그대로** 내보내는 값. */
  status: 400 | 403 | 409 | 422;
  body: Record<string, unknown>;
}

export interface DraftAssessment {
  /**
   * 확정을 막는 판정들. **확정 경로가 보는 순서 그대로**이고 첫 항목이 실제 응답이 된다.
   * 비어 있으면 이 초안은 (바인딩을 빼고) 확정 가능하다.
   */
  findings: AssessFinding[];
  /**
   * 교육 원칙 판정 **전체**(warn·skip 포함). 막지 않는 항목도 확정 성공 응답과 점검
   * 화면에 같이 실린다 — 통과를 보고하면서 미확인을 숨기지 않는다.
   * 형태 검증 전에 멈춘 경우에는 이 목록을 계산하지 않으므로 `null` 이다
   * (확정 경로도 그 순서에서 pedagogy 를 돌리지 않는다).
   */
  pedagogy: PedagogyFinding[] | null;
}

export interface AssessInput {
  /** 초안이 고른 실행 템플릿. 빈 문자열이면 아직 고르지 않은 것이다. */
  profileId: string;
  /** #1006 IC-02 — 고객 프로필과 독립으로 만든 강의인가. */
  independent: boolean;
  /** 이미 파싱된 세션 설계. 이 함수는 **고치지 않는다**. */
  content: any;
}

/**
 * 확정 직전 검사를 **한 번에** 돌린다. 부수효과 없음.
 *
 * 순서는 `PUT …/versions/:version` 의 순서 그대로다:
 * 템플릿 선택 → 템플릿 심사 → 형태·완전성 → 교육 원칙 → 모델 정책 → 기능 정책.
 * 확정 경로는 첫 항목에서 멈추지만, 점검 화면은 전부를 받아야 강사가 한 번에 고친다.
 */
export function assessDraft({ profileId, independent, content }: AssessInput): DraftAssessment {
  const findings: AssessFinding[] = [];

  if (!profileId) {
    findings.push({ check: 'template_required', status: 409, body: { ...TEMPLATE_REQUIRED } });
    // 템플릿이 없으면 그 아래 검사는 확정 경로에서도 돌지 않는다. 여기서 멈추는 것이
    // "같은 판정"이다 — 더 보여 주려고 계속 가면 확정과 다른 말을 하게 된다.
    return { findings, pedagogy: null };
  }
  if (templateAdmission(independent, profileId)) {
    findings.push({ check: 'template_not_reviewed', status: 403, body: { ...TEMPLATE_NOT_REVIEWED } });
    return { findings, pedagogy: null };
  }

  const invalid = validateSessionDesign(content, true);
  if (invalid) {
    findings.push({ check: 'session_design', status: 400, body: { error: invalid } });
    return { findings, pedagogy: null };
  }

  const pedagogy = checkLessonPedagogy(content);
  if (blockingPedagogyFindings(pedagogy).length) {
    findings.push({
      check: 'pedagogy',
      status: 422,
      body: { error: '수업 설계가 교육 원칙 검사를 통과하지 못했습니다', reason: 'pedagogy_blocked', findings: pedagogy },
    });
    return { findings, pedagogy };
  }

  // 모델·기능은 **선언돼 있을 때만** 본다. 확정 경로와 같은 조건이다.
  if (content.model) {
    const profile = getProfile(profileId);
    if (!profile || validateModelSubset(content.model, profile))
      findings.push({ check: 'model_policy', status: 403, body: { error: 'model is not permitted by the cohort' } });
  }
  if (content.features) {
    const profile = getProfile(profileId);
    if (!profile || validateFeatureSubset(content.features, profile))
      findings.push({ check: 'feature_policy', status: 403, body: { error: 'feature is not permitted by the cohort' } });
  }

  return { findings, pedagogy };
}
