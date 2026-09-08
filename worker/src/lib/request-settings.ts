import type { Env } from '../env';
import type { TokenPayload } from './tokens';
import type { EffortReceipt } from './model-effort';

export const validTurnId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
export async function persistRequestSettings(env: Env, p: TokenPayload, turn: string | undefined,
  request: string, model: string, receipt: EffortReceipt | undefined, status: number): Promise<void> {
  if (!receipt || !validTurnId(turn)) return;
  try {
    await env.HPS_DB.prepare(`INSERT INTO usage_request_settings
      (request_id,cohort_id,user_id,profile_id,lesson_scope,client_turn_id,model,requested,applied,reason,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING`)
      .bind(request,p.c,p.u,p.p,p.lesson ? JSON.stringify([p.lesson.course_id,p.lesson.version,p.lesson.sha256]) : '',turn,model,receipt.requested,receipt.applied,receipt.reason,status).run();
  } catch {
    // A missing receipt is unknown in the UI. Never fail chat or fabricate one.
    console.error(`[${request}] request settings could not be recorded`);
  }
}
export async function readRequestSettings(env: Env, p: TokenPayload, turn: string) {
  return env.HPS_DB.prepare(`SELECT request_id,model,requested,applied,reason,status,created_at
    FROM usage_request_settings WHERE cohort_id=? AND user_id=? AND profile_id=? AND lesson_scope=? AND client_turn_id=?
    ORDER BY created_at,request_id LIMIT 101`).bind(p.c,p.u,p.p,p.lesson ? JSON.stringify([p.lesson.course_id,p.lesson.version,p.lesson.sha256]) : '',turn).all();
}
