// Remote classroom operations (#751, R4) — device half of consented record collection.
//
//   - The snapshot is an immutable COPY taken once (bytes + sha256). The live spool
//     keeps growing; it is never truncated, sealed early or overwritten for this.
//   - Upload state is persisted, so an offline laptop resumes the same revision on
//     the next run instead of starting over or silently giving up.
//   - "Done" is the Service's verified receipt. A 2xx on a file PUT is not.
//   - Only allowlisted spool files are read. Nothing is executed or rendered.
// No `vscode` import: file access, HTTP and storage are injected.
import { createHash } from "crypto";

export const SNAPSHOT_SCHEMA = "hps-classroom-snapshot/2";
/** Who and what this connection may collect for. Copied from the Service's connect response, never typed or guessed. */
export interface SnapshotScope {
  grant_id: string; class_run_id: string; seat_id: string;
  student: { u: string; c: string; p: string };
  activity: { course_id: string; version: string } | null;
  run: { starts_at: number; ends_at: number };
}
export interface SnapshotBinding {
  class_run_id: string; batch_id: string; seat_id: string; spool_session_id: string;
  student: { u: string; c: string; p: string }; activity: { course_id: string; version: string } | null;
  consent: { purpose: string; notice_version: string };
  /**
   * What this copy covers. `first_seq`/`last_seq` are declared only when the START is provable from the live file;
   * `session_last_seq` is the spool's own counter when the copy was read (a lost tail shows as a difference);
   * `other_sessions_in_window` counts sessions of this learner in the class window that this copy does NOT contain.
   * A field the App cannot establish is left out — the Service then answers `range_unknown`, never `complete`.
   */
  range: { lines: number; from_ts: string; to_ts: string; final_line_sha256: string; first_seq?: number; last_seq?: number; session_last_seq?: number; other_sessions_in_window?: number };
}
/** The live spool's sequence state, read together with the bytes (SessionSpool.readForSnapshot). */
export interface SnapshotSource { sequence: { session_id: string; last_seq: number }; other_sessions: number | null }
/** Events of an earlier session on the same PC are another activity: only this class run's window is copied. */
export const WINDOW_LEAD_MS = 30 * 60_000;

/**
 * Turn the live spool files into the immutable copy for ONE batch, or say why nothing may be sent.
 * The spool keeps identity in session.meta.json only. A session that belongs to another learner,
 * cohort or profile — or to nobody — is never sent under this seat's credential.
 */
