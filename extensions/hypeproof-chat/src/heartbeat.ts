// Task E (docs/plan/dag.yaml) — client half of the liveness contract.
//
// Why this exists: an empty stretch in the data is ambiguous — the app died,
// the laptop closed, the participant is reading, or the participant left. The
// instructor's response differs in each case. A ping that fires whether or not
// the participant is asking anything splits *alive but not asking* from *not
// alive* (docs/plan/vessel-and-modules.md §3).
//
// Rules this file obeys:
//   - **No `vscode` import.** Same discipline as sessionSpool.ts /
//     spoolUploader.ts: the payload builders and the scheduler are plain
//     functions over injected dependencies, so test/*.smoke.mjs can drive them
//     under plain Node, and worker/test/liveness-trace.test.mjs can import the
//     payload builders straight into the worker's own validator (drift lock).
//   - **Metadata only.** artifactChanged carries a digest and a byte count.
//     Never the file, never its name. That is what keeps the instructor board
//     shippable for minor cohorts without a guardian-consent procedure
//     (§4 "Privacy" — PIPA Art. 22-2).

import { createHash } from "crypto";

/**
 * Ping interval. The spec window is 30–60 s; 45 s sits in the middle so one
 * dropped request still leaves the worker's 15-minute record fresh.
 */
export const HEARTBEAT_INTERVAL_MS = 45_000;

/** Below this much idle time the seat reads as "active" on the board. */
export const HEARTBEAT_IDLE_AFTER_MS = 60_000;

export type HeartbeatState = "active" | "idle";

export interface HeartbeatEvent {
  type: "heartbeat";
  state: HeartbeatState;
  idle_ms: number;
}

export interface ArtifactChangedEvent {
  type: "artifactChanged";
  sha256: string;
  bytes: number;
}

export type LivenessEvent = HeartbeatEvent | ArtifactChangedEvent;

/**
 * Drift lock — the worker half is
 * `worker/src/routes/trace.ts` HEARTBEAT_EVENT_KEYS / ARTIFACT_CHANGED_EVENT_KEYS,
 * and worker/test/liveness-trace.test.mjs asserts the two agree. The two sides
 * deploy on different trains (worker in 30 s, app in 1–2 h plus a participant
 * reinstall), so only a test can hold them together.
 */
export const CLIENT_LIVENESS_EVENT_KEYS = {
  heartbeat: ["type", "state", "idle_ms"] as const,
  artifactChanged: ["type", "sha256", "bytes"] as const,
};

export function heartbeatState(idleMs: number): HeartbeatState {
  return idleMs < HEARTBEAT_IDLE_AFTER_MS ? "active" : "idle";
}

/** Build the ping payload. `idleMs` is clamped: a clock skew must not send a negative. */
export function buildHeartbeatEvent(idleMs: number): HeartbeatEvent {
  const idle = Number.isFinite(idleMs) && idleMs > 0 ? Math.round(idleMs) : 0;
  return { type: "heartbeat", state: heartbeatState(idle), idle_ms: idle };
}

/**
 * Digest an artifact. Takes the content only to measure it — the return value
 * is a hash and a length, and nothing derived from the content survives past
 * this function.
 */
export function buildArtifactChangedEvent(content: string | Uint8Array): ArtifactChangedEvent {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  return {
    type: "artifactChanged",
    sha256: createHash("sha256").update(buf).digest("hex"),
    bytes: buf.byteLength,
  };
}

// ── scheduler ───────────────────────────────────────────────────────────────

export interface HeartbeatSendResult {
  ok: boolean;
  /** HTTP status, or 0 when the request never completed (offline, DNS, …). */
  status: number;
}

export interface HeartbeatDeps {
  /** POST the event. Must not throw — return {ok:false,status:0} instead. */
  send: (ev: HeartbeatEvent) => Promise<HeartbeatSendResult>;
  /** ms since the participant last did anything in the panel. */
  idleMs: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** Optional diagnostics sink (output channel in the host). */
  log?: (line: string) => void;
}

/** Beyond this many consecutive failures the pinger gives up until restarted. */
export const HEARTBEAT_MAX_BACKOFF_TICKS = 8;

export interface HeartbeatPinger {
  stop(): void;
  /** Visible for tests: fire one tick synchronously. */
  tick(): Promise<void>;
}

/**
 * Start pinging. Failure policy, in order of how often it actually happens:
 *
 *  - `401` — the token is rejected. Stop for good; retrying a rejected token
 *    every 45 s just fills the worker's logs with the same line.
 *  - `403` — no active session (class not open yet, or already closed). This
 *    is the *normal* state outside class hours, so back off exponentially
 *    rather than stopping: the pinger must come back to life when the
 *    instructor opens the session, without the participant restarting Studio.
 *  - anything else (offline, 429, 5xx) — same exponential back-off.
 */
export function startHeartbeat(
  deps: HeartbeatDeps,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): HeartbeatPinger {
  let stopped = false;
  let failures = 0;
  let skip = 0;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (skip > 0) {
      skip--;
      return;
    }
    const r = await deps.send(buildHeartbeatEvent(deps.idleMs()));
    if (r.ok) {
      failures = 0;
      return;
    }
    if (r.status === 401) {
      deps.log?.("[heartbeat] token rejected (401) — stopping");
      pinger.stop();
      return;
    }
    failures++;
    skip = Math.min(2 ** failures, HEARTBEAT_MAX_BACKOFF_TICKS);
    deps.log?.(`[heartbeat] send failed (${r.status}) — skipping ${skip} tick(s)`);
  };

  const handle = deps.setInterval(() => void tick(), intervalMs);

  const pinger: HeartbeatPinger = {
    stop() {
      if (stopped) return;
      stopped = true;
      deps.clearInterval(handle);
    },
    tick,
  };
  return pinger;
}

// ── change gate ─────────────────────────────────────────────────────────────

/**
 * "artifactChanged" means *changed*. Saving the same bytes twice is not an
 * event, and the coach re-emitting an identical file is the common case. This
 * keeps the board's answer to "the coach ran for four minutes — did anything
 * actually change?" meaningful instead of always-yes.
 */
export class ArtifactChangeGate {
  private lastSha: string | null = null;

  /** Returns the event to send, or null when the bytes are unchanged. */
  next(content: string | Uint8Array): ArtifactChangedEvent | null {
    const ev = buildArtifactChangedEvent(content);
    if (ev.sha256 === this.lastSha) return null;
    this.lastSha = ev.sha256;
    return ev;
  }

  reset(): void {
    this.lastSha = null;
  }
}
