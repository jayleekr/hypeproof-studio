// Pure helpers used by reportProblem.ts. Kept in a separate file so tests
// can import them without dragging in the `vscode` host module. Do NOT import
// anything from "vscode" or any side-effectful Node module here.

import type { ChatMessage } from "./protocol";

/**
 * Hash a JWT-ish identifier with SHA-256, return the first 16 hex chars.
 * Stable across runs (same input → same hash). The Worker also computes a
 * server-authoritative hash from the Bearer token; this client copy is
 * mostly useful when the token is too broken to verify server-side (so we
 * can still correlate multiple reports from the same user).
 */
export async function hashJti(jti: string): Promise<string> {
  const data = new TextEncoder().encode(jti);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 16);
}

/**
 * Extract the jti from a HypeProof v2 token WITHOUT verifying the signature.
 * The Worker re-verifies properly; we just need a stable opaque id for
 * client-side correlation (e.g., attach to the metadata blob even when the
 * server can't verify the token).
 *
 * Token format: <base64url(payload)>.<base64url(sig)>
 * payload JSON contains a `jti` field for v2 tokens.
 */
export function extractJtiUnverified(token: string): string | undefined {
  try {
    const [payloadB64] = token.split(".", 2);
    if (!payloadB64) return undefined;
    const b64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const json = Buffer.from(b64 + pad, "base64").toString("utf8");
    const payload = JSON.parse(json) as { jti?: string };
    return payload.jti;
  } catch {
    return undefined;
  }
}

/**
 * Strip recent turns to the last 3 messages and cap each content at 2000
 * chars. Drops system messages entirely — system messages aren't shown to
 * the user anyway, and they may contain prompt-engineering context we don't
 * want to leak in a bug report.
 *
 * Defense in depth — the Worker also enforces this (see report.ts), but
 * no need to send the giant payload if the user opted in.
 */
export function sanitizeRecentTurns(
  turns: ChatMessage[],
): Array<{ role: "user" | "assistant"; content: string }> {
  return turns
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-3)
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: (m.content ?? "").slice(0, 2000),
    }));
}