export function freezeSnapshot(files: Array<{ name: string; data: Uint8Array }>, scope: SnapshotScope, batchId: string, consent: { purpose: string; notice_version: string }, nowMs: number, source?: SnapshotSource):
  { ok: true; files: Array<{ name: string; data: Uint8Array }>; binding: SnapshotBinding } | { ok: false; code: string } {
  const metaFile = files.find((f) => f.name === "session.meta.json"), eventsFile = files.find((f) => f.name === "events.jsonl");
  if (!metaFile || !eventsFile) return { ok: false, code: "nothing_recorded" };
  let meta: { session_id?: unknown; user?: { u?: unknown; c?: unknown; p?: unknown } | null };
  try { meta = JSON.parse(new TextDecoder().decode(metaFile.data)); } catch { return { ok: false, code: "metadata_invalid" }; }
  const user = meta?.user;
  if (!user || typeof user.u !== "string" || typeof user.c !== "string" || typeof user.p !== "string" || typeof meta.session_id !== "string") return { ok: false, code: "identity_unbound" };
  if (user.u !== scope.student.u || user.c !== scope.student.c || user.p !== scope.student.p) return { ok: false, code: "identity_mismatch" };
  const from = scope.run.starts_at - WINDOW_LEAD_MS, kept: string[] = []; let firstTs = "", lastTs = "", sequenced = true; const seqs: number[] = [];
  const rawLines = new TextDecoder().decode(eventsFile.data).split("\n");
  // Bytes after the last newline are an append still in flight (or torn): not a committed line, so not part of the copy.
  rawLines.pop();
  // The seq of the line that sits immediately before the first kept one, when the window (not a loss) excluded it.
  let beforeFirst: number | null | undefined;
  for (const raw of rawLines) {
    if (!raw.trim()) continue;
    let e: { ts?: unknown; seq?: unknown } | null = null; try { e = JSON.parse(raw); } catch { e = null; }
    const at = e && typeof e.ts === "string" ? Date.parse(e.ts) : NaN;
    if (Number.isFinite(at) && (at < from || at > nowMs)) { if (!kept.length) beforeFirst = e && Number.isSafeInteger(e.seq) ? (e.seq as number) : null; continue; } // outside this class run
    kept.push(raw);
    if (e && typeof e.ts === "string") { firstTs ||= e.ts; lastTs = e.ts; }
    if (e && Number.isSafeInteger(e.seq)) seqs.push(e.seq as number); else sequenced = false;
  }
  if (!kept.length) return { ok: false, code: "nothing_recorded" };
  // The start is provable only if the copy begins at the session's first event, or right after an event the window left out.
  const first = seqs.length ? Math.min(...seqs) : 0, startProven = sequenced && seqs.length > 0 && (first === 1 ? beforeFirst === undefined : beforeFirst === first - 1);
  const live = source && source.sequence.session_id === meta.session_id ? source : undefined;
  const events = new TextEncoder().encode(kept.join("\n") + "\n"), iso = new Date(nowMs).toISOString();
  const binding: SnapshotBinding = {
    class_run_id: scope.class_run_id, batch_id: batchId, seat_id: scope.seat_id, spool_session_id: meta.session_id, student: scope.student, activity: scope.activity, consent,
    range: { lines: kept.length, from_ts: firstTs || iso, to_ts: lastTs || iso, final_line_sha256: createHash("sha256").update(kept[kept.length - 1]!).digest("hex"), ...(startProven ? { first_seq: first, last_seq: Math.max(...seqs) } : {}), ...(live && Number.isSafeInteger(live.sequence.last_seq) && live.sequence.last_seq > 0 ? { session_last_seq: live.sequence.last_seq } : {}), ...(live && live.other_sessions !== null ? { other_sessions_in_window: live.other_sessions } : {}) },
  };
  return { ok: true, files: [{ name: "session.meta.json", data: metaFile.data }, { name: "events.jsonl", data: events }], binding };
}
export const SNAPSHOT_FILE_NAMES = ["session.meta.json", "events.jsonl"] as const;

