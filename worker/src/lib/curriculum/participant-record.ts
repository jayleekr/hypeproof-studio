// The participant session record on the Service (recon R6; CR-21, CR-22, CR-73).
//
// Participant evidence lives in the one measurement-core record (`LocalRecord`), on the
// Service host, over the existing R2 binding `HPS_TRACES` under `curriculum/<cohort>/<project>/`.
// No new KV namespace, no traffic table, no validator copy (SX-48). One Experiment is one
// record task (same id, `project` = the project id), created when the student starts the
// test, so opening a link never races to create it. A participant session is written as its
// per-session key only (`LocalRecord.linkSessionKey`): constant cost per open, however many
// sessions the project already holds. It never rewrites the task document and never scans
// the review quota; how many such keys exist is bounded per link by the caller (the D1
// counter `cr_test_links.sessions_opened`, store.ts `reserveSession`), which is also the
// index the per-channel counts read (CR-73).
//
// cr-evidence (#1394) adds the event half on top of these session keys (`appendParticipantEvents`),
// the student's manual records (`addNote`), the experiment's evidence read and its deletion.
// R6's "one writer per experiment" is the per-session keys: every participant session is its
// own atomic key (`ifAbsent`, a conditional put on R2), the task document is never rewritten
// per session, and every read of an experiment's sessions lists those keys. So sessions
// linked at the same time are all kept (CR-T67), with no serialisation and no compare-and-swap.

import { LocalRecord, NOTES_HOST, canonicalJson, PARTICIPANT_HOST, type ObservationRecord, type SessionAttribution, type StoragePort } from "../measurement-core/local-record.ts";
import { OBSERVATION_FORMAT_V2, validateObservation, type ObservationEvent } from "../measurement-core/legacy-observation.ts";
import { MANUAL_RECORD_KINDS, PARTICIPANT_EVENT_KINDS, SOURCE_STATES, forbidIdentityFields, type ManualRecordKind, type ParticipantEventKind } from "../measurement-core/learning-events.ts";
import { comparisonSupport, type EvidenceDraft } from "../measurement-core/interpretation.ts";
import { isComparison, participantSessions, returnEvidence, reviewInput, runtimeDraft, variantOfRef, variantResults, type ParticipantSession } from "../measurement-core/participant-evidence.ts";
import type { Experiment, TestLink } from "./venture.ts";
import { pinnedVersion } from "./venture.ts";

/** The record host of participant sessions; the core names it (`PARTICIPANT_HOST`) so a draft reference resolves there. */
export const PUBLISHED_HOST = PARTICIPANT_HOST;

/** The minimal R2 surface this port uses (the binding's own types in the Worker). */
export interface R2Like {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string, options?: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list(options: { prefix: string; cursor?: string }): Promise<{ objects: Array<{ key: string }>; truncated?: boolean; cursor?: string }>;
}

const safe = (s: string) => encodeURIComponent(s);

export function participantPrefix(cohortId: string, projectId: string): string {
  return `curriculum/${safe(cohortId)}/${safe(projectId)}/`;
}

export function r2RecordPort(bucket: R2Like, prefix: string): StoragePort {
  return {
    async read(key) {
      const o = await bucket.get(prefix + key);
      return o ? o.text() : null;
    },
    async write(key, value, options) {
      if (options?.ifAbsent) {
        // Conditional put: the object must not exist. cr-evidence confirms R2's semantics
        // for concurrent writers (recon §7); the read before it keeps a sequential retry honest.
        if ((await bucket.get(prefix + key)) !== null) throw new Error("exists");
        const r = await bucket.put(prefix + key, value, { onlyIf: { etagDoesNotMatch: "*" } });
        if (r === null) throw new Error("exists");
        return;
      }
      await bucket.put(prefix + key, value);
    },
    async list(p) {
      const out: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix: prefix + p, ...(cursor ? { cursor } : {}) });
        for (const o of page.objects) out.push(o.key.slice(prefix.length));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
    async remove(key) {
      await bucket.delete(prefix + key);
    },
  };
}

export function participantRecord(bucket: R2Like, cohortId: string, projectId: string): LocalRecord {
  return new LocalRecord(r2RecordPort(bucket, participantPrefix(cohortId, projectId)));
}

