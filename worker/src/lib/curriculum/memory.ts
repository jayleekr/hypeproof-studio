// Venture Memory, read (cr-memory #1395; PRD P0-6, §10; CR-35–CR-42, CR-75–CR-79, CR-82).
//
// Pure views over what is stored: the `hps-venture/1` documents of the Project (D1, recon R5)
// and the evidence drafts and participant events of its experiments in the measurement-core
// record (R6). Nothing here is stored and nothing here calls a model: the register, the
// timeline, the version diff, the belief changes, the metric values and the director's chains
// are computed again on every read from those records, so a view cannot drift from its
// sources and reopening a project needs no chat history (CR-36).
//
// An evidence item (CR-40) is an item of an `hps-evidence-draft/1` revision, named
// `ev:<experiment>/<draft>/<item>`; its current revision is the draft's latest. Only the
// student's own revision changes an item's confidence (CR-82, MC-22): an assumption that a
// revision not written by the student turned into an observation stays assumed here.

import type { DraftItem, EvidenceDraft } from "../measurement-core/interpretation.ts";
import type { ObservationEvent } from "../measurement-core/legacy-observation.ts";
import {
  DECK_SLIDES,
  artifactOfVersion,
  evidenceItemRef,
  hypothesisRevisions,
  parseEvidenceItemRef,
  type Artifact,
  type Confidence,
  type DeckSlide,
  type Decision,
  type Experiment,
  type Hypothesis,
  type HypothesisRevision,
  type Metric,
  type ProductVersion,
  type Project,
  type Stakeholder,
} from "./venture.ts";

const SECTION_CONFIDENCE: Record<string, Confidence | null> = { observation: "observed", interpretation: "interpreted", assumption: "assumed", next_experiment: null };

export interface EvidenceItemRevision {
  revision: number;
  confidence: Confidence;
  statement: string;
  source_refs: string[];
  review: DraftItem["review"];
  author: EvidenceDraft["author"];
  at: number;
}

/** One evidence item as Venture Memory shows it: the CR-40 contract plus where it lives and its revisions. */
export interface EvidenceItemView {
  id: string;
  type: string;
  source_refs: string[];
  statement: string;
  confidence: Confidence;
  created_by: "student" | "system";
  created_at: number;
  experiment_id: string;
  draft_id: string;
  item_id: string;
  /** The draft's latest revision, which holds the item's current state. */
  revision: number;
  review: DraftItem["review"];
  /** Every revision of the draft that holds this item, oldest first: an earlier statement stays readable. */
  revisions: EvidenceItemRevision[];
  /** Ever an assumption: still open, or observed in a later revision the student made (CR-82). */
  assumption_status?: "open" | "observed_later";
  promoted_at_revision?: number;
}

/**
 * The evidence items of one experiment, from its stored draft revisions. Rejected items and
 * "next experiment" items are not evidence and are left out.
 */
