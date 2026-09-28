// #1012 · #751 G2 — storage of rehearsals, their request records and confirmations (migration 0026). Pure judging lives in
// lesson-rehearsal.ts. Every write here is conditional and write-once; a missing table (migration not applied) reads as
// "no record", never as a pass.
import type { Env } from '../env';
import type { TokenPayload } from './tokens';
import { getProfile } from '../profiles';
import type { SessionDesign } from './session-design';
import { policyDigest, rehearsalState, type RehearsalState, type RehearsalTurn } from './lesson-rehearsal';

/** `require` makes a confirmation (on a passed rehearsal) the condition for inviting learners to, or switching them to, a version. */
export const confirmationRequired = (env: Env) => env.HPS_LESSON_CONFIRMATION === 'require';
const noSuchTable = (err: unknown) => /no such table/i.test(String((err as Error)?.message ?? err));

export interface RehearsalRow {
  rehearsal_id: string; cohort_id: string; course_id: string; version: string; lesson_sha256: string; source_revision: number;
  profile_id: string; learner_id: string; token_jti: string; policy_digest: string; created_by: string; created_at: number;
  expires_at: number; request_id: string; report_json: string | null; report_hash: string | null; reported_at: number | null;
  verdict: string | null; verdict_json: string | null; judged_at: number | null;
}
export interface ConfirmationRow { cohort_id: string; course_id: string; version: string; lesson_sha256: string; rehearsal_id: string; policy_digest: string; confirmed_by: string; confirmed_at: number }

export async function latestRehearsal(db: D1Database, cohort: string, course: string, version: string): Promise<RehearsalRow | null> {
  try { return await db.prepare('SELECT * FROM authoring_rehearsals WHERE cohort_id=? AND course_id=? AND version=? ORDER BY created_at DESC, rehearsal_id DESC LIMIT 1').bind(cohort, course, version).first<RehearsalRow>(); }
  catch (err) { if (noSuchTable(err)) return null; throw err; }
}
export async function rehearsalHistory(db: D1Database, cohort: string, course: string, version: string, limit = 5): Promise<RehearsalRow[]> {
  try { return ((await db.prepare('SELECT * FROM authoring_rehearsals WHERE cohort_id=? AND course_id=? AND version=? ORDER BY created_at DESC, rehearsal_id DESC LIMIT ?').bind(cohort, course, version, limit).all<RehearsalRow>()).results ?? []); }
  catch (err) { if (noSuchTable(err)) return []; throw err; }
}
export async function confirmationOf(db: D1Database, cohort: string, course: string, version: string): Promise<ConfirmationRow | null> {
  try { return await db.prepare('SELECT * FROM authoring_confirmations WHERE cohort_id=? AND course_id=? AND version=?').bind(cohort, course, version).first<ConfirmationRow>(); }
  catch (err) { if (noSuchTable(err)) return null; throw err; }
}
export async function rehearsalTurns(db: D1Database, rehearsalId: string): Promise<RehearsalTurn[]> {
  try {
    const rows = (await db.prepare('SELECT request_id,lesson_sha256,step_id,help_receipt,runtime,tool_names_json,outcome FROM authoring_rehearsal_turns WHERE rehearsal_id=? ORDER BY at LIMIT 200').bind(rehearsalId).all<Record<string, any>>()).results ?? [];
    return rows.map((r) => ({ request_id: r.request_id, lesson_sha256: r.lesson_sha256, step_id: r.step_id, help_receipt: r.help_receipt, runtime: r.runtime, outcome: r.outcome, tool_names: (() => { try { return JSON.parse(r.tool_names_json); } catch { return []; } })() }));
  } catch (err) { if (noSuchTable(err)) return []; throw err; }
}

/** The digest the candidate would get NOW; null when its profile is gone (then nothing can be confirmed). */
export async function currentDigest(profileId: string, content: SessionDesign): Promise<string | null> {
  const p = getProfile(profileId);
  return p ? policyDigest(p, content) : null;
}

