// Participant evidence, read (cr-evidence #1394; CR-25, CR-27, CR-28, CR-72, CR-74).
//
// Pure views over what the measurement-core record already holds for one experiment: its
// participant session links, their events and the student's manual records. Nothing here is
// stored, and nothing here is a score (SX-48): every function reads records and answers with
// counts that cite those records, computed again on every read, so a view can never drift
// from its sources. Counts are of sessions and device pseudonyms, never of people (CR-72).
//
// Imports: types only, plus the draft item shape from interpretation.ts.
import type { ObservationEvent } from "./legacy-observation.ts";
import type { DraftItem, EvidenceDraft } from "./interpretation.ts";

/** One participant session link as `LocalRecord.sessionLinks` reads it. */
export interface SessionLinkView {
  session_id: string;
  task: string;
  attribution: { project: string; experiment: string; product_version: string; link?: string; channel?: string; variant?: string } | null;
  at?: number;
  pseudonym?: string;
}

/** What one participant session did, read from its events. */
export interface ParticipantSession {
  session_id: string;
  /** When the session was opened on the Service (its link record), else its first event. */
  at: number;
  pseudonym: string | null;
  variant: string | null;
  channel: string | null;
  product_version: string | null;
  events: number;
  pages: number;
  clicks: number;
  inputs: number;
  /** Per task label: started and/or completed in this session. */
  tasks: Record<string, { started: boolean; completed: boolean }>;
  milestones: string[];
  /** Event ids of this session, for references (`event:<session>/<id>`). */
  event_ids: string[];
}

export const sessionRef = (sessionId: string) => `session:${sessionId}`;
export const noteRef = (eventId: string) => `note:${eventId}`;

/** The experiment's sessions, oldest first. A session with no link record is not a session of this experiment. */
export function participantSessions(experimentId: string, links: readonly SessionLinkView[], events: readonly ObservationEvent[]): ParticipantSession[] {
  const bySession = new Map<string, ObservationEvent[]>();
  for (const e of events) {
    const sid = e.participant?.session_id;
    if (!sid || e.task !== experimentId) continue;
    (bySession.get(sid) ?? bySession.set(sid, []).get(sid)!).push(e);
  }
  const out: ParticipantSession[] = [];
  for (const l of links) {
    if (l.task !== experimentId) continue;
    const evs = (bySession.get(l.session_id) ?? []).sort((a, b) => a.seq - b.seq);
    const tasks: ParticipantSession["tasks"] = {};
    const milestones: string[] = [];
    for (const e of evs) {
      if ((e.kind === "task_start" || e.kind === "task_complete") && e.label) {
        const t = (tasks[e.label] ??= { started: false, completed: false });
        if (e.kind === "task_start") t.started = true;
        else t.completed = true;
      }
      if (e.kind === "milestone" && e.label && !milestones.includes(e.label)) milestones.push(e.label);
    }
    out.push({
      session_id: l.session_id,
      at: l.at ?? evs[0]?.at ?? 0,
      pseudonym: l.pseudonym ?? evs.find((e) => e.participant?.pseudonym)?.participant?.pseudonym ?? null,
      variant: l.attribution?.variant ?? null,
      channel: l.attribution?.channel ?? null,
      product_version: l.attribution?.product_version ?? null,
      events: evs.length,
      pages: evs.filter((e) => e.kind === "page_view").length,
      clicks: evs.filter((e) => e.kind === "click").length,
      inputs: evs.filter((e) => e.kind === "input").length,
      tasks,
      milestones,
      event_ids: evs.map((e) => e.id),
    });
  }
  return out.sort((a, b) => a.at - b.at || a.session_id.localeCompare(b.session_id));
}

// ── CR-72 — returning sessions ────────────────────────────────────────────────

export interface DeviceReturns {
  /** The device pseudonym; never a person (CR-72). */
  pseudonym: string;
  sessions: Array<{ session_id: string; at: number; completed: string[] }>;
  return_count: number;
  /** Time between consecutive sessions, in order. */
  intervals_ms: number[];
  source_refs: string[];
}

export type ReturnEvidence =
  | { status: "not_measured"; reason: "not_declared" }
  | { status: "measured"; basis: "per_device_pseudonym"; devices: DeviceReturns[]; sessions_without_pseudonym: number };