export function evidenceItemsOf(experimentId: string, drafts: readonly EvidenceDraft[]): EvidenceItemView[] {
  const byDraft = new Map<string, EvidenceDraft[]>();
  for (const d of drafts) if (d.experiment === experimentId) (byDraft.get(d.id) ?? byDraft.set(d.id, []).get(d.id)!).push(d);
  const out: EvidenceItemView[] = [];
  for (const [draftId, revs] of byDraft) {
    revs.sort((a, b) => a.revision - b.revision);
    const latest = revs.at(-1)!;
    for (const item of latest.items) {
      const history: EvidenceItemRevision[] = [];
      for (const r of revs) {
        const it = r.items.find((i) => i.id === item.id);
        const conf = it ? SECTION_CONFIDENCE[it.section] : null;
        if (it && conf) history.push({ revision: r.revision, confidence: conf, statement: it.text, source_refs: [...it.source_refs], review: it.review, author: r.author, at: r.created_at });
      }
      if (!history.length || item.review === "rejected") continue;
      // Only the student's revision moves a confidence (CR-82): an assumption a non-student
      // revision turned into an observation stays assumed, with that revision still listed.
      let confidence = history[0]!.confidence;
      let promotedAt: number | undefined;
      for (const h of history.slice(1)) {
        if (h.confidence === confidence) continue;
        const byStudent = h.author === "user" && h.review !== "draft";
        if (confidence === "assumed" && h.confidence === "observed") {
          if (!byStudent || h.source_refs.length === 0) continue;
          promotedAt = h.revision;
        }
        confidence = h.confidence;
      }
      const last = history.at(-1)!;
      const everAssumed = history.some((h) => h.confidence === "assumed");
      out.push({
        id: evidenceItemRef(experimentId, draftId, item.id),
        type: item.section,
        source_refs: confidence === "assumed" && last.confidence !== "assumed" ? history.filter((h) => h.confidence === "assumed").at(-1)!.source_refs : last.source_refs,
        statement: last.statement,
        confidence,
        created_by: item.reviewed_by === "user" || latest.author === "user" ? "student" : "system",
        created_at: history[0]!.at,
        experiment_id: experimentId,
        draft_id: draftId,
        item_id: item.id,
        revision: latest.revision,
        review: item.review,
        revisions: history,
        ...(everAssumed ? { assumption_status: promotedAt !== undefined ? ("observed_later" as const) : ("open" as const) } : {}),
        ...(promotedAt !== undefined ? { promoted_at_revision: promotedAt } : {}),
      });
    }
  }
  return out.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}

// ── Decisions (CR-38, CR-41, CR-82) ─────────────────────────────────────────

/**
 * What the store refuses in a decision before it is written: an evidence reference that is
 * not an evidence item of this Project, an assumption reference that is dangling or whose
 * item is not assumed (CR-82), a resulting version or experiment of another Project.
 */
export function decisionRefProblems(
  d: Pick<Decision, "evidence_refs" | "assumption_refs" | "resulting_version_id"> & { experiment_id?: string },
  ctx: { items: ReadonlyMap<string, EvidenceItemView>; versions: ReadonlySet<string>; experiments: ReadonlySet<string> },
): string[] {
  const problems: string[] = [];
  for (const ref of d.evidence_refs) if (!ctx.items.has(ref)) problems.push(`unresolved_evidence_ref:${ref}`);
  for (const ref of d.assumption_refs) {
    const it = ctx.items.get(ref);
    if (!it) problems.push(`unresolved_assumption_ref:${ref}`);
    else if (it.confidence !== "assumed") problems.push(`assumption_ref_not_assumed:${ref}`);
  }
  if (d.resulting_version_id !== null && !ctx.versions.has(d.resulting_version_id)) problems.push("unresolved_version");
  if (d.experiment_id !== undefined && !ctx.experiments.has(d.experiment_id)) problems.push("unresolved_experiment");
  return problems;
}

/** A decision as shown: an AI suggestion is never the team's decision (SX-45); no evidence is marked, not hidden (CR-38). */
export interface DecisionView extends Decision {
  shown_as: "team_decision" | "ai_suggestion";
  no_evidence: boolean;
  evidence: Array<{ ref: string; state: "ok" | "missing"; statement?: string; confidence?: Confidence }>;
  assumptions: Array<{ ref: string; state: "ok" | "missing"; statement?: string; confidence?: Confidence }>;
}

function cite(refs: readonly string[], items: ReadonlyMap<string, EvidenceItemView>) {
  return refs.map((ref) => {
    const it = items.get(ref);
    return it ? { ref, state: "ok" as const, statement: it.statement, confidence: it.confidence } : { ref, state: "missing" as const };
  });
}

export function decisionView(d: Decision, items: ReadonlyMap<string, EvidenceItemView>): DecisionView {
  return { ...d, shown_as: d.actor === "student" ? "team_decision" : "ai_suggestion", no_evidence: d.evidence_refs.length === 0, evidence: cite(d.evidence_refs, items), assumptions: cite(d.assumption_refs, items) };
}

const timeOf = (t: number | string) => (typeof t === "number" ? t : Date.parse(t));

// ── Register (CR-82) ────────────────────────────────────────────────────────

export interface RegisterEntry extends EvidenceItemView {
  cited_by: Array<{ decision_id: string; shown_as: DecisionView["shown_as"] }>;
  slides: number[];
}

