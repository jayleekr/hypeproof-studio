import { Hono } from "hono";
import type { Env } from "../env";
import { authorizeIssuerForCohort } from "../lib/instructor-auth";
import { NATIVE_TRIAL_LIMITS } from "../lib/native-trial-grants";
export const nativeTrials = new Hono<{ Bindings: Env }>();
const path = "/cohorts/:cohort/native-trials/:user";
for (const method of ["get", "delete"] as const)
  nativeTrials[method](path, async (c) => {
    c.header("cache-control", "no-store");
    const auth = await authorizeIssuerForCohort(c, c.req.param("cohort"));
    if (auth instanceof Response) return auth;
    // Parent admin middleware already authenticates Basic/Access administrators.
    const owner=auth?.payload.u??"admin";
    const row = await c.env.HPS_DB.prepare(
      "SELECT id,profile_id,owner_id,started_at,expires_at,revoked,requests_used,request_limit,lease_id FROM native_trials WHERE cohort_id=? AND user_id=?",
    )
      .bind(c.req.param("cohort"), c.req.param("user"))
      .first<{
        id: string;
        profile_id: string;
        owner_id: string;
        started_at: number | null;
        expires_at: number | null;
        revoked: number;
        requests_used: number;
        request_limit: number;
        lease_id: string | null;
      }>();
    if (
      !row ||
      row.owner_id !== owner ||
      (auth && !auth.scope.profiles.includes(row.profile_id))
    )
      return c.json({ error: "trial not found" }, 404);
    if (method === "delete")
      await c.env.HPS_DB.prepare(
        "UPDATE native_trials SET revoked=1 WHERE id=? AND owner_id=?",
      )
        .bind(row.id, owner)
        .run();
    return c.json({
      started_at: row.started_at,
      expires_at: row.expires_at,
      revoked: method === "delete" || !!row.revoked,
      requests_used: row.requests_used,
      remaining_requests: row.request_limit - row.requests_used,
      busy: !!row.lease_id,
      limits: NATIVE_TRIAL_LIMITS,
    });
  });
