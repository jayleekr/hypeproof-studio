// #1295 — Chalk course generation routes (server side).
// PUT  /chalk/cohorts/:cohort/courses/:course/inputs    — save 5 inputs + optional vocab
// PUT  /chalk/cohorts/:cohort/courses/:course/plan      — save plan file + auto-check
// GET  /chalk/cohorts/:cohort/courses/:course/brief     — generation brief bundle
// GET  /chalk/cohorts/:cohort/courses/:course/plan      — read plan file (issuer only)
// POST /chalk/cohorts/:cohort/courses/:course/check     — pedagogy + parser check (#1294)
// POST /chalk/cohorts/:cohort/courses/:course/feedback  — record feedback (#1466 E2-7)
// GET  /chalk/cohorts/:cohort/courses/:course/diff      — revision diff (#1466 E2-7)
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../env";
import { authorizeIssuerForCohort, type IssuerAuthz } from "../lib/instructor-auth";
import { sha256Hex } from "../lib/modules";
import { ASSETS } from "../lib/trial-evidence";
import { readDraft, owns, writeDraft, type Draft } from "../lib/authoring-draft-write";
import { recommendMethods, VocabError, KnowledgeIncompatibleError, type MethodFields } from "../lib/chalk-recommend";
import { checkLessonPedagogy, type PedagogyFinding } from "../lib/lesson-pedagogy";
import { parsePlan, type Violation } from "../lib/chalk-plan";
import { planUnits, diffUnits } from "../lib/chalk-plan/units.ts";
import type { SessionDesign } from "../lib/session-design";

type Vars = { Variables: { author: IssuerAuthz } };

export const chalkCourses = new Hono<{ Bindings: Env } & Vars>();

// Auth middleware — runs before bodyLimit so oversized unauthenticated requests get 401.
chalkCourses.use("/chalk/cohorts/:cohort/courses/:course/*", async (c, next) => {
  const auth = await authorizeIssuerForCohort(c, c.req.param("cohort")!);
  if (auth instanceof Response) return auth;
  if (!auth) return c.json({ error: "instructor Bearer required" }, 401);
  c.set("author", auth);
  await next();
});

const PLAN_MAX_BYTES = 256 * 1024;
const VALID_FILES = ["lesson", "ops"] as const;
const VALID_FORMATS = ["workshop", "track"] as const;

// ── Types ────────────────────────────────────────────────────────────────────

interface KbVersionRow { version: number }
interface KbDoc { version: number; doc_id: string; kind: string; fields_json: string; body: string }
interface PlanFileRow { html: string; sha256: string; knowledge_version: number; ref_kind: string; ref: string }
interface InputsRow {
  revision: number; audience: string; assets_json: string; teaching_style: string;
  requirements: string; format: string; family_session: number; vocab_json: string | null;
}
interface InputsWithOptionsRow extends InputsRow {
  audience_tier: string | null;
  duration_min: number | null;
}
interface VocabInput { goals: string[]; conditions: string[]; learner_level?: string; has_guidance?: boolean }

// ── Auth helper ──────────────────────────────────────────────────────────────

async function authAndOwn(c: any, cohort: string, course: string) {
  const auth = c.get("author") as IssuerAuthz;
  const draft = await readDraft(c.env.HPS_DB, cohort, course);
  if (!draft || !owns(draft, auth.payload.u, auth.scope.profiles))
    return { err: c.json({ error: "course not found" }, 404) };
  return { auth, draft };
}

// ── Knowledge helpers ────────────────────────────────────────────────────────

async function latestKbVersion(db: D1Database): Promise<number | null> {
  const r = await db.prepare("SELECT version FROM chalk_knowledge_versions ORDER BY version DESC LIMIT 1")
    .first<KbVersionRow>();
  return r?.version ?? null;
}

async function loadVocab(db: D1Database, version: number) {
  const [goalRow, condRow, priorRow] = await Promise.all([
    db.prepare("SELECT fields_json FROM chalk_knowledge_docs WHERE version=? AND doc_id='vocab:goal'")
      .bind(version).first<{ fields_json: string }>(),
    db.prepare("SELECT fields_json FROM chalk_knowledge_docs WHERE version=? AND doc_id='vocab:condition'")
      .bind(version).first<{ fields_json: string }>(),
    db.prepare("SELECT fields_json FROM chalk_knowledge_docs WHERE version=? AND doc_id='vocab:prior'")
      .bind(version).first<{ fields_json: string }>(),
  ]);
  const goalKeys = goalRow
    ? (JSON.parse(goalRow.fields_json) as { keys: Array<{ key: string }> }).keys.map(k => k.key) : [];
  const condKeys = condRow
    ? (JSON.parse(condRow.fields_json) as { keys: Array<{ key: string }> }).keys.map(k => k.key) : [];
  const priorKeys = priorRow
    ? (JSON.parse(priorRow.fields_json) as { keys: Array<{ key: string }> }).keys.map(k => k.key) : [];
  return { goals: goalKeys, conditions: condKeys, prior: priorKeys };
}

// ── Skeleton HTML ────────────────────────────────────────────────────────────