// ── #751 U1b: schema /3 — the kinds a selected collection asked for, over every session of this learner in the class window ──
//
// One PART per spool session: its session.meta.json verbatim, an INDEX of every event of that session inside the window (seq,
// ts, type, the sha256 of the raw line — never content) and the raw lines of the asked kinds only. Each part keeps its own
// session_id and seq; sessions are never concatenated into one stream that would pretend to be one complete sequence. The
// Service reads the same parts back and decides coverage itself (worker/src/lib/classroom-collect.ts verifyCollection); the
// kind rules below are the same rules — worker/test/classroom-ops-collect-kinds.test.mjs checks that both sides agree.
export const SNAPSHOT_SCHEMA_V3 = "hps-classroom-snapshot/3";
export const COLLECT_KINDS = ["record", "prompts", "artifacts"] as const;
export type CollectKind = (typeof COLLECT_KINDS)[number];
const KIND_SETS = ["record", "prompts", "artifacts", "artifacts,prompts"];
export function normalizeKinds(v: unknown): CollectKind[] | null {
  if (!Array.isArray(v) || !v.length || v.some((k) => typeof k !== "string") || new Set(v).size !== v.length) return null;
  const sorted = [...(v as string[])].sort();
  return KIND_SETS.includes(sorted.join(",")) ? (sorted as CollectKind[]) : null;
}
export function kindSelects(kinds: readonly string[], type: unknown, artifactSha: unknown, approved: ReadonlySet<string>): boolean {
  if (kinds.includes("record")) return true;
  if (type === "lesson_binding") return true;
  if (kinds.includes("prompts") && type === "prompt") return true;
  if (kinds.includes("artifacts") && (type === "artifact_approval" || (type === "artifact_snapshot" && typeof artifactSha === "string" && approved.has(artifactSha)))) return true;
  return false;
}
export function approvedArtifacts(entries: Array<{ type?: unknown; ts?: unknown; artifact_sha256?: unknown; approved?: unknown; part: number; order: number }>): Set<string> {
  const list = entries.filter((e) => e.type === "artifact_approval" && typeof e.artifact_sha256 === "string").sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")) || a.part - b.part || a.order - b.order);
  const state = new Map<string, boolean>(); for (const e of list) state.set(e.artifact_sha256 as string, e.approved === true);
  return new Set([...state].filter(([, v]) => v).map(([k]) => k));
}
export const MAX_PARTS = 8;
export interface CollectionPart { part: number; spool_session_id: string; current: boolean; lines: number; included: number; from_ts: string; to_ts: string; first_seq?: number; last_seq?: number; session_last_seq?: number; final_index_sha256: string; torn_tail: boolean }
export interface CollectionBinding { class_run_id: string; batch_id: string; seat_id: string; student: { u: string; c: string; p: string }; activity: { course_id: string; version: string } | null; consent: { purpose: string; notice_version: string }; kinds: CollectKind[]; parts: CollectionPart[]; omitted: { unreadable: number; over_limit: number } }
/** What SessionSpool.readForCollection returns: the current session under the write queue, and this learner's other sessions. */
export interface CollectionSource {
  current: { files: Array<{ name: string; data: Uint8Array }>; sequence: { session_id: string; last_seq: number } } | null;
  others: Array<{ session_id: string; meta: Uint8Array; events: Uint8Array }>;
  omitted: { unreadable: number; over_limit: number };
}
type Kept = { raw: string; e: Record<string, unknown> | null };
/**
 * Turn this learner's sessions into the /3 copy for ONE batch, or say why nothing may be sent. A session whose metadata names
 * anyone else is not part of it. The current session may start in the lead-in before class (as in /2); an EARLIER session
 * contributes only what happened inside the run itself — a class the same learner had before is another activity.
 */
