import { cohortEffort, effortForModel, validateEffortPolicy, type EffortPolicy } from './model-effort.ts';
import { resolveProvider, type Env, type LLMProvider } from '../env.ts';
import { MODEL_MAP, ANTHROPIC_MODELS, modelIdFor, permittedModelKeys, type ModelKey, type Profile } from '../profiles/types.ts';

export interface ModelChoice { alias: ModelKey; id: string; label: string }
export interface ModelBinding {
  revision: 'hps-model-selection/1';
  runtime: 'proxy' | 'agent-sdk';
  provider: LLMProvider;
  choices: ModelChoice[];
  effort?: { revision: 'hps-effort/1'; choices: Array<{ id: string; policy: EffortPolicy | null }> };
}
export interface LessonModelPolicy {
  effort?: EffortPolicy;
  default: ModelKey;
  allowed: ModelKey[];
  /** Service-produced at freeze; a draft cannot supply its own binding. */
  binding?: ModelBinding;
}
const aliases = [...Object.keys(MODEL_MAP), ...Object.keys(ANTHROPIC_MODELS)];
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function validateLessonModel(value: unknown): string | null {
  if (!object(value) || Object.keys(value).some(k => !['default', 'allowed', 'binding', 'effort'].includes(k))) return 'invalid model fields';
  if (typeof value.default !== 'string' || !aliases.includes(value.default) || !Array.isArray(value.allowed)
    || value.allowed.length < 1 || value.allowed.length > Object.keys(ANTHROPIC_MODELS).length || value.allowed.some(a => !aliases.includes(a))
    || new Set(value.allowed).size !== value.allowed.length || !value.allowed.includes(value.default)) return 'invalid model selection';
  if ('effort' in value && validateEffortPolicy(value.effort)) return 'invalid effort selection';
  if ('binding' in value && !object(value.binding)) return 'invalid model binding';
  return null;
}

export function validateModelSubset(policy: LessonModelPolicy, profile: Profile): string | null {
  if (policy.effort) {
    const ceiling = cohortEffort(profile);
    if (!ceiling || policy.effort.allowed.some(e => !ceiling.allowed.includes(e))) return 'effort is not permitted by the cohort';
  }
  const allowed = permittedModelKeys(profile);
  return policy.allowed.every(a => allowed.includes(a)) ? null : 'model is not permitted by the cohort';
}

/** Same provider resolution and pins as the existing execution routes; no new catalogue store. */
export function modelBinding(env: Env, profile: Profile, policy?: LessonModelPolicy): ModelBinding {
  const runtime = profile.minor_cohort ? 'proxy' : profile.coach_runtime ?? 'proxy';
  const provider = runtime === 'agent-sdk' ? 'anthropic' : profile.model.provider ?? resolveProvider(env).provider;
  const allowed = policy?.allowed ?? permittedModelKeys(profile);
  const first = policy?.default ?? profile.model.default;
  const ordered = [first, ...allowed.filter(a => a !== first)];
  // Alias synonyms are one actual choice. The original aliases still get validated by the Service.
  const seen = new Set<string>();
  const choices = ordered.flatMap(alias => {
    const id = modelIdFor(alias, provider);
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ alias, id, label: (ANTHROPIC_MODELS as Record<string, string>)[id] ?? id }];
  });
  return { revision: 'hps-model-selection/1', runtime, provider, choices,
    ...(policy?.effort ? { effort: { revision: 'hps-effort/1' as const,
      choices: choices.map(c => ({ id: c.id, policy: effortForModel(profile, c.id, provider, policy.effort) ?? null })) } } : {}),
  };
}

export function lessonModelIsCurrent(env: Env, profile: Profile, policy: LessonModelPolicy): boolean {
  if (validateLessonModel(policy) || validateModelSubset(policy, profile) || !policy.binding) return false;
  try { return JSON.stringify(policy.binding) === JSON.stringify(modelBinding(env, profile, policy)); }
  catch { return false; }
}

/** Derived only from a verified, frozen lesson. No new tool or role grant. */
export function applyLessonModel(profile: Profile, policy: LessonModelPolicy): Profile {
  return { ...profile, model: {
    ...profile.model, ...(policy.effort ? { effort: policy.effort } : {}), default: policy.default, allowed: [...policy.allowed],
    fallback: policy.allowed.find(a => a !== policy.default), lesson_locked: true,
  } };
}

export function servedModelSelection(env: Env, profile: Profile, policy?: LessonModelPolicy) {
  try {
    const binding = modelBinding(env, profile, policy);
    return { ...binding, choices: binding.choices.map(c => ({ ...c, effort: effortForModel(profile, c.id, binding.provider, policy?.effort ?? cohortEffort(profile)) })), default: policy?.default ?? profile.model.default, source: policy ? 'lesson' as const : 'profile' as const };
  } catch { return undefined; } // Old/unconfigured Service environments retain their previous profile response.
}
