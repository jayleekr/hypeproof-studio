// GET /admin/cohorts/:id/state — read-only cohort state for the instructor
// console (#352). Moved here from worker/src/routes/admin.ts with plan task F.
//
// Auth: instructor issuer Bearer with ANY scope on the cohort (no
// can_start_session — a mint-only instructor must still SEE what is open
// before handing out tokens). Verification is the Service's, re-exported via
// shared.ts. Unlike the old Service route there is NO admin Basic / CF Access
// path: Chalk has no admin password, so `null` from the shared helper (no
// Bearer at all) is a 401 here, not "admin". Operator tools that read this
// with Basic auth use the Service's GET /admin/cohorts/:id instead.
//
// Privacy contract (spec §4, board rule 4 — applies to every Chalk read):
// operational metadata only. roster_size, never member handles; display
// names of tracks, never prompt text. chalk/test/board-contract.test.mjs
// pins the response shape.

import { Hono } from "hono";
import type { ChalkEnv } from "../env.ts";
import {
  authorizeIssuerForCohort,
  getActiveSession,
  getCohortPause,
  getRoster,
  listProfiles,
} from "../shared.ts";

export const state = new Hono<{ Bindings: ChalkEnv; Variables: { requestId: string } }>();

state.get("/cohorts/:id/state", async (c) => {
  const cohortId = c.req.param("id");
  const authz = await authorizeIssuerForCohort(c, cohortId);
  if (authz instanceof Response) return authz;
  if (authz === null) {
    return c.json({ error: "instructor issuer token required (Authorization: Bearer …)" }, 401);
  }
  const [session, roster, paused] = await Promise.all([
    getActiveSession(c.env.HPS_KV, cohortId),
    getRoster(c.env.HPS_KV, cohortId),
    getCohortPause(c.env.HPS_KV, cohortId),
  ]);
  const scopedIds = authz.scope.profiles ?? [];
  // #384 — hide dashboard_hidden tracks from the console (session cards + mint
  // dropdown both read this), and order by dashboard_order (lower first; absent
  // sorts last, then registry order). Does not touch /v1/profile resolution.
  const profiles = listProfiles()
    .filter((p) => p.session.cohort_id === cohortId)
    .filter((p) => scopedIds.includes(p.id))
    .filter((p) => p.dashboard_hidden !== true)
    .sort((a, b) => (a.dashboard_order ?? Number.MAX_SAFE_INTEGER) - (b.dashboard_order ?? Number.MAX_SAFE_INTEGER))
    .map((p) => ({ id: p.id, display_name: p.display_name }));
  return c.json({
    id: cohortId,
    now: new Date().toISOString(),
    session,
    roster_size: roster?.users.length ?? 0,
    paused,
    profiles,
    // Server-authoritative caps so the console renders the same limits the
    // Service's mutation endpoints will enforce on the forwarded writes.
    scope: {
      can_start_session: authz.scope.can_start_session === true,
      max_session_hours: authz.scope.max_session_hours ?? 4,
      max_hours: authz.scope.max_hours ?? 12,
    },
  });
});
