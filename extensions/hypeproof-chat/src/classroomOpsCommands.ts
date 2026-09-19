// Remote classroom operations (#751, R2) — the device half of the command ledger.
//
//   - **Closed allowlist.** An action without a registered executor answers
//     `unsupported`. There is no generic "run", no shell, no URL, no VS Code
//     command id and no file path in the envelope, and `args` must be empty.
//   - **Ask before running.** A command is first answered `accepted`; it only
//     runs after the Service, reading its primary, says `proceed` — and only if
//     the monotonic clock says the start window is still open. The device's wall
//     clock is never consulted.
//   - **Journal before effect.** `running` is persisted before the executor is
//     called. After a crash, a journaled `running` entry is NEVER re-executed:
//     its postcondition is checked, and if that cannot tell, the receipt is
//     `outcome_unknown`. Exactly-once is not claimed.
//   - No `vscode` import: executors, storage and clocks are injected.

export interface CommandEnvelope {
  schema_version: number; command_id: string; action: string; args: Record<string, unknown>;
  lease_generation: number; connection_epoch: number; issued_at: number; start_within_ms: number; run_within_ms: number;
}
export type ReceiptState = "accepted" | "running" | "succeeded" | "failed" | "rejected" | "outcome_unknown" | "unsupported";
export interface Receipt { command_id: string; lease_generation: number; connection_epoch: number; state: ReceiptState; result_code: string; observed_at: number }
export interface ReceiptAck { command_id: string; state: string; proceed: boolean; reason: string }

export interface ExecutorResult { ok: boolean; code: string }
export interface Executor {
  /** True when the action changes learner-visible state; such an action is never auto-retried. */
  mutating: boolean;
  /** Closed argument check. Absent → the action takes no arguments at all. */
  acceptsArgs?(args: Record<string, unknown>): boolean;
  run(signal: AbortSignal, command: CommandEnvelope): Promise<ExecutorResult>;
  /** Did the effect already happen? Consulted only after a crash between `running` and the final receipt. */
  postcondition?(command: CommandEnvelope): Promise<"done" | "not_done" | "unknown">;
}

interface JournalEntry {
  envelope: CommandEnvelope; state: ReceiptState; result_code: string; observed_at: number;
  /** Final receipt delivered and acknowledged — the entry is history, not work. */
  settled: boolean;
  /** `accepted` was answered with proceed. */
  proceed: boolean;
}
export interface JournalState { entries: JournalEntry[] }
export interface JournalStore { load(): Promise<JournalState | null>; save(s: JournalState): Promise<void> }

const SAFE_CODE = /^[a-z0-9_.-]{1,64}$/;
const TERMINAL: ReceiptState[] = ["succeeded", "failed", "rejected", "outcome_unknown", "unsupported"];
const JOURNAL_KEEP = 200;

export interface RunnerDeps {
  executors: Record<string, Executor>;
  journal: JournalStore;
  /** Monotonic ms (performance.now-like). Wall-clock changes must not move deadlines. */
  monotonic(): number;
  now(): number;
  /** The epoch the Service last reported for this connection. */
  epoch(): number;
  /** Shown to the learner: who did what. The learner's own Stop keeps working regardless. */
  notify?(line: string): void;
  log?(line: string): void;
}

export class CommandRunner {
  private state: JournalState = { entries: [] };
  private received = new Map<string, number>();
  private running = false;
  private closed = false;
  private current: AbortController | null = null;
  private deps: RunnerDeps;
  constructor(deps: RunnerDeps) { this.deps = deps; }

  /** Call once at start-up, before the first sync. */
  async recover(): Promise<void> {
    this.state = (await this.deps.journal.load().catch(() => null)) ?? { entries: [] };
    for (const e of this.state.entries) {
      if (e.settled || TERMINAL.includes(e.state)) continue;
      if (e.state === "accepted") { this.finish(e, "rejected", "restart_before_run"); continue; } // nothing ran
      // state === "running": the effect may or may not have happened. Look; never redo.
      const ex = this.deps.executors[e.envelope.action];
      let verdict: "done" | "not_done" | "unknown" = "unknown";
      try { verdict = (await ex?.postcondition?.(e.envelope)) ?? "unknown"; } catch { verdict = "unknown"; }
      if (verdict === "done") this.finish(e, "succeeded", "recovered_postcondition");
      else if (verdict === "not_done" && ex && !ex.mutating) this.finish(e, "failed", "interrupted");
      else this.finish(e, "outcome_unknown", "interrupted");
    }
    await this.save();
  }

  private finish(e: JournalEntry, state: ReceiptState, code: string): void {
    e.state = state; e.result_code = SAFE_CODE.test(code) ? code : ""; e.observed_at = this.deps.now();
  }
  private async save(): Promise<void> {
    const settled = this.state.entries.filter((e) => e.settled);
    if (settled.length > JOURNAL_KEEP) this.state.entries = this.state.entries.filter((e) => !e.settled || settled.indexOf(e) >= settled.length - JOURNAL_KEEP);
    await this.deps.journal.save(this.state);
  }

