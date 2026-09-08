import { getProfile } from '../profiles';
import { lessonModelIsCurrent } from './lesson-model-policy';
import type { Env } from '../env';
import type { TokenPayload } from './tokens';
import { isModuleVersion, validateModuleDoc } from './modules';
import { validateSessionDesign, type SessionDesign } from './session-design';

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
  if (content.model) {
    const current = getProfile(profile);
    if (!current || !lessonModelIsCurrent(env, current, content.model)) return null;
  }
  return { course_id: course, version, sha256: result.doc.sha256, content: result.doc.content as unknown as SessionDesign };
}

/** A missing/broken signed lesson never falls back to another class or draft. */
export async function resolveTokenLesson(env: Env, p: TokenPayload) {
  if (!p.lesson) return null;
  const ref = p.lesson;
  if (typeof ref.course_id !== 'string' || typeof ref.version !== 'string' || typeof ref.sha256 !== 'string') return null;
  const lesson = await readLesson(env, p.c, ref.course_id, ref.version, p.p);
  return lesson?.sha256 === ref.sha256 ? lesson : null;
}
