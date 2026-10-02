export type Severity = 'fail' | 'warn' | 'info';

export type ViolationCode =
  | 'markup.malformed'
  | 'markup.script'
  | 'markup.external_resource'
  | 'markup.too_large'
  | 'markup.bad_entity'
  | 'markup.internal'
  | 'markup.too_deep'
  | 'spec.section_missing'
  | 'spec.support_missing'
  | 'spec.parent_role_missing'
  | 'spec.step_id_duplicate'
  | 'spec.step_ref_unknown'
  | 'spec.meta_missing'
  | 'spec.meta_prerequisites_mismatch'
  | 'spec.block_field_missing'
  | 'spec.risk_missing'
  | 'spec.buffer_missing'
  | 'spec.block_step_unlinked'
  | 'spec.step_block_unlinked';

export interface ViolationAt {
  file: string;
  section: string | null;
  step: string | null;
  field: string | null;
}

export interface Violation {
  item: ViolationCode;
  severity: Severity;
  at: ViolationAt;
  message: string;
  refs: string[];
}

export interface PlanMeta {
  kind: string | null;
  course: string | null;
  knowledgeVersion: number | null;
  format: string | null;
  audienceTier: string | null;
  familySession: boolean;
  durationMin: number | null;
  methods: string[];
  prerequisites: string | null;   // chalk:prerequisites (선택)
}

export interface StepCell {
  text: string;
  role?: string;
}

export interface ParsedStep {
  id: string;
  durationMin: number | null;
  title: string | null;
  roles: string[];
  cells: {
    teacher?: string;
    assistant?: string;
    learner?: string;
    parent?: { text: string; role: string };
  };
  requires: string[];
  forbids: string[];
}

export interface ParsedStuck {
  id: string;
  stepId: string;
  expectedStuck: string | null;
  signal: string | null;
  minSupport: string | null;
  expectedResponse: string | null;
}

export interface ParsedSection {
  key: string;
  present: boolean;
}

export interface ProhibitedMove {
  family: string;
  stepId: string | null;
  text: string;
}

export interface KeyQuestion {
  text: string;
  stepId: string | null;
}

export interface Objective {
  id: string | null;
  text: string;
}

export interface Evidence {
  id: string | null;
  text: string;
}

// #1467 (E3-1) — ops-specific parsed structures.
export interface ParsedBlock {
  key: string;
  kind: 'normal' | 'buffer' | 'break' | 'wrap-up';
  start: string | null;
  durationMin: number | null;
  stepRefs: string[];
  fields: {
    activity: string | null;
    asset: string | null;
    artifact: string | null;
    exitCriteria: string | null;
    ifStuck: string | null;
    ifAhead: string | null;
    ifBehind: string | null;
  };
  roles: {
    facilitator?: string;
    assistant?: string;
    learner?: string;
    parent?: { text: string; role: string };
  };
}

export interface ParsedRisk {
  key: string;
  firstLine: string | null;
}

export interface ParsedPlan {
  meta: PlanMeta;
  sections: ParsedSection[];
  steps: ParsedStep[];
  stucks: ParsedStuck[];
  objectives: Objective[];
  essentialQuestion: string | null;
  evidence: Evidence[];
  keyQuestions: KeyQuestion[];
  prohibitedMoves: ProhibitedMove[];
  safety: string | null;
  bridgingOpener: string | null;
  violations: Violation[];
  // ops-only (undefined for lesson files)
  blocks?: ParsedBlock[];
  risks?: ParsedRisk[];
}
