// Who may open the instructor (Chalk) surface inside Studio? (#1184)
//
// Pure, vscode-free so it unit-tests under plain Node.
//
// ── Why this file exists at all ───────────────────────────────────────────
// `role: "issuer"` was minted to mean ONE thing — "this token may delegate
// student tokens" (worker/src/lib/tokens.ts). Studio now also reads it as
// "this person gets the authoring surface". Two meanings now ride on one
// name. We deliberately do NOT split them yet: nothing observed requires a
// second role, and inventing one would put an unbacked field in signed
// tokens. What we do instead is make the SCREEN never ask about roles at
// all — it asks `canAuthor()`. When the two meanings do have to part, this
// one function changes; no grep for `"issuer"` across the extension.
//
// ── What this file is NOT ─────────────────────────────────────────────────
// It is not enforcement. Every value it reads is UNVERIFIED — the signature
// is never checked here. Hiding a view hides a view; the Service is what
// refuses an unauthorized call (see #1185). A student who forges a payload
// gains a tree with four buttons, each of which fails server-side.

import { decodeTokenPayloadUnverified } from "./tokenPayload.ts";

/** `when` clause key the manifest gates the Chalk view on. */
export const AUTHORING_CONTEXT_KEY = "hypeproof-chat.canAuthor";

/**
 * THE role check. The only place in the extension that spells `"issuer"` as
 * a role value — everything user-facing goes through `canAuthor`.
 *
 * `issueIssuer()` also stamps placeholder cohort/profile, so an older issuer
 * token minted before the explicit `role` field still reads correctly.
 */
export function isIssuerRolePayload(
  payload: Record<string, unknown> | null | undefined,
): boolean {
  if (!payload) return false;
  if (payload.role === "issuer") return true;
  return payload.c === "__issuer__" || payload.p === "__issuer__";
}

/**
 * May this session show the authoring surface?
 *
 * Named after the capability, not the role, on purpose — callers state what
 * they need, not who they think is asking.
 */
export function canAuthor(payload: Record<string, unknown> | null | undefined): boolean {
  return isIssuerRolePayload(payload);
}

/** `canAuthor` for a raw token string. Undecodable → false. */
export function canAuthorWithToken(token: string | null | undefined): boolean {
  return canAuthor(decodeTokenPayloadUnverified(token));
}

export interface AuthoringAccessInput {
  /** SecretStorage `hypeproofChat.issuerToken` — set once the 강사 mints. */
  issuerToken?: string | null;
  /** The participant token this window is connected with, if any. */
  participantToken?: string | null;
}

export interface AuthoringAccess {
  canAuthor: boolean;
  /** Which token answered. `"none"` when nobody did. */
  source: "issuer-secret" | "participant-token" | "none";
  /** Cohorts the issuer token is scoped to, for the surface's subtitle. `[]` when unknown. */
  cohorts: string[];
}

/**
 * Resolve the surface decision from everything the window holds.
 *
 * Order matters only for reporting: the stored issuer secret is the normal
 * path (the 강사 pasted it to mint), the participant token is the belt —
 * a window whose only credential is an issuer token still gets the surface.
 */
export function resolveAuthoringAccess(input: AuthoringAccessInput): AuthoringAccess {
  const issuerPayload = decodeTokenPayloadUnverified(input.issuerToken);
  if (canAuthor(issuerPayload)) {
    return { canAuthor: true, source: "issuer-secret", cohorts: scopedCohorts(issuerPayload) };
  }
  const participantPayload = decodeTokenPayloadUnverified(input.participantToken);
  if (canAuthor(participantPayload)) {
    return {
      canAuthor: true,
      source: "participant-token",
      cohorts: scopedCohorts(participantPayload),
    };
  }
  return { canAuthor: false, source: "none", cohorts: [] };
}

/**
 * Cohorts named by an issuer payload's `scopes`, in order, deduped.
 *
 * Mirrors `issuerCohorts()` in mintStudentTokenHelpers.ts, which reads the
 * same worker-signed `IssuerScope[]`. Kept here rather than imported because
 * that module is the mint command's, and this one must stay importable by the
 * surface without dragging the mint flow in.
 */
export function scopedCohorts(payload: Record<string, unknown> | null | undefined): string[] {
  const raw = payload?.scopes;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const cohort = (s as { cohort?: unknown }).cohort;
    if (typeof cohort === "string" && cohort && !out.includes(cohort)) out.push(cohort);
  }
  return out;
}

/** One-line subtitle for the surface: who the window thinks you are. */
export function authoringSubtitle(access: AuthoringAccess): string {
  if (!access.canAuthor) return "";
  if (access.cohorts.length === 1) return `강사 · ${access.cohorts[0]}`;
  if (access.cohorts.length > 1) return `강사 · ${access.cohorts.length}개 수업`;
  return "강사";
}