  /**
   * The connection this runner served is gone (learner disconnected, re-paired, seat replaced, credential expired).
   * Nothing may START from here on. An action that is already running is asked to stop; whether its effect landed is
   * a separate question, answered by its receipt (`outcome_unknown` for a state-changing action), never assumed.
   */
  close(): void { this.closed = true; this.current?.abort(); }
  get isClosed(): boolean { return this.closed; }

  /** Receipts the Service has not acknowledged yet. Sent on every sync until it does. */
  pendingReceipts(): Receipt[] {
    return this.state.entries.filter((e) => !e.settled).slice(0, 50).map((e) => ({ command_id: e.envelope.command_id, lease_generation: e.envelope.lease_generation, connection_epoch: e.envelope.connection_epoch, state: e.state, result_code: e.result_code, observed_at: e.observed_at }));
  }

  async onCommands(cmds: CommandEnvelope[]): Promise<void> {
    if (this.closed) return;
    let changed = false;
    for (const c of cmds) {
      if (!c || typeof c.command_id !== "string" || this.state.entries.some((e) => e.envelope.command_id === c.command_id)) continue; // re-delivery
      const entry: JournalEntry = { envelope: c, state: "accepted", result_code: "", observed_at: this.deps.now(), settled: false, proceed: false };
      if (!this.deps.executors[c.action]) this.finish(entry, "unsupported", "unknown_action");
      else if (c.args && Object.keys(c.args).length && !this.deps.executors[c.action]!.acceptsArgs?.(c.args)) this.finish(entry, "rejected", "args_not_allowed");
      else if (c.connection_epoch !== this.deps.epoch()) this.finish(entry, "rejected", "epoch_stale");
      else this.received.set(c.command_id, this.deps.monotonic());
      this.state.entries.push(entry); changed = true;
    }
    if (changed) await this.save();
  }

  /** Returns true when something ran, so the caller can sync the result promptly. */
  async onAcks(acks: ReceiptAck[]): Promise<boolean> {
    if (this.closed) return false;
    let ran = false;
    for (const a of acks) {
      const e = this.state.entries.find((x) => x.envelope.command_id === a.command_id);
      if (!e || e.settled) continue;
      if (TERMINAL.includes(e.state)) { if (a.state === e.state || a.reason === "recorded" || a.reason === "terminal" || a.reason === "not_found" || a.reason === "epoch_stale" || a.reason === "lease_lost") e.settled = true; continue; }
      if (e.state === "accepted") {
        if (a.proceed && a.state === "accepted") e.proceed = true;
        // Expired, cancelled, superseded lease or epoch: the Service said no, so nothing runs.
        else if (!a.proceed) { this.finish(e, "rejected", a.state === "expired" ? "expired" : a.state === "cancelled" ? "cancelled" : SAFE_CODE.test(a.reason) ? a.reason : "refused"); e.settled = true; }
      }
    }
    await this.save();
    for (const e of this.state.entries) if (e.state === "accepted" && e.proceed && !this.running && !this.closed) { await this.execute(e); ran = true; }
    return ran;
  }

  private async execute(e: JournalEntry): Promise<void> {
    const c = e.envelope, started = this.received.get(c.command_id);
    // Unknown receipt time (restart) or a closed start window: do not run on a guess.
    if (started === undefined || this.deps.monotonic() - started > c.start_within_ms) { this.finish(e, "rejected", "start_window_closed"); await this.save(); return; }
    if (c.connection_epoch !== this.deps.epoch()) { this.finish(e, "rejected", "epoch_stale"); await this.save(); return; }
    const ex = this.deps.executors[c.action]!;
    // Checked again at the last moment before any effect: saving the journal above may have outlived the connection.
    if (this.closed) { this.finish(e, "rejected", "connection_closed"); await this.save(); return; }
    this.running = true; this.finish(e, "running", "");
    await this.save(); // journal first: a crash from here on is recoverable without re-running
    if (this.closed) { this.running = false; this.finish(e, "rejected", "connection_closed"); await this.save(); return; }
    if (ex.mutating) this.deps.notify?.(`강사가 ‘${c.action}’ 조치를 요청해 실행합니다.`);
    const abort = new AbortController(); this.current = abort; let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
    try {
      const result = await Promise.race([
        ex.run(abort.signal, c),
        new Promise<ExecutorResult>((resolve) => { timer = setTimeout(() => { timedOut = true; abort.abort(); resolve({ ok: false, code: "timeout" }); }, Math.max(1000, c.run_within_ms)); }),
      ]);
      // A timed-out state-changing action may still have landed: that is unknown, not failed.
      // (The abort may make the executor answer first; the deadline, not the answer's wording, decides.)
      // Stopped because the connection closed mid-run: a stop was REQUESTED; for a state-changing action the result is unknown.
      if (!result.ok && this.closed && !timedOut) this.finish(e, ex.mutating ? "outcome_unknown" : "failed", "connection_closed");
      else if (!result.ok && timedOut && ex.mutating) this.finish(e, "outcome_unknown", "timeout");
      else this.finish(e, result.ok ? "succeeded" : "failed", result.code);
    } catch (err) {
      this.deps.log?.(`[ops] ${c.action} threw: ${(err as Error)?.name ?? "error"}`);
      this.finish(e, ex.mutating ? "outcome_unknown" : "failed", "executor_error");
    } finally {
      if (timer) clearTimeout(timer); this.running = false; this.current = null; await this.save();
    }
  }
}
