// #1293 — POST /admin/chalk/cohorts/:cohort/courses/:course/recommend
// Issuer Bearer only. Deterministic closed-vocabulary method recommendation.
// Depends on chalk_knowledge_versions and chalk_knowledge_docs from #1288 (migration 0030).
// TODO(#1295): readDraft 통합
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../env";
import { authorizeIssuerForCohort } from "../lib/instructor-auth";
import { owns, type Draft } from "./authoring";
import { recommendMethods, VocabError, type MethodFields } from "../lib/chalk-recommend";

interface KbDoc {
  version: number;
  doc_id: string;
  kind: string;
  fields_json: string;
  body: string;
  source_path: string | null;
}

export const chalkRecommend = new Hono<{ Bindings: Env }>();

chalkRecommend.post(
  "/chalk/cohorts/:cohort/courses/:course/recommend",
  bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "request body too large" }, 413) }),
  async (c) => {
    const cohort = c.req.param("cohort")!;
    const course = c.req.param("course")!;

    const auth = await authorizeIssuerForCohort(c, cohort);
    if (auth instanceof Response) return auth;
    if (!auth) return c.json({ error: "instructor Bearer required" }, 401);

    c.header("cache-control", "no-store");

    // Verify the course draft exists and is owned by this issuer.
    const draft = await c.env.HPS_DB
      .prepare("SELECT * FROM authoring_drafts WHERE cohort_id=? AND course_id=?")
      .bind(cohort, course)
      .first<Draft>();
    if (!draft || !owns(draft, auth)) {
      return c.json({ error: "course not found" }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "request body must be JSON" }, 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "request body must be a JSON object" }, 400);
    }
    const req = body as Record<string, unknown>;

    if (!Array.isArray(req.conditions) || req.conditions.some((v) => typeof v !== "string")) {
      return c.json({ error: "conditions must be a string array" }, 400);
    }
    if (!Array.isArray(req.goals) || req.goals.some((v) => typeof v !== "string")) {
      return c.json({ error: "goals must be a string array" }, 400);
    }

    const requestedVersion =
      req.knowledge_version !== undefined
        ? typeof req.knowledge_version === "number"
          ? req.knowledge_version
          : null
        : null;
    if (req.knowledge_version !== undefined && requestedVersion === null) {
      return c.json({ error: "knowledge_version must be a number" }, 400);
    }

    const learnerLevel = typeof req.learner_level === "string" ? req.learner_level : undefined;
    const hasGuidance = typeof req.has_guidance === "boolean" ? req.has_guidance : undefined;

    // Resolve knowledge version
    const versionRow = requestedVersion !== null
      ? await c.env.HPS_DB
          .prepare("SELECT version FROM chalk_knowledge_versions WHERE version=?")
          .bind(requestedVersion)
          .first<{ version: number }>()
      : await c.env.HPS_DB
          .prepare("SELECT version FROM chalk_knowledge_versions ORDER BY version DESC LIMIT 1")
          .first<{ version: number }>();

    if (!versionRow) {
      return c.json({ error: "no knowledge version found; load knowledge data first" }, 409);
    }
    const kbVersion = versionRow.version;

    // Load vocab docs — all three required; missing any → knowledge incomplete
    const [goalVocabRow, condVocabRow, priorVocabRow] = await Promise.all([
      c.env.HPS_DB
        .prepare("SELECT fields_json FROM chalk_knowledge_docs WHERE version=? AND doc_id='vocab:goal'")
        .bind(kbVersion)
        .first<{ fields_json: string }>(),
      c.env.HPS_DB
        .prepare("SELECT fields_json FROM chalk_knowledge_docs WHERE version=? AND doc_id='vocab:condition'")
        .bind(kbVersion)
        .first<{ fields_json: string }>(),
      c.env.HPS_DB
        .prepare("SELECT fields_json FROM chalk_knowledge_docs WHERE version=? AND doc_id='vocab:prior'")
        .bind(kbVersion)
        .first<{ fields_json: string }>(),
    ]);

    if (!goalVocabRow || !condVocabRow || !priorVocabRow) {
      return c.json({ error: "knowledge incomplete; reload knowledge data" }, 409);
    }

    const goalKeys = (JSON.parse(goalVocabRow.fields_json) as { keys: Array<{ key: string }> }).keys.map((k) => k.key);
    const condKeys = (JSON.parse(condVocabRow.fields_json) as { keys: Array<{ key: string }> }).keys.map((k) => k.key);
    const priorKeys = (JSON.parse(priorVocabRow.fields_json) as { keys: Array<{ key: string }> }).keys.map((k) => k.key);

    // Load method docs — ORDER BY doc_id for deterministic ordering
    const methodRows = await c.env.HPS_DB
      .prepare("SELECT * FROM chalk_knowledge_docs WHERE version=? AND kind='method' ORDER BY doc_id")
      .bind(kbVersion)
      .all<KbDoc>();

    const methods: MethodFields[] = (methodRows.results ?? []).map((row) => {
      const fields = JSON.parse(row.fields_json) as Record<string, unknown>;
      return {
        id: String(fields.id ?? row.doc_id),
        best_for: Array.isArray(fields.best_for) ? (fields.best_for as string[]) : [],
        weak_for: Array.isArray(fields.weak_for) ? (fields.weak_for as string[]) : [],
        avoid_when: Array.isArray(fields.avoid_when) ? (fields.avoid_when as string[]) : [],
        prior_knowledge: typeof fields.prior_knowledge === "string" ? fields.prior_knowledge : undefined,
        requires_guidance: typeof fields.requires_guidance === "boolean" ? fields.requires_guidance : undefined,
      };
    });

    try {
      const result = recommendMethods(
        {
          conditions: req.conditions as string[],
          goals: req.goals as string[],
          learner_level: learnerLevel,
          has_guidance: hasGuidance,
        },
        methods,
        { goals: goalKeys, conditions: condKeys, prior: priorKeys },
        kbVersion,
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof VocabError) {
        return c.json({ error: err.message, field: err.field, unknown_values: err.unknown_values }, 400);
      }
      throw err;
    }
  },
);