export function freezeCollection(src: CollectionSource, scope: SnapshotScope, batchId: string, consent: { purpose: string; notice_version: string }, kinds: CollectKind[], nowMs: number):
  { ok: true; files: Array<{ name: string; data: Uint8Array }>; binding: CollectionBinding } | { ok: false; code: string } {
  const dec = new TextDecoder(), sessions: Array<{ id: string; meta: Uint8Array; events: Uint8Array; current: boolean; lastSeq?: number }> = [];
  let currentForeign = false;
  if (src.current) {
    const meta = src.current.files.find((f) => f.name === "session.meta.json"), events = src.current.files.find((f) => f.name === "events.jsonl");
    if (meta && events) sessions.push({ id: src.current.sequence.session_id, meta: meta.data, events: events.data, current: true, lastSeq: src.current.sequence.last_seq });
  }
  for (const o of src.others) sessions.push({ id: o.session_id, meta: o.meta, events: o.events, current: false });
  const built: Array<{ current: boolean; id: string; meta: Uint8Array; kept: Kept[]; idx: Array<Record<string, unknown>>; torn: boolean; startProven: boolean; first: number; last: number; lastSeq?: number }> = [];
  for (const s of sessions) {
    let meta: { session_id?: unknown; user?: { u?: unknown; c?: unknown; p?: unknown } | null };
    try { meta = JSON.parse(dec.decode(s.meta)); } catch { if (s.current) currentForeign = true; continue; }
    const u = meta?.user;
    if (!u || u.u !== scope.student.u || u.c !== scope.student.c || u.p !== scope.student.p || meta.session_id !== s.id) { if (s.current) currentForeign = true; continue; }
    const rawLines = dec.decode(s.events).split("\n"), tail = rawLines.pop() ?? "";
    // Bytes after the last newline are an append still in flight (this or another window) or torn by a crash: never part of the copy.
    const torn = tail.length > 0, from = s.current ? scope.run.starts_at - WINDOW_LEAD_MS : scope.run.starts_at, kept: Kept[] = [];
    let beforeFirst: number | null | undefined;
    for (const raw of rawLines) {
      if (!raw.trim()) continue;
      let e: Record<string, unknown> | null = null; try { const v = JSON.parse(raw); e = v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { e = null; }
      const at = e && typeof e.ts === "string" ? Date.parse(e.ts) : NaN;
      if (Number.isFinite(at) && (at < from || at > nowMs)) { if (!kept.length) beforeFirst = e && Number.isSafeInteger(e.seq) ? (e.seq as number) : null; continue; }
      kept.push({ raw, e });
    }
    if (!kept.length) continue;
    const seqs = kept.map((k) => k.e?.seq).filter((q): q is number => Number.isSafeInteger(q)), sequenced = seqs.length === kept.length;
    const first = seqs.length ? Math.min(...seqs) : 0, last = seqs.length ? Math.max(...seqs) : 0;
    const idx = kept.map(({ raw, e }) => ({ seq: e && Number.isSafeInteger(e.seq) ? e.seq : null, ts: e && typeof e.ts === "string" ? e.ts : null, type: e && typeof e.type === "string" ? e.type : null, sha256: createHash("sha256").update(raw).digest("hex"),
      ...(e?.type === "artifact_snapshot" && typeof e.sha256 === "string" ? { artifact_sha256: e.sha256 } : {}),
      ...(e?.type === "artifact_approval" && typeof e.artifact_sha256 === "string" ? { artifact_sha256: e.artifact_sha256, approved: e.approved === true } : {}),
      ...(e?.type === "prompt" && e.text_truncated === true ? { truncated: true } : {}),
      ...(!e ? { malformed: true } : {}) }));
    built.push({ current: s.current, id: s.id, meta: s.meta, kept, idx, torn, startProven: sequenced && seqs.length > 0 && (first === 1 ? beforeFirst === undefined : beforeFirst === first - 1), first, last, ...(s.current && Number.isSafeInteger(s.lastSeq) && s.lastSeq! > 0 ? { lastSeq: s.lastSeq } : {}) });
  }
  if (!built.length) return { ok: false, code: currentForeign && !src.others.length ? "identity_mismatch" : "nothing_recorded" };
  // Parts in time order; the approvals of every part decide which artifact versions are approved (the learner's last word wins).
  built.sort((a, b) => String(a.idx.find((x) => x.ts)?.ts ?? "").localeCompare(String(b.idx.find((x) => x.ts)?.ts ?? "")));
  const parts = built.slice(-MAX_PARTS), overLimit = src.omitted.over_limit + (built.length - parts.length);
  const approved = approvedArtifacts(parts.flatMap((p, n) => p.idx.map((x, order) => ({ ...x, part: n + 1, order }))));
  const iso = new Date(nowMs).toISOString(), enc = new TextEncoder(), files: Array<{ name: string; data: Uint8Array }> = [], decl: CollectionPart[] = [];
  for (const [n, p] of parts.entries()) {
    const part = n + 1, lines = p.idx.map((x) => JSON.stringify(x)), sent = p.kept.filter((k) => kindSelects(kinds, k.e?.type, k.e?.sha256, approved)).map((k) => k.raw);
    const ts = p.idx.map((x) => x.ts).filter((t): t is string => typeof t === "string");
    files.push({ name: `p${part}.meta.json`, data: p.meta }, { name: `p${part}.index.jsonl`, data: enc.encode(lines.join("\n") + "\n") });
    if (sent.length) files.push({ name: `p${part}.events.jsonl`, data: enc.encode(sent.join("\n") + "\n") });
    decl.push({ part, spool_session_id: p.id, current: p.current, lines: lines.length, included: sent.length, from_ts: ts[0] ?? iso, to_ts: ts.at(-1) ?? iso, ...(p.startProven ? { first_seq: p.first, last_seq: p.last } : {}), ...(p.lastSeq ? { session_last_seq: p.lastSeq } : {}), final_index_sha256: createHash("sha256").update(lines.at(-1)!).digest("hex"), torn_tail: p.torn });
  }
  return { ok: true, files, binding: { class_run_id: scope.class_run_id, batch_id: batchId, seat_id: scope.seat_id, student: scope.student, activity: scope.activity, consent, kinds, parts: decl, omitted: { unreadable: src.omitted.unreadable, over_limit: overLimit } } };
}
const V3_FILE_RE = /^p[1-8]\.(meta\.json|index\.jsonl|events\.jsonl)$/;
/** The files a copy consists of: the parts its /3 binding declares, or the two legacy files. */
export function copyFileNames(copy: { binding?: SnapshotBinding; collection?: CollectionBinding }): string[] {
  return copy.collection ? copy.collection.parts.flatMap((p) => [`p${p.part}.meta.json`, `p${p.part}.index.jsonl`, ...(p.included ? [`p${p.part}.events.jsonl`] : [])]) : [...SNAPSHOT_FILE_NAMES];
}

export interface SnapshotFile { name: string; bytes: number; sha256: string; uploaded: boolean }
/**
 * `scope` and `binding`/`collection` are what the copy was frozen FOR. A state without them predates the binding contract and
 * is never resumed. `collection` = a U1b (/3) copy.
 */
export interface SnapshotState { batch_id: string; revision: number; files: SnapshotFile[]; scope?: { grant_id: string; class_run_id: string; seat_id: string; student: { u: string; c: string; p: string } }; binding?: SnapshotBinding; collection?: CollectionBinding; receipt_id?: string; coverage?: string; coverage_reason?: string; result?: string }
export type SnapshotCopy = { files: Array<{ name: string; data: Uint8Array }>; binding?: SnapshotBinding; collection?: CollectionBinding };
export interface SnapshotDeps {
  /** Take (or re-open) the immutable copy for this batch+revision, with the binding it was frozen under. */
  copy(batchId: string, revision: number): Promise<SnapshotCopy | { code: string } | null>;
  /** The connection this upload runs under. A stored state frozen for another grant is not this learner's to send. */
  scope(): SnapshotScope | null;
  loadState(batchId: string): Promise<SnapshotState | null>;
  saveState(s: SnapshotState): Promise<void>;
  /** status 0 = never reached the Service. */
  put(batchId: string, revision: number, name: string, data: Uint8Array): Promise<{ status: number; reason?: string }>;
  seal(batchId: string, revision: number, manifest: unknown): Promise<{ status: number; reason?: string; receipt_id?: string; coverage?: string; coverage_reason?: string }>;
}
export interface SnapshotResult { ok: boolean; code: string }
const sha = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");

const scopeOf = (s: SnapshotScope) => ({ grant_id: s.grant_id, class_run_id: s.class_run_id, seat_id: s.seat_id, student: s.student });
type Copy = SnapshotCopy;
/** Only the files the copy's own binding names ever leave the device — never anything else found next to them. */
const allowedOf = (copy: Copy) => { const names = copyFileNames(copy); return copy.files.filter((f) => names.includes(f.name) && (copy.collection ? V3_FILE_RE.test(f.name) : true)); };
const stateFor = (batchId: string, revision: number, copy: Copy, scope: SnapshotScope): SnapshotState => ({ batch_id: batchId, revision, scope: scopeOf(scope), ...(copy.collection ? { collection: copy.collection } : { binding: copy.binding }), files: allowedOf(copy).map((f) => ({ name: f.name, bytes: f.data.byteLength, sha256: sha(f.data), uploaded: false })) });

async function nextRevision(batchId: string, revision: number, deps: SnapshotDeps, scope: SnapshotScope): Promise<SnapshotState | null> {
  const copy = await deps.copy(batchId, revision + 1);
  if (!copy || "code" in copy) return null;
  const state = stateFor(batchId, revision + 1, copy, scope);
  await deps.saveState(state);
  return state;
}

export async function uploadSnapshot(batchId: string, deps: SnapshotDeps): Promise<SnapshotResult> {
  const scope = deps.scope();
  if (!scope) return { ok: false, code: "not_connected" };
  let state = await deps.loadState(batchId);
  // A copy frozen under another grant (previous learner on a shared PC, a replaced seat) or before the binding
  // contract is never sent with this credential. It is left exactly where it is.
  if (state && (!state.scope || !(state.binding || state.collection) || state.scope.grant_id !== scope.grant_id || state.scope.student.u !== scope.student.u || state.scope.class_run_id !== scope.class_run_id)) return { ok: false, code: "foreign_pending_copy" };
  if (state?.receipt_id) return { ok: true, code: "receipt_verified" }; // already proven; never re-sent as a new input
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = state?.revision ?? 1;
    const copy = await deps.copy(batchId, revision);
    if (!copy) return { ok: false, code: "nothing_recorded" };
    if ("code" in copy) return { ok: false, code: copy.code };
    const allowed = allowedOf(copy);
    if (copyFileNames(copy).some((n) => !allowed.some((f) => f.name === n))) return { ok: false, code: "nothing_recorded" };
    if (!state) { state = stateFor(batchId, revision, copy, scope); await deps.saveState(state); }
    // The copy must still be the bytes that were hashed: a changed copy is a new revision, never a quiet overwrite.
    if (allowed.some((f) => state!.files.find((x) => x.name === f.name)?.sha256 !== sha(f.data))) { state = await nextRevision(batchId, revision, deps, scope); if (!state) return { ok: false, code: "nothing_recorded" }; continue; }
    let moved = false;
    for (const f of allowed) {
      const entry = state.files.find((x) => x.name === f.name)!;
      if (entry.uploaded) continue;
      const r = await deps.put(batchId, revision, f.name, f.data);
      if (r.status === 0 || r.status >= 500 || r.status === 429) return { ok: false, code: "offline_pending" }; // kept; resumes next sync/run
      if (r.status === 409) { moved = true; break; } // the Service holds other bytes for this revision → next revision
      if (r.status !== 200 && r.status !== 201) return await refused(state, r.reason, "upload_refused", deps);
      entry.uploaded = true; await deps.saveState(state);
    }
    if (moved) { state = await nextRevision(batchId, revision, deps, scope); if (!state) return { ok: false, code: "nothing_recorded" }; continue; }
    const listed = state.files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 }));
    const sealed = await deps.seal(batchId, revision, state.collection ? { schema: SNAPSHOT_SCHEMA_V3, files: listed, collection: state.collection } : { schema: SNAPSHOT_SCHEMA, files: listed, binding: state.binding });
    if (sealed.status === 0 || sealed.status >= 500) return { ok: false, code: "offline_pending" };
    if ((sealed.status === 200 || sealed.status === 201) && sealed.receipt_id) { state.receipt_id = sealed.receipt_id; state.coverage = sealed.coverage; if (sealed.coverage_reason) state.coverage_reason = sealed.coverage_reason; state.result = "receipt_verified"; await deps.saveState(state); return { ok: true, code: "receipt_verified" }; }
    return await refused(state, sealed.reason, "verify_failed", deps);
  }
  return { ok: false, code: "revision_limit" };
}
/** A refusal is final for this copy (withdrawn, window closed, not verified): it is recorded so nothing keeps retrying it. */
async function refused(state: SnapshotState, reason: string | undefined, fallback: string, deps: SnapshotDeps): Promise<SnapshotResult> {
  const code = reason && /^[a-z_]{1,48}$/.test(reason) ? reason : fallback;
  state.result = code; await deps.saveState(state);
  return { ok: false, code };
}