function generateSkeleton(opts: {
  course_id: string; knowledge_version: number; format: string;
  family_session: boolean; duration_min: number; methods: string[];
  audience_tier: string | null;
}): string {
  const { course_id, knowledge_version, format, family_session, duration_min, methods, audience_tier } = opts;
  const parentCol = family_session
    ? `\n      <td data-chalk-role="parent" data-chalk-parent-role=""></td>` : "";
  const homeLink = family_session
    ? `\n  <section data-chalk-section="home-link"></section>` : "";
  return `<!DOCTYPE html>
<html lang="ko" data-chalk-plan="1" data-chalk-kind="lesson">
<head>
  <meta charset="utf-8">
  <meta name="chalk:course" content="${course_id}">
  <meta name="chalk:knowledge-version" content="${knowledge_version}">
  <meta name="chalk:format" content="${format}">
  <meta name="chalk:audience-tier" content="${audience_tier ?? ''}">
  <meta name="chalk:family-session" content="${family_session}">
  <meta name="chalk:duration-min" content="${duration_min}">
  <meta name="chalk:prerequisites" content="">
  <meta name="chalk:methods" content="${methods.join(" ")}">
  <style>
    body { font-family: sans-serif; background: #fff; color: #111; max-width: 900px; margin: 0 auto; padding: 1rem; font-size: 1rem; }
    h2 { font-size: 1.1rem; }
    table { border-collapse: collapse; width: 100%; }
    td, th { border: 1px solid #ccc; padding: 0.4rem; vertical-align: top; }
    section { margin-bottom: 1.5rem; }
  </style>
</head>
<body>

  <section data-chalk-section="meta">
    <table>
      <tr><th>과목</th><td></td></tr>
      <tr><th>형식</th><td>${format}</td></tr>
      <tr><th>시간</th><td>${duration_min}분</td></tr>
      <tr><th>선행 조건</th><td></td></tr>
    </table>
  </section>

  <section data-chalk-section="objectives">
    <ul>
      <li data-chalk-objective="obj-1"></li>
    </ul>
  </section>

  <section data-chalk-section="essential-question">
    <p data-chalk-question></p>
  </section>

  <section data-chalk-section="evidence">
    <ul>
      <li data-chalk-evidence="ev-1"></li>
    </ul>
  </section>

  <section data-chalk-section="flow">
    <table data-chalk-flow>
      <tr data-chalk-step="s-1" data-duration-min="0" data-chalk-requires="" data-chalk-forbids="">
        <th data-chalk-field="title"></th>
        <td data-chalk-role="teacher"></td>
        <td data-chalk-role="learner"></td>${parentCol}
      </tr>
    </table>
  </section>

  <section data-chalk-section="key-questions">
    <ul>
      <li data-chalk-key-question></li>
    </ul>
  </section>

  <section data-chalk-section="prohibited-moves">
    <ul>
      <li data-chalk-move="P1" data-chalk-step="s-1"></li>
      <li data-chalk-move="P2" data-chalk-step="s-1"></li>
      <li data-chalk-move="P3" data-chalk-step="s-1"></li>
      <li data-chalk-move="P4" data-chalk-step="s-1"></li>
    </ul>
  </section>

  <section data-chalk-section="materials">
    <ul>
      <li data-chalk-material data-kind="physical" data-owner="instructor"></li>
    </ul>
  </section>

  <section data-chalk-section="safety" data-chalk-safety="none"></section>

  <section data-chalk-section="bridging"></section>${homeLink}

  <section data-chalk-section="support">
    <div data-chalk-stuck="st-1" data-chalk-step="s-1">
      <p data-chalk-field="expected-stuck"></p>
      <p data-chalk-field="signal"></p>
      <p data-chalk-field="min-support"></p>
      <p data-chalk-field="expected-response"></p>
    </div>
  </section>

</body>
</html>`;
}

// ── PUT /inputs ──────────────────────────────────────────────────────────────

