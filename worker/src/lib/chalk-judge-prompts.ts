// E2-5 (#1465): prompts for model-judged chalk plan items.
// Verdicts: pass | violation | unsure (one-to-two sentence rationale).
// Increment version when text changes; keep the old entry below the new one.
// Rule: checklist citation + one example only (lesson-pedagogy.ts:26-27).

export interface JudgePrompt {
  prompt_id: string;
  version: number;
  text: string;
}

// Ordered list — for hint_gives_answer: item=null, check_name='hint_gives_answer' in the record.
const PROMPTS: readonly JudgePrompt[] = [
  {
    prompt_id: 'G2-2',
    version: 1,
    text: `Criterion G2-2: Each learning objective must use an observable, measurable verb (e.g. "만든다", "설명한다", "비교한다"). Vague verbs such as "이해한다" do not qualify.
Review the objectives below and reply with verdict "pass", "violation", or "unsure" and a one-to-two sentence rationale in Korean. If any objective uses a non-observable verb, reply "violation".`,
  },
  {
    prompt_id: 'G2-3',
    version: 1,
    text: `Criterion G2-3: The essential question (본질적 질문) must be exactly one open-ended question that cannot be answered yes/no and connects to the session's big idea.
Review the essential question below and reply with verdict "pass", "violation", or "unsure" and a one-to-two sentence rationale in Korean.`,
  },
  {
    prompt_id: 'G3-2',
    version: 1,
    text: `Criterion G3-2: All key questions (핵심 발문) must be open-ended — they cannot be answered with yes/no or a single word, and they must invite student thinking.
Review the key questions below and reply with verdict "pass", "violation", or "unsure" and a one-to-two sentence rationale in Korean. If any question is closed, reply "violation".`,
  },
  {
    prompt_id: 'G1-3',
    version: 1,
    text: `Criterion G1-3 (VAULT-CL B-2): The lesson must not include a single overall score or grade for the student. Exception: scores inside a game the student builds do not count.
Review the teacher, assistant, and learner column texts from sections 2, 4, and 5 below and reply with verdict "pass", "violation", or "unsure" and a one-to-two sentence rationale in Korean.`,
  },
  {
    prompt_id: 'hint_gives_answer',
    version: 1,
    text: `Criterion (REQ FB-04, GEN §3-3): Section 13 hints must not reveal the answer or pre-structure the solution (prohibited interventions P1 선취 and P3 구조).
Review the stuck-support entries below (expected-stuck, min-support, learner column) and reply with verdict "pass", "violation", or "unsure" and a one-to-two sentence rationale in Korean. If any entry violates, reply "violation".`,
  },
];

const BY_ID = new Map<string, JudgePrompt>(PROMPTS.map((p) => [p.prompt_id, p]));

// Items the model judges (used in judge-brief validation).
export const MODEL_JUDGED_KEYS: ReadonlySet<string> = new Set(PROMPTS.map((p) => p.prompt_id));
// Alias used by chalk-courses.ts import.
export const JUDGE_CHECK_NAMES: ReadonlySet<string> = MODEL_JUDGED_KEYS;

// Items only a human may judge (return 400 human_only from judge-brief).
export const HUMAN_ONLY_KEYS: ReadonlySet<string> = new Set(['G2-12', 'G3-6']);

// Verdicts the model must use.
export const VALID_VERDICTS: ReadonlySet<string> = new Set(['pass', 'violation', 'unsure']);

export function getJudgePrompt(key: string): JudgePrompt | undefined {
  return BY_ID.get(key);
}

export function allJudgePrompts(): readonly JudgePrompt[] {
  return PROMPTS;
}

export function isKnownPromptVersion(promptId: string, version: number): boolean {
  const p = BY_ID.get(promptId);
  if (!p) return false;
  return p.version === version;
}
