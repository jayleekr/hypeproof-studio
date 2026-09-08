// #748 (E2) — a frozen lesson may NARROW the features its seat may use.
// Contract: docs/adr/0007-lesson-feature-binding.md.
//
// Deliberately the same shape as lesson-model-policy.ts (#795): validate on
// save, produce a Service binding at freeze, recheck on every read, and project
// the result onto the keys the client already reads. A lesson can only take
// away. It can never grant something the compiled cohort profile withholds —
// that is checked three times, and the last check is at read time so a profile
// that shrinks after the freeze closes the lesson instead of serving a stale
// wider set.
//
// WHERE THIS IS AND IS NOT A BOUNDARY — read this before claiming enforcement.
//
//   /v1/chat/completions (proxy)   The worker composes the upstream tool array
//                                  itself, from the SERVED profile: web_search
//                                  (translate.ts, `web_search_20250305`) and the
//                                  browser loop (BROWSER_TOOLS, gated on
//                                  browser_control.enabled). Narrowing either
//                                  one here removes it from the request the
//                                  provider actually sees. A real boundary.
//
//   /v1/messages (agent-sdk)       The route spreads the client's body and does
//                                  NOT override `tools`. Every workspace tool is
//                                  declared and executed client-side, gated by
//                                  the SDK's canUseTool against what /v1/profile
//                                  served. So the narrowing is real for an
//                                  unmodified client and is NOT a Service
//                                  boundary against a modified one. Server-side
//                                  tool policy on this route is the ADR's
//                                  Phase-2 item; the route's own header comment
//                                  already says so.
//
// Both halves are asserted by tests, including a negative control that pins
// today's /v1/messages passthrough. When the follow-up closes that hole the
// control fails, which is the point: this comment cannot quietly become false.
import type { Profile } from '../profiles/types.ts';

/**
 * The narrowable features. One key per thing an instructor would recognise, so
 * `browser` covers BOTH runtime spellings (`sdk_tools.browser` for the SDK's
 * MCP tools, `browser_control.enabled` for the proxy loop). An instructor
 * should not have to know which route her class runs to turn the browser off.
 */
export const FEATURE_KEYS = ['read', 'write', 'shell', 'subagents', 'browser', 'web_search'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/**
 * 강사에게 보이는 이름. 키 옆에 두는 이유는 하나 — 카탈로그가 늘어날 때 이름을
 * 빠뜨리면 **여기서** 타입 오류가 나야지, 강사 화면에 `subagents` 라는 날것이
 * 떠서는 안 된다. Chalk 는 이 목록을 받아 그리기만 한다.
 */
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  read: '파일 읽기',
  write: '파일 쓰기·수정',
  shell: '터미널 명령 실행',
  subagents: '보조 에이전트',
  browser: '브라우저 사용',
  web_search: '웹 검색',
};

export interface FeatureBinding {
  revision: 'hps-feature-narrowing/1';
  runtime: 'proxy' | 'agent-sdk';
  /** What the compiled profile granted at freeze — the catalogue narrowed FROM. */
  catalogue: FeatureKey[];
  /** Removed keys the Service itself strips from the upstream request on this runtime. */
  removed_enforced: FeatureKey[];
  /** Removed keys that depend on the client honouring what /v1/profile served. */
  removed_client_only: FeatureKey[];
}

export interface LessonFeaturePolicy {
  /**
   * What the lesson KEEPS. An empty array is meaningful and allowed: a
   * chat-only lesson on a cohort that otherwise grants tools.
   */
  allowed: FeatureKey[];
  /** Service-produced at freeze; a draft cannot supply its own binding. */
  binding?: FeatureBinding;
}

