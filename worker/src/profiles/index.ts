import type { Profile } from "./types";
import { profile as skBiopharmKidsS1 } from "./sk-biopharm-kids-s1.ts";
import { profile as boahDentalTeaserS1 } from "./boah-dental-teaser-2026-s1.ts";
import { profile as skBiopharmKids2026Grade56S1 } from "./sk-biopharm-kids-2026-grade-5-6-s1.ts";
import { profile as boahDentalDirectorCopycloneS1 } from "./boah-dental-director-copyclone-2026-s1.ts";
// Synthetic — CI-only gateway contract canary (#406). Empty roster, hidden
// from the instructor console; see the file header for why it exists.
import { profile as canarySdkContract } from "./canary-sdk-contract.ts";
import { profile as homepagePractice } from "./homepage-practice-s1.ts";
import { profile as nativeTrial } from "./studio-native-trial.ts";
import { profile as gptPractice } from "./studio-gpt-practice.ts";
import { profile as modelPractice } from "./studio-model-practice.ts";

// All known profiles. Add new cohorts here.
const REGISTRY: Profile[] = [
  skBiopharmKidsS1,
  boahDentalTeaserS1,
  skBiopharmKids2026Grade56S1,
  boahDentalDirectorCopycloneS1,
  canarySdkContract,
  homepagePractice,
  nativeTrial,
  gptPractice,
  modelPractice,
];

const BY_ID = new Map(REGISTRY.map((p) => [p.id, p]));

export function getProfile(id: string): Profile | null {
  return BY_ID.get(id) ?? null;
}

export function listProfiles(): Profile[] {
  return REGISTRY.slice();
}

export type { Profile };
export { MODEL_MAP } from "./types.ts";