chalkCourses.put(
  "/chalk/cohorts/:cohort/courses/:course/inputs",
  bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ error: "request too large" }, 413) }),
  async (c) => {
    const cohort = c.req.param("cohort")!;
    const course = c.req.param("course")!;
    const auth = c.get("author");

    c.header("cache-control", "no-store");

    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ code: "invalid_request", error: "invalid JSON" }, 400); }
    if (typeof body !== "object" || body === null) return c.json({ code: "invalid_request", error: "request body must be a JSON object" }, 400);
    const b = body as Record<string, unknown>;

    // Validate required fields
    if (typeof b.audience !== "string" || !b.audience.trim())
      return c.json({ code: "invalid_request", error: "audience is required" }, 400);
    if (!Array.isArray(b.assets) || b.assets.length === 0)
      return c.json({ code: "invalid_request", error: "assets must be a non-empty array" }, 400);
    // Closed vocabulary check for assets
    const badAssets = (b.assets as unknown[]).filter(a => typeof a !== "string" || !ASSETS.includes(a as any));
    if (badAssets.length > 0)
      return c.json({ code: "vocab_unknown", error: "unknown asset values", field: "assets", unknown_values: badAssets }, 400);
    if (typeof b.teaching_style !== "string" || !b.teaching_style.trim())
      return c.json({ code: "invalid_request", error: "teaching_style is required" }, 400);
    if (typeof b.requirements !== "string")
      return c.json({ code: "invalid_request", error: "requirements is required" }, 400);
    if (!VALID_FORMATS.includes(b.format as any))
      return c.json({ code: "invalid_request", error: `format must be one of: ${VALID_FORMATS.join(", ")}` }, 400);
    if (!Number.isSafeInteger(b.expected_revision) || (b.expected_revision as number) < 1)
      return c.json({ code: "invalid_request", error: "expected_revision required (≥1; use the draft save endpoint to create a new course)" }, 400);
    if (typeof b.request_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(b.request_id))
      return c.json({ code: "invalid_request", error: "request_id required" }, 400);
    const profile_id = typeof b.profile_id === "string" ? b.profile_id : "";

    if (b.audience_tier != null && (typeof b.audience_tier !== 'string' || !['lv1', 'lv2', 'adult'].includes(b.audience_tier as string)))
      return c.json({ code: 'invalid_request', error: 'audience_tier must be one of: lv1, lv2, adult' }, 400);
    const audienceTier: string | null = typeof b.audience_tier === 'string' ? b.audience_tier : null;

    if (b.duration_min != null && (!Number.isInteger(b.duration_min) || (b.duration_min as number) < 1))
      return c.json({ code: 'invalid_request', error: 'duration_min must be a positive integer' }, 400);
    const durationMinInput: number | null = typeof b.duration_min === 'number' ? b.duration_min : null;

    const familySession = b.family_session === true ? 1 : 0;

    // Vocab validation
    let vocabJson: string | null = null;
    if (b.vocab !== undefined) {
      if (typeof b.vocab !== "object" || b.vocab === null || Array.isArray(b.vocab))
        return c.json({ code: "invalid_request", error: "vocab must be an object" }, 400);
      const v = b.vocab as Record<string, unknown>;
      if (!Array.isArray(v.goals) || v.goals.some(g => typeof g !== "string"))
        return c.json({ code: "invalid_request", error: "vocab.goals must be a string array" }, 400);
      if (!Array.isArray(v.conditions) || v.conditions.some(cc => typeof cc !== "string"))
        return c.json({ code: "invalid_request", error: "vocab.conditions must be a string array" }, 400);

      // Must have a knowledge version to validate vocab against
      const kbVersion = await latestKbVersion(c.env.HPS_DB);
      if (!kbVersion) return c.json({ code: "knowledge_missing", error: "제품 지식이 아직 없습니다; 지식을 먼저 적재하세요" }, 409);
      const closedVocab = await loadVocab(c.env.HPS_DB, kbVersion);

      const badGoals = (v.goals as string[]).filter(g => !closedVocab.goals.includes(g));
      if (badGoals.length > 0) return c.json({ code: "vocab_unknown", error: "unknown goal values", field: "vocab.goals", unknown_values: badGoals }, 400);
      const badConds = (v.conditions as string[]).filter(cc => !closedVocab.conditions.includes(cc));
      if (badConds.length > 0) return c.json({ code: "vocab_unknown", error: "unknown condition values", field: "vocab.conditions", unknown_values: badConds }, 400);

      vocabJson = JSON.stringify({
        goals: v.goals,
        conditions: v.conditions,
        learner_level: typeof v.learner_level === "string" ? v.learner_level : undefined,
        has_guidance: typeof v.has_guidance === "boolean" ? v.has_guidance : undefined,
      });
    }

    // Require existing draft: inputs can only be saved against an existing course
    const prior = await readDraft(c.env.HPS_DB, cohort, course);
    if (!prior || !owns(prior, auth.payload.u, auth.scope.profiles))
      return c.json({ error: "course not found" }, 404);

    // Content for new drafts: minimal valid SessionDesign
    const existingContent = prior ? prior.content_json : JSON.stringify({
      schema: "hps-session-design/1",
      title: "", audience: b.audience as string, duration_minutes: 120,
      objective: "", prerequisites: "", starter: "", steps: [],
    });
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const hash = await sha256Hex(JSON.stringify([
      b.expected_revision, profile_id, existingContent, b.audience, b.assets, b.teaching_style,
      b.requirements, b.format, familySession, vocabJson,
    ]));

    // Extra batch stmts: upsert chalk_course_inputs + chalk_course_input_options,
    // both conditional on the same CAS WHERE EXISTS. SELECT WHERE EXISTS is a no-op
    // if the draft UPDATE matched 0 rows.
    const newRevision = (b.expected_revision as number) + 1;
    const boundInputsUpsert = c.env.HPS_DB.prepare(
      `INSERT INTO chalk_course_inputs (cohort_id,course_id,revision,audience,assets_json,teaching_style,requirements,format,family_session,vocab_json,updated_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?
       WHERE EXISTS (SELECT 1 FROM authoring_drafts WHERE cohort_id=? AND course_id=? AND revision=? AND request_id=? AND request_hash=?)
       ON CONFLICT(cohort_id,course_id) DO UPDATE SET
         revision=excluded.revision, audience=excluded.audience, assets_json=excluded.assets_json,
         teaching_style=excluded.teaching_style, requirements=excluded.requirements,
         format=excluded.format, family_session=excluded.family_session,
         vocab_json=excluded.vocab_json, updated_at=excluded.updated_at`
    ).bind(
      cohort, course, newRevision,
      b.audience as string, JSON.stringify(b.assets), b.teaching_style as string,
      b.requirements as string, b.format as string, familySession, vocabJson, nowMs,
      cohort, course, newRevision, b.request_id as string, hash
    );
    const boundOptionsUpsert = c.env.HPS_DB.prepare(
      `INSERT INTO chalk_course_input_options (cohort_id,course_id,audience_tier,duration_min,updated_at)
       SELECT ?,?,?,?,?
       WHERE EXISTS (SELECT 1 FROM authoring_drafts WHERE cohort_id=? AND course_id=? AND revision=? AND request_id=? AND request_hash=?)
       ON CONFLICT(cohort_id,course_id) DO UPDATE SET
         audience_tier=excluded.audience_tier,
         duration_min=excluded.duration_min,
         updated_at=excluded.updated_at`
    ).bind(
      cohort, course, audienceTier, durationMinInput, nowMs,
      cohort, course, newRevision, b.request_id as string, hash
    );

    const wr = await writeDraft(c.env.HPS_DB, prior, {
      cohort, course, owner_id: auth.payload.u,
      expected_revision: b.expected_revision as number,
      request_id: b.request_id as string,
      profile_id,
      content_json: existingContent,
      hash, now,
      independent: !!prior.independent,
      profile_scope: auth.scope.profiles ?? [],
      extra_batch_stmts: [boundInputsUpsert, boundOptionsUpsert],
    });

    if (wr.kind === 'ok' || wr.kind === 'idempotent')
      return c.json({ revision: wr.draft.revision });
    if (wr.kind === 'request_id_reused')
      return c.json({ code: "request_id_reused", error: "request id reused with different content" }, 409);
    return c.json({ code: "revision_conflict", error: "revision conflict; reload before saving" }, 409);
  },
);

