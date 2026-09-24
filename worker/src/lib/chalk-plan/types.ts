export type Severity = 'fail' | 'warn' | 'info';

export type ViolationCode =
  | 'markup.malformed'
  | 'markup.script'
  | 'markup.external_resource'
  | 'markup.too_large'
  | 'spec.section_missing'
  | 'spec.support_missing'
  | 'spec.parent_role_missing'
  | 'spec.step_id_duplicate'
  | 'spec.step_ref_unknown'
  | 'spec.meta_missing';

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
}
