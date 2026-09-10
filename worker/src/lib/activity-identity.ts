import type { TokenPayload } from './tokens';
import { sha256Hex } from './modules';
/** Presentation/storage identity only. Execution must still pass gateChatRequest. */
export function activityIdentity(p: TokenPayload): Promise<string> {
  return sha256Hex(JSON.stringify(['hps-activity/1',
    [p.native_trial ? 'trial' : 'classroom', p.c, p.u, p.account ?? null],
    p.p, p.lesson?.course_id ?? null, p.lesson?.version ?? null, p.lesson?.sha256 ?? null,
  ]));
}
