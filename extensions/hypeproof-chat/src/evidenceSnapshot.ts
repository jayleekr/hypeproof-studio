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
export interface SnapshotFile { name: string; bytes: number; sha256: string; uploaded: boolean }
/** `scope` and `binding` are what the copy was frozen FOR. A state without them predates the binding contract and is never resumed. */
export interface SnapshotState { batch_id: string; revision: number; files: SnapshotFile[]; scope?: { grant_id: string; class_run_id: string; seat_id: string; student: { u: string; c: string; p: string } }; binding?: SnapshotBinding; receipt_id?: string; coverage?: string; result?: string }
export interface SnapshotDeps {
  /** Take (or re-open) the immutable copy for this batch+revision, with the binding it was frozen under. */
  copy(batchId: string, revision: number): Promise<{ files: Array<{ name: string; data: Uint8Array }>; binding: SnapshotBinding } | { code: string } | null>;
  /** The connection this upload runs under. A stored state frozen for another grant is not this learner's to send. */
  scope(): SnapshotScope | null;
  loadState(batchId: string): Promise<SnapshotState | null>;
  saveState(s: SnapshotState): Promise<void>;
  /** status 0 = never reached the Service. */
  put(batchId: string, revision: number, name: string, data: Uint8Array): Promise<{ status: number; reason?: string }>;
  seal(batchId: string, revision: number, manifest: unknown): Promise<{ status: number; reason?: string; receipt_id?: string; coverage?: string }>;
}
export interface SnapshotResult { ok: boolean; code: string }
const sha = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");

const scopeOf = (s: SnapshotScope) => ({ grant_id: s.grant_id, class_run_id: s.class_run_id, seat_id: s.seat_id, student: s.student });
type Copy = { files: Array<{ name: string; data: Uint8Array }>; binding: SnapshotBinding };
const stateFor = (batchId: string, revision: number, copy: Copy, scope: SnapshotScope): SnapshotState => ({ batch_id: batchId, revision, scope: scopeOf(scope), binding: copy.binding, files: copy.files.filter((f) => (SNAPSHOT_FILE_NAMES as readonly string[]).includes(f.name)).map((f) => ({ name: f.name, bytes: f.data.byteLength, sha256: sha(f.data), uploaded: false })) });

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
  if (state && (!state.scope || !state.binding || state.scope.grant_id !== scope.grant_id || state.scope.student.u !== scope.student.u || state.scope.class_run_id !== scope.class_run_id)) return { ok: false, code: "foreign_pending_copy" };
  if (state?.receipt_id) return { ok: true, code: "receipt_verified" }; // already proven; never re-sent as a new input
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = state?.revision ?? 1;
    const copy = await deps.copy(batchId, revision);
    if (!copy) return { ok: false, code: "nothing_recorded" };
    if ("code" in copy) return { ok: false, code: copy.code };
    const allowed = copy.files.filter((f) => (SNAPSHOT_FILE_NAMES as readonly string[]).includes(f.name));
    if (!allowed.some((f) => f.name === "events.jsonl") || !allowed.some((f) => f.name === "session.meta.json")) return { ok: false, code: "nothing_recorded" };
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
    const sealed = await deps.seal(batchId, revision, { schema: SNAPSHOT_SCHEMA, files: state.files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 })), binding: state.binding });
    if (sealed.status === 0 || sealed.status >= 500) return { ok: false, code: "offline_pending" };
    if ((sealed.status === 200 || sealed.status === 201) && sealed.receipt_id) { state.receipt_id = sealed.receipt_id; state.coverage = sealed.coverage; state.result = "receipt_verified"; await deps.saveState(state); return { ok: true, code: "receipt_verified" }; }
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
