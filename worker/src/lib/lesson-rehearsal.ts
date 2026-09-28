// #1012 · #751 G2 — learner-condition rehearsal of ONE immutable candidate version, judged from two independent records:
//
//   the App's report   what the learner's Studio actually offered for each step (help choices, work surface) and which
//                      App/SDK identity did it — the App's own attestation, sent with the rehearsal code
//   the Service's own  every model request admitted with that code: under which lesson digest, which step and help mode
//   request records    the Service resolved, which tool names the request carried, and how it ended upstream
//
// A pass needs both to agree with the candidate. Issuing the code, freezing the version, or a ping is never a pass, and a
// candidate edited while its rehearsal ran is a different version with its own (empty) record: readiness is keyed by
// (version, sha256), so nothing can be inherited by the edited draft.
//
// Teaching strategy (help), work surface (ui) and tool grants stay three separate things, as in lesson-help-mode.ts,
// learning-design.ts and lesson-feature-policy.ts. Nothing here grants, widens or stores a capability.
import type { Profile } from '../profiles/types';
import { permittedFeatureKeys } from './lesson-feature-policy';
import type { SessionDesign } from './session-design';
import { HELP_MODES } from './lesson-help-mode';
import { sha256Hex } from './modules';

/** Work surfaces the current Studio renders for a step (G2). Others remain valid data but a rehearsal reports them unsupported. */
export const AUTHORABLE_STEP_UI = ['criterion_form', 'decision_form'] as const;
/** A step without `ui` opens the ordinary coach conversation. */
export const DEFAULT_SURFACE = 'chat';
export const REHEARSAL_HOURS = 4;
export const REHEARSAL_REPORT_MAX = 16 * 1024;

// Tool names the Studio Agent SDK runtime exposes per grant (extensions/hypeproof-chat/src/sdkCoachHelpers.ts permittedToolsFor).
// Used only to READ a recorded request: a write-restricted lesson whose request still carried a write tool is a failure.
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const SHELL_TOOLS = ['Bash'];
const SEARCH_TOOLS = ['WebSearch', 'WebFetch'];

export type RehearsalState = 'not_run' | 'running' | 'expired' | 'passed' | 'failed' | 'unsupported' | 'stale';

export interface ExpectedStep { id: string; help: { default: string; allowed: string[] } | null; surface: string }
export const expectedSteps = (c: SessionDesign): ExpectedStep[] => c.steps.map((s) => ({
  id: s.id,
  help: s.help ? { default: s.help.default, allowed: [...s.help.allowed].sort() } : null,
  surface: typeof s.ui === 'string' ? s.ui : DEFAULT_SURFACE,
}));

/**
 * What the candidate's readiness depends on besides its own bytes: the grants of the profile it runs on and the Service
 * bindings frozen into it. If any of these changes after a pass, the pass is shown as stale (never silently reused).
 */
export async function policyDigest(profile: Profile, content: SessionDesign): Promise<string> {
  return sha256Hex(JSON.stringify([
    profile.id, profile.coach_runtime ?? '', permittedFeatureKeys(profile).sort(),
    content.features?.binding ?? null, content.model?.binding ?? null,
  ]));
}

/**
 * #751 G2 mission — what the learner's mission header (MissionHeader.tsx) DREW, read back from the rendered DOM: the week line,
 * the mission sentence and the completion conditions, as text. Optional in the schema only so an older App's report still
 * parses; a candidate that HAS a mission cannot pass without it (mission_not_reported).
 */
export interface RenderedMission { week: string | null; sentence: string; completion: string[] }
export interface RehearsalReport {
  schema: 'hps-rehearsal-report/1';
  app: { extension_version: string; host: string; runtime: string; sdk?: string; os: string; arch: string };
  steps: Array<{ id: string; visited: boolean; help_offered: string[]; help_default: string | null; surface: string }>;
  mission?: RenderedMission;
}
/** The header a candidate must draw: exactly MissionHeader's text for its `learning`, or null when it has none. */
export const expectedMission = (c: SessionDesign): RenderedMission | null => c.learning
  ? { week: c.learning.week + '주차', sentence: c.learning.mission, completion: (c.learning.completion ?? []).map((x) => x.text) } : null;