export interface FactRegister {
  observed: RegisterEntry[];
  interpreted: RegisterEntry[];
  assumed: RegisterEntry[];
}

/** Every evidence item of the project by confidence, with its current revision and what cites it. No model call. */
export function factRegister(items: readonly EvidenceItemView[], decisions: readonly Decision[], slides: readonly DeckSlide[]): FactRegister {
  const out: FactRegister = { observed: [], interpreted: [], assumed: [] };
  const latestSlides = latestSlideRevisions(slides);
  for (const it of items) {
    const citing = decisions.filter((d) => d.evidence_refs.includes(it.id) || d.assumption_refs.includes(it.id));
    const slideNums = new Set<number>();
    for (const d of citing) if (d.actor === "student") for (const n of d.affected_deck_slides) slideNums.add(n);
    for (const s of latestSlides) if (s.evidence_refs.includes(it.id)) slideNums.add(s.number);
    out[it.confidence].push({ ...it, cited_by: citing.map((d) => ({ decision_id: d.id, shown_as: d.actor === "student" ? "team_decision" : "ai_suggestion" })), slides: [...slideNums].sort((a, b) => a - b) });
  }
  return out;
}

export function latestSlideRevisions(slides: readonly DeckSlide[]): DeckSlide[] {
  const best = new Map<number, DeckSlide>();
  for (const s of slides) if (!best.has(s.number) || best.get(s.number)!.revision < s.revision) best.set(s.number, s);
  return [...best.values()].sort((a, b) => a.number - b.number);
}

// ── Version diff (CR-77) ────────────────────────────────────────────────────

export type VersionDiff =
  | { ok: false; code: "cross_project" | "same_version" }
  | {
      ok: true;
      from: { id: string; created_at: number };
      to: { id: string; created_at: number };
      files: Array<{ path: string; change: "added" | "removed" | "modified" }>;
      /** The team decisions that produced the newer version; empty means "no recorded decision", never an inferred reason. */
      decisions: DecisionView[];
      reason: "recorded" | "no_recorded_decision";
    };

/** Two product versions of one project, compared by content digest with no model call. */
export function versionDiff(projectId: string, a: ProductVersion, b: ProductVersion, decisions: readonly Decision[], items: ReadonlyMap<string, EvidenceItemView>): VersionDiff {
  if (a.project_id !== projectId || b.project_id !== projectId) return { ok: false, code: "cross_project" };
  if (a.id === b.id) return { ok: false, code: "same_version" };
  const [older, newer] = a.created_at <= b.created_at ? [a, b] : [b, a];
  const before = new Map(older.files.map((f) => [f.path, f.sha256]));
  const after = new Map(newer.files.map((f) => [f.path, f.sha256]));
  const files: Array<{ path: string; change: "added" | "removed" | "modified" }> = [];
  for (const [p, sha] of after) if (!before.has(p)) files.push({ path: p, change: "added" });
  else if (before.get(p) !== sha) files.push({ path: p, change: "modified" });
  for (const p of before.keys()) if (!after.has(p)) files.push({ path: p, change: "removed" });
  files.sort((x, y) => x.path.localeCompare(y.path));
  const behind = decisions.filter((d) => d.actor === "student" && d.resulting_version_id === newer.id).map((d) => decisionView(d, items));
  return { ok: true, from: { id: older.id, created_at: older.created_at }, to: { id: newer.id, created_at: newer.created_at }, files, decisions: behind, reason: behind.length ? "recorded" : "no_recorded_decision" };
}

// ── Belief changes (CR-79) ──────────────────────────────────────────────────

export interface BeliefChange {
  hypothesis_id: string;
  before: Pick<HypothesisRevision, "revision" | "statement" | "status">;
  after: Pick<HypothesisRevision, "revision" | "statement" | "status">;
  decision: { id: string; statement: string; resulting_version_id: string | null } | null;
  evidence: Array<{ ref: string; statement: string; confidence: Confidence }>;
  /** "we believed X; after this evidence we believe Y; so we changed Z" only when evidence is cited; else "reason not recorded". */
  reason: "recorded" | "reason_not_recorded";
}

