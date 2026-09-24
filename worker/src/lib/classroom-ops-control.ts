// #751 R3 — class-run "pause new runs" admission, read from the D1 primary.
// Kept apart from routes/ so the chat gate can import it without the ops router.
import type { Env } from '../env';

export interface RunControl { paused: boolean; control_revision: number }
export const CLASS_PAUSED_MESSAGE = '강사가 새 AI 실행을 잠시 멈췄습니다. 작업 파일과 대화는 그대로이며 저장·내보내기·중지는 계속 할 수 있습니다.';

/**
 * null when the feature is off, the run has no control row, or the read failed.
 * A failed read is deliberately NOT a pause: operations metadata must never be
 * able to take the learning path down (AT-25). The pre-existing KV cohort kill
 * switch remains the emergency stop and is checked before this.
 */
export async function readRunControl(env: Env, classRunId: string): Promise<RunControl | null> {
  if (env.HPS_CLASSROOM_OPS !== 'enabled') return null;
  try {
    const row = await env.HPS_DB.prepare('SELECT paused,control_revision FROM class_run_control WHERE class_run_id=?').bind(classRunId).first<{ paused: number; control_revision: number }>();
    return row ? { paused: row.paused === 1, control_revision: row.control_revision } : null;
  } catch (err) {
    console.error('class run control unavailable — admission not restricted:', err);
    return null;
  }
}