export interface Readiness {
  state: RehearsalState;
  rehearsal: { id: string; learner_id: string; created_at: number; expires_at: number; verdict: string | null; reasons: string[]; judged_at: number | null; app: unknown; checks: unknown } | null;
  confirmed: { at: number; by: string; rehearsal_id: string } | null;
  /** A confirmation whose rehearsal policy no longer matches the profile is shown, but it is not a current readiness claim. */
  confirmation_current: boolean;
}
export async function readinessOf(env: Env, v: { cohort: string; course: string; version: string; profileId: string; lessonSha: string; content: SessionDesign }, now = Date.now()): Promise<Readiness> {
  const [row, conf, digest] = await Promise.all([latestRehearsal(env.HPS_DB, v.cohort, v.course, v.version), confirmationOf(env.HPS_DB, v.cohort, v.course, v.version), currentDigest(v.profileId, v.content)]);
  const own = row && row.lesson_sha256 === v.lessonSha ? row : null;
  const verdict = own?.verdict_json ? (() => { try { return JSON.parse(own.verdict_json!); } catch { return null; } })() : null;
  const report = own?.report_json ? (() => { try { return JSON.parse(own.report_json!); } catch { return null; } })() : null;
  return {
    state: rehearsalState(own, { now, currentDigest: digest }),
    rehearsal: own ? { id: own.rehearsal_id, learner_id: own.learner_id, created_at: own.created_at, expires_at: own.expires_at, verdict: own.verdict, reasons: verdict?.reasons ?? [], judged_at: own.judged_at, app: report?.app ?? null, checks: verdict?.checks ?? null } : null,
    confirmed: conf && conf.lesson_sha256 === v.lessonSha ? { at: conf.confirmed_at, by: conf.confirmed_by, rehearsal_id: conf.rehearsal_id } : null,
    confirmation_current: !!conf && conf.lesson_sha256 === v.lessonSha && digest !== null && conf.policy_digest === digest,
  };
}

/** True when this exact version may be used by learners: confirmation off, or confirmed on a still-current policy. */
export async function versionUsable(env: Env, v: { cohort: string; course: string; version: string; profileId: string; lessonSha: string; content: SessionDesign }): Promise<boolean> {
  if (!confirmationRequired(env)) return true;
  const conf = await confirmationOf(env.HPS_DB, v.cohort, v.course, v.version);
  if (!conf || conf.lesson_sha256 !== v.lessonSha) return false;
  return conf.policy_digest === await currentDigest(v.profileId, v.content);
}

/**
 * One admitted model request made with a rehearsal code. Written only where the rehearsal row names THIS token, so a code
 * that does not belong to a rehearsal, or a copied rehearsal id on another token, records nothing. Failure to write is
 * logged: the verdict then lacks the request and cannot pass (never the reverse).
 */
export async function recordRehearsalRequest(env: Env, p: TokenPayload, o: { requestId: string; lessonSha: string; step: string; help: string; runtime: string; model: string; toolNames: string[]; outcome: string; status: number | null; now: number }): Promise<void> {
  if (!p.rehearsal || !p.jti) return;
  try {
    await env.HPS_DB.prepare(`INSERT INTO authoring_rehearsal_turns(rehearsal_id,request_id,at,lesson_sha256,step_id,help_receipt,runtime,model,tool_names_json,outcome,status)
 SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM authoring_rehearsals r WHERE r.rehearsal_id=? AND r.token_jti=? AND r.verdict IS NULL) ON CONFLICT DO NOTHING`)
      .bind(p.rehearsal, o.requestId.slice(0, 128), o.now, o.lessonSha, o.step.slice(0, 64), o.help.slice(0, 200), o.runtime, o.model.slice(0, 120), JSON.stringify(o.toolNames), o.outcome, o.status, p.rehearsal, p.jti).run();
  } catch (err) { console.error('rehearsal request not recorded — the rehearsal cannot pass on it:', err); }
}
