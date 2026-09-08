import type { Env } from "../env";
import type { TokenPayload } from "./tokens";
import type { ActiveSession } from "./kv";
export const NATIVE_TRIAL_LIMITS = {
  duration_ms: 3600000,
  request_limit: 40,
  input_bytes: 200000,
  output_tokens: 8192,
  request_timeout_ms: 60000,
};
type Grant = {
  id: string;
  token_jti: string;
  cohort_id: string;
  profile_id: string;
  user_id: string;
  owner_id: string;
  issued_expires_at: number;
  duration_ms: number;
  started_at: number | null;
  expires_at: number | null;
  revoked: number;
  request_limit: number;
  requests_used: number;
  lease_id: string | null;
};
export async function createNativeGrant(
  env: Env,
  p: TokenPayload,
  owner: string,
) {
  if (!p.jti) throw Error("trial_missing_id");
  const saved = await env.HPS_DB.prepare(
    `INSERT INTO native_trials(id,token_jti,cohort_id,profile_id,user_id,owner_id,issued_expires_at,duration_ms,request_limit) VALUES(?,?,?,?,?,?,?,?,?)
 ON CONFLICT(cohort_id,profile_id,user_id) DO UPDATE SET token_jti=excluded.token_jti,issued_expires_at=MIN(native_trials.issued_expires_at,excluded.issued_expires_at)
 WHERE native_trials.owner_id=excluded.owner_id AND native_trials.lease_id IS NULL AND native_trials.revoked=0`,
  )
    .bind(
      p.jti,
      p.jti,
      p.c,
      p.p,
      p.u,
      owner,
      p.exp * 1000,
      NATIVE_TRIAL_LIMITS.duration_ms,
      NATIVE_TRIAL_LIMITS.request_limit,
    )
    .run();
  if (!saved.meta?.changes) throw Error("trial_reissue_conflict");
}
export async function readNativeGrant(
  env: Env,
  p: TokenPayload,
): Promise<Grant | null> {
  if (!p.jti) return null;
  return env.HPS_DB.prepare(
    "SELECT * FROM native_trials WHERE token_jti=? AND cohort_id=? AND profile_id=? AND user_id=?",
  )
    .bind(p.jti, p.c, p.p, p.u)
    .first<Grant>();
}
export async function startNativeGrant(
  env: Env,
  p: TokenPayload,
  now = Date.now(),
): Promise<ActiveSession | null> {
  await env.HPS_DB.prepare(
    "UPDATE native_trials SET started_at=?,expires_at=MIN(issued_expires_at,?+duration_ms) WHERE token_jti=? AND cohort_id=? AND profile_id=? AND user_id=? AND started_at IS NULL AND revoked=0 AND issued_expires_at>?",
  )
    .bind(now, now, p.jti, p.c, p.p, p.u, now)
    .run();
  const grant = await readNativeGrant(env, p);
  if (
    !grant ||
    grant.revoked ||
    !grant.started_at ||
    !grant.expires_at ||
    grant.expires_at <= now
  )
    return null;
  return {
    session_id: grant.id,
    profile_id: grant.profile_id,
    starts_at: new Date(grant.started_at).toISOString(),
    ends_at: new Date(grant.expires_at).toISOString(),
  };
}
export async function reserveNativeRequest(
  env: Env,
  p: TokenPayload,
  id: string,
  now = Date.now(),
) {
  // Recover reservations orphaned by a Worker restart after two provider deadlines.
  // Attempts remain charged. The settlement trigger releases only that request's lock.
  await env.HPS_DB.prepare("UPDATE native_trial_requests SET status='failed',finished_at=? WHERE trial_id IN (SELECT id FROM native_trials WHERE token_jti=?) AND status='reserved' AND created_at<=?")
    .bind(now,p.jti,now-2*NATIVE_TRIAL_LIMITS.request_timeout_ms).run();
  const result = await env.HPS_DB.prepare(
    `INSERT INTO native_trial_requests(id,trial_id,status,created_at)
 SELECT ?,id,'reserved',? FROM native_trials WHERE token_jti=? AND cohort_id=? AND user_id=? AND profile_id=? AND revoked=0 AND expires_at>? AND lease_id IS NULL AND requests_used<request_limit
 ON CONFLICT(id) DO NOTHING`,
  )
    .bind(id, now, p.jti, p.c, p.u, p.p, now)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}
export async function finishNativeRequest(
  env: Env,
  id: string,
  success: boolean,
  now = Date.now(),
) {
  // Do not refund failed attempts: provider calls may already have incurred usage.
  // This is an attempt allowance, separate from the existing billing usage ledger.
  await env.HPS_DB.prepare(
    "UPDATE native_trial_requests SET status=?,finished_at=? WHERE id=? AND status='reserved'",
  )
    .bind(success ? "completed" : "failed", now, id)
    .run();
}
