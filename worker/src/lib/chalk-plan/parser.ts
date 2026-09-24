import { tokenize, type Token } from './tokenizer.ts';
import type {
  ParsedPlan, PlanMeta, ParsedStep, ParsedStuck, ParsedSection, Violation,
} from './types.ts';

const MAX_SIZE_BYTES = 256 * 1024;

const VOID_ELEMENTS = new Set(['meta', 'br', 'img', 'hr', 'input', 'link']);

const REQUIRED_SECTIONS: string[] = [
  'meta', 'objectives', 'essential-question', 'evidence',
  'flow', 'key-questions', 'prohibited-moves', 'materials', 'safety', 'bridging', 'support',
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

function textContent(tokens: Token[], from: number, stopTag: string): [string, number] {
  let text = '';
  let i = from;
  let depth = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'text') { text += t.text ?? ''; continue; }
    if (t.kind === 'open') { depth++; continue; }
    if (t.kind === 'close') {
      if (depth > 0) { depth--; continue; }
      if (t.tag === stopTag) break;
    }
  }
  return [decodeEntities(text.trim()), i];
}

export function parsePlan(html: string, file = 'lesson'): ParsedPlan {
  const violations: Violation[] = [];

  const enc = new TextEncoder();
  if (enc.encode(html).length > MAX_SIZE_BYTES) {
    violations.push({
      item: 'HTML-01',
      severity: 'error',
      at: { file, section: null, step: null, field: null },
      message: `파일 크기가 256KB 를 초과한다`,
    });
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

  // Parsing context
  let currentSection: string | null = null;
  let inFlowTable = false;
  let inFlowRow = false;
  let currentStep: ParsedStep | null = null;
  let inSupport = false;
  let currentStuck: ParsedStuck | null = null;
  let currentStuckField: string | null = null;
  let collectingText = false;
  let collectedText = '';

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t.kind === 'open' || t.kind === 'selfclose') {
      const tag = t.tag!;
      const attrs = t.attrs ?? {};

      // Script presence check
      if (tag === 'script') {
        violations.push({
          item: 'HTML-03',
          severity: 'error',
          at: { file, section: currentSection, step: currentStep?.id ?? null, field: null },
          message: `<script> 태그는 허용되지 않는다`,
        });
      }

      // External resource check
      const extUrl = hasExternalUrl(attrs);
      if (extUrl) {
        violations.push({
          item: 'HTML-03',
          severity: 'error',
          at: { file, section: currentSection, step: currentStep?.id ?? null, field: null },
          message: `외부 리소스 URL 이 있다: ${extUrl}`,
        });
      }

      // html element: kind
      if (tag === 'html') {
        meta.kind = attrs['data-chalk-kind'] ?? null;
      }

      // meta elements: chalk:*
      if (tag === 'meta') {
        const name = attrs['name'] ?? '';
        const content = attrs['content'] ?? '';
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

      // Section tracking
      if ('data-chalk-section' in attrs) {
        const key = attrs['data-chalk-section'];
        currentSection = key;
        sections.set(key, { key, present: true });
        if (key === 'support') inSupport = true;
      }

      // Flow table
      if ('data-chalk-flow' in attrs) {
        inFlowTable = true;
      }

      // Flow row (step)
      if (inFlowTable && tag === 'tr' && 'data-chalk-step' in attrs) {
        inFlowRow = true;
        const stepId = attrs['data-chalk-step'];
        const dur = attrs['data-duration-min'] ? parseInt(attrs['data-duration-min'], 10) : null;
        currentStep = {
          id: stepId,
          durationMin: isNaN(dur as number) ? null : dur,
          title: null,
          roles: [],
          requires: splitWords(attrs['data-chalk-requires'] ?? ''),
          forbids: splitWords(attrs['data-chalk-forbids'] ?? ''),
        };
        steps.push(currentStep);
      }

      // Flow row: field (title, roles)
      if (inFlowRow && currentStep) {
        if (attrs['data-chalk-field'] === 'title') {
          // Collect text content of this th until close
          collectingText = true;
          collectedText = '';
        }
        if ('data-chalk-role' in attrs) {
          currentStep.roles.push(attrs['data-chalk-role']);
        }
      }

      // Stuck entry
      if (inSupport && 'data-chalk-stuck' in attrs) {
        currentStuck = {
          id: attrs['data-chalk-stuck'],
          stepId: attrs['data-chalk-step'] ?? '',
          expectedStuck: null, signal: null, minSupport: null, expectedResponse: null,
        };
        stucks.push(currentStuck);
      }

      // Stuck field
      if (inSupport && currentStuck && 'data-chalk-field' in attrs) {
        currentStuckField = attrs['data-chalk-field'];
        collectingText = true;
        collectedText = '';
      }

      // Push to stack (non-void)
      if (t.kind === 'open' && !VOID_ELEMENTS.has(tag)) {
        stack.push(tag);
      }

    } else if (t.kind === 'close') {
      const tag = t.tag!;

      if (collectingText) {
        // Flush collected text on matching close
        const decoded = decodeEntities(collectedText.trim());
        if (currentStuckField && currentStuck) {
          switch (currentStuckField) {
            case 'expected-stuck': currentStuck.expectedStuck = decoded; break;
            case 'signal': currentStuck.signal = decoded; break;
            case 'min-support': currentStuck.minSupport = decoded; break;
            case 'expected-response': currentStuck.expectedResponse = decoded; break;
          }
          currentStuckField = null;
        } else if (currentStep && !currentStep.title) {
          currentStep.title = decoded;
        }
        collectingText = false;
        collectedText = '';
      }

      if (!VOID_ELEMENTS.has(tag)) {
        // Pop stack, check nesting
        if (stack.length === 0) {
          violations.push({
            item: 'HTML-02',
            severity: 'error',
            at: { file, section: currentSection, step: currentStep?.id ?? null, field: null },
            message: `</${tag}> 가 매칭되는 열린 태그 없이 닫혔다`,
          });
        } else {
          const top = stack[stack.length - 1];
          if (top !== tag) {
            violations.push({
              item: 'HTML-02',
              severity: 'error',
              at: { file, section: currentSection, step: currentStep?.id ?? null, field: null },
              message: `태그 중첩 오류: <${top}> 가 열린 상태에서 </${tag}> 가 닫혔다`,
            });
            // Pop until matching tag found (recover)
            while (stack.length > 0 && stack[stack.length - 1] !== tag) {
              const unclosed = stack.pop()!;
              violations.push({
                item: 'HTML-02',
                severity: 'error',
                at: { file, section: currentSection, step: currentStep?.id ?? null, field: null },
                message: `<${unclosed}> 가 닫히지 않았다`,
              });
            }
            if (stack.length > 0) stack.pop(); // pop the matching tag
          } else {
            stack.pop();
          }
        }

        // Context exit tracking
        if (tag === 'tr' && inFlowRow) {
          inFlowRow = false;
          currentStep = null;
        }
        if (tag === 'table' && inFlowTable) {
          inFlowTable = false;
        }
        if (tag === 'div' && inSupport && currentStuck) {
          currentStuck = null;
        }
        // Section exit on matching section close
        if ((tag === 'section' || tag === 'div' || tag === 'article') && currentSection) {
          if (currentSection === 'support' && tag === 'section') {
            inSupport = false;
          }
          // Don't clear currentSection on every close — track depth instead (simplified: clear on section tag close)
          if (tag === 'section') currentSection = null;
        }
      }
    } else if (t.kind === 'text' && collectingText) {
      collectedText += t.text ?? '';
    }
  }

  // Unclosed tags at end
  while (stack.length > 0) {
    const unclosed = stack.pop()!;
    violations.push({
      item: 'HTML-02',
      severity: 'error',
      at: { file, section: null, step: null, field: null },
      message: `<${unclosed}> 가 끝까지 닫히지 않았다`,
    });
  }

  // Required section presence checks
  for (const key of REQUIRED_SECTIONS) {
    if (!sections.has(key)) {
      sections.set(key, { key, present: false });
    }
  }

  // 13절 (support) required
  if (!sections.get('support')?.present) {
    violations.push({
      item: 'HTML-04',
      severity: 'error',
      at: { file, section: null, step: null, field: null },
      message: `13절 (support) 이 없다`,
    });
  }

  // family-session requires parent role in every step
  if (meta.familySession) {
    for (const step of steps) {
      if (!step.roles.includes('parent')) {
        violations.push({
          item: 'PLAN-04',
          severity: 'error',
          at: { file, section: 'flow', step: step.id, field: 'parent' },
          message: `가족 수업(family-session=true)인데 단계 ${step.id} 에 parent 칸이 없다`,
        });
      }
    }
  }

  return {
    meta,
    sections: Array.from(sections.values()),
    steps,
    stucks,
    violations,
  };
}
