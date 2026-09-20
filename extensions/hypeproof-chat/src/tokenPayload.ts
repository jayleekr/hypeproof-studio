// Decode half of a HypeProof token. Pure, vscode-free.
//
// Extracted from chatPanelHelpers.ts (#1184) so that authoringAccess.ts can own
// the single role predicate without importing back into chatPanelHelpers and
// creating a module cycle. chatPanelHelpers re-exports the function, so every
// existing caller and smoke test is unchanged.

/**
 * Decode the (unverified) payload half of `<base64url(payload)>.<sig>`.
 *
 * HypeProof tokens are TWO segments, not a 3-segment JWT (worker
 * lib/tokens.ts), so the payload is parts[0]. Returns undefined for any
 * unrecognized structure — never throws.
 *
 * UNVERIFIED: the signature is not checked here. A value read out of this may
 * pick a local bucket or choose what to render; it may never grant access.
 * The server decides what a token may do.
 */
export function decodeTokenPayloadUnverified(
  token: string | null | undefined,
): Record<string, unknown> | undefined {
  try {
    if (!token) return undefined;
    const parts = token.split(".");
    if (parts.length !== 2) return undefined;
    const payload = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
