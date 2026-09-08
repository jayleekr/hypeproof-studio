// One Service contract for catalogue, frozen lessons and both request routes.
import { supportedEffort, stripModelGatedParams } from './model-caps.ts';
import type { Profile } from '../profiles/types.ts';

export const COURSE_EFFORT = ['low', 'medium', 'high'] as const;
export type CourseEffort = typeof COURSE_EFFORT[number];
export interface EffortPolicy { default: CourseEffort; allowed: CourseEffort[] }
export interface EffortReceipt {
  requested: CourseEffort | null;
  applied: CourseEffort | null;
  reason: 'selected' | 'course_default' | 'unsupported_model';
}
export const isCourseEffort = (v: unknown): v is CourseEffort => COURSE_EFFORT.includes(v as CourseEffort);
export function validateEffortPolicy(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'invalid effort policy';
  const p = v as EffortPolicy;
  return Object.keys(p).some(k => !['default','allowed'].includes(k)) || !isCourseEffort(p.default)
    || !Array.isArray(p.allowed) || !p.allowed.length || p.allowed.some(x => !isCourseEffort(x))
    || new Set(p.allowed).size !== p.allowed.length || !p.allowed.includes(p.default)
    ? 'invalid effort selection' : null;
}
export function cohortEffort(profile: Profile): EffortPolicy | undefined {
  return profile.minor_cohort ? undefined : profile.model.effort;
}
export function effortForModel(profile: Profile, model: string, provider: string, policy = cohortEffort(profile)) {
  if (!policy || provider !== 'anthropic') return undefined;
  const allowed = COURSE_EFFORT.filter(e => policy.allowed.includes(e) && supportedEffort(model).includes(e));
  return allowed.includes(policy.default) ? { default: policy.default, allowed } : undefined;
}
export class EffortPolicyError extends Error {}
/** Explicit client header is a choice, never a grant. Old clients use the course default. */
export function applyRequestEffort(body: Record<string, unknown>, profile: Profile, model: string, requested?: string) {
  const policy = cohortEffort(profile);
  if (!policy) {
    if (requested !== undefined) throw new EffortPolicyError('이 수업에서는 처리 수준을 변경할 수 없습니다.');
    return { body, receipt: undefined };
  }
  if (requested !== undefined && (!isCourseEffort(requested) || !policy.allowed.includes(requested)))
    throw new EffortPolicyError('수업에서 허용하지 않은 처리 수준입니다. 설정을 다시 확인하세요.');
  const supported = effortForModel(profile, model, 'anthropic');
  const applied = supported ? (requested as CourseEffort | undefined) ?? supported.default : null;
  const config = body.output_config && typeof body.output_config === 'object' && !Array.isArray(body.output_config)
    ? { ...(body.output_config as Record<string, unknown>) } : {};
  if (applied) config.effort = applied;
  else delete config.effort;
  const out: Record<string, unknown> = { ...body, output_config: config };
  // Per-message effort must not override the frozen course policy.
  if (Array.isArray(body.messages)) out.messages = body.messages.map(m => {
    if (!m || typeof m !== 'object') return m;
    const copy = { ...m }; delete copy.output_config; return copy;
  });
  const normalized = stripModelGatedParams(out, model);
  const actual = (normalized.body.output_config as Record<string, unknown> | undefined)?.effort;
  if ((actual ?? null) !== applied) throw new EffortPolicyError('모델의 처리 수준이 수업 설정과 맞지 않습니다. 강사에게 알려주세요.');
  const receipt: EffortReceipt = { requested: requested as CourseEffort | undefined ?? null, applied,
    reason: !supported ? 'unsupported_model' : requested ? 'selected' : 'course_default' };
  return { body: normalized.body, receipt };
}
