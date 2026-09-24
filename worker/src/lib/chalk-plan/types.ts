export type Severity = 'error' | 'warn' | 'info';

export interface ViolationAt {
  file: string;
  section: string | null;
  step: string | null;
  field: string | null;
}

export interface Violation {
  item: string;
  severity: Severity;
  at: ViolationAt;
  message: string;
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

export interface ParsedStep {
  id: string;
  durationMin: number | null;
  title: string | null;
  roles: string[];
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

export interface ParsedPlan {
  meta: PlanMeta;
  sections: ParsedSection[];
  steps: ParsedStep[];
  stucks: ParsedStuck[];
  violations: Violation[];
}
