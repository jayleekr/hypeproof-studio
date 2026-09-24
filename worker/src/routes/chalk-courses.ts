// Chalk course-level API. Issuer-only; handler re-verifies identity and ownership.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '../env';
import { authorizeIssuerForCohort, type IssuerAuthz } from '../lib/instructor-auth';
import { checkLessonPedagogy, type PedagogyFinding } from '../lib/lesson-pedagogy';
import { parsePlan, type Violation } from '../lib/chalk-plan';
import type { SessionDesign } from '../lib/session-design';
import { type Draft, owns } from './authoring';

type Bindings = { Bindings: Env; Variables: { author: IssuerAuthz } };

export const chalkCourses = new Hono<Bindings>();

const PLAN_CHECK_LIMIT = 256 * 1024;

chalkCourses.post(
  '/chalk/cohorts/:cohort/courses/:course/check',
  async (c, next) => {
    const auth = await authorizeIssuerForCohort(c, c.req.param('cohort')!);
    if (auth instanceof Response) return auth;
    if (!auth) return c.json({ error: 'instructor Bearer required' }, 401);
    c.set('author', auth);
    return next();
  },
  bodyLimit({ maxSize: PLAN_CHECK_LIMIT, onError: (c) => c.json({ error: 'request too large' }, 413) }),
  async (c) => {
    const cohort = c.req.param('cohort')!;
    const course = c.req.param('course')!;
    const author = c.get('author');

    const draft = await c.env.HPS_DB
      .prepare('SELECT * FROM authoring_drafts WHERE cohort_id=? AND course_id=?')
      .bind(cohort, course)
      .first<Draft>();

    if (!draft || !owns(draft, author)) {
      return c.json({ error: 'course not found' }, 404);
    }

    const rawBody = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const html: string | undefined = typeof rawBody?.html === 'string' ? rawBody.html : undefined;

    const results: CheckResultItem[] = [];

    // 1. 규격 검사 (파서): HTML이 요청 본문에 있을 때
    if (html !== undefined) {
      const parsed = parsePlan(html, 'lesson');
      for (const v of parsed.violations) {
        results.push(fromParserViolation(v));
      }
    }

    // 2. 관문 v0 검사 (checkLessonPedagogy): 저장된 초안 content로
    const content = JSON.parse(draft.content_json) as SessionDesign;
    const pedagogyFindings = checkLessonPedagogy(content);
    for (const f of pedagogyFindings) {
      results.push(fromPedagogyFinding(f));
    }

    return c.json({ results });
  },
);

interface CheckResultItem {
  item: string | null;
  check?: string;
  severity: 'fail' | 'warn' | 'info';
  judge: 'machine' | 'model' | 'human';
  at: { file: string; section: string | null; step: string | null; field: string | null };
  message: string;
  remedy?: string;
  skipped?: boolean;
  source: string;
  blocks_confirm: boolean;
}

function fromParserViolation(v: Violation): CheckResultItem {
  return {
    item: null,
    severity: 'warn',
    judge: 'machine',
    at: v.at,
    message: v.message,
    source: `chalk-plan/1 parser (${v.item})`,
    blocks_confirm: false,
  };
}

function fromPedagogyFinding(f: PedagogyFinding): CheckResultItem {
  return {
    item: null,
    check: f.check,
    severity: f.severity,
    judge: 'machine',
    at: { file: 'lesson', section: null, step: f.step_id ?? null, field: null },
    message: f.message,
    remedy: f.remedy,
    skipped: f.skipped,
    source: f.source,
    blocks_confirm: f.severity === 'fail',
  };
}