/** Which narrowed-away keys the Service removes itself, per runtime. */
const SERVICE_ENFORCED: Record<FeatureBinding['runtime'], readonly FeatureKey[]> = {
  // translate.ts builds the upstream tool array from the served profile.
  proxy: ['web_search', 'browser'],
  // routes/messages.ts spreads the client body and never touches `tools`.
  'agent-sdk': [],
};

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** The catalogue this compiled profile grants, in canonical order. */
export function permittedFeatureKeys(profile: Profile): FeatureKey[] {
  const granted: Record<FeatureKey, boolean> = {
    read: profile.sdk_tools?.read === true,
    write: profile.sdk_tools?.write === true,
    shell: profile.sdk_tools?.shell === true,
    subagents: profile.sdk_tools?.subagents === true,
    // Either spelling counts as "this cohort has the browser".
    browser: profile.sdk_tools?.browser === true || profile.browser_control?.enabled === true,
    web_search: profile.tools?.web_search === true,
  };
  return FEATURE_KEYS.filter(k => granted[k]);
}

export function validateLessonFeatures(value: unknown): string | null {
  if (!object(value) || Object.keys(value).some(k => !['allowed', 'binding'].includes(k))) return 'invalid features fields';
  if (!Array.isArray(value.allowed) || value.allowed.length > FEATURE_KEYS.length
    || value.allowed.some(a => typeof a !== 'string' || !(FEATURE_KEYS as readonly string[]).includes(a))
    || new Set(value.allowed).size !== value.allowed.length) return 'invalid feature selection';
  if ('binding' in value && !object(value.binding)) return 'invalid feature binding';
  return null;
}

/** A lesson may only narrow. Anything outside the cohort's catalogue is refused. */
export function validateFeatureSubset(policy: LessonFeaturePolicy, profile: Profile): string | null {
  const allowed = permittedFeatureKeys(profile);
  return policy.allowed.every(a => allowed.includes(a)) ? null : 'feature is not permitted by the cohort';
}

/**
 * Recorded at freeze so a later change cannot silently reinterpret the lesson.
 * `runtime` mirrors lesson-model-policy's: minors are forced to proxy, which is
 * exactly where the two enforceable keys ARE enforced.
 */
export function featureBinding(profile: Profile, policy: LessonFeaturePolicy): FeatureBinding {
  const runtime: FeatureBinding['runtime'] = profile.minor_cohort ? 'proxy' : profile.coach_runtime ?? 'proxy';
  const catalogue = permittedFeatureKeys(profile);
  const removed = catalogue.filter(k => !policy.allowed.includes(k));
  const enforced = SERVICE_ENFORCED[runtime];
  return {
    revision: 'hps-feature-narrowing/1',
    runtime,
    catalogue,
    removed_enforced: removed.filter(k => enforced.includes(k)),
    removed_client_only: removed.filter(k => !enforced.includes(k)),
  };
}

/**
 * Re-derive and compare on every read. A profile whose grants moved after the
 * freeze produces a different binding, so the lesson refuses to open rather
 * than serving the set the instructor last saw.
 */
export function lessonFeaturesAreCurrent(profile: Profile, policy: LessonFeaturePolicy): boolean {
  if (validateLessonFeatures(policy) || validateFeatureSubset(policy, profile) || !policy.binding) return false;
  try { return JSON.stringify(policy.binding) === JSON.stringify(featureBinding(profile, policy)); }
  catch { return false; }
}

/**
 * Derived only from a verified, frozen lesson. Every field can only go from
 * true to false: `&&` with the profile's own grant, never `||`, so no path here
 * can turn a feature ON. Absent sub-objects stay absent — a cohort with no
 * `sdk_tools` already grants nothing and does not need an all-false object.
 */
export function applyLessonFeatures(profile: Profile, policy: LessonFeaturePolicy): Profile {
  const keep = new Set<FeatureKey>(policy.allowed);
  const sdk = profile.sdk_tools;
  const browserLoop = profile.browser_control;
  return {
    ...profile,
    tools: { ...profile.tools, web_search: profile.tools?.web_search === true && keep.has('web_search') },
    ...(sdk ? {
      sdk_tools: {
        ...sdk,
        read: sdk.read === true && keep.has('read'),
        write: sdk.write === true && keep.has('write'),
        shell: sdk.shell === true && keep.has('shell'),
        subagents: sdk.subagents === true && keep.has('subagents'),
        browser: sdk.browser === true && keep.has('browser'),
      },
    } : {}),
    ...(browserLoop ? {
      browser_control: { ...browserLoop, enabled: browserLoop.enabled === true && keep.has('browser') },
    } : {}),
  };
}