// ── PUT /plan ────────────────────────────────────────────────────────────────

chalkCourses.put(
  "/chalk/cohorts/:cohort/courses/:course/plan",
  bodyLimit({ maxSize: PLAN_MAX_BYTES + 8 * 1024, onError: c => c.json({ error: "계획서가 너무 큽니다", max_bytes: PLAN_MAX_BYTES }, 413) }),
  async (c) => {
    const cohort = c.req.param("cohort")!;
    const course = c.req.param("course")!;
    const { err, auth, draft: prior } = await authAndOwn(c, cohort, course) as any;
    if (err) return err;

    c.header("cache-control", "no-store");

    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ code: "invalid_request", error: "invalid JSON" }, 400); }
    if (typeof body !== "object" || body === null) return c.json({ code: "invalid_request", error: "request body must be a JSON object" }, 400);
    const b = body as Record<string, unknown>;

    if (!VALID_FILES.includes(b.file as any))
      return c.json({ code: "invalid_request", error: `file must be one of: ${VALID_FILES.join(", ")}` }, 400);
    if (typeof b.html !== "string")
      return c.json({ code: "invalid_request", error: "html is required" }, 400);
    if (!Number.isInteger(b.knowledge_version) || (b.knowledge_version as number) < 1)
      return c.json({ code: "invalid_request", error: "knowledge_version must be a positive integer" }, 400);
    if (!Number.isSafeInteger(b.expected_revision) || (b.expected_revision as number) < 1)
      return c.json({ code: "invalid_request", error: "expected_revision required (plan requires existing draft)" }, 400);
    if (typeof b.request_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(b.request_id))
      return c.json({ code: "invalid_request", error: "request_id required" }, 400);

    const htmlBytes = new TextEncoder().encode(b.html as string).length;
    if (htmlBytes > PLAN_MAX_BYTES)
      return c.json({ error: "계획서가 너무 큽니다", max_bytes: PLAN_MAX_BYTES }, 413);

    // Verify knowledge version exists
    const kbRow = await c.env.HPS_DB.prepare(
      "SELECT version FROM chalk_knowledge_versions WHERE version=?"
    ).bind(b.knowledge_version).first<KbVersionRow>();
    if (!kbRow) return c.json({ code: "knowledge_missing", error: "knowledge version not found" }, 409);

    const sha256 = await sha256Hex(b.html as string);
    const nowMs = Date.now();
    const newRevision = (b.expected_revision as number) + 1;

    // Parse plan to extract method IDs (avoids fragile regex on raw HTML)
    const parsed = parsePlan(b.html as string, 'lesson');
    const methodIds = parsed.meta.methods;

    // Build updated plan_ref
    const existingContent = JSON.parse(prior!.content_json);
    const existingPlanRef = existingContent.plan_ref ?? {};
    const newPlanRef = {
      spec: 'chalk-plan/1',
      knowledge_version: b.knowledge_version as number,
      files: {
        ...(existingPlanRef.files ?? {}),
        [b.file as string]: sha256,
      },
      methods: methodIds.length > 0 ? methodIds : (existingPlanRef.methods ?? []),
    };
    const newContent = JSON.stringify({ ...existingContent, plan_ref: newPlanRef });
    const hash = await sha256Hex(JSON.stringify([b.expected_revision, prior!.profile_id, newContent]));
    const now = new Date().toISOString();

    // Optional feedback link: feedback_id must belong to this cohort/course.
    let feedbackLinkStmt: ReturnType<typeof c.env.HPS_DB.prepare> | null = null;
    if (typeof b.feedback_id === "string") {
      const fbRow = await c.env.HPS_DB.prepare(
        "SELECT feedback_id FROM chalk_feedback WHERE feedback_id=? AND cohort_id=? AND course_id=?"
      ).bind(b.feedback_id, cohort, course).first<{ feedback_id: string }>();
      if (!fbRow) return c.json({ code: "invalid_request", error: "feedback_id not found for this course" }, 400);
      feedbackLinkStmt = c.env.HPS_DB.prepare(
        `INSERT INTO chalk_feedback_revisions (feedback_id,revision,file,cohort_id,course_id,created_at)
         SELECT ?,?,?,?,?,?
         WHERE EXISTS (SELECT 1 FROM authoring_drafts WHERE cohort_id=? AND course_id=? AND revision=? AND request_id=? AND request_hash=?)`
      ).bind(b.feedback_id as string, newRevision, b.file, cohort, course, nowMs,
             cohort, course, newRevision, b.request_id as string, hash);
    }

    // Plan file insert: conditional on the draft UPDATE succeeding (SELECT WHERE EXISTS).
    // This is a no-op if the CAS UPDATE matched 0 rows, preserving data integrity.
    const planFileInsert = c.env.HPS_DB.prepare(
      `INSERT INTO chalk_plan_files (cohort_id,course_id,ref_kind,ref,file,html,sha256,knowledge_version,created_at)
       SELECT ?,?,?,?,?,?,?,?,?
       WHERE EXISTS (SELECT 1 FROM authoring_drafts WHERE cohort_id=? AND course_id=? AND revision=? AND request_id=? AND request_hash=?)`
    ).bind(cohort, course, 'draft', String(newRevision), b.file, b.html, sha256, b.knowledge_version, nowMs,
           cohort, course, newRevision, b.request_id as string, hash);

    const extraBatch = feedbackLinkStmt ? [planFileInsert, feedbackLinkStmt] : [planFileInsert];

    const wr = await writeDraft(c.env.HPS_DB, prior!, {
      cohort, course, owner_id: auth.payload.u,
      expected_revision: b.expected_revision as number,
      request_id: b.request_id as string,
      profile_id: prior!.profile_id,
      content_json: newContent, hash, now,
      independent: !!prior!.independent,
      profile_scope: auth.scope.profiles ?? [],
      extra_batch_stmts: extraBatch,
    });

    if (wr.kind === 'ok' || wr.kind === 'idempotent') {
      const findings = runPlanCheck(wr.draft, b.html as string);
      return c.json({ revision: wr.draft.revision, sha256, findings });
    }
    if (wr.kind === 'request_id_reused')
      return c.json({ code: "request_id_reused", error: "request id reused with different content" }, 409);
    return c.json({ code: "revision_conflict", error: "revision conflict; reload before saving" }, 409);
  },
);

