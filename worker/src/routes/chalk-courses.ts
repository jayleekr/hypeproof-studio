// #1295 — Chalk course generation routes (server side).
// PUT  /chalk/cohorts/:cohort/courses/:course/inputs  — save 5 inputs + optional vocab
// PUT  /chalk/cohorts/:cohort/courses/:course/plan    — save plan file + auto-check
// GET  /chalk/cohorts/:cohort/courses/:course/brief   — generation brief bundle
// GET  /chalk/cohorts/:cohort/courses/:course/plan    — read plan file (issuer only)
//
// Note: chalk-courses.ts merges with chalk-recommend.ts once #1293 lands
// (whichever PR merges second does the consolidation — #1294 comment).
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../env";
import { authorizeIssuerForCohort, type IssuerAuthz } from "../lib/instructor-auth";
import { sha256Hex } from "../lib/modules";
import { ASSETS } from "../lib/trial-evidence";
import { readDraft, owns, writeDraft } from "../lib/authoring-draft-write";
import { recommendMethods, VocabError, type MethodFields } from "../lib/chalk-recommend";

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
  const [goalRow, condRow] = await Promise.all([
    db.prepare("SELECT fields_json FROM chalk_knowledge_docs WHERE version=? AND doc_id='vocab:goal'")
      .bind(version).first<{ fields_json: string }>(),
    db.prepare("SELECT fields_json FROM chalk_knowledge_docs WHERE version=? AND doc_id='vocab:condition'")
      .bind(version).first<{ fields_json: string }>(),
  ]);
  const goalKeys = goalRow
    ? (JSON.parse(goalRow.fields_json) as { keys: Array<{ key: string }> }).keys.map(k => k.key) : [];
  const condKeys = condRow
    ? (JSON.parse(condRow.fields_json) as { keys: Array<{ key: string }> }).keys.map(k => k.key) : [];
  return { goals: goalKeys, conditions: condKeys };
}

// ── Skeleton HTML ────────────────────────────────────────────────────────────

