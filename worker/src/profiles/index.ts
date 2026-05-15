import type { Profile } from "./types";
import { profile as skBiopharmKidsS1 } from "./sk-biopharm-kids-s1";

// All known profiles. Add new cohorts here.
const REGISTRY: Profile[] = [skBiopharmKidsS1];

const BY_ID = new Map(REGISTRY.map((p) => [p.id, p]));

export function getProfile(id: string): Profile | null {
  return BY_ID.get(id) ?? null;
}

export function listProfiles(): Profile[] {
  return REGISTRY.slice();
}

export type { Profile };
export { MODEL_MAP } from "./types";
