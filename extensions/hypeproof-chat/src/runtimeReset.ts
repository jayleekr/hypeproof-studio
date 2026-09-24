// Remote classroom operations (#751, R3) — evidence-preserving runtime reset.
//
// What this is NOT: clearHistory(), a workspace wipe, a credential reset or a
// reboot. `ResetSteps` has no operation that deletes or truncates anything, so
// this module cannot lose a learner's conversation, draft, files or spool even
// by mistake. It stops the stuck run, proves what is being kept, starts a new
// execution generation on the same files, and checks it came back.
//
// Order is the contract:
//   freeze input → stop and CONFIRM stopped → record what is preserved (durably)
//   → new generation → compare preserved state → probe → unfreeze (always).
// Stop or preservation that cannot be confirmed ends the reset before anything
// changes. No `vscode` import: every effect is injected.

export interface Preservation {
  history_count: number;
  history_sha256: string;
  /** null when this activity keeps no separate draft. */
  draft_sha256: string | null;
  spool_session: string | null;
  spool_flushed: boolean;
}
export interface ResetManifest {
  schema: "hps-runtime-reset/1";
  command_id: string;
  started_at: number;
  before: Preservation;
  generation_before: number;
  /** Absent until the new generation exists: its presence is the crash-recovery postcondition. */
  generation_after?: number;
  after?: Preservation;
  finished_at?: number;
  result?: string;
}
export interface ResetSteps {
  /** Throws when the draft could not be confirmed saved. */
  freezeInput(): Promise<void>;
  unfreezeInput(): Promise<void>;
  /** Ask every running turn and pending tool approval to end. Must not wait. */
  requestStop(): void;
  /** True only when no stream, send, approval or tool run is left — not merely "abort was called". */
  isStopped(): boolean;
  preserve(): Promise<Preservation>;
  generation(): number;
  /** Durable write (temp file + rename). Throws on failure, e.g. disk full. */
  persistManifest(m: ResetManifest): Promise<void>;
  /** Drop cached runtime handles and start a new execution generation. Deletes nothing. */
  newGeneration(): Promise<number>;
  probe(): Promise<boolean>;
  wait(ms: number): Promise<void>;
  now(): number;
}
export interface ResetResult { ok: boolean; code: string }

export const STOP_CONFIRM_TIMEOUT_MS = 15_000;
const STOP_POLL_MS = 250;

/** Stop and wait for the stop to be real. Also the whole of `cancel_current_run`. */
export async function stopAndConfirm(steps: Pick<ResetSteps, "requestStop" | "isStopped" | "wait">, timeoutMs = STOP_CONFIRM_TIMEOUT_MS): Promise<boolean> {
  if (steps.isStopped()) return true;
  steps.requestStop();
  for (let waited = 0; waited < timeoutMs; waited += STOP_POLL_MS) {
    if (steps.isStopped()) return true;
    await steps.wait(STOP_POLL_MS);
  }
  return steps.isStopped();
}

const same = (a: Preservation, b: Preservation) => a.history_sha256 === b.history_sha256 && a.history_count === b.history_count && a.draft_sha256 === b.draft_sha256;

export async function runPreservingReset(commandId: string, steps: ResetSteps, signal?: AbortSignal, stopTimeoutMs = STOP_CONFIRM_TIMEOUT_MS): Promise<ResetResult> {
  try { await steps.freezeInput(); } catch { await steps.unfreezeInput().catch(() => undefined); return { ok: false, code: "draft_not_saved" }; }
  try {
    if (!(await stopAndConfirm(steps, stopTimeoutMs))) return { ok: false, code: "stop_unconfirmed" };
    if (signal?.aborted) return { ok: false, code: "deadline_before_change" };
    let manifest: ResetManifest;
    try {
      const before = await steps.preserve();
      if (before.spool_session !== null && !before.spool_flushed) return { ok: false, code: "evidence_not_flushed" };
      manifest = { schema: "hps-runtime-reset/1", command_id: commandId, started_at: steps.now(), before, generation_before: steps.generation() };
      await steps.persistManifest(manifest);
    } catch { return { ok: false, code: "preserve_failed" }; }
    // Nothing above changed the runtime. From here on the generation moves.
    const generation = await steps.newGeneration();
    const after = await steps.preserve();
    manifest = { ...manifest, generation_after: generation, after };
    if (!same(manifest.before, after)) { await steps.persistManifest({ ...manifest, finished_at: steps.now(), result: "preservation_mismatch" }).catch(() => undefined); return { ok: false, code: "preservation_mismatch" }; }
    const ready = await steps.probe();
    const result = ready ? "reset_ok" : "reset_done_probe_failed";
    await steps.persistManifest({ ...manifest, finished_at: steps.now(), result }).catch(() => undefined);
    return { ok: ready, code: result };
  } finally {
    await steps.unfreezeInput().catch(() => undefined);
  }
}

/** Crash recovery: did the reset pass the point of no return? */
export function resetPostcondition(m: ResetManifest | null, currentGeneration: number): "done" | "not_done" | "unknown" {
  if (!m) return "not_done";
  if (m.result === "reset_ok") return "done";
  if (m.generation_after !== undefined || currentGeneration !== m.generation_before) return "unknown";
  return "not_done";
}