const id = (x: unknown) => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(x);
const short = (x: unknown, max = 120) => typeof x === 'string' && x.length <= max && !/[\u0000-\u001f]/.test(x);
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function parseReport(x: unknown): RehearsalReport | string {
  if (!object(x) || x.schema !== 'hps-rehearsal-report/1') return 'unsupported report schema';
  const a = x.app;
  if (!object(a) || !['extension_version', 'host', 'runtime', 'os', 'arch'].every((k) => short(a[k])) || (a.sdk !== undefined && !short(a.sdk))) return 'invalid app identity';
  if (!Array.isArray(x.steps) || !x.steps.length || x.steps.length > 30) return 'steps must list 1..30 items';
  const seen = new Set<string>();
  for (const s of x.steps) {
    if (!object(s) || !id(s.id) || seen.has(s.id as string) || typeof s.visited !== 'boolean') return 'invalid step entry';
    seen.add(s.id as string);
    if (!Array.isArray(s.help_offered) || s.help_offered.length > HELP_MODES.length || !s.help_offered.every((m) => (HELP_MODES as readonly string[]).includes(m as string))) return 'invalid help_offered';
    if (s.help_default !== null && !(HELP_MODES as readonly string[]).includes(s.help_default as string)) return 'invalid help_default';
    if (!short(s.surface, 64)) return 'invalid surface';
  }
  if (x.mission !== undefined) {
    const m = x.mission;
    // Drawn text may hold a line break the teacher typed; only NUL and oversize are refused.
    const text = (t: unknown) => typeof t === 'string' && t.length <= 240 && !t.includes('\0');
    if (!object(m) || !(m.week === null || short(m.week, 20)) || !text(m.sentence) || !Array.isArray(m.completion) || m.completion.length > 10 || !m.completion.every(text)) return 'invalid mission';
  }
  return x as unknown as RehearsalReport;
}

export interface RehearsalTurn { request_id: string; lesson_sha256: string; step_id: string; help_receipt: string; runtime: string; tool_names: string[]; outcome: string }
export interface Verdict {
  verdict: 'passed' | 'failed' | 'unsupported';
  reasons: string[];
  checks: {
    steps: Array<{ id: string; visited: boolean; help: 'match' | 'mismatch' | 'none' | 'not_seen'; surface: 'match' | 'mismatch' | 'unsupported' | 'not_seen'; expected_surface: string }>;
    turns: { total: number; completed: number; with_step: number; other_lesson: number; help_modes: string[] };
    /** `none` = the candidate has no mission, so no mission-linked claim is made either way. */
    mission: { expected: RenderedMission | null; observed: RenderedMission | null; result: 'match' | 'mismatch' | 'not_reported' | 'none' };
    tools: { runtime: string; observed: string[]; boundary: 'held' | 'violated' | 'server_enforced' | 'not_observed'; write_expected: boolean };
  };
}

/**
 * Judge one report against the candidate and the Service's own request records. Pure: the caller loads rows and stores
 * the result once. `unsupported` wins over `failed` only where the App itself said it cannot render a surface; any
 * disagreement about what was offered, a missing completed request or a crossed tool boundary is a failure.
 */