/**
 * The record task of an experiment; created once, when the student starts the test, before
 * any D1 row of it is written (POST /experiments). Constant cost: one read when it exists,
 * else a read and a conditional put. The review quota is not scanned (it would read every
 * session key of the project); the route bounds tasks by `PUBLISH_LIMITS.maxExperimentsPerProject`.
 */
export async function ensureExperimentTask(record: LocalRecord, experiment: Pick<Experiment, "id" | "project_id" | "question">, at: number): Promise<void> {
  try {
    await record.getTask(experiment.id);
    return;
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "unknown_task") throw e;
  }
  try {
    await record.createTask({ id: experiment.id, project: experiment.project_id, at, purpose: { text: experiment.question, source: "user" } }, { quota: "none" });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "task_exists") throw e;
  }
}

export type SessionRefusal = "session_experiment_mismatch" | "session_version_mismatch" | "session_project_mismatch" | "session_deleted" | "pseudonym_in_other_experiment";

/** A fresh random pseudonym, made on the Service (CR-65: never derived from anything). */
function freshPseudonym(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return "pp-" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Open a participant session for a served link (CR-21, CR-73). The attribution is derived
 * from the link and its experiment. A caller that also CLAIMS an experiment or version (the
 * participant snippet's later events, cr-evidence) is refused when the claim is not the
 * link's: a session claiming another experiment, or a version that is not what the
 * experiment pins for this link, writes nothing.
 */
export async function openParticipantSession(
  record: LocalRecord,
  input: {
    link: Pick<TestLink, "id" | "experiment_id" | "project_id" | "channel" | "variant_id">;
    experiment: Pick<Experiment, "id" | "project_id" | "product_version_id" | "declarations">;
    sessionId: string;
    at: number;
    claimed?: { experiment?: string; product_version?: string; project?: string };
    /** The participant's random per-experiment pseudonym, as the snippet made it (cr-evidence, CR-65). */
    pseudonym?: string;
  },
): Promise<{ ok: true; attribution: SessionAttribution; created: boolean } | { ok: false; code: SessionRefusal }> {
  const { link, experiment } = input;
  if (link.experiment_id !== experiment.id || (input.claimed?.experiment !== undefined && input.claimed.experiment !== link.experiment_id)) return { ok: false, code: "session_experiment_mismatch" };
  if (link.project_id !== experiment.project_id || (input.claimed?.project !== undefined && input.claimed.project !== link.project_id)) return { ok: false, code: "session_project_mismatch" };
  const version = pinnedVersion(experiment, link.variant_id);
  if (!version || (input.claimed?.product_version !== undefined && input.claimed.product_version !== version)) return { ok: false, code: "session_version_mismatch" };
  const attribution: SessionAttribution = {
    project: link.project_id,
    experiment: experiment.id,
    product_version: version,
    link: link.id,
    ...(link.channel ? { channel: link.channel } : {}),
    ...(link.variant_id ? { variant: link.variant_id } : {}),
  };
  // CR-65: the page's pseudonym links sessions only in an experiment that declared repeated-use
  // measurement. Otherwise the Service ignores what the page sent and gives the session a fresh
  // pseudonym of its own, so no two sessions of an undeclared experiment can share one.
  const pseudonym = experiment.declarations?.repeated_use === true ? input.pseudonym : freshPseudonym();
  try {
    const { created } = await record.linkSessionKey(experiment.id, { host: PUBLISHED_HOST, session_id: input.sessionId, by: "adapter_explicit", at: input.at, attribution, ...(pseudonym ? { pseudonym } : {}) });
    return { ok: true, attribution, created };
  } catch (e) {
    const code = e instanceof Error ? e.message : "";
    if (code === "session_deleted" || code === "pseudonym_in_other_experiment") return { ok: false, code };
    throw e;
  }
}

/**
 * Where a session is counted (CR-73): under its link's channel label, as "unlabelled" when its
 * link has none, and as "unknown channel" when no link is recorded. Never assigned by guess.
 */
export type ChannelOf = { kind: "channel"; label: string } | { kind: "unlabelled" } | { kind: "unknown" };
export function channelOf(attribution: SessionAttribution | null): ChannelOf {
  if (!attribution?.link) return { kind: "unknown" };
  return attribution.channel ? { kind: "channel", label: attribution.channel } : { kind: "unlabelled" };
}

export interface ChannelCounts {
  channels: Record<string, number>;
  unlabelled: number;
  unknown: number;
}

/**
 * Sessions opened per channel for one experiment. A usage observation, never a demand claim
 * (SX-58): it counts link opens, not people or interest.
 */
export async function sessionsByChannel(record: LocalRecord, experimentId: string): Promise<ChannelCounts> {
  const out: ChannelCounts = { channels: {}, unlabelled: 0, unknown: 0 };
  for (const s of await record.sessionLinks(PUBLISHED_HOST)) {
    if (s.task !== experimentId) continue;
    const ch = channelOf(s.attribution);
    if (ch.kind === "channel") out.channels[ch.label] = (out.channels[ch.label] ?? 0) + 1;
    else out[ch.kind]++;
  }
  return out;
}

// ── cr-evidence (#1394): participant events, manual records, evidence read ─────


/** Policy values (CR-70 "rate limits are policy"). */
export const EVIDENCE_LIMITS = {
  /** Events one participant session may record (the per-session-token limit; event ids are `e1`…`e300`). */
  maxEventsPerSession: 300,
  /** Events in one request from the snippet. */
  maxEventsPerBatch: 50,
  /** Event batches a link may take per window, across all its sessions. */
  eventBatchesPerWindow: 600,
  /** Event batches one participant session may send per window (its own window, before the link's). */
  eventBatchesPerSessionWindow: 60,
  /** Session opens a link may take per window (a scripted client cannot fill its 5000-session bound at once). */
  opensPerWindow: 600,
  windowMs: 60_000,
  /** Manual records one experiment may hold. */
  maxNotesPerExperiment: 500,
  /** Draft revisions one experiment may hold. */
  maxDraftRevisionsPerExperiment: 500,
} as const;

const PROGRAM = "hps-participant/1";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, n: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= n;
const CLIENT_EVENT_KEYS = ["kind", "seq", "label", "target", "field", "value", "path"];

export type EventRefusal =
  | "identity_field"
  | "invalid_event"
  | "too_many_events"
  | "session_event_limit"
  | "variant_required"
  | "session_not_open"
  | "session_version_mismatch";

/** What the stored event says, in words a reviewer reads; never a typed value. */
/** A page path as the participant snippet sends it: the path under the link, no query string. */
function describe(kind: ParticipantEventKind, e: { label?: string; target?: { role: string; path: string }; field?: string }, path?: string): string {
  if (kind === "task_start" || kind === "task_complete" || kind === "milestone") return `${kind}: ${e.label}`;
  if (kind === "click") return `click: ${e.target!.role} ${e.target!.path}`;
  if (kind === "input") return `input: ${e.field ?? e.target!.path}`;
  if (kind === "page_view") return `page_view: ${path ?? ""}`.trim();
  return "session_start";
}

/**
 * Turn the snippet's events into stored participant events (CR-23, CR-65, CR-67, CR-74). A task
 * or milestone label is free text the page chose, so it is kept only when the experiment
 * declared that name (`declarations.labels`); an event with any other label (a typed value the
 * page passed as a label) is dropped and counted, never stored. The
 * page sends only what happened (kind, sequence, a task label, a clicked element's role and
 * path, an input field); everything that says WHERE it belongs (project, experiment,
 * version, link, channel, variant, pseudonym) is copied from the session the Service
 * recorded, never taken from the page. A typed value is kept only for a field the experiment
 * declared (CR-67); otherwise the event keeps the fact of the input, not its content.
 */
export function participantEvents(
  input: {
    experiment: Pick<Experiment, "id" | "declarations">;
    sessionId: string;
    link: { attribution: SessionAttribution; pseudonym?: string };
    linkId: string;
    events: unknown;
    now: number;
  },
): { ok: true; events: ObservationEvent[]; values_dropped: number; labels_dropped: number } | { ok: false; code: EventRefusal } {
  const raw = input.events;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, code: "invalid_event" };
  if (raw.length > EVIDENCE_LIMITS.maxEventsPerBatch) return { ok: false, code: "too_many_events" };
  try {
    forbidIdentityFields(raw);
  } catch {
    return { ok: false, code: "identity_field" };
  }
  const a = input.link.attribution;
  if (isComparison(input.experiment.declarations) && !a.variant) return { ok: false, code: "variant_required" };
  const declared = new Set(input.experiment.declarations?.raw_input?.fields ?? []);
  const labels = new Set((input.experiment.declarations?.labels ?? []).map((l) => l.trim()));
  let labelsDropped = 0;
  const when = new Date(input.now).toISOString();
  const pseudonym = input.link.pseudonym;
  const out: ObservationEvent[] = [];
  let dropped = 0;
  for (const e of raw) {
    if (!isObj(e) || !Object.keys(e).every((k) => CLIENT_EVENT_KEYS.includes(k))) return { ok: false, code: "invalid_event" };
    const kind = e.kind as ParticipantEventKind;
    if (!(PARTICIPANT_EVENT_KINDS as readonly string[]).includes(String(kind))) return { ok: false, code: "invalid_event" };
    if (!Number.isSafeInteger(e.seq) || (e.seq as number) < 1) return { ok: false, code: "invalid_event" };
    if ((e.seq as number) > EVIDENCE_LIMITS.maxEventsPerSession) return { ok: false, code: "session_event_limit" };
    const labelled = kind === "task_start" || kind === "task_complete" || kind === "milestone";
    if (labelled ? !str(e.label, 80) : e.label !== undefined) return { ok: false, code: "invalid_event" };
    const targeted = kind === "click" || kind === "input";
    const t = e.target;
    if (targeted ? !(isObj(t) && Object.keys(t).length === 2 && str(t.role, 40) && str(t.path, 300)) : t !== undefined) return { ok: false, code: "invalid_event" };
    if (kind !== "input" && (e.field !== undefined || e.value !== undefined)) return { ok: false, code: "invalid_event" };
    if (e.field !== undefined && !str(e.field, 60)) return { ok: false, code: "invalid_event" };
    if (e.value !== undefined && !(typeof e.value === "string" && e.value.length <= 2000)) return { ok: false, code: "invalid_event" };
    if (kind === "page_view" ? !(e.path === undefined || (typeof e.path === "string" && e.path.startsWith("/") && e.path.length <= 300)) : e.path !== undefined) return { ok: false, code: "invalid_event" };
    if (labelled && !labels.has((e.label as string).trim())) {
      labelsDropped++;
      continue;
    }
    const keep = kind === "input" && typeof e.value === "string" && typeof e.field === "string" && declared.has(e.field);
    if (kind === "input" && e.value !== undefined && !keep) dropped++;
    out.push({
      id: `e${e.seq}`,
      seq: e.seq as number,
      task: input.experiment.id,
      at: input.now,
      kind,
      text: describe(kind, e as { label?: string; target?: { role: string; path: string }; field?: string }, typeof e.path === "string" ? e.path : undefined),
      actor: "external_user",
      assistance: "unknown",
      evidence_type: "action",
      source_kind: "test",
      source_state: "real",
      provenance: { who: pseudonym ?? "anonymous-participant", when, where: `test-link:${input.linkId}` },
      participant: { session_id: input.sessionId, ...(pseudonym ? { pseudonym } : {}) },
      attribution: { project: a.project, experiment: a.experiment, product_version: a.product_version, ...(a.link ? { link: a.link } : {}), ...(a.channel ? { channel: a.channel } : {}), ...(a.variant ? { variant: a.variant } : {}) },
      ...(targeted ? { target: { role: (t as { role: string }).role, path: (t as { path: string }).path } } : {}),
      ...(labelled ? { label: (e.label as string).trim() } : {}),
      ...(keep ? { input_value: e.value as string } : {}),
    });
  }
  return { ok: true, events: out, values_dropped: dropped, labels_dropped: labelsDropped };
}

/**
 * The same participant event, as the page sent it: everything but the Service's receive time
 * (`at`, `provenance.when`), which differs on every delivery. A redelivered batch (a lost
 * response, a retry after a 5xx) is then a duplicate; different content under one id is still
 * a conflict.
 */
export function sameClientEvent(stored: ObservationEvent, incoming: ObservationEvent): boolean {
  const strip = (e: ObservationEvent) => ({ ...e, at: 0, provenance: { ...e.provenance, when: "" } });
  return canonicalJson(strip(stored)) === canonicalJson(strip(incoming));
}

/** Append one batch of participant events to the experiment's record (constant cost; bounded by the caller). */
export async function appendParticipantEvents(record: LocalRecord, experimentId: string, sessionId: string, events: ObservationEvent[]): Promise<{ stored: number; duplicates: number; refused_deleted: number }> {
  const batch = { format: OBSERVATION_FORMAT_V2, scope: experimentId, session: sessionId, program: PROGRAM, events };
  const r = await record.appendObservations(PUBLISHED_HOST, batch, { quota: "none", gaps: false, sameEvent: sameClientEvent });
  return { stored: r.stored, duplicates: r.duplicates, refused_deleted: r.refused_deleted };
}

export type NoteRefusal = "invalid_note" | "missing_provenance" | "missing_source_state" | "missing_locator" | "variant_required" | "unknown_variant" | "note_limit";

const NOTE_ACTOR: Record<ManualRecordKind, "user" | "external_user"> = {
  observer_note: "user",
  interview_note: "external_user",
  quote: "external_user",
  anomaly: "user",
  external_source: "user",
};

/**
 * A manual record (CR-24): one `external_feedback_received` event in the experiment's notes
 * session, with the provenance its kind needs (who, when, in what situation; for an external
 * source also the document and a locator) and the `source_state` the student chose. Nothing
 * is filled in with a guess: a missing provenance or source state is refused by name. The
 * text is kept verbatim (Korean and English alike).
 */
export function noteEvent(
  input: { experiment: Pick<Experiment, "id" | "project_id" | "week" | "product_version_id" | "declarations">; note: unknown; id: string; now: number },
): { ok: true; event: ObservationEvent } | { ok: false; code: NoteRefusal } {
  const n = input.note;
  if (!isObj(n)) return { ok: false, code: "invalid_note" };
  try {
    forbidIdentityFields(n);
  } catch {
    return { ok: false, code: "invalid_note" };
  }
  if (!Object.keys(n).every((k) => ["note_kind", "text", "provenance", "source_state", "locator", "variant"].includes(k))) return { ok: false, code: "invalid_note" };
  if (!(MANUAL_RECORD_KINDS as readonly string[]).includes(String(n.note_kind)) || !str(n.text, 2000)) return { ok: false, code: "invalid_note" };
  const kind = n.note_kind as ManualRecordKind;
  const p = n.provenance;
  if (!isObj(p) || !str(p.who, 200) || !str(p.when, 200) || !str(p.where, 200) || Object.keys(p).length !== 3) return { ok: false, code: "missing_provenance" };
  if (n.source_state === undefined || n.source_state === null) return { ok: false, code: "missing_source_state" };
  if (!(SOURCE_STATES as readonly string[]).includes(String(n.source_state))) return { ok: false, code: "invalid_note" };
  if (kind === "external_source" ? !str(n.locator, 500) : n.locator !== undefined) return { ok: false, code: kind === "external_source" ? "missing_locator" : "invalid_note" };
  const variants = input.experiment.declarations?.variants ?? [];
  if (isComparison(input.experiment.declarations)) {
    if (!str(n.variant, 64)) return { ok: false, code: "variant_required" };
    if (!variants.some((v) => v.id === n.variant)) return { ok: false, code: "unknown_variant" };
  } else if (n.variant !== undefined) return { ok: false, code: "unknown_variant" };
  const variant = n.variant as string | undefined;
  const v = variant ? variants.find((x) => x.id === variant) : undefined;
  const version = v?.alternative ? undefined : (v?.product_version_id ?? input.experiment.product_version_id);
  const actor = NOTE_ACTOR[kind];
  const text = n.text as string;
  const event: ObservationEvent = {
    id: input.id,
    seq: 1,
    task: input.experiment.id,
    at: input.now,
    kind: "external_feedback_received",
    text,
    student_text: text,
    actor,
    assistance: "unknown",
    evidence_type: "action",
    source_kind: kind === "interview_note" || kind === "quote" ? "interview" : kind === "external_source" ? (/^https?:\/\//i.test(String(n.locator)) ? "link" : "article") : "test",
    source_state: n.source_state as ObservationEvent["source_state"],
    provenance: { who: (p.who as string).trim(), when: (p.when as string).trim(), where: (p.where as string).trim() },
    context: { week: input.experiment.week, step_id: "cr-evidence-note", task: input.experiment.id, module_version: "unversioned" },
    attribution: { project: input.experiment.project_id, experiment: input.experiment.id, ...(version ? { product_version: version } : {}), ...(variant ? { variant } : {}) },
    note_kind: kind,
    ...(kind === "external_source" ? { locator: (n.locator as string).trim() } : {}),
  };
  return { ok: true, event };
}

/** Store a manual record in the experiment's notes session (linked once, constant cost). */
export async function addNote(record: LocalRecord, experiment: Pick<Experiment, "id" | "project_id" | "product_version_id">, event: ObservationEvent): Promise<{ stored: number }> {
  await record.linkSessionKey(experiment.id, { host: NOTES_HOST, session_id: experiment.id, by: "user", at: event.at, attribution: { project: experiment.project_id, experiment: experiment.id, product_version: experiment.product_version_id } });
  // Validate first so a refusal names the rule (the record validates again on append).
  validateObservation({ format: OBSERVATION_FORMAT_V2, scope: experiment.id, session: experiment.id, program: "hps-notes/1", events: [event] });
  const r = await record.appendObservations(NOTES_HOST, { format: OBSERVATION_FORMAT_V2, scope: experiment.id, session: experiment.id, program: "hps-notes/1", events: [event] }, { quota: "none", gaps: false });
  return { stored: r.stored };
}

const eventsOf = (records: readonly ObservationRecord[]) => records.map((r) => r.event);

export interface ExperimentEvidence {
  experiment_id: string;
  sessions: ParticipantSession[];
  notes: ObservationEvent[];
  /** Every draft revision, oldest first; each item carries how its references resolve now (CR-27). */
  drafts: Array<EvidenceDraft & { items: Array<EvidenceDraft["items"][number] & { sources: Array<{ ref: string; state: "ok" | "missing" | "deleted" | "foreign" }>; comparison?: "supported" | "unsupported" }> }>;
  /** The runtime's own observed items over the records, revision 1 of a draft the student can keep (CR-25). */
  runtime_draft: EvidenceDraft | null;
  returns: ReturnType<typeof returnEvidence>;
  variants: ReturnType<typeof variantResults>;
  review_input: ReturnType<typeof reviewInput>;
  /** Per link: sessions opened in the busiest hour, so a reviewer sees a flood from one link (recon §6). */
  bursts: Array<{ link: string; busiest_hour_sessions: number; flagged: boolean }>;
}

const BURST_SESSIONS_PER_HOUR = 30;

/** Everything a member reads about one experiment's evidence, computed from the record on every read. */
export async function experimentEvidence(record: LocalRecord, experiment: Pick<Experiment, "id" | "product_version_id" | "declarations">, now: number): Promise<ExperimentEvidence> {
  const links = (await record.sessionLinks(PUBLISHED_HOST)).filter((l) => l.task === experiment.id);
  const events = eventsOf(await record.observationsOf(PUBLISHED_HOST, experiment.id));
  const notes = eventsOf(await record.observationsOf(NOTES_HOST, experiment.id)).sort((a, b) => a.at - b.at);
  const sessions = participantSessions(experiment.id, links, events);
  const variantOf = variantOfRef(sessions, notes);
  const drafts: ExperimentEvidence["drafts"] = [];
  const stored = await record.evidenceDrafts(experiment.id);
  // The deletion tombstones are read once per evidence read, not once per reference.
  const deleted = stored.length ? await record.deletedEvidenceKeys() : new Set<string>();
  for (const d of stored) {
    const items = [];
    for (const it of d.items) {
      const sources = [];
      for (const ref of it.source_refs) sources.push({ ref, state: await record.resolveEvidenceRef(experiment.id, ref, deleted) });
      const comparison = comparisonSupport(it, variantOf);
      items.push({ ...it, sources, ...(comparison ? { comparison } : {}) });
    }
    drafts.push({ ...d, items });
  }
  const perLink = new Map<string, number[]>();
  for (const l of links) if (l.attribution?.link && typeof l.at === "number") (perLink.get(l.attribution.link) ?? perLink.set(l.attribution.link, []).get(l.attribution.link)!).push(l.at);
  const bursts = [...perLink].map(([link, ats]) => {
    const sorted = ats.sort((a, b) => a - b);
    let best = 0;
    for (let i = 0, j = 0; i < sorted.length; i++) {
      while (sorted[i]! - sorted[j]! > 3600_000) j++;
      best = Math.max(best, i - j + 1);
    }
    return { link, busiest_hour_sessions: best, flagged: best > BURST_SESSIONS_PER_HOUR };
  });
  return {
    experiment_id: experiment.id,
    sessions,
    notes,
    drafts,
    runtime_draft: runtimeDraft({ id: "runtime", experiment: { ...experiment }, sessions, notes, at: now }),
    returns: returnEvidence(experiment.declarations, sessions),
    variants: variantResults(experiment, sessions, notes),
    review_input: reviewInput({ experiment: { ...experiment }, sessions, notes, drafts: stored }),
    bursts,
  };
}
