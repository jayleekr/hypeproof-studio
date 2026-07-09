// HMAC-SHA256 signed stateless workshop tokens.
//
// v2 payload (JSON, base64url-encoded):
//   { u: string, c: string, p: string, iat: number, exp: number, jti?: string, v: 2 }
//
// Token wire format:  base64url(payload) "." base64url(sig)
//
// Rotating HPS_SIGNING_SECRET revokes all outstanding tokens at once.
//
// jti (#46 / S-01): per-token UUID. Every token issued after 2026-05-20 has
// one; older tokens are read-through without it. The Worker checks
// `KV revoked:<jti>` on every chat request — admin can kill a single token
// without rotating the global secret. Tokens without jti remain valid until
// exp (transition window) — but cannot be individually revoked.

export interface TokenPayload {
  u: string;       // user id (cohort-local), e.g. "kid01"
  c: string;       // cohort id, e.g. "sk-biopharm-2026-a"
  p: string;       // profile id, e.g. "sk-biopharm-kids-2026-grade-3-4-s1"
  iat: number;     // issued at (unix seconds)
  exp: number;     // expires (unix seconds)
  jti?: string;    // per-token UUID — present on tokens issued post-S-01
  // Self-service delegation (post-D-day-6): issuer-role tokens let an
  // instructor mint student tokens within a declared scope without holding
  // the admin password. Default role is implicit "student" (chat path).
  role?: "student" | "issuer";
  // Issuer scope — only consulted when role === "issuer". An empty / absent
  // scopes array means "no minting permission" (defensive default).
  scopes?: IssuerScope[];
  // #295 — admin-tier delegation. When true, this issuer token may also call
  // POST /admin/issuers to MINT OTHER issuer tokens (i.e. it is an "admin
  // minter"), without holding the shared admin password. Defensive default
  // undefined → cannot mint issuers. A Bearer-authed mint can NEVER set this
  // flag on its child (only true admin Basic/CF Access can create new admin
  // minters), so the capability cannot spread on its own.
  can_issue_issuers?: boolean;
  v: 2;
}

export interface IssuerScope {
  cohort: string;            // cohort id the issuer can mint into
  profiles: string[];        // profile ids the issuer can pick from
  // Max hours a child (student) token can declare. Caps the blast radius if
  // the issuer credential leaks.
  max_hours?: number;
  // #167 — when true, this scope also lets the issuer start/end the cohort's
  // active session without admin Basic auth. Defensive default: undefined →
  // session control denied. The endpoint additionally caps requested session
  // duration to `max_session_hours` (or 4h if unset).
  can_start_session?: boolean;
  // Max duration of a session the issuer can open in hours. Independent of
  // `max_hours` (which bounds STUDENT tokens, not sessions). Only consulted
  // when `can_start_session === true`.
  max_session_hours?: number;
}

export type TokenErrorCode = "malformed" | "signature" | "expired" | "version" | "revoked";

export class TokenError extends Error {
  code: TokenErrorCode;
  constructor(message: string, code: TokenErrorCode) {
    super(message);
    this.code = code;
  }
}

function b64uEncode(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64uDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(payloadBytes: Uint8Array, secret: string): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return new Uint8Array(sig);
}

export async function issue(
  payload: Omit<TokenPayload, "iat" | "exp" | "v" | "jti">,
  hours: number,
  secret: string,
  opts: { jti?: string } = {},
): Promise<{ token: string; jti: string }> {
  if (!secret || secret.length < 16) throw new TokenError("signing secret too short", "malformed");
  const now = Math.floor(Date.now() / 1000);
  // crypto.randomUUID is available in Workers + Node 19+ (the issue-token CLI).
  const jti = opts.jti ?? crypto.randomUUID();
  const full: TokenPayload = {
    ...payload,
    iat: now,
    exp: now + hours * 3600,
    jti,
    v: 2,
  };
  const payloadBytes = new TextEncoder().encode(canonicalize(full));
  const sig = await sign(payloadBytes, secret);
  return { token: `${b64uEncode(payloadBytes)}.${b64uEncode(sig)}`, jti };
}

/**
 * Convenience: mint an issuer-role token. Same HMAC machinery, but the
 * payload carries `role: "issuer"` and a scopes array. The admin
 * /tokens/issue endpoint checks role + scope on each mint request.
 */
export async function issueIssuer(
  params: {
    issuer: string;                // instructor handle, goes into u
    scopes: IssuerScope[];
    can_issue_issuers?: boolean;   // #295 — admin-tier minter capability
  },
  hours: number,
  secret: string,
): Promise<{ token: string; jti: string }> {
  if (params.scopes.length === 0) {
    throw new TokenError("issuer must have at least one scope", "malformed");
  }
  return issue(
    {
      u: params.issuer,
      c: "__issuer__",
      p: "__issuer__",
      role: "issuer",
      scopes: params.scopes,
      ...(params.can_issue_issuers ? { can_issue_issuers: true } : {}),
    },
    hours,
    secret,
  );
}

export async function verify(token: string, secret: string): Promise<TokenPayload> {
  if (!token || !token.includes(".")) throw new TokenError("malformed token", "malformed");
  const [payloadB64, sigB64] = token.split(".", 2);
  if (!payloadB64 || !sigB64) throw new TokenError("malformed token", "malformed");

  let payloadBytes: Uint8Array;
  let sig: Uint8Array;
  try {
    payloadBytes = b64uDecode(payloadB64);
    sig = b64uDecode(sigB64);
  } catch {
    throw new TokenError("malformed token", "malformed");
  }

  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, sig, payloadBytes);
  if (!ok) throw new TokenError("invalid signature", "signature");

  let p: TokenPayload;
  try {
    p = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    throw new TokenError("malformed payload", "malformed");
  }

  if (p.v !== 2) throw new TokenError(`unsupported token version: ${p.v}`, "version");
  if (!p.u || !p.c || !p.p) throw new TokenError("missing required fields", "malformed");
  const now = Math.floor(Date.now() / 1000);
  if (typeof p.exp !== "number" || p.exp < now) throw new TokenError("token expired", "expired");
  return p;
}

// JSON canonicalization — same key order in issue + verify so the signature is
// reproducible. New optional fields are appended at the end ONLY when present,
// so legacy (jti-less, role-less) tokens still verify byte-for-byte against
// their original signature.
//
// Order is fixed: base → jti → role → scopes. Adding a new optional field?
// Append at the end; never re-order existing fields.
function canonicalize(p: TokenPayload): string {
  const out: Record<string, unknown> = {
    c: p.c, exp: p.exp, iat: p.iat, p: p.p, u: p.u, v: p.v,
  };
  if (p.jti !== undefined) out.jti = p.jti;
  if (p.role !== undefined) out.role = p.role;
  if (p.scopes !== undefined) out.scopes = p.scopes;
  if (p.can_issue_issuers !== undefined) out.can_issue_issuers = p.can_issue_issuers;
  return JSON.stringify(out);
}

// Extract Bearer token from an Authorization header value.
export function bearer(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m && m[1] ? m[1].trim() : null;
}