export function judgeRehearsal(o: { content: SessionDesign; lessonSha: string; profile: Profile; report: RehearsalReport; turns: RehearsalTurn[] }): Verdict {
  const reasons: string[] = [];
  const want = expectedSteps(o.content), got = new Map(o.report.steps.map((s) => [s.id, s]));
  const steps = want.map((w) => {
    const r = got.get(w.id);
    // A step the learner never opened is one reason (steps_not_visited), not also a help or surface disagreement.
    if (!r?.visited) return { id: w.id, visited: false, help: 'not_seen' as const, surface: 'not_seen' as const, expected_surface: w.surface };
    const offered = [...r.help_offered].sort();
    const help: 'match' | 'mismatch' | 'none' = !w.help ? (offered.length ? 'mismatch' : 'none')
      : JSON.stringify(offered) === JSON.stringify(w.help.allowed) && r.help_default === w.help.default ? 'match' : 'mismatch';
    const surface: 'match' | 'mismatch' | 'unsupported' = r.surface === w.surface ? 'match' : r.surface === 'unsupported:' + w.surface ? 'unsupported' : 'mismatch';
    return { id: w.id, visited: true, help, surface, expected_surface: w.surface };
  });
  const extra = o.report.steps.filter((s) => !want.some((w) => w.id === s.id)).map((s) => s.id);
  if (extra.length) reasons.push('steps_not_in_candidate');
  if (steps.some((s) => !s.visited)) reasons.push('steps_not_visited');
  if (steps.some((s) => s.help === 'mismatch')) reasons.push('help_mismatch');
  if (steps.some((s) => s.surface === 'mismatch')) reasons.push('surface_mismatch');
  const unsupported = steps.some((s) => s.surface === 'unsupported');

  // The mission the learner's screen showed must be the candidate's own, word for word. A stale header (another version's
  // mission), a missing one, or an App that does not read it back cannot pass a candidate that has a mission.
  const wantMission = expectedMission(o.content), m = o.report.mission, sawMission = m ? { week: m.week, sentence: m.sentence, completion: [...m.completion] } : null;
  const missionResult: Verdict['checks']['mission']['result'] = wantMission
    ? (!sawMission ? 'not_reported' : JSON.stringify(sawMission) === JSON.stringify(wantMission) ? 'match' : 'mismatch')
    : (sawMission && (sawMission.week !== null || sawMission.completion.length) ? 'mismatch' : 'none');
  if (missionResult === 'not_reported') reasons.push('mission_not_reported');
  if (missionResult === 'mismatch') reasons.push('mission_mismatch');

  const mine = o.turns.filter((t) => t.lesson_sha256 === o.lessonSha), completed = mine.filter((t) => t.outcome === 'completed');
  const turns = { total: o.turns.length, completed: completed.length, with_step: completed.filter((t) => t.step_id).length, other_lesson: o.turns.length - mine.length,
    help_modes: [...new Set(completed.map((t) => /mode=([a-z_]+)/.exec(t.help_receipt)?.[1]).filter((m): m is string => !!m))].sort() };
  if (turns.other_lesson) reasons.push('other_lesson_requests');
  if (!turns.completed) reasons.push('no_completed_request');
  else if (!turns.with_step) reasons.push('step_not_sent');

  const runtime = completed[0]?.runtime ?? '';
  const observed = [...new Set(completed.flatMap((t) => t.tool_names))].sort();
  const keys = new Set(permittedFeatureKeys(o.profile).filter((k) => !o.content.features || o.content.features.allowed.includes(k)));
  const writeExpected = keys.has('write');
  let boundary: Verdict['checks']['tools']['boundary'] = 'not_observed';
  if (runtime === 'proxy') boundary = 'server_enforced';
  else if (runtime === 'agent-sdk' && completed.length) {
    const has = (names: string[]) => observed.some((n) => names.includes(n));
    const violated = (!writeExpected && has(WRITE_TOOLS)) || (!keys.has('shell') && has(SHELL_TOOLS)) || (!keys.has('web_search') && has(SEARCH_TOOLS))
      || (!keys.has('read') && has(['Read', 'Grep', 'Glob']));
    // A lesson that keeps writing must actually carry a write tool to the model; otherwise the learner could not do the task.
    const missing = writeExpected && !has(WRITE_TOOLS);
    boundary = violated || missing ? 'violated' : 'held';
    if (violated) reasons.push('tool_boundary_crossed');
    if (missing) reasons.push('allowed_tool_missing');
  }
  const failed = reasons.length > 0;
  return { verdict: failed ? 'failed' : unsupported ? 'unsupported' : 'passed', reasons: unsupported && !failed ? ['surface_unsupported'] : reasons,
    checks: { steps, turns, mission: { expected: wantMission, observed: sawMission, result: missionResult }, tools: { runtime, observed, boundary, write_expected: writeExpected } } };
}

/** The readiness a version shows NOW, from its latest rehearsal row and the current policy digest. */
export function rehearsalState(row: { verdict: string | null; expires_at: number; policy_digest: string } | null, o: { now: number; currentDigest: string | null }): RehearsalState {
  if (!row) return 'not_run';
  if (!row.verdict) return row.expires_at <= o.now ? 'expired' : 'running';
  if (row.verdict === 'passed' && o.currentDigest !== null && o.currentDigest !== row.policy_digest) return 'stale';
  return row.verdict as RehearsalState;
}

/** Tool names a model request carried (Anthropic Messages or OpenAI chat shape). Names only, bounded. */
export function requestToolNames(body: unknown): string[] {
  if (!object(body) || !Array.isArray(body.tools)) return [];
  const names = body.tools.map((t) => object(t) ? (typeof t.name === 'string' ? t.name : object(t.function) && typeof t.function.name === 'string' ? t.function.name : typeof t.type === 'string' ? t.type : '') : '')
    .filter((n) => typeof n === 'string' && n.length > 0 && n.length <= 80);
  return [...new Set(names)].sort().slice(0, 64);
}
