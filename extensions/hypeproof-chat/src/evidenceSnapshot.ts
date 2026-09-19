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

export const SNAPSHOT_SCHEMA = "hps-classroom-snapshot/1";
export const SNAPSHOT_FILE_NAMES = ["session.meta.json", "events.jsonl"] as const;
export interface SnapshotFile { name: string; bytes: number; sha256: string; uploaded: boolean }
export interface SnapshotState { batch_id: string; revision: number; files: SnapshotFile[]; receipt_id?: string; coverage?: string; result?: string }
export interface SnapshotDeps {
  /** Take (or re-open) the immutable copy for this batch+revision. null → nothing recorded for this class. */
  copy(batchId: string, revision: number): Promise<Array<{ name: string; data: Uint8Array }> | null>;
  loadState(batchId: string): Promise<SnapshotState | null>;
  saveState(s: SnapshotState): Promise<void>;
  /** status 0 = never reached the Service. */
  put(batchId: string, revision: number, name: string, data: Uint8Array): Promise<{ status: number; reason?: string }>;
  seal(batchId: string, revision: number, manifest: unknown): Promise<{ status: number; reason?: string; receipt_id?: string; coverage?: string }>;
}
export interface SnapshotResult { ok: boolean; code: string }
const sha = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");

async function nextRevision(batchId: string, revision: number, deps: SnapshotDeps): Promise<SnapshotState | null> {
  const files = await deps.copy(batchId, revision + 1);
  if (!files) return null;
  const state: SnapshotState = { batch_id: batchId, revision: revision + 1, files: files.filter((f) => (SNAPSHOT_FILE_NAMES as readonly string[]).includes(f.name)).map((f) => ({ name: f.name, bytes: f.data.byteLength, sha256: sha(f.data), uploaded: false })) };
  await deps.saveState(state);
  return state;
}

export async function uploadSnapshot(batchId: string, deps: SnapshotDeps): Promise<SnapshotResult> {
  let state = await deps.loadState(batchId);
  if (state?.receipt_id) return { ok: true, code: "receipt_verified" }; // already proven; never re-sent as a new input
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = state?.revision ?? 1;
    const files = await deps.copy(batchId, revision);
    if (!files) return { ok: false, code: "nothing_recorded" };
    const allowed = files.filter((f) => (SNAPSHOT_FILE_NAMES as readonly string[]).includes(f.name));
    if (!allowed.some((f) => f.name === "events.jsonl")) return { ok: false, code: "nothing_recorded" };
    if (!state) { state = { batch_id: batchId, revision, files: allowed.map((f) => ({ name: f.name, bytes: f.data.byteLength, sha256: sha(f.data), uploaded: false })) }; await deps.saveState(state); }
    // The copy must still be the bytes that were hashed: a changed copy is a new revision, never a quiet overwrite.
    if (allowed.some((f) => state!.files.find((x) => x.name === f.name)?.sha256 !== sha(f.data))) { state = await nextRevision(batchId, revision, deps); if (!state) return { ok: false, code: "nothing_recorded" }; continue; }
    let moved = false;
    for (const f of allowed) {
      const entry = state.files.find((x) => x.name === f.name)!;
      if (entry.uploaded) continue;
      const r = await deps.put(batchId, revision, f.name, f.data);
      if (r.status === 0 || r.status >= 500 || r.status === 429) return { ok: false, code: "offline_pending" }; // kept; resumes next sync/run
      if (r.status === 409) { moved = true; break; } // the Service holds other bytes for this revision → next revision
      if (r.status !== 200 && r.status !== 201) return { ok: false, code: r.reason && /^[a-z_]{1,48}$/.test(r.reason) ? r.reason : "upload_refused" };
      entry.uploaded = true; await deps.saveState(state);
    }
    if (moved) { state = await nextRevision(batchId, revision, deps); if (!state) return { ok: false, code: "nothing_recorded" }; continue; }
    const sealed = await deps.seal(batchId, revision, { schema: SNAPSHOT_SCHEMA, files: state.files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 })) });
    if (sealed.status === 0 || sealed.status >= 500) return { ok: false, code: "offline_pending" };
    if ((sealed.status === 200 || sealed.status === 201) && sealed.receipt_id) { state.receipt_id = sealed.receipt_id; state.coverage = sealed.coverage; state.result = "receipt_verified"; await deps.saveState(state); return { ok: true, code: "receipt_verified" }; }
    state.result = sealed.reason ?? "verify_failed"; await deps.saveState(state);
    return { ok: false, code: sealed.reason && /^[a-z_]{1,48}$/.test(sealed.reason) ? sealed.reason : "verify_failed" };
  }
  return { ok: false, code: "revision_limit" };
}
