// Versioned capability model definitions (#1042; MC-16, MC-17). DATA, not a scorer.
//
// Two models are readable. New interpretations default to the six-capability
// candidate model (Jay's 2026-09-13 decision, #1020). The historical seven Assets
// stay readable under their own id with their original keys; nothing here maps
// one model onto the other, and there is deliberately no conversion table.
//
// Definitions are provisional operational wording, not validated constructs.

export interface CapabilityDefinition {
  readonly key: string;
  readonly label_ko: string;
  readonly definition: string;
  /** Operational observation criterion used when citing evidence. */
  readonly observe: string;
  /** Behaviour that is NOT enough on its own (counter-example). */
  readonly insufficient: string;
}

export interface CapabilityModel {
  readonly id: string;
  readonly revision: number;
  readonly status: "provisional" | "legacy";
  readonly definition_revision: string;
  readonly source: {
    readonly repo: string;
    readonly path: string;
    readonly commit: string;
    readonly section: string;
  };
  readonly capabilities: readonly CapabilityDefinition[];
}

export const CANDIDATE_CAPABILITY_V1: CapabilityModel = {
  id: "candidate-capability-v1",
  revision: 1,
  status: "provisional",
  // Canonical wording: Lab PHILOSOPHY §6 at the pinned commit. Operational
  // observe/insufficient wording: studio docs/design/measurement-core.md (#1025 b9409fa).
  definition_revision: "philosophy@b081a790+design@b9409fac",
  source: {
    repo: "jayleekr/hypeprooflab",
    path: "PHILOSOPHY.md",
    commit: "b081a790cee1a8efa4b6c98dc3cfdf549bd7f3bf",
    section: "§6 Candidate Capability Model v1",
  },
  capabilities: [
    {
      key: "FRAMING",
      label_ko: "문제 구성",
      definition: "목적·상황·제약·성공 조건을 함께 구성하고 다시 정의하는 능력",
      observe: "목적·상황·제약·성공 조건을 함께 정하거나 다시 구성함",
      insufficient: "AI가 만든 요구사항을 사용자 확인 없이 그대로 저장; 자료 첨부량",
    },
    {
      key: "JUDGMENT",
      label_ko: "판단",
      definition: "목적과 기준에 비추어 대안을 평가하고 선택 이유를 설명하는 능력",
      observe: "목적·기준에 따라 대안을 평가하고 선택 이유를 설명함",
      insufficient: "AI가 제시한 안을 자동 채택; 결과물이 예쁨",
    },
    {
      key: "ORCHESTRATE",
      label_ko: "역할·통제 설계",
      definition: "인간·AI의 역할, 권한, 자율성, 검토 지점과 개입 조건을 설계하는 능력",
      observe: "사람·AI 역할, 권한, 검토 지점·개입 조건을 정함",
      insufficient: "도구를 많이 호출하거나 agent 수를 늘림",
    },
    {
      key: "VERIFY",
      label_ko: "검증",
      definition: "근거·반례·한계를 확인하고 확신 수준을 조절하는 능력",
      observe: "근거·반례·한계를 확인하고 확신을 조절함",
      insufficient: "AI가 '테스트 통과'라고 말함; 테스트 요청만 존재",
    },
    {
      key: "ADAPT",
      label_ko: "전략 수정",
      definition: "피드백으로 상태를 진단하고 전략을 바꾼 뒤 다시 확인하는 능력",
      observe: "피드백으로 문제를 진단하고 접근을 바꾼 뒤 다시 확인함",
      insufficient: "같은 요청 반복, 결과 변화 없이 재시도 횟수 증가",
    },
    {
      key: "OWNERSHIP",
      label_ko: "책임",
      definition: "자신의 선택과 도움의 범위를 설명하고 결과·오류에 대한 책임을 이어가는 능력과 태도",
      observe: "자신의 선택과 도움 범위를 설명하고 결과·오류에 대한 책임을 이어감",
      insufficient: "제출 버튼 클릭, 자기 이름 붙이기, AI의 책임 선언",
    },
  ],
};

export const LEGACY_SEVEN_ASSETS: CapabilityModel = {
  id: "legacy-seven-assets",
  revision: 1,
  status: "legacy",
  definition_revision: "philosophy@b081a790#candidate-model-0",
  source: {
    repo: "jayleekr/hypeprooflab",
    path: "PHILOSOPHY.md",
    commit: "b081a790cee1a8efa4b6c98dc3cfdf549bd7f3bf",
    section: "§6 Candidate Model 0 (historical 7 Human Assets)",
  },
  // Keys are exactly the hps-observation/1 asset keys; values are never re-mapped.
  capabilities: [
    { key: "TASTE", label_ko: "보는 눈", definition: "좋은 결과가 무엇인지 판별하는 능력", observe: "historical", insufficient: "historical" },
    { key: "INTENT", label_ko: "의도", definition: "무엇을 원하는지 스스로 정하고 표현하는 능력", observe: "historical", insufficient: "historical" },
    { key: "CONTEXT", label_ko: "맥락", definition: "필요한 배경·제약·재료·관계를 구성하는 능력", observe: "historical", insufficient: "historical" },
    { key: "VERIFY", label_ko: "검증", definition: "근거와 한계를 확인하고 확신 수준을 조절하는 능력", observe: "historical", insufficient: "historical" },
    { key: "DELEGATE", label_ko: "위임", definition: "AI와 인간 사이의 실행·위험·책임 경계를 정하는 능력", observe: "historical", insufficient: "historical" },
    { key: "ITERATE", label_ko: "반복", definition: "피드백을 기준으로 방향을 수정하는 능력", observe: "historical", insufficient: "historical" },
    { key: "OWNERSHIP", label_ko: "주인의식", definition: "AI가 도운 결과를 이해하고 최종 결정과 책임을 소유하는 태도", observe: "historical", insufficient: "historical" },
  ],
};

export const CAPABILITY_MODELS: readonly CapabilityModel[] = [CANDIDATE_CAPABILITY_V1, LEGACY_SEVEN_ASSETS];

/** New work cards and interpretations use this model unless a legacy record is being read. */
export const DEFAULT_CAPABILITY_MODEL = CANDIDATE_CAPABILITY_V1;

/**
 * The Korean label for a capability key, in the model that key belongs to.
 *
 * `model` is required for a reason. Scanning both models candidate-first labels
 * a stored seven-Asset finding with the current model's word wherever the keys
 * collide: OWNERSHIP is 책임 in the candidate model and 주인의식 in the seven
 * Assets. Those are different constructs, and quietly showing one under the
 * other's name is exactly the conversion this file's header says does not exist.
 *
 * An unrecognized model or key returns the key, so a wrong value is visible on
 * screen rather than blank.
 */
export function capabilityLabel(key: unknown, model: string): string {
  const wanted = String(key);
  const found = CAPABILITY_MODELS.find((m) => m.id === model);
  return found?.capabilities.find((c) => c.key === wanted)?.label_ko ?? wanted;
}

export function capabilityModel(id: unknown, revision: unknown): CapabilityModel | undefined {
  return CAPABILITY_MODELS.find((m) => m.id === id && m.revision === revision);
}