// ── GET /brief ───────────────────────────────────────────────────────────────

chalkCourses.get(
  "/chalk/cohorts/:cohort/courses/:course/brief",
  async (c) => {
    const cohort = c.req.param("cohort")!;
    const course = c.req.param("course")!;
    const { err } = await authAndOwn(c, cohort, course) as any;
    if (err) return err;

    c.header("cache-control", "no-store");

    const file = c.req.query("file") ?? "lesson";
    if (!VALID_FILES.includes(file as any))
      return c.json({ code: "invalid_request", error: `file must be one of: ${VALID_FILES.join(", ")}` }, 400);

    // Load inputs (LEFT JOIN to pick up audience_tier/duration_min from options table)
    const inputs = await c.env.HPS_DB.prepare(
      `SELECT ci.*, cio.audience_tier, cio.duration_min
       FROM chalk_course_inputs ci
       LEFT JOIN chalk_course_input_options cio
         ON ci.cohort_id=cio.cohort_id AND ci.course_id=cio.course_id
       WHERE ci.cohort_id=? AND ci.course_id=?`
    ).bind(cohort, course).first<InputsWithOptionsRow>();
    if (!inputs) return c.json({ code: "inputs_missing", error: "입력을 먼저 저장하세요 (PUT .../inputs)" }, 409);
    if (!inputs.vocab_json) return c.json({ code: "inputs_missing", error: "어휘(vocab)를 입력에 포함해야 brief를 만들 수 있습니다" }, 409);

    const vocab = JSON.parse(inputs.vocab_json) as VocabInput;

    // Load knowledge version
    const kbVersion = await latestKbVersion(c.env.HPS_DB);
    if (!kbVersion) return c.json({ code: "knowledge_missing", error: "제품 지식이 아직 없습니다; 지식을 먼저 적재하세요" }, 409);

    // Load methods and vocab from knowledge
    const [methodRows, closedVocab] = await Promise.all([
      c.env.HPS_DB.prepare("SELECT * FROM chalk_knowledge_docs WHERE version=? AND kind='method'")
        .bind(kbVersion).all<KbDoc>(),
      loadVocab(c.env.HPS_DB, kbVersion),
    ]);

    const methods: MethodFields[] = (methodRows.results ?? []).map(row => {
      const fields = JSON.parse(row.fields_json) as Record<string, unknown>;
      return {
        id: String(fields.id ?? row.doc_id),
        best_for: Array.isArray(fields.best_for) ? fields.best_for as string[] : [],
        weak_for: Array.isArray(fields.weak_for) ? fields.weak_for as string[] : [],
        avoid_when: Array.isArray(fields.avoid_when) ? fields.avoid_when as string[] : [],
        prior_knowledge: typeof fields.prior_knowledge === "string" ? fields.prior_knowledge : undefined,
        requires_guidance: typeof fields.requires_guidance === "boolean" ? fields.requires_guidance : undefined,
      };
    });

    // Recommend methods based on stored vocab
    let methodResult;
    try {
      methodResult = recommendMethods(
        {
          conditions: vocab.conditions,
          goals: vocab.goals,
          learner_level: vocab.learner_level,
          has_guidance: vocab.has_guidance,
        },
        methods,
        closedVocab,
        kbVersion,
      );
    } catch (err) {
      if (err instanceof KnowledgeIncompatibleError)
        return c.json({ code: "knowledge_incompatible", error: "knowledge incompatible", field: err.field, unranked: err.unranked }, 409);
      if (err instanceof VocabError)
        return c.json({ code: "knowledge_incompatible", error: err.message, field: err.field, unknown_values: err.unknown_values }, 409);
      throw err;
    }

    // Load guide docs
    const guideDocIds = ["guide:authoring-order", "guide:plan-spec", "guide:workshop-core"];
    const guideDocs: Record<string, unknown> = {};
    for (const docId of guideDocIds) {
      const row = await c.env.HPS_DB.prepare(
        "SELECT fields_json, body FROM chalk_knowledge_docs WHERE version=? AND doc_id=?"
      ).bind(kbVersion, docId).first<{ fields_json: string; body: string }>();
      if (row) {
        try {
          guideDocs[docId] = { ...JSON.parse(row.fields_json), body: row.body };
        } catch {
          guideDocs[docId] = { body: row.body };
        }
      }
    }

    const authoring_order = (guideDocs["guide:authoring-order"] as any)?.order ?? [
      "evidence", "objectives", "essential-question", "prohibited-moves",
      "flow", "key-questions", "support",
    ];

    const assets = JSON.parse(inputs.assets_json) as string[];
    const goalMatchedIds = methodResult.chosen.filter((m: any) => !m.no_goal_match).map((m: any) => m.id);
    const chosenMethodIds = goalMatchedIds.length > 0
      ? goalMatchedIds
      : methodResult.chosen.slice(0, 1).map((m: any) => m.id);
    const methodsWarning: string | undefined = goalMatchedIds.length === 0 && methodResult.chosen.length > 0
      ? '지금 입력된 목표·조건과 딱 맞는 수업 모형이 없어 상위 1개를 임시로 넣었습니다. 목표나 조건을 바꿔 다시 추천받으면 더 잘 맞는 모형을 고를 수 있습니다.'
      : undefined;
    const familySession = inputs.family_session === 1;

    // Duration: use stored value if set; fall back to format default.
    const durationMin = inputs.duration_min ?? (inputs.format === 'workshop' ? 240 : 120);

    const skeleton_html = generateSkeleton({
      course_id: course,
      knowledge_version: kbVersion,
      format: inputs.format,
      family_session: familySession,
      duration_min: durationMin,
      methods: chosenMethodIds,
      audience_tier: inputs.audience_tier,
    });

    const time_spec = inputs.format === 'workshop'
      ? { format: 'workshop', core: ['intro', 'explore', 'first-try', 'improve', 'share'], total_min: durationMin }
      : { format: 'track', core: ['intro', 'practice', 'reflect'], total_min: durationMin };

    return c.json({
      knowledge_version: kbVersion,
      inputs: {
        audience: inputs.audience,
        assets,
        teaching_style: inputs.teaching_style,
        requirements: inputs.requirements,
        format: inputs.format,
        family_session: familySession,
        audience_tier: inputs.audience_tier,
        duration_min: durationMin,
      },
      vocab,
      methods: {
        chosen: methodResult.chosen,
        excluded: methodResult.excluded,
      },
      ...(methodsWarning ? { methods_warning: methodsWarning } : {}),
      authoring_order,
      time_spec,
      skeleton_html,
      rules: (guideDocs["guide:plan-spec"] as any)?.rules ?? [],
      family_session: familySession,
      guide_docs: guideDocs,
    });
  },
);

