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
