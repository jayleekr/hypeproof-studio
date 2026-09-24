import { tokenize } from './tokenizer.ts';
import type {
  ParsedPlan, PlanMeta, ParsedStep, ParsedStuck, ParsedSection, Violation, ViolationCode,
  ProhibitedMove, KeyQuestion, Objective, Evidence,
} from './types.ts';

const MAX_SIZE_BYTES = 256 * 1024;

const VOID_ELEMENTS = new Set(['meta', 'br', 'img', 'hr', 'input', 'link']);

// Sections required for kind=lesson (E1-1 §2-3)
const LESSON_REQUIRED_SECTIONS: ReadonlyArray<string> = [
  'meta', 'objectives', 'essential-question', 'evidence',
  'flow', 'key-questions', 'prohibited-moves', 'materials', 'safety', 'bridging', 'support',
];

// Required chalk:* meta keys
const REQUIRED_META_KEYS: ReadonlyArray<string> = [
  'chalk:course', 'chalk:knowledge-version', 'chalk:format', 'chalk:audience-tier', 'chalk:duration-min',
];

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
}

function cleanText(s: string): string {
  return decodeEntities(s.replace(/\s+/g, ' ').trim());
}

function hasExternalUrl(attrs: Record<string, string>): string | null {
  for (const key of ['src', 'href', 'action', 'data']) {
    const v = attrs[key];
    if (v && /^https?:\/\//i.test(v)) return v;
  }
  return null;
}

function splitWords(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
}

function violation(
  item: ViolationCode,
  refs: string[],
  message: string,
  file: string,
  section: string | null,
  step: string | null,
  field: string | null = null,
): Violation {
  return { item, severity: 'warn', at: { file, section, step, field }, message, refs };
}

export function parsePlan(html: string, file = 'lesson'): ParsedPlan {
  const violations: Violation[] = [];

  const enc = new TextEncoder();
  if (enc.encode(html).length > MAX_SIZE_BYTES) {
    violations.push(violation('markup.too_large', ['HTML-03'], `파일 크기가 256KB 를 초과한다`, file, null, null));
  }

  const tokens = Array.from(tokenize(html));
  const stack: string[] = [];

  const meta: PlanMeta = {
    kind: null, course: null, knowledgeVersion: null,
    format: null, audienceTier: null, familySession: false,
    durationMin: null, methods: [],
  };

  const sections: Map<string, ParsedSection> = new Map();
  const steps: ParsedStep[] = [];
  const stucks: ParsedStuck[] = [];
  const objectives: Objective[] = [];
  const evidence: Evidence[] = [];
  const keyQuestions: KeyQuestion[] = [];
  const prohibitedMoves: ProhibitedMove[] = [];
  let essentialQuestion: string | null = null;
  let safety: string | null = null;
  let bridgingOpener: string | null = null;

  // Tracking which chalk:* meta keys were seen
  const seenMetaKeys = new Set<string>();

  // Parsing context stack for sections
  type SectionCtx = { key: string; depth: number };
  const sectionStack: SectionCtx[] = [];
  const currentSection = () => sectionStack.length > 0 ? sectionStack[sectionStack.length - 1].key : null;

  let tagDepth = 0; // overall element depth (for section tracking)

  let inFlowTable = false;
  let flowTableDepth = 0;
  let inFlowRow = false;
  let flowRowDepth = 0;
  let currentStep: ParsedStep | null = null;
  let currentStepRoleCurrent: { role: string; parentRole?: string } | null = null;

  let inSupport = false;
  let supportDepth = 0;
  let currentStuck: ParsedStuck | null = null;
  let currentStuckDepth = 0;
  let currentStuckField: string | null = null;

  // Text collection context
  type CollectTarget =
    | { kind: 'step_title' }
    | { kind: 'step_cell'; role: string; parentRole?: string }
    | { kind: 'stuck_field'; field: string }
    | { kind: 'objective'; id: string | null }
    | { kind: 'evidence'; id: string | null }
    | { kind: 'essential_question' }
    | { kind: 'key_question'; stepId: string | null }
    | { kind: 'prohibited_move'; family: string; stepId: string | null }
    | { kind: 'bridging_opener' }
    | { kind: 'safety_value' };

  let collectTarget: CollectTarget | null = null;
  let collectDepth = 0;
  let collectedText = '';

  const flushCollect = () => {
    if (!collectTarget) return;
    const text = cleanText(collectedText);
    const ct = collectTarget;
    collectTarget = null;
    collectedText = '';

    if (ct.kind === 'step_title' && currentStep) {
      if (!currentStep.title) currentStep.title = text;
    } else if (ct.kind === 'step_cell' && currentStep) {
      if (ct.role === 'parent') {
        currentStep.cells.parent = { text, role: ct.parentRole ?? '' };
      } else if (ct.role === 'teacher') {
        currentStep.cells.teacher = text;
      } else if (ct.role === 'assistant') {
        currentStep.cells.assistant = text;
      } else if (ct.role === 'learner') {
        currentStep.cells.learner = text;
      }
    } else if (ct.kind === 'stuck_field' && currentStuck) {
      switch (ct.field) {
        case 'expected-stuck': currentStuck.expectedStuck = text; break;
        case 'signal': currentStuck.signal = text; break;
        case 'min-support': currentStuck.minSupport = text; break;
        case 'expected-response': currentStuck.expectedResponse = text; break;
      }
    } else if (ct.kind === 'objective') {
      objectives.push({ id: ct.id, text });
    } else if (ct.kind === 'evidence') {
      evidence.push({ id: ct.id, text });
    } else if (ct.kind === 'essential_question') {
      if (!essentialQuestion) essentialQuestion = text;
    } else if (ct.kind === 'key_question') {
      keyQuestions.push({ text, stepId: ct.stepId });
    } else if (ct.kind === 'prohibited_move') {
      prohibitedMoves.push({ family: ct.family, stepId: ct.stepId, text });
    } else if (ct.kind === 'bridging_opener') {
      if (!bridgingOpener) bridgingOpener = text;
    } else if (ct.kind === 'safety_value') {
      if (!safety) safety = text;
    }
  };

  for (const t of tokens) {
    if (t.kind === 'open' || t.kind === 'selfclose') {
      const tag = t.tag!;
      const attrs = t.attrs ?? {};

      // --- Violation checks ---
      if (tag === 'script') {
        violations.push(violation('markup.script', ['HTML-03'], `<script> 태그는 허용되지 않는다`, file, currentSection(), currentStep?.id ?? null));
      }
      const extUrl = hasExternalUrl(attrs);
      if (extUrl) {
        violations.push(violation('markup.external_resource', ['HTML-03'], `외부 리소스 URL 이 있다: ${extUrl}`, file, currentSection(), currentStep?.id ?? null));
      }

      // --- html element ---
      if (tag === 'html') {
        meta.kind = attrs['data-chalk-kind'] ?? null;
      }

      // --- meta elements ---
      if (tag === 'meta') {
        const name = attrs['name'] ?? '';
        const content = attrs['content'] ?? '';
        if (name.startsWith('chalk:')) seenMetaKeys.add(name);
        switch (name) {
          case 'chalk:course': meta.course = content; break;
          case 'chalk:knowledge-version': meta.knowledgeVersion = parseInt(content, 10) || null; break;
          case 'chalk:format': meta.format = content; break;
          case 'chalk:audience-tier': meta.audienceTier = content; break;
          case 'chalk:family-session': meta.familySession = content === 'true'; break;
          case 'chalk:duration-min': meta.durationMin = parseInt(content, 10) || null; break;
          case 'chalk:methods': meta.methods = splitWords(content); break;
        }
      }

      // --- Section tracking ---
      if ('data-chalk-section' in attrs) {
        const key = attrs['data-chalk-section'];
        sections.set(key, { key, present: true });
        sectionStack.push({ key, depth: tagDepth + 1 });

        if (key === 'support') { inSupport = true; supportDepth = tagDepth + 1; }
      }

      // --- Flow table ---
      if ('data-chalk-flow' in attrs) {
        inFlowTable = true;
        flowTableDepth = tagDepth + 1;
      }

      // --- Flow row (step) ---
      if (inFlowTable && tag === 'tr' && 'data-chalk-step' in attrs) {
        inFlowRow = true;
        flowRowDepth = tagDepth + 1;
        const stepId = attrs['data-chalk-step'];
        const rawDur = attrs['data-duration-min'];
        const dur = rawDur ? parseInt(rawDur, 10) : null;
        if (steps.some(s => s.id === stepId)) {
          violations.push(violation('spec.step_id_duplicate', ['HTML-02'], `단계 ID 중복: ${stepId}`, file, currentSection(), stepId));
        }
        currentStep = {
          id: stepId,
          durationMin: isNaN(dur as number) ? null : dur,
          title: null,
          roles: [],
          cells: {},
          requires: splitWords(attrs['data-chalk-requires'] ?? ''),
          forbids: splitWords(attrs['data-chalk-forbids'] ?? ''),
        };
        steps.push(currentStep);
      }

      // --- Flow row: title / role cells ---
      if (inFlowRow && currentStep && !collectTarget) {
        if (attrs['data-chalk-field'] === 'title') {
          collectTarget = { kind: 'step_title' };
          collectDepth = tagDepth + 1;
          collectedText = '';
        } else if ('data-chalk-role' in attrs) {
          const role = attrs['data-chalk-role'];
          const parentRole = attrs['data-chalk-parent-role'];
          currentStep.roles.push(role);
          collectTarget = { kind: 'step_cell', role, parentRole };
          collectDepth = tagDepth + 1;
          collectedText = '';
          currentStepRoleCurrent = { role, parentRole };
        }
      }

      // --- Stuck entry ---
      if (inSupport && 'data-chalk-stuck' in attrs) {
        currentStuck = {
          id: attrs['data-chalk-stuck'],
          stepId: attrs['data-chalk-step'] ?? '',
          expectedStuck: null, signal: null, minSupport: null, expectedResponse: null,
        };
        currentStuckDepth = tagDepth + 1;
        stucks.push(currentStuck);
      }

      // --- Stuck field ---
      if (inSupport && currentStuck && 'data-chalk-field' in attrs && !collectTarget) {
        currentStuckField = attrs['data-chalk-field'];
        collectTarget = { kind: 'stuck_field', field: currentStuckField };
        collectDepth = tagDepth + 1;
        collectedText = '';
      }

      // --- Section-specific extraction (lesson kind only) ---
      if (meta.kind !== 'ops') {
        const sec = currentSection();

        if (sec === 'objectives' && 'data-chalk-objective' in attrs && !collectTarget) {
          collectTarget = { kind: 'objective', id: attrs['data-chalk-objective'] || null };
          collectDepth = tagDepth + 1;
          collectedText = '';
        }
        if (sec === 'evidence' && 'data-chalk-evidence' in attrs && !collectTarget) {
          collectTarget = { kind: 'evidence', id: attrs['data-chalk-evidence'] || null };
          collectDepth = tagDepth + 1;
          collectedText = '';
        }
        if (sec === 'essential-question' && 'data-chalk-question' in attrs && !collectTarget) {
          collectTarget = { kind: 'essential_question' };
          collectDepth = tagDepth + 1;
          collectedText = '';
        }
        if (sec === 'key-questions' && 'data-chalk-key-question' in attrs && !collectTarget) {
          const stepId = attrs['data-chalk-step'] ?? null;
          collectTarget = { kind: 'key_question', stepId };
          collectDepth = tagDepth + 1;
          collectedText = '';
        }
        if (sec === 'prohibited-moves' && 'data-chalk-move' in attrs && !collectTarget) {
          const family = attrs['data-chalk-move'];
          const stepId = attrs['data-chalk-step'] ?? null;
          collectTarget = { kind: 'prohibited_move', family, stepId };
          collectDepth = tagDepth + 1;
          collectedText = '';
        }
        if (sec === 'safety' && tag === 'section' && 'data-chalk-safety' in attrs) {
          safety = attrs['data-chalk-safety'] || null;
        }
        if (sec === 'bridging' && tag === 'p' && !bridgingOpener && !collectTarget) {
          collectTarget = { kind: 'bridging_opener' };
          collectDepth = tagDepth + 1;
          collectedText = '';
        }
      }

      // Push to element stack (non-void, non-selfclose)
      if (t.kind === 'open' && !VOID_ELEMENTS.has(tag)) {
        stack.push(tag);
        tagDepth++;
      }

    } else if (t.kind === 'close') {
      const tag = t.tag!;

      if (!VOID_ELEMENTS.has(tag)) {
        // Flush collect context if at or above start depth
        if (collectTarget && tagDepth <= collectDepth) {
          flushCollect();
        }

        // Nesting validation
        if (stack.length === 0) {
          violations.push(violation('markup.malformed', ['HTML-02'], `</${tag}> 가 매칭되는 열린 태그 없이 닫혔다`, file, currentSection(), currentStep?.id ?? null));
        } else {
          const top = stack[stack.length - 1];
          if (top !== tag) {
            violations.push(violation('markup.malformed', ['HTML-02'], `태그 중첩 오류: <${top}> 열린 상태에서 </${tag}> 닫힘`, file, currentSection(), currentStep?.id ?? null));
            // Recover: pop until match
            while (stack.length > 0 && stack[stack.length - 1] !== tag) {
              const unclosed = stack.pop()!;
              tagDepth--;
              violations.push(violation('markup.malformed', ['HTML-02'], `<${unclosed}> 가 닫히지 않았다`, file, currentSection(), currentStep?.id ?? null));
            }
            if (stack.length > 0) { stack.pop(); tagDepth--; }
          } else {
            stack.pop();
            tagDepth--;
          }
        }

        // Section exit (pop-후 tagDepth 기준: depth는 push-후 값이므로 < 비교)
        if (sectionStack.length > 0 && sectionStack[sectionStack.length - 1].depth > tagDepth) {
          const exiting = sectionStack.pop()!;
          if (exiting.key === 'support') inSupport = false;
        }

        // Flow row exit
        if (inFlowRow && tagDepth < flowRowDepth) {
          inFlowRow = false;
          currentStep = null;
          currentStepRoleCurrent = null;
        }
        // Flow table exit
        if (inFlowTable && tagDepth < flowTableDepth) {
          inFlowTable = false;
        }
        // Stuck exit
        if (currentStuck && tagDepth < currentStuckDepth) {
          currentStuck = null;
          currentStuckField = null;
        }
      }

    } else if (t.kind === 'text') {
      if (collectTarget) collectedText += t.text ?? '';
    }
  }

  // Flush any open collect at EOF
  flushCollect();

  // Unclosed tags
  while (stack.length > 0) {
    const unclosed = stack.pop()!;
    violations.push(violation('markup.malformed', ['HTML-02'], `<${unclosed}> 가 끝까지 닫히지 않았다`, file, null, null));
  }

  // Required meta keys (lesson only)
  if (meta.kind !== 'ops') {
    for (const key of REQUIRED_META_KEYS) {
      if (!seenMetaKeys.has(key)) {
        violations.push(violation('spec.meta_missing', ['HTML-02'], `필수 메타 ${key} 가 없다`, file, null, null));
      }
    }
  }

  // Required sections (lesson only)
  if (meta.kind !== 'ops') {
    for (const key of LESSON_REQUIRED_SECTIONS) {
      if (!sections.has(key)) {
        sections.set(key, { key, present: false });
        if (key === 'support') {
          violations.push(violation('spec.support_missing', ['GEN-04', '결정 2'], `13절 (support) 이 없다`, file, null, null));
        } else {
          violations.push(violation('spec.section_missing', ['GEN-04'], `필수 절 ${key} 이 없다`, file, key, null));
        }
      }
    }
  }

  // family-session requires parent role + data-chalk-parent-role in every step
  if (meta.familySession && meta.kind !== 'ops') {
    for (const step of steps) {
      if (!step.roles.includes('parent')) {
        violations.push(violation('spec.parent_role_missing', ['결정 9', 'PLAN-04'], `가족 수업(family-session=true)인데 단계 ${step.id} 에 parent 칸이 없다`, file, 'flow', step.id, 'parent'));
      } else if (!step.cells.parent?.role) {
        violations.push(violation('spec.parent_role_missing', ['결정 9', 'PLAN-04'], `가족 수업인데 단계 ${step.id} parent 칸에 data-chalk-parent-role 이 없다`, file, 'flow', step.id, 'data-chalk-parent-role'));
      }
    }
  }

  // 7절·13절이 없는 단계를 가리키는 참조 검사
  const stepIds = new Set(steps.map(s => s.id));
  for (const move of prohibitedMoves) {
    if (move.stepId && !stepIds.has(move.stepId)) {
      violations.push(violation('spec.step_ref_unknown', ['HTML-02'], `7절 금지 개입이 없는 단계 ${move.stepId} 를 가리킨다`, file, 'prohibited-moves', move.stepId));
    }
  }
  for (const stuck of stucks) {
    if (stuck.stepId && !stepIds.has(stuck.stepId)) {
      violations.push(violation('spec.step_ref_unknown', ['HTML-02'], `13절 막힘이 없는 단계 ${stuck.stepId} 를 가리킨다`, file, 'support', stuck.stepId));
    }
  }

  return {
    meta,
    sections: Array.from(sections.values()),
    steps,
    stucks,
    objectives,
    essentialQuestion,
    evidence,
    keyQuestions,
    prohibitedMoves,
    safety,
    bridgingOpener,
    violations,
  };
}