// ── GET /plan ────────────────────────────────────────────────────────────────

chalkCourses.get(
  "/chalk/cohorts/:cohort/courses/:course/plan",
  async (c) => {
    const cohort = c.req.param("cohort")!;
    const course = c.req.param("course")!;
    const { err } = await authAndOwn(c, cohort, course) as any;
    if (err) return err;

    c.header("cache-control", "no-store");

    const file = c.req.query("file") ?? "lesson";
    if (!VALID_FILES.includes(file as any))
      return c.json({ code: "invalid_request", error: `file must be one of: ${VALID_FILES.join(", ")}` }, 400);

    // Read latest draft plan file
    const planRow = await c.env.HPS_DB.prepare(
      `SELECT html, sha256, knowledge_version, ref_kind, ref
       FROM chalk_plan_files
       WHERE cohort_id=? AND course_id=? AND ref_kind='draft' AND file=?
       ORDER BY CAST(ref AS INTEGER) DESC LIMIT 1`
    ).bind(cohort, course, file).first<PlanFileRow>();
    if (!planRow) return c.json({ error: "plan file not found" }, 404);

    return c.json({
      html: planRow.html,
      sha256: planRow.sha256,
      knowledge_version: planRow.knowledge_version,
      ref_kind: planRow.ref_kind,
      ref: planRow.ref,
    });
  },
);

