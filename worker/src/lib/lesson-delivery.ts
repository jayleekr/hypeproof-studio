import { getProfile } from '../profiles';
import { lessonFeaturesAreCurrent } from './lesson-feature-policy';
import { lessonModelIsCurrent } from './lesson-model-policy';
import type { Env } from '../env';
import type { TokenPayload } from './tokens';
import { isModuleVersion, validateModuleDoc } from './modules';
import { validateSessionDesign, type SessionDesign } from './session-design';
import { studentVisibleLesson } from './learning-prompt';

export async function readLesson(env: Env, cohort: string, course: string, version: string, profile: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(course) || !isModuleVersion(version)) return null;
  const row = await env.HPS_DB.prepare('SELECT module_json FROM authoring_versions WHERE cohort_id=? AND course_id=? AND version=?')
    .bind(cohort, course, version).first<{ module_json: string }>();
  if (!row) return null;
  let raw: unknown;
  try { raw = JSON.parse(row.module_json); } catch { return null; }
  const result = await validateModuleDoc(raw, { kind: 'session-design', profileId: profile });
  if (!result.ok || result.doc.version !== version || validateSessionDesign(result.doc.content, true)) return null;
  const content = result.doc.content as unknown as SessionDesign;
  if (content.model || content.features) {
    const current = getProfile(profile);
    if (!current) return null;
    if (content.model && !lessonModelIsCurrent(env, current, content.model)) return null;
    // #748 — a profile whose grants shrank after the freeze closes the lesson
    // rather than serving the wider set the instructor last saw.
    if (content.features && !lessonFeaturesAreCurrent(current, content.features)) return null;
  }
  return { course_id: course, version, sha256: result.doc.sha256, content: result.doc.content as unknown as SessionDesign };
}

/** A missing/broken signed lesson never falls back to another class or draft. */
// `lessonCohort` is where the frozen versions live: the token cohort for legacy seats,
// the template cohort for a class opening (#1006 IC-B, from profileServesCohort).
export async function resolveTokenLesson(env: Env, p: TokenPayload, lessonCohort = p.c) {
  if (!p.lesson) return null;
  const ref = p.lesson;
  if (typeof ref.course_id !== 'string' || typeof ref.version !== 'string' || typeof ref.sha256 !== 'string') return null;
  const lesson = await readLesson(env, lessonCohort, ref.course_id, ref.version, p.p);
  if (!lesson || lesson.sha256 !== ref.sha256) return null;
  // SCH-03 (#1291): strip prohibited_moves AFTER sha256 check so the stored bytes
  // are never altered by the projection.
  return { ...lesson, content: studentVisibleLesson(lesson.content) };
}