function generateSkeleton(opts: {
  course_id: string; knowledge_version: number; format: string;
  family_session: boolean; duration_min: number; methods: string[];
}): string {
  const { course_id, knowledge_version, format, family_session, duration_min, methods } = opts;
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
  <meta name="chalk:family-session" content="${family_session}">
  <meta name="chalk:duration-min" content="${duration_min}">
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
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    if (typeof body !== "object" || body === null) return c.json({ error: "request body must be a JSON object" }, 400);
    const b = body as Record<string, unknown>;

    // Validate required fields
    if (typeof b.audience !== "string" || !b.audience.trim())
      return c.json({ error: "audience is required" }, 400);
    if (!Array.isArray(b.assets) || b.assets.length === 0)
      return c.json({ error: "assets must be a non-empty array" }, 400);
    // Closed vocabulary check for assets
    const badAssets = (b.assets as unknown[]).filter(a => typeof a !== "string" || !ASSETS.includes(a as any));
    if (badAssets.length > 0)
      return c.json({ error: "unknown asset values", field: "assets", unknown_values: badAssets }, 400);
    if (typeof b.teaching_style !== "string" || !b.teaching_style.trim())
      return c.json({ error: "teaching_style is required" }, 400);
    if (typeof b.requirements !== "string")
      return c.json({ error: "requirements is required" }, 400);
    if (!VALID_FORMATS.includes(b.format as any))
      return c.json({ error: `format must be one of: ${VALID_FORMATS.join(", ")}` }, 400);
    if (!Number.isSafeInteger(b.expected_revision) || (b.expected_revision as number) < 0)
      return c.json({ error: "expected_revision required" }, 400);
    if (typeof b.request_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(b.request_id))
      return c.json({ error: "request_id required" }, 400);
    const profile_id = typeof b.profile_id === "string" ? b.profile_id : "";

    const familySession = b.family_session === true ? 1 : 0;

    // Vocab validation
    let vocabJson: string | null = null;
    if (b.vocab !== undefined) {
      if (typeof b.vocab !== "object" || b.vocab === null || Array.isArray(b.vocab))
        return c.json({ error: "vocab must be an object" }, 400);
      const v = b.vocab as Record<string, unknown>;
      if (!Array.isArray(v.goals) || v.goals.some(g => typeof g !== "string"))
        return c.json({ error: "vocab.goals must be a string array" }, 400);
      if (!Array.isArray(v.conditions) || v.conditions.some(cc => typeof cc !== "string"))
        return c.json({ error: "vocab.conditions must be a string array" }, 400);

      // Must have a knowledge version to validate vocab against
      const kbVersion = await latestKbVersion(c.env.HPS_DB);
      if (!kbVersion) return c.json({ error: "제품 지식이 아직 없습니다; 지식을 먼저 적재하세요" }, 409);
      const closedVocab = await loadVocab(c.env.HPS_DB, kbVersion);

      const badGoals = (v.goals as string[]).filter(g => !closedVocab.goals.includes(g));
      if (badGoals.length > 0) return c.json({ error: "unknown goal values", field: "vocab.goals", unknown_values: badGoals }, 400);
      const badConds = (v.conditions as string[]).filter(cc => !closedVocab.conditions.includes(cc));
      if (badConds.length > 0) return c.json({ error: "unknown condition values", field: "vocab.conditions", unknown_values: badConds }, 400);

      vocabJson = JSON.stringify({
        goals: v.goals,
        conditions: v.conditions,
        learner_level: typeof v.learner_level === "string" ? v.learner_level : "any",
        has_guidance: typeof v.has_guidance === "boolean" ? v.has_guidance : undefined,
      });
    }

    // CAS write: read existing draft (if any), then upsert
    const prior = await readDraft(c.env.HPS_DB, cohort, course);
    if (prior && !owns(prior, auth.payload.u, auth.scope.profiles))
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

    // Extra batch stmt: upsert chalk_course_inputs
    const inputsUpsert = c.env.HPS_DB.prepare(
      `INSERT INTO chalk_course_inputs (cohort_id,course_id,revision,audience,assets_json,teaching_style,requirements,format,family_session,vocab_json,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(cohort_id,course_id) DO UPDATE SET
         revision=excluded.revision, audience=excluded.audience, assets_json=excluded.assets_json,
         teaching_style=excluded.teaching_style, requirements=excluded.requirements,
         format=excluded.format, family_session=excluded.family_session,
         vocab_json=excluded.vocab_json, updated_at=excluded.updated_at`
    );
    // revision for inputs is the new revision (expected+1), bound later via extra_batch_stmts
    // We insert with the new revision: for expected_revision=0 it will be 1; for >0 it will be expected+1.
    // Since writeDraft does the authoring_drafts write first, we use expected+1 to match.
    const newRevision = (b.expected_revision as number) + 1;
    const boundInputsUpsert = inputsUpsert.bind(
      cohort, course, newRevision,
      b.audience as string, JSON.stringify(b.assets), b.teaching_style as string,
      b.requirements as string, b.format as string, familySession, vocabJson, nowMs
    );

    const wr = await writeDraft(c.env.HPS_DB, prior, {
      cohort, course, owner_id: auth.payload.u,
      expected_revision: b.expected_revision as number,
      request_id: b.request_id as string,
      profile_id,
      content_json: existingContent,
      hash, now,
      independent: prior ? !!prior.independent : profile_id === '',
      extra_batch_stmts: [boundInputsUpsert],
    });

    if (wr.kind === 'ok' || wr.kind === 'idempotent')
      return c.json({ revision: wr.draft.revision });
    if (wr.kind === 'request_id_reused')
      return c.json({ error: "request id reused with different content" }, 409);
    return c.json({ error: "revision conflict; reload before saving" }, 409);
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
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    if (typeof body !== "object" || body === null) return c.json({ error: "request body must be a JSON object" }, 400);
    const b = body as Record<string, unknown>;

    if (!VALID_FILES.includes(b.file as any))
      return c.json({ error: `file must be one of: ${VALID_FILES.join(", ")}` }, 400);
    if (typeof b.html !== "string")
      return c.json({ error: "html is required" }, 400);
    if (!Number.isInteger(b.knowledge_version) || (b.knowledge_version as number) < 1)
      return c.json({ error: "knowledge_version must be a positive integer" }, 400);
    if (!Number.isSafeInteger(b.expected_revision) || (b.expected_revision as number) < 1)
      return c.json({ error: "expected_revision required (plan requires existing draft)" }, 400);
    if (typeof b.request_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(b.request_id))
      return c.json({ error: "request_id required" }, 400);

    const htmlBytes = new TextEncoder().encode(b.html as string).length;
    if (htmlBytes > PLAN_MAX_BYTES)
      return c.json({ error: "계획서가 너무 큽니다", max_bytes: PLAN_MAX_BYTES }, 413);

    // Verify knowledge version exists
    const kbRow = await c.env.HPS_DB.prepare(
      "SELECT version FROM chalk_knowledge_versions WHERE version=?"
    ).bind(b.knowledge_version).first<KbVersionRow>();
    if (!kbRow) return c.json({ error: "knowledge version not found" }, 409);

    const sha256 = await sha256Hex(b.html as string);
    const nowMs = Date.now();
    const newRevision = (b.expected_revision as number) + 1;

    // Extract method IDs from HTML meta tag (simple regex, no full parse needed)
    const methodsMeta = /data-chalk-plan[^>]*>.*?<meta[^>]+chalk:methods[^>]+content="([^"]*)"/.exec(
      (b.html as string).slice(0, 2000)
    );
    const methodIds = methodsMeta?.[1]?.split(/\s+/).filter(Boolean) ?? [];

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

    // Plan file insert (part of atomic batch with authoring_drafts update)
    const planFileInsert = c.env.HPS_DB.prepare(
      `INSERT INTO chalk_plan_files (cohort_id,course_id,ref_kind,ref,file,html,sha256,knowledge_version,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(cohort, course, 'draft', String(newRevision), b.file, b.html, sha256, b.knowledge_version, nowMs);

    const wr = await writeDraft(c.env.HPS_DB, prior!, {
      cohort, course, owner_id: auth.payload.u,
      expected_revision: b.expected_revision as number,
      request_id: b.request_id as string,
      profile_id: prior!.profile_id,
      content_json: newContent, hash, now,
      independent: !!prior!.independent,
      extra_batch_stmts: [planFileInsert],
    });

    if (wr.kind === 'ok' || wr.kind === 'idempotent') {
      // Auto-check: stub for now. Worker4's #1294 will provide checkChalkPlan().
      // Returns empty findings until #1294 lands.
      const findings: unknown[] = [];
      return c.json({ revision: wr.draft.revision, sha256, findings });
    }
    if (wr.kind === 'request_id_reused')
      return c.json({ error: "request id reused with different content" }, 409);
    return c.json({ error: "revision conflict; reload before saving" }, 409);
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
      return c.json({ error: `file must be one of: ${VALID_FILES.join(", ")}` }, 400);

    // Load inputs
    const inputs = await c.env.HPS_DB.prepare(
      "SELECT * FROM chalk_course_inputs WHERE cohort_id=? AND course_id=?"
    ).bind(cohort, course).first<InputsRow>();
    if (!inputs) return c.json({ error: "입력을 먼저 저장하세요 (PUT .../inputs)" }, 409);
    if (!inputs.vocab_json) return c.json({ error: "어휘(vocab)를 입력에 포함해야 brief를 만들 수 있습니다" }, 409);

    const vocab = JSON.parse(inputs.vocab_json) as VocabInput;

    // Load knowledge version
    const kbVersion = await latestKbVersion(c.env.HPS_DB);
    if (!kbVersion) return c.json({ error: "제품 지식이 아직 없습니다; 지식을 먼저 적재하세요" }, 409);

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
      if (err instanceof VocabError)
        return c.json({ error: err.message, field: err.field, unknown_values: err.unknown_values }, 409);
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
    const chosenMethodIds = methodResult.chosen.map(m => m.id);
    const familySession = inputs.family_session === 1;

    // Duration from format default (240 min for workshop)
    const durationMin = inputs.format === "workshop" ? 240 : 120;

    const skeleton_html = generateSkeleton({
      course_id: course,
      knowledge_version: kbVersion,
      format: inputs.format,
      family_session: familySession,
      duration_min: durationMin,
      methods: chosenMethodIds,
    });

    const time_spec = inputs.format === "workshop"
      ? { format: "workshop", core: ["intro", "explore", "first-try", "improve", "share"], total_min: 240 }
      : { format: "track", core: ["intro", "practice", "reflect"], total_min: 120 };

    return c.json({
      knowledge_version: kbVersion,
      inputs: {
        audience: inputs.audience,
        assets,
        teaching_style: inputs.teaching_style,
        requirements: inputs.requirements,
        format: inputs.format,
        family_session: familySession,
      },
      vocab,
      methods: {
        chosen: methodResult.chosen,
        excluded: methodResult.excluded,
      },
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
      return c.json({ error: `file must be one of: ${VALID_FILES.join(", ")}` }, 400);

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
