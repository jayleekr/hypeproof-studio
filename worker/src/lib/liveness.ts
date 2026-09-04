// Liveness — "is this seat alive?" state, independent of chat activity.
//
// docs/plan/vessel-and-modules.md §3 "the third gap": an empty stretch in the
// data is ambiguous — the app died, the laptop closed, the participant is
// reading, or the participant left. The instructor's response differs in each
// case. A 30–60 s heartbeat that does not depend on the participant asking
// anything splits *alive but not asking* from *not alive*.
//
// Why KV and not D1:
//   - A D1 table needs a migration, and migrations here are human-gated and
//     applied exactly once per database (migrations/0001-*.sql header). This
//     task must ship on the worker's 30-second cadence.
//   - The board only ever asks "when was this seat last seen"; every write
//     supersedes the previous one. That is a last-value cache, not a ledger.
//   - Self-expiring: TTL means a finished class cleans itself up.
//   - usage_log is the billing ledger (§3). Heartbeats must never land there.
//
// Privacy (§4 "zero prompt text is what makes this shippable"): every field
// here is operational metadata — a timestamp, a coarse state, a digest, a
// byte count. No file content, no filename, no prompt text, ever.

/** Coarse participant state. Deliberately two values — the board reads it in 2s. */
export const HEARTBEAT_STATES = ["active", "idle"] as const;
export type HeartbeatState = (typeof HEARTBEAT_STATES)[number];

/**
 * How long a heartbeat record survives without a refresh. Generously longer
 * than the client's 30–60 s ping so one dropped request is not "dead", but
 * short enough that a closed laptop disappears within the class hour.
 */
export const HEARTBEAT_TTL_SEC = 900; // 15 min

/**
 * Artifact-change records outlive heartbeats: "the coach ran for four minutes
 * — did anything actually change?" stays answerable after the seat goes quiet.
 */
export const ARTIFACT_TTL_SEC = 12 * 60 * 60;

export const heartbeatKey = (cohortId: string, userId: string) => `live:hb:${cohortId}:${userId}`;
export const artifactKey = (cohortId: string, userId: string) => `live:af:${cohortId}:${userId}`;
export const LIVENESS_HB_PREFIX = "live:hb:";
export const LIVENESS_AF_PREFIX = "live:af:";

export interface HeartbeatRecord {
  /** ISO timestamp the worker observed the ping (server clock — never the client's). */
  at: string;
  state: HeartbeatState;
  /** ms since the participant last did anything in the panel, as the client sees it. */
  idle_ms?: number;
  /**
   * App build that sent this ping, from the optional `x-hps-client-version`
   * header. Undefined for any client built before this landed — the app train
   * is 1–2 h plus a reinstall behind the worker, so that is the normal case.
   */
  client_version?: string;
}

export interface ArtifactRecord {
  at: string;
  /** lowercase hex sha-256 of the artifact bytes. NOT the bytes. */
  sha256: string;
  bytes: number;
}

export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** 64 MB — far above any classroom artifact; a sanity bound, not a policy. */
export const ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

export function isSha256Hex(v: unknown): v is string {
  return typeof v === "string" && SHA256_HEX_RE.test(v);
}

export function isArtifactByteCount(v: unknown): v is number {
  return (
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= ARTIFACT_MAX_BYTES
  );
}

export function isHeartbeatState(v: unknown): v is HeartbeatState {
  return typeof v === "string" && (HEARTBEAT_STATES as readonly string[]).includes(v);
}

/**
 * Client version strings reach us from an untrusted header. Keep them short
 * and boring so nothing weird lands in a KV value the board renders.
 */
export const CLIENT_VERSION_MAX = 64;
export function sanitizeClientVersion(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (!v) return undefined;
  if (v.length > CLIENT_VERSION_MAX) return undefined;
  return /^[A-Za-z0-9._+-]+$/.test(v) ? v : undefined;
}

export async function recordHeartbeat(
  kv: KVNamespace,
  cohortId: string,
  userId: string,
  rec: HeartbeatRecord,
): Promise<void> {
  await kv.put(heartbeatKey(cohortId, userId), JSON.stringify(rec), {
    expirationTtl: HEARTBEAT_TTL_SEC,
  });
}

export async function recordArtifactChange(
  kv: KVNamespace,
  cohortId: string,
  userId: string,
  rec: ArtifactRecord,
): Promise<void> {
  await kv.put(artifactKey(cohortId, userId), JSON.stringify(rec), {
    expirationTtl: ARTIFACT_TTL_SEC,
  });
}

export async function getHeartbeat(
  kv: KVNamespace,
  cohortId: string,
  userId: string,
): Promise<HeartbeatRecord | null> {
  return await kv.get<HeartbeatRecord>(heartbeatKey(cohortId, userId), "json");
}

export async function getArtifact(
  kv: KVNamespace,
  cohortId: string,
  userId: string,
): Promise<ArtifactRecord | null> {
  return await kv.get<ArtifactRecord>(artifactKey(cohortId, userId), "json");
}
