import type { ResolvedProfile } from './protocol';
import { resolveCoachRuntime } from './chatPanelHelpers.ts';

export type ModelSelection = NonNullable<ResolvedProfile['model_selection']>;
export interface SavedModelChoice { scope: string; alias: string }

export function modelSelectionScope(profile: ResolvedProfile): string {
  return JSON.stringify([profile.profile_id, profile.lesson?.sha256 ?? null, profile.model_selection]);
}

export function availableModelSelection(profile: ResolvedProfile | null, settingRuntime: 'proxy' | 'agent-sdk'): ModelSelection | undefined {
  const model = profile?.model_selection;
  if (!profile || !model || !model.choices.length || (profile.minor_cohort && model.runtime === 'agent-sdk')) return undefined;
  const runtime = resolveCoachRuntime({ settingRuntime, profileRuntime: profile.coach_runtime, minorCohort: profile.minor_cohort });
  // Frozen lesson runtime is binding; old profiles with a machine override keep their existing behavior.
  return model.source === 'lesson' || model.runtime === runtime ? model : undefined;
}

export function selectedModel(profile: ResolvedProfile, selection: ModelSelection, saved: SavedModelChoice | undefined, setting: string): string {
  const requested = saved?.scope === modelSelectionScope(profile) ? saved.alias : selection.source === 'lesson' ? selection.default : setting;
  return selection.choices.find(c => c.alias === requested || c.id === requested)?.alias ?? selection.default;
}

export interface SavedEffortChoice { scope: string; model: string; value: import('./protocol').CourseEffort }
export function selectedEffort(profile: ResolvedProfile, selection: ModelSelection, model: string, saved?: SavedEffortChoice) {
  const policy = selection.choices.find(c => c.alias === model)?.effort;
  if (!policy?.allowed.length || !policy.allowed.includes(policy.default)) return undefined;
  const value = saved?.scope === modelSelectionScope(profile) && saved.model === model && policy.allowed.includes(saved.value)
    ? saved.value : policy.default;
  return { value, allowed: policy.allowed };
}

/** Unknown/malformed Service data cannot become a claim of applied settings. */
export function observedEffortResult(data: unknown): import('./protocol').ChatConfig['effortResult'] {
  const unknown = { state: 'unknown' as const, requests: [] };
  if (!data || typeof data !== 'object') return unknown;
  const { requests, truncated } = data as Record<string, unknown>;
  const level = (v: unknown) => v === null || ['low', 'medium', 'high'].includes(v as string);
  if (!Array.isArray(requests) || !requests.length || requests.length > 100 || typeof truncated !== 'boolean') return unknown;
  if (!requests.every(r => r && typeof r === 'object' && typeof r.request_id === 'string'
    && typeof r.model === 'string' && level(r.requested) && level(r.applied)
    && ['selected', 'course_default', 'unsupported_model'].includes(r.reason)
    && Number.isInteger(r.status) && r.status >= 100 && r.status <= 599
    && typeof r.created_at === 'string')) return unknown;
  return { state: 'observed', requests, truncated };
}
