import { resolveProvider, type Env, type LLMProvider } from '../env.ts';
import { MODEL_MAP, GEMINI_MODEL_MAP, OPENAI_MODEL_MAP, GLM_MODEL_MAP, type ModelAlias, type Profile } from '../profiles/types.ts';

export interface ModelChoice { alias: ModelAlias; id: string; label: string }
export interface ModelBinding {
  revision: 'hps-model-selection/1';
  runtime: 'proxy' | 'agent-sdk';
  provider: LLMProvider;
  choices: ModelChoice[];
}
export interface LessonModelPolicy {
  default: ModelAlias;
  allowed: ModelAlias[];
  /** Service-produced at freeze; a draft cannot supply its own binding. */
  binding?: ModelBinding;
}
const aliases = ['hypeproof-default', 'hypeproof-fast', 'hypeproof-strong'];
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function validateLessonModel(value: unknown): string | null {
  if (!object(value) || Object.keys(value).some(k => !['default', 'allowed', 'binding'].includes(k))) return 'invalid model fields';
  if (typeof value.default !== 'string' || !aliases.includes(value.default) || !Array.isArray(value.allowed)
    || value.allowed.length < 1 || value.allowed.length > 2 || value.allowed.some(a => !aliases.includes(a))
    || new Set(value.allowed).size !== value.allowed.length || !value.allowed.includes(value.default)) return 'invalid model selection';
  if ('binding' in value && !object(value.binding)) return 'invalid model binding';
  return null;
}

export function validateModelSubset(policy: LessonModelPolicy, profile: Profile): string | null {
  const allowed = [profile.model.default, profile.model.fallback];
  return policy.allowed.every(a => allowed.includes(a)) ? null : 'model is not permitted by the cohort';
}

const labels: Record<string, string> = {
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
  'claude-opus-4-7': 'Claude Opus 4.7',
};

/** Same provider resolution and pins as the existing execution routes; no new catalogue store. */
export function modelBinding(env: Env, profile: Profile, policy?: LessonModelPolicy): ModelBinding {
  const runtime = profile.minor_cohort ? 'proxy' : profile.coach_runtime ?? 'proxy';
  const provider = runtime === 'agent-sdk' ? 'anthropic' : profile.model.provider ?? resolveProvider(env).provider;
  const map = { anthropic: MODEL_MAP, gemini: GEMINI_MODEL_MAP, openai: OPENAI_MODEL_MAP, glm: GLM_MODEL_MAP }[provider];
  const allowed = policy?.allowed ?? [profile.model.default, ...(profile.model.fallback ? [profile.model.fallback] : [])];
  const first = policy?.default ?? profile.model.default;
  const ordered = [first, ...allowed.filter(a => a !== first)];
  // Alias synonyms are one actual choice. The original aliases still get validated by the Service.
  const seen = new Set<string>();
  const choices = ordered.flatMap(alias => {
    const id = map[alias];
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ alias, id, label: labels[id] ?? id }];
  });
  return { revision: 'hps-model-selection/1', runtime, provider, choices };
}

export function lessonModelIsCurrent(env: Env, profile: Profile, policy: LessonModelPolicy): boolean {
  if (validateLessonModel(policy) || validateModelSubset(policy, profile) || !policy.binding) return false;
  try { return JSON.stringify(policy.binding) === JSON.stringify(modelBinding(env, profile, policy)); }
  catch { return false; }
}

/** Derived only from a verified, frozen lesson. No new tool or role grant. */
export function applyLessonModel(profile: Profile, policy: LessonModelPolicy): Profile {
  return { ...profile, model: {
    ...profile.model, default: policy.default,
    fallback: policy.allowed.find(a => a !== policy.default), lesson_locked: true,
  } };
}

export function servedModelSelection(env: Env, profile: Profile, policy?: LessonModelPolicy) {
  try {
    return { ...modelBinding(env, profile, policy), default: policy?.default ?? profile.model.default, source: policy ? 'lesson' as const : 'profile' as const };
  } catch { return undefined; } // Old/unconfigured Service environments retain their previous profile response.
}