/**
 * Return counts and intervals per device pseudonym (CR-72), only for an experiment that
 * declared repeated-use measurement; otherwise "not measured", never zero (SX-33). Grouped
 * within this experiment only: a pseudonym is scoped to one experiment, and sessions of
 * another experiment are never in `sessions` (they are another task).
 */
export function returnEvidence(declarations: { repeated_use?: true } | undefined, sessions: readonly ParticipantSession[]): ReturnEvidence {
  if (declarations?.repeated_use !== true) return { status: "not_measured", reason: "not_declared" };
  const by = new Map<string, ParticipantSession[]>();
  let without = 0;
  for (const s of sessions) {
    if (!s.pseudonym) {
      without++;
      continue;
    }
    (by.get(s.pseudonym) ?? by.set(s.pseudonym, []).get(s.pseudonym)!).push(s);
  }
  const devices: DeviceReturns[] = [];
  for (const [pseudonym, list] of by) {
    const ordered = [...list].sort((a, b) => a.at - b.at);
    devices.push({
      pseudonym,
      sessions: ordered.map((s) => ({ session_id: s.session_id, at: s.at, completed: Object.entries(s.tasks).filter(([, t]) => t.completed).map(([k]) => k) })),
      return_count: ordered.length - 1,
      intervals_ms: ordered.slice(1).map((s, i) => s.at - ordered[i]!.at),
      source_refs: ordered.map((s) => sessionRef(s.session_id)),
    });
  }
  return { status: "measured", basis: "per_device_pseudonym", devices: devices.sort((a, b) => b.return_count - a.return_count || a.pseudonym.localeCompare(b.pseudonym)), sessions_without_pseudonym: without };
}

/**
 * A return count is a claim about sessions (CR-72). A statement counted per device pseudonym
 * must cite the sessions it counts, carry its count as `return_count` equal to those sessions
 * less one, and every cited session must carry the same pseudonym (one device of a declared
 * experiment). Otherwise it is refused. Called by the store on every draft it saves
 * (`LocalRecord.saveEvidenceDraft`); resolution of each cited session is `draftRefusals`'.
 */
export function returnItemProblem(
  item: { return_count?: number; source_refs: readonly string[] },
  pseudonymOf: (sessionRef: string) => string | null,
): "return_without_sessions" | "return_count_mismatch" | "return_sessions_not_one_device" | null {
  const sessions = item.source_refs.filter((r) => r.startsWith("session:"));
  if (sessions.length === 0) return "return_without_sessions";
  if (item.return_count !== sessions.length - 1) return "return_count_mismatch";
  const devices = new Set(sessions.map(pseudonymOf));
  if (devices.size !== 1 || devices.has(null)) return "return_sessions_not_one_device";
  return null;
}

// ── CR-74 — comparison experiments ────────────────────────────────────────────

export interface VariantDeclaration {
  id: string;
  product_version_id?: string;
  alternative?: string;
}

export interface VariantResult {
  variant: string;
  kind: "version" | "alternative";
  /** The pinned product version, or the alternative's own words. */
  subject: string;
  sessions: number;
  /** Per task label: sessions that started it, and that completed it. */
  tasks: Record<string, { started: number; completed: number }>;
  notes: number;
  source_refs: string[];
}

/** Is this a comparison experiment (two or more declared variants)? */
export const isComparison = (declarations: { variants?: readonly VariantDeclaration[] } | undefined): boolean => (declarations?.variants?.length ?? 0) >= 2;

/**
 * Results per variant under the same criteria (CR-74): every session and note is counted
 * under the one variant it carries; an outside alternative is observed through notes only.
 */
export function variantResults(
  experiment: { product_version_id: string; declarations?: { variants?: readonly VariantDeclaration[] } },
  sessions: readonly ParticipantSession[],
  notes: readonly ObservationEvent[],
): VariantResult[] {
  const variants = experiment.declarations?.variants ?? [];
  return variants.map((v) => {
    const mine = sessions.filter((s) => s.variant === v.id);
    const myNotes = notes.filter((n) => n.attribution?.variant === v.id);
    const tasks: VariantResult["tasks"] = {};
    for (const s of mine) {
      for (const [label, t] of Object.entries(s.tasks)) {
        const r = (tasks[label] ??= { started: 0, completed: 0 });
        if (t.started) r.started++;
        if (t.completed) r.completed++;
      }
    }
    return {
      variant: v.id,
      kind: v.alternative ? "alternative" : "version",
      subject: v.alternative ?? v.product_version_id ?? experiment.product_version_id,
      sessions: mine.length,
      tasks,
      notes: myNotes.length,
      source_refs: [...mine.map((s) => sessionRef(s.session_id)), ...myNotes.map((n) => noteRef(n.id))],
    };
  });
}