// ── Shared check logic ───────────────────────────────────────────────────────

function runPlanCheck(draft: Draft, htmlOverride?: string): CheckResultItem[] {
  const results: CheckResultItem[] = [];

  let derivedPrerequisites: string | null = null;

  if (htmlOverride !== undefined) {
    const parsed = parsePlan(htmlOverride, 'lesson');
    for (const v of parsed.violations) {
      results.push(fromParserViolation(v));
    }
    // Derive prerequisites from parsed plan for gate checks only.
    // Not stored back to content — plan→lesson derivation is E5-1 (freeze time).
    if (parsed.meta.prerequisites) {
      derivedPrerequisites = parsed.meta.prerequisites;
    }
  }

  let content: SessionDesign | null = null;
  try {
    content = JSON.parse(draft.content_json) as SessionDesign;
  } catch {
    results.push({
      item: null,
      severity: 'warn',
      judge: 'machine',
      at: { file: 'lesson', section: null, step: null, field: 'content_json' },
      message: '저장된 초안을 읽지 못해 관문 검사를 건너뜀',
      skipped: true,
      source: 'chalk-draft-check',
      blocks_confirm: false,
    });
    return results;
  }

  // Apply derived prerequisites for gate check (not saved to content).
  const checkContent = derivedPrerequisites && !content.prerequisites?.trim()
    ? { ...content, prerequisites: derivedPrerequisites }
    : content;

  const pedagogyFindings = checkLessonPedagogy(checkContent);
  for (const f of pedagogyFindings) {
    results.push(fromPedagogyFinding(f));
  }

  return results;
}

// ── POST /check ──────────────────────────────────────────────────────────────