/** Assembled only from hypothesis revisions and the decisions and evidence they link. No generated reason. */
export function beliefChanges(hypotheses: readonly Hypothesis[], decisions: readonly Decision[], items: ReadonlyMap<string, EvidenceItemView>): BeliefChange[] {
  const out: BeliefChange[] = [];
  const byId = new Map(decisions.map((d) => [d.id, d]));
  for (const h of hypotheses) {
    const revs = hypothesisRevisions(h);
    for (let i = 1; i < revs.length; i++) {
      const prev = revs[i - 1]!;
      const cur = revs[i]!;
      const d = cur.decision_id ? byId.get(cur.decision_id) : undefined;
      const decision = d && d.actor === "student" ? d : undefined;
      const refs = [...new Set([...(cur.evidence_refs ?? []), ...(decision?.evidence_refs ?? [])])];
      const evidence = refs.map((r) => items.get(r)).filter((x): x is EvidenceItemView => !!x).map((x) => ({ ref: x.id, statement: x.statement, confidence: x.confidence }));
      out.push({
        hypothesis_id: h.id,
        before: { revision: prev.revision, statement: prev.statement, status: prev.status },
        after: { revision: cur.revision, statement: cur.statement, status: cur.status },
        decision: decision ? { id: decision.id, statement: decision.statement, resulting_version_id: decision.resulting_version_id } : null,
        evidence,
        reason: evidence.length ? "recorded" : "reason_not_recorded",
      });
    }
  }
  return out;
}

// ── Stakeholders (CR-75) ────────────────────────────────────────────────────

export interface StakeholderView extends Stakeholder {
  roles_shown: Array<{ role: Stakeholder["roles"][number]["role"]; confidence: "observed" | "assumed"; evidence: ReturnType<typeof cite> }>;
  /** Payer and user held by the same stakeholder: recorded, never assumed. */
  payer_and_user: boolean;
}

export function stakeholderView(s: Stakeholder, items: ReadonlyMap<string, EvidenceItemView>): StakeholderView {
  const roles = new Set(s.roles.map((r) => r.role));
  return {
    ...s,
    roles_shown: s.roles.map((r) => ({ role: r.role, confidence: r.basis === "observed" && r.evidence_refs.length > 0 ? "observed" : "assumed", evidence: cite(r.evidence_refs, items) })),
    payer_and_user: roles.has("payer") && roles.has("user"),
  };
}

// ── Metrics (CR-76) ─────────────────────────────────────────────────────────

export interface MetricValue {
  /** `result`: a value counted from real inputs only. `unsupported`: no resolvable real source, so no value is shown. */
  status: "result" | "unsupported" | "evidence_only";
  value: number | null;
  source_refs: string[];
  source_state: "real" | null;
  /** Inputs that are not real (simulated, self-reported, unverified), labelled and never counted into the value (SX-46). */
  not_counted: Record<string, number>;
}

/** A metric's value from its source, on every read. Simulated or self-reported inputs are labelled, never counted (SX-46). */
export function metricValue(m: Metric, ctx: { experiments: ReadonlySet<string>; events: ReadonlyMap<string, readonly ObservationEvent[]>; items: ReadonlyMap<string, EvidenceItemView> }): MetricValue {
  if (m.source.type === "evidence_items") {
    const refs = m.source.refs.filter((r) => ctx.items.has(r));
    return { status: refs.length ? "evidence_only" : "unsupported", value: null, source_refs: refs, source_state: null, not_counted: {} };
  }
  const src = m.source;
  if (!ctx.experiments.has(src.experiment_id)) return { status: "unsupported", value: null, source_refs: [], source_state: null, not_counted: {} };
  const real: string[] = [];
  const notCounted: Record<string, number> = {};
  for (const e of ctx.events.get(src.experiment_id) ?? []) {
    if (e.kind !== src.event_kind || (src.label !== undefined && e.label !== src.label)) continue;
    const state = typeof e.source_state === "string" ? e.source_state : "unverified";
    const sid = e.participant?.session_id;
    if (state === "real" && sid) real.push(`event:${sid}/${e.id}`);
    else notCounted[state] = (notCounted[state] ?? 0) + 1;
  }
  if (!real.length) return { status: "unsupported", value: null, source_refs: [], source_state: null, not_counted: notCounted };
  return { status: "result", value: real.length, source_refs: real, source_state: "real", not_counted: notCounted };
}