/** The variant a reference belongs to, for `comparisonSupport` (interpretation.ts). */
export function variantOfRef(sessions: readonly ParticipantSession[], notes: readonly ObservationEvent[]): (ref: string) => string | null {
  const s = new Map(sessions.map((x) => [x.session_id, x.variant]));
  const n = new Map(notes.map((x) => [x.id, x.attribution?.variant ?? null]));
  return (ref) => {
    if (ref.startsWith("session:")) return s.get(ref.slice(8)) ?? null;
    if (ref.startsWith("event:")) return s.get(ref.slice(6).split("/")[0]!) ?? null;
    if (ref.startsWith("note:")) return n.get(ref.slice(5)) ?? null;
    return null;
  };
}

// ── CR-25 — the runtime's observed statements ─────────────────────────────────

const days = (ms: number) => Math.round((ms / 86_400_000) * 10) / 10;

/**
 * The bounds `validateEvidenceDraftShape` (interpretation.ts) puts on every draft, which the
 * runtime's own draft must fit: references per statement and statements per draft.
 */
export const RUNTIME_DRAFT_LIMITS = { refsPerItem: 50, items: 60 } as const;

/** Up to `max` references, taken in turn from each group, so every group stays cited. */
function balancedRefs(groups: readonly (readonly string[])[], max: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < max && groups.some((g) => i < g.length); i++) for (const g of groups) if (i < g.length && out.length < max) out.push(g[i]!);
  return out;
}

/**
 * Observed statements the runtime reads off the records: what happened, with the records that
 * show it (CR-25). No interpretation, no assumption: those are the student's (or an AI
 * summary's, reviewed by the student). Student-facing Korean copy. Deterministic: the same
 * records give the same items.
 */
export function observedItems(
  experiment: { id: string; product_version_id: string; declarations?: { repeated_use?: true; variants?: readonly VariantDeclaration[] } },
  sessions: readonly ParticipantSession[],
  notes: readonly ObservationEvent[],
): DraftItem[] {
  const items: DraftItem[] = [];
  const add = (text: string, refs: string[], extra: Partial<DraftItem> = {}) => {
    if (!refs.length) return;
    items.push({ id: `o${items.length + 1}`, section: "observation", text, source_refs: refs, review: "draft", ...extra });
  };
  // A statement over more sessions than one item may cite is split into parts that together
  // cite every session, each part saying which part it is.
  const addSplit = (text: string, refs: string[]) => {
    const parts = Math.ceil(refs.length / RUNTIME_DRAFT_LIMITS.refsPerItem);
    for (let i = 0; i < parts; i++) add(parts > 1 ? `${text} (근거 ${i + 1}/${parts})` : text, refs.slice(i * RUNTIME_DRAFT_LIMITS.refsPerItem, (i + 1) * RUNTIME_DRAFT_LIMITS.refsPerItem));
  };
  const comparison = isComparison(experiment.declarations);
  const groups: Array<{ label: string; sessions: readonly ParticipantSession[] }> = comparison
    ? (experiment.declarations!.variants ?? []).map((v) => ({ label: `[${v.id}] `, sessions: sessions.filter((s) => s.variant === v.id) }))
    : [{ label: "", sessions }];
  for (const g of groups) {
    const labels = [...new Set(g.sessions.flatMap((s) => Object.keys(s.tasks)))].sort();
    for (const label of labels) {
      const started = g.sessions.filter((s) => s.tasks[label]?.started);
      const done = g.sessions.filter((s) => s.tasks[label]?.completed);
      const paused = started.filter((s) => !s.tasks[label]?.completed);
      addSplit(`${g.label}'${label}'을(를) 시작한 세션 ${started.length}개 중 ${done.length}개가 끝까지 마쳤어요.`, started.map((s) => sessionRef(s.session_id)));
      if (paused.length) addSplit(`${g.label}'${label}'을(를) 시작했지만 마치지 않은 세션이 ${paused.length}개 있어요.`, paused.map((s) => sessionRef(s.session_id)));
    }
  }
  if (comparison) {
    const results = variantResults(experiment, sessions, notes);
    if (results.every((r) => r.source_refs.length > 0)) {
      // One statement; its references are drawn from every variant in turn, so it stays
      // supported (CR-74) within the per-statement bound.
      add(
        `같은 기준으로 비교한 기록: ${results.map((r) => `${r.variant} 세션 ${r.sessions}개·기록 ${r.notes}개`).join(" / ")}.`,
        balancedRefs(results.map((r) => r.source_refs), RUNTIME_DRAFT_LIMITS.refsPerItem),
        { compares: results.map((r) => r.variant) },
      );
    }
  }
  const returns = returnEvidence(experiment.declarations, sessions);
  if (returns.status === "measured") {
    for (const d of returns.devices) {
      // A return count must cite every session it counts (CR-72), so a device with more sessions
      // than one statement may cite is left to the evidence read's `returns`, not the draft.
      if (d.return_count < 1 || d.source_refs.length > RUNTIME_DRAFT_LIMITS.refsPerItem) continue;
      const gaps = d.intervals_ms.map((ms) => `${days(ms)}일`).join(", ");
      add(`같은 기기(익명 표시 ${d.pseudonym.slice(3, 9)})에서 ${d.sessions.length}번 열었어요. 다시 온 횟수 ${d.return_count}번, 사이 간격 ${gaps}.`, d.source_refs, { basis: "per_device_pseudonym", return_count: d.return_count });
    }
  }
  // The draft's own bound: statements past it are left out of the draft (the evidence read
  // still shows every session); tasks first, then the comparison, then returns.
  return items.slice(0, RUNTIME_DRAFT_LIMITS.items);
}