chalkCourses.post(
  '/chalk/cohorts/:cohort/courses/:course/check',
  bodyLimit({ maxSize: PLAN_MAX_BYTES, onError: (c) => c.json({ error: 'request too large' }, 413) }),
  async (c) => {
    const cohort = c.req.param('cohort')!;
    const course = c.req.param('course')!;
    const author = c.get('author');

    const draft = await readDraft(c.env.HPS_DB, cohort, course);
    if (!draft || !owns(draft, author.payload.u, author.scope.profiles)) {
      return c.json({ error: 'course not found' }, 404);
    }

    const rawBody = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const html: string | undefined = typeof rawBody?.html === 'string' ? rawBody.html : undefined;

    const results = runPlanCheck(draft, html);
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

// ── POST /feedback ────────────────────────────────────────────────────────────

const FEEDBACK_MAX_BYTES = 16 * 1024;

interface FeedbackBody {
  text: string;
  model: string;
  base_revision: number;
  request_id: string;
}

chalkCourses.post(
  "/chalk/cohorts/:cohort/courses/:course/feedback",
  bodyLimit({ maxSize: FEEDBACK_MAX_BYTES + 4 * 1024, onError: c => c.json({ error: "피드백이 너무 깁니다", max_bytes: FEEDBACK_MAX_BYTES }, 413) }),
  async (c) => {
    const cohort = c.req.param("cohort")!;
    const course = c.req.param("course")!;
    const { err, auth } = await authAndOwn(c, cohort, course) as any;
    if (err) return err;

    c.header("cache-control", "no-store");

    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ code: "invalid_request", error: "invalid JSON" }, 400); }
    if (typeof body !== "object" || body === null) return c.json({ code: "invalid_request", error: "request body must be a JSON object" }, 400);
    const b = body as Record<string, unknown>;

    if (typeof b.text !== "string" || b.text.length === 0)
      return c.json({ code: "invalid_request", error: "text is required" }, 400);
    if (new TextEncoder().encode(b.text).length > FEEDBACK_MAX_BYTES)
      return c.json({ error: "피드백이 너무 깁니다", max_bytes: FEEDBACK_MAX_BYTES }, 413);
    if (typeof b.model !== "string" || b.model.length === 0)
      return c.json({ code: "invalid_request", error: "model is required" }, 400);
    if (!Number.isSafeInteger(b.base_revision) || (b.base_revision as number) < 1)
      return c.json({ code: "invalid_request", error: "base_revision must be a positive integer" }, 400);
    if (typeof b.request_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(b.request_id))
      return c.json({ code: "invalid_request", error: "request_id required" }, 400);

    const fb = b as unknown as FeedbackBody;
    const nowMs = Date.now();
    const feedbackId = `fb_${fb.request_id}`;

    // Idempotent: if request_id already exists for this course, return it.
    const existing = await c.env.HPS_DB.prepare(
      "SELECT feedback_id, base_revision, created_at FROM chalk_feedback WHERE request_id=? AND cohort_id=? AND course_id=?"
    ).bind(fb.request_id, cohort, course).first<{ feedback_id: string; base_revision: number; created_at: number }>();
    if (existing) {
      return c.json({ feedback_id: existing.feedback_id, base_revision: existing.base_revision, created_at: existing.created_at });
    }

    await c.env.HPS_DB.prepare(
      `INSERT INTO chalk_feedback (feedback_id,cohort_id,course_id,base_revision,text,model,actor,request_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(feedbackId, cohort, course, fb.base_revision, fb.text, fb.model, auth.payload.u, fb.request_id, nowMs).run();

    return c.json({ feedback_id: feedbackId, base_revision: fb.base_revision, created_at: nowMs });
  },
);

// ── GET /diff ─────────────────────────────────────────────────────────────────

chalkCourses.get(
  "/chalk/cohorts/:cohort/courses/:course/diff",
  async (c) => {
    const cohort = c.req.param("cohort")!;
    const course = c.req.param("course")!;
    const { err } = await authAndOwn(c, cohort, course) as any;
    if (err) return err;

    c.header("cache-control", "no-store");

    const toStr = c.req.query("to");
    const fromStr = c.req.query("from");
    const file = c.req.query("file") ?? "lesson";

    if (!VALID_FILES.includes(file as any))
      return c.json({ code: "invalid_request", error: `file must be one of: ${VALID_FILES.join(", ")}` }, 400);

    // Resolve 'to' revision (default: latest).
    let toRevision: number;
    if (toStr !== undefined) {
      const parsed = parseInt(toStr, 10);
      if (!Number.isFinite(parsed) || parsed < 1) return c.json({ code: "invalid_request", error: "to must be a positive integer" }, 400);
      toRevision = parsed;
    } else {
      const latest = await c.env.HPS_DB.prepare(
        "SELECT MAX(CAST(ref AS INTEGER)) AS rev FROM chalk_plan_files WHERE cohort_id=? AND course_id=? AND file=? AND ref_kind='draft'"
      ).bind(cohort, course, file).first<{ rev: number | null }>();
      if (!latest?.rev) return c.json({ code: "not_found", error: "no plan file found" }, 404);
      toRevision = latest.rev;
    }

    const toRow = await c.env.HPS_DB.prepare(
      "SELECT html FROM chalk_plan_files WHERE cohort_id=? AND course_id=? AND file=? AND ref_kind='draft' AND ref=?"
    ).bind(cohort, course, file, String(toRevision)).first<{ html: string }>();
    if (!toRow) return c.json({ code: "not_found", error: "to revision not found" }, 404);

    // Resolve 'from' revision (optional: absent → use previous).
    let fromRevision: number | null = null;
    if (fromStr !== undefined) {
      const parsed = parseInt(fromStr, 10);
      if (!Number.isFinite(parsed) || parsed < 1) return c.json({ code: "invalid_request", error: "from must be a positive integer" }, 400);
      fromRevision = parsed;
    } else {
      // Find previous revision before toRevision.
      const prevRow = await c.env.HPS_DB.prepare(
        "SELECT MAX(CAST(ref AS INTEGER)) AS rev FROM chalk_plan_files WHERE cohort_id=? AND course_id=? AND file=? AND ref_kind='draft' AND CAST(ref AS INTEGER) < ?"
      ).bind(cohort, course, file, toRevision).first<{ rev: number | null }>();
      fromRevision = prevRow?.rev ?? null;
    }

    if (fromRevision === null) {
      // No previous revision available.
      return c.json({ from_revision: null, to_revision: toRevision, file, changes: [] });
    }

    const fromRow = await c.env.HPS_DB.prepare(
      "SELECT html FROM chalk_plan_files WHERE cohort_id=? AND course_id=? AND file=? AND ref_kind='draft' AND ref=?"
    ).bind(cohort, course, file, String(fromRevision)).first<{ html: string }>();
    if (!fromRow) return c.json({ code: "not_found", error: "from revision not found" }, 404);

    const changes = diffUnits(planUnits(fromRow.html, file), planUnits(toRow.html, file));
    return c.json({ from_revision: fromRevision, to_revision: toRevision, file, changes });
  },
);
