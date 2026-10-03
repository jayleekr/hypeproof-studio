// Curriculum Runtime admin controls (cr-evidence #1394; CR-70, CR-69, CR-67, CR-19).
// Mounted under /admin, behind the existing admin gate (Cloudflare Access, or the dev
// Basic-auth fallback). Not in `isIssuerAllowedEndpoint`, so no Bearer token reaches it: a
// student or a director (issuer) changing a ceiling or a data control gets the gate's refusal.
//
// Per cohort: the retention period after an experiment ends (Jay's decision 6: 30 days by
// default, per-cohort override; it covers declared raw input too, which decision 6 does not
// keep any longer), whether an experiment may declare raw-input retention at all, the link expiry the
// publish panel offers first (none until set: the student chooses, CR-19), whether students
// may delete their experiment's test data themselves, and team (Project) budget ceilings by
// meter. Cohort budget ceilings stay the access budgets' (AB-04, /admin/cohorts/:cohort/budgets);
// the team ceilings are enforced on the gateway path by cr-gateway (CR-34). Writes carry the
// expected revision, so two admins cannot both win (AB-04's revision conflict).
//
// With the CR switch off for every profile of the cohort, both routes answer as an unknown
// route does (CR-02).

import { Hono } from "hono";
import type { Env } from "../env";
import { listProfiles } from "../profiles";
import { curriculumRuntimeAllowed } from "../lib/moderation";
import { budgetMeter } from "../lib/budgets";
import { VENTURE_SCHEMA, isVentureId } from "../lib/curriculum/venture";
import { getCohortControls, putCohortControls, type CohortControls } from "../lib/curriculum/store";
import { unknownRoute } from "./curriculum";


export const curriculumAdmin = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();

/** Is the switch on for any profile that serves this cohort? */
export function cohortHasCurriculumRuntime(cohortId: string): boolean {
  return listProfiles().some((p) => p.session?.cohort_id === cohortId && curriculumRuntimeAllowed(p));
}

const COHORT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const days = (v: unknown, max: number) => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= max;

/** The controls a body asks for, or the problems with it. Nothing is defaulted from a missing field: the admin sends all of them. */
export function controlsProblems(body: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const allowed = ["expected_revision", "retention_days_after_end", "raw_input_allowed", "link_expiry_default_days", "student_deletion", "team_ceilings"];
  for (const k of Object.keys(body)) if (!allowed.includes(k)) problems.push(`unknown:${k}`);
  if (!Number.isSafeInteger(body.expected_revision) || (body.expected_revision as number) < 0) problems.push("invalid:expected_revision");
  if (!days(body.retention_days_after_end, 365)) problems.push("invalid:retention_days_after_end");
  if (typeof body.raw_input_allowed !== "boolean") problems.push("invalid:raw_input_allowed");
  if (!(body.link_expiry_default_days === null || days(body.link_expiry_default_days, 90))) problems.push("invalid:link_expiry_default_days");
  if (typeof body.student_deletion !== "boolean") problems.push("invalid:student_deletion");
  const t = body.team_ceilings;
  if (!(t && typeof t === "object" && !Array.isArray(t) && Object.keys(t).length <= 200 && Object.entries(t).every(([team, limits]) => isVentureId(team) && limits && typeof limits === "object" && !Array.isArray(limits) && Object.keys(limits).length >= 1 && Object.entries(limits as Record<string, unknown>).every(([m, n]) => budgetMeter(m) && Number.isSafeInteger(n) && (n as number) >= 0))))
    problems.push("invalid:team_ceilings");
  return problems;
}

curriculumAdmin.get("/curriculum/cohorts/:cohort/controls", async (c) => {
  const cohort = c.req.param("cohort");
  if (!COHORT.test(cohort) || !cohortHasCurriculumRuntime(cohort)) return unknownRoute(c);
  c.header("cache-control", "no-store");
  return c.json({ controls: await getCohortControls(c.env.HPS_DB, cohort) });
});

curriculumAdmin.put("/curriculum/cohorts/:cohort/controls", async (c) => {
  const cohort = c.req.param("cohort");
  if (!COHORT.test(cohort) || !cohortHasCurriculumRuntime(cohort)) return unknownRoute(c);
  c.header("cache-control", "no-store");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { type: "curriculum", code: "invalid_json" } }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: { type: "curriculum", code: "invalid_controls" } }, 400);
  const problems = controlsProblems(body);
  if (problems.length) return c.json({ error: { type: "curriculum", code: "invalid_controls", problems } }, 400);
  const expected = body.expected_revision as number;
  const next: CohortControls = {
    schema: VENTURE_SCHEMA,
    kind: "cohort_controls",
    cohort_id: cohort,
    retention_days_after_end: body.retention_days_after_end as number,
    raw_input_allowed: body.raw_input_allowed as boolean,
    link_expiry_default_days: body.link_expiry_default_days as number | null,
    student_deletion: body.student_deletion as boolean,
    team_ceilings: body.team_ceilings as CohortControls["team_ceilings"],
    revision: expected + 1,
    updated_at: Date.now(),
    updated_by: c.req.header("cf-access-authenticated-user-email") ?? "operator",
  };
  const stored = await putCohortControls(c.env.HPS_DB, next, expected);
  if (!stored) return c.json({ error: { type: "curriculum", code: "revision_conflict", current: (await getCohortControls(c.env.HPS_DB, cohort)).revision } }, 409);
  return c.json({ controls: stored });
});

/** The CR-T02 inventory of this router. */
export const CURRICULUM_ADMIN_ROUTES = ["GET /admin/curriculum/cohorts/:cohort/controls", "PUT /admin/curriculum/cohorts/:cohort/controls"] as const;
