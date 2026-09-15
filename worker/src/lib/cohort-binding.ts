// #1006 IC-B — the single decision "does this participant token's cohort run on
// this profile?". Replaces six copies of `payload.c !== profile.session.cohort_id`.
//
// Legacy cohorts: the token cohort must equal the compiled profile cohort (unchanged).
// Class cohorts (`class-…`): a server-written opening row binds the class cohort to
// one reviewed execution template, one independent course and a time window. The
// class cohort owns its own roster / active session / pause keys, so two classes
// opened from the same template share neither. The template profile is never copied.
import type { Env } from '../env';
import type { Profile } from '../profiles/types';
import type { TokenPayload } from './tokens';

export const CLASS_COHORT_PREFIX = 'class-';
export const isClassCohort = (c: string) => c.startsWith(CLASS_COHORT_PREFIX);

export interface OpeningBinding {
  class_cohort: string;
  template_cohort: string;
  profile_id: string;
  course_id: string;
  version: string;
  starts_at: number;  // epoch ms
  ends_at: number;    // epoch ms
  revoked: number;    // 0 | 1
}

export type CohortRejection =
  | 'cohort_mismatch'
  | 'opening_missing'
  | 'opening_profile_mismatch'
  | 'opening_lesson_required'
  | 'opening_course_mismatch'
  | 'opening_version_mismatch'
  | 'opening_revoked'
  | 'opening_expired'
  | 'template_not_reviewed';

/** `lessonCohort` is where the frozen course versions live (the template cohort for a class). */
export type CohortDecision = { ok: true; lessonCohort: string } | { ok: false; reason: CohortRejection };

/** Pure: no I/O. `binding` is the opening row for `c` (or null); ignored for legacy cohorts. */
export function decideCohort(
  profile: Pick<Profile, 'id' | 'session' | 'execution_template'>,
  payload: Pick<TokenPayload, 'c' | 'lesson'>,
  binding: OpeningBinding | null,
  now: number,
): CohortDecision {
  const c = payload.c;
  if (!isClassCohort(c)) {
    return c === profile.session.cohort_id ? { ok: true, lessonCohort: c } : { ok: false, reason: 'cohort_mismatch' };
  }
  if (!binding || binding.class_cohort !== c) return { ok: false, reason: 'opening_missing' };
  if (binding.profile_id !== profile.id || binding.template_cohort !== profile.session.cohort_id)
    return { ok: false, reason: 'opening_profile_mismatch' };
  if (profile.execution_template !== true) return { ok: false, reason: 'template_not_reviewed' };
  if (binding.revoked) return { ok: false, reason: 'opening_revoked' };
  if (!(now >= binding.starts_at && now < binding.ends_at)) return { ok: false, reason: 'opening_expired' };
  // A class seat exists only to deliver the opening's bound course version. Without a lesson
  // reference it would run the bare template, so it is refused (fail closed; X2 on #1037).
  if (!payload.lesson) return { ok: false, reason: 'opening_lesson_required' };
  // Only this opening's course AND its frozen version (VER-01): another opening's course,
  // or another version of the same course, is refused before delivery.
  if (payload.lesson.course_id !== binding.course_id) return { ok: false, reason: 'opening_course_mismatch' };
  if (payload.lesson.version !== binding.version) return { ok: false, reason: 'opening_version_mismatch' };
  return { ok: true, lessonCohort: binding.template_cohort };
}

export async function readOpening(env: Env, classCohort: string): Promise<OpeningBinding | null> {
  return env.HPS_DB.prepare(
    'SELECT class_cohort,template_cohort,profile_id,course_id,version,starts_at,ends_at,revoked FROM authoring_openings WHERE class_cohort=?',
  ).bind(classCohort).first<OpeningBinding>();
}

/** Loads the opening row only for class cohorts, so legacy requests never touch D1 here. */
export async function profileServesCohort(
  env: Env,
  profile: Pick<Profile, 'id' | 'session' | 'execution_template'>,
  payload: Pick<TokenPayload, 'c' | 'lesson'>,
  now = Date.now(),
): Promise<CohortDecision> {
  const binding = isClassCohort(payload.c) ? await readOpening(env, payload.c) : null;
  return decideCohort(profile, payload, binding, now);
}