/** The runtime's draft over the records, revision 1. Interpretations and assumptions are left for the student. */
export function runtimeDraft(input: {
  id: string;
  experiment: Parameters<typeof observedItems>[0];
  sessions: readonly ParticipantSession[];
  notes: readonly ObservationEvent[];
  at: number;
}): EvidenceDraft | null {
  const items = observedItems(input.experiment, input.sessions, input.notes);
  if (!items.length) return null;
  return { format: "hps-evidence-draft/1", id: input.id, revision: 1, supersedes: null, experiment: input.experiment.id, author: "runtime", created_at: input.at, items };
}

// ── CR-28 — what the Weekly Review reads ──────────────────────────────────────

export interface ReviewClaim {
  section: DraftItem["section"];
  text: string;
  source_refs: string[];
  review: DraftItem["review"];
}

export type ReviewInput = { status: "no_evidence_recorded"; claims: [] } | { status: "evidence"; claims: ReviewClaim[]; sessions: number; notes: number };

/**
 * The Weekly Review's input for one experiment (CR-28): structured evidence items only. The
 * latest revision of each draft, without rejected items; when there is no draft, the
 * runtime's observed items over the records. Chat history is not an input: a project with
 * only chat yields "no evidence recorded" and no claims. cr-review consumes this.
 */
export function reviewInput(input: {
  experiment: Parameters<typeof observedItems>[0];
  sessions: readonly ParticipantSession[];
  notes: readonly ObservationEvent[];
  drafts: readonly EvidenceDraft[];
  /** Accepted and ignored: chat is never evidence here. */
  chat?: unknown;
}): ReviewInput {
  const latest = new Map<string, EvidenceDraft>();
  for (const d of input.drafts) if ((latest.get(d.id)?.revision ?? 0) < d.revision) latest.set(d.id, d);
  const fromDrafts: ReviewClaim[] = [...latest.values()].flatMap((d) => d.items.filter((i) => i.review !== "rejected").map((i) => ({ section: i.section, text: i.text, source_refs: i.source_refs, review: i.review })));
  const claims = fromDrafts.length
    ? fromDrafts
    : observedItems(input.experiment, input.sessions, input.notes).map((i) => ({ section: i.section, text: i.text, source_refs: i.source_refs, review: i.review }));
  const noteClaims: ReviewClaim[] = fromDrafts.length ? [] : input.notes.map((n) => ({ section: "observation" as const, text: n.student_text ?? n.text, source_refs: [noteRef(n.id)], review: "draft" as const }));
  const all = [...claims, ...noteClaims];
  if (!all.length) return { status: "no_evidence_recorded", claims: [] };
  return { status: "evidence", claims: all, sessions: input.sessions.length, notes: input.notes.length };
}