// ── Timeline (CR-78) ────────────────────────────────────────────────────────

export type RecordRef =
  | { kind: "hypothesis"; id: string; revision: number }
  | { kind: "experiment"; id: string }
  | { kind: "product_version"; id: string }
  | { kind: "evidence_item"; id: string }
  | { kind: "decision"; id: string }
  | { kind: "deck_slide"; id: string; revision: number };

export interface TimelineEntry {
  at: number;
  /** An AI suggestion is its own entry kind, never "decision" (SX-45). */
  entry: "hypothesis" | "hypothesis_revised" | "experiment" | "product_version" | "evidence_item" | "decision" | "ai_suggestion" | "deck_slide";
  label: string;
  record: RecordRef;
}

export interface MemoryRecords {
  project: Project;
  hypotheses: Hypothesis[];
  experiments: Experiment[];
  versions: ProductVersion[];
  decisions: Decision[];
  stakeholders: Stakeholder[];
  metrics: Metric[];
  slides: DeckSlide[];
  items: EvidenceItemView[];
}

/** The project's timeline in time order, every entry naming the stored record it opens. No model call. */
export function timeline(r: MemoryRecords): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const h of r.hypotheses) {
    for (const rev of hypothesisRevisions(h)) out.push({ at: rev.at, entry: rev.revision === 1 ? "hypothesis" : "hypothesis_revised", label: rev.statement, record: { kind: "hypothesis", id: h.id, revision: rev.revision } });
  }
  for (const e of r.experiments) out.push({ at: e.created_at, entry: "experiment", label: e.question, record: { kind: "experiment", id: e.id } });
  for (const v of r.versions) out.push({ at: v.created_at, entry: "product_version", label: v.entry_html, record: { kind: "product_version", id: v.id } });
  for (const it of r.items) out.push({ at: it.created_at, entry: "evidence_item", label: it.statement, record: { kind: "evidence_item", id: it.id } });
  for (const d of r.decisions) out.push({ at: timeOf(d.decided_at), entry: d.actor === "student" ? "decision" : "ai_suggestion", label: d.statement, record: { kind: "decision", id: d.id } });
  for (const s of r.slides) out.push({ at: s.at, entry: "deck_slide", label: `${s.number}. ${s.title}`, record: { kind: "deck_slide", id: String(s.number), revision: s.revision } });
  return out.sort((a, b) => a.at - b.at || a.entry.localeCompare(b.entry));
}

/** The stored record a timeline entry names, or null (a planted entry with no record fails CR-T73). */
export function openRecord(r: MemoryRecords, ref: RecordRef): unknown {
  switch (ref.kind) {
    case "hypothesis": {
      const h = r.hypotheses.find((x) => x.id === ref.id);
      return h ? (hypothesisRevisions(h).find((x) => x.revision === ref.revision) ?? null) : null;
    }
    case "experiment":
      return r.experiments.find((x) => x.id === ref.id) ?? null;
    case "product_version":
      return r.versions.find((x) => x.id === ref.id) ?? null;
    case "evidence_item":
      return r.items.find((x) => x.id === ref.id) ?? null;
    case "decision":
      return r.decisions.find((x) => x.id === ref.id) ?? null;
    case "deck_slide":
      return r.slides.find((x) => String(x.number) === ref.id && x.revision === ref.revision) ?? null;
  }
}

// ── The director's traversal (CR-37) ────────────────────────────────────────

export interface Chain {
  hypothesis: { id: string; statement: string; status: string };
  experiments: Array<{ id: string; question: string; status: string }>;
  evidence: Array<{ ref: string; statement: string; confidence: Confidence }>;
  decisions: Array<{ id: string; statement: string; shown_as: DecisionView["shown_as"]; resulting_version_id: string | null }>;
  versions: string[];
}

/** hypothesis → experiment → evidence → decision → version, from the records only. */
export function chains(r: MemoryRecords): Chain[] {
  return r.hypotheses.map((h) => {
    const exps = r.experiments.filter((e) => e.hypothesis_id === h.id);
    const expIds = new Set(exps.map((e) => e.id));
    const ev = r.items.filter((i) => expIds.has(i.experiment_id));
    const evIds = new Set(ev.map((i) => i.id));
    const revDecisions = new Set(hypothesisRevisions(h).map((x) => x.decision_id).filter((x): x is string => !!x));
    const decs = r.decisions.filter((d) => revDecisions.has(d.id) || (d.experiment_id !== undefined && expIds.has(d.experiment_id)) || d.evidence_refs.some((x) => evIds.has(x)) || d.assumption_refs.some((x) => evIds.has(x)));
    return {
      hypothesis: { id: h.id, statement: h.statement, status: h.status },
      experiments: exps.map((e) => ({ id: e.id, question: e.question, status: e.status })),
      evidence: ev.map((i) => ({ ref: i.id, statement: i.statement, confidence: i.confidence })),
      decisions: decs.map((d) => ({ id: d.id, statement: d.statement, shown_as: d.actor === "student" ? ("team_decision" as const) : ("ai_suggestion" as const), resulting_version_id: d.resulting_version_id })),
      versions: [...new Set(decs.filter((d) => d.actor === "student" && d.resulting_version_id).map((d) => d.resulting_version_id!))],
    };
  });
}

// ── The whole state (CR-35, CR-36) ──────────────────────────────────────────

export interface MemoryState {
  format: "hps-venture-memory/1";
  project: Project;
  problem: string | null;
  stakeholders: StakeholderView[];
  hypotheses: Array<Hypothesis & { revisions: HypothesisRevision[] }>;
  experiments: Experiment[];
  evidence_items: EvidenceItemView[];
  decisions: DecisionView[];
  versions: ProductVersion[];
  artifacts: Artifact[];
  metrics: Array<Metric & { value: MetricValue }>;
  deck_slides: DeckSlide[];
  register: FactRegister;
  timeline: TimelineEntry[];
  belief_changes: BeliefChange[];
  chains: Chain[];
  /** Entities whose records belong to later items: their absence here is a fact, not an empty result. */
  not_in_this_read: Array<"weekly_reviews" | "ai_usage">;
}

/** Everything Venture Memory holds for one Project, assembled from stored records with no model call. */
export function memoryState(r: MemoryRecords, events: ReadonlyMap<string, readonly ObservationEvent[]>): MemoryState {
  const items = new Map(r.items.map((i) => [i.id, i]));
  const versionsByTime = [...r.versions].sort((a, b) => a.created_at - b.created_at);
  const decisions = r.decisions.map((d) => decisionView(d, items));
  const experiments = new Set(r.experiments.map((e) => e.id));
  return {
    format: "hps-venture-memory/1",
    project: r.project,
    problem: r.project.problem?.revisions.at(-1)?.statement ?? null,
    stakeholders: r.stakeholders.map((s) => stakeholderView(s, items)),
    hypotheses: r.hypotheses.map((h) => ({ ...h, revisions: hypothesisRevisions(h) })),
    experiments: r.experiments,
    evidence_items: r.items,
    decisions,
    versions: versionsByTime,
    artifacts: versionsByTime.map((v, i) => artifactOfVersion(v, i, [...new Set(r.decisions.filter((d) => d.actor === "student" && d.resulting_version_id === v.id).flatMap((d) => d.evidence_refs))])),
    metrics: r.metrics.map((m) => ({ ...m, value: metricValue(m, { experiments, events, items }) })),
    deck_slides: latestSlideRevisions(r.slides),
    register: factRegister(r.items, r.decisions, r.slides),
    timeline: timeline(r),
    belief_changes: beliefChanges(r.hypotheses, r.decisions, items),
    chains: chains(r),
    not_in_this_read: ["weekly_reviews", "ai_usage"],
  };
}

export { DECK_SLIDES, parseEvidenceItemRef };
