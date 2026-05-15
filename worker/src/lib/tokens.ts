// HMAC-SHA256 signed stateless workshop tokens.
//
// v2 payload (JSON, base64url-encoded):
//   { u: string, c: string, p: string, iat: number, exp: number, v: 2 }
//
// Token wire format:  base64url(payload) "." base64url(sig)
//
// Rotating HPS_SIGNING_SECRET revokes all outstanding tokens at once.

export interface TokenPayload {
  u: string;       // user id (cohort-local), e.g. "kid01"
  c: string;       // cohort id, e.g. "sk-biopharm-2026-a"
  p: string;       // profile id, e.g. "sk-biopharm-kids-2026-grade-3-4-s1"
  iat: number;     // issued at (unix seconds)
  exp: number;     // expires (unix seconds)
  v: 2;
}

export type TokenErrorCode = "malformed" | "signature" | "expired" | "version";

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
  payload: Omit<TokenPayload, "iat" | "exp" | "v">,
  hours: number,
  secret: string,
): Promise<string> {
  if (!secret || secret.length < 16) throw new TokenError("signing secret too short", "malformed");
  const now = Math.floor(Date.now() / 1000);
  const full: TokenPayload = {
    ...payload,
    iat: now,
    exp: now + hours * 3600,
    v: 2,
  };
  const payloadBytes = new TextEncoder().encode(canonicalize(full));
  const sig = await sign(payloadBytes, secret);
  return `${b64uEncode(payloadBytes)}.${b64uEncode(sig)}`;
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

// JSON canonicalization — same key order in issue + verify so the signature is reproducible.
function canonicalize(p: TokenPayload): string {
  return JSON.stringify({ c: p.c, exp: p.exp, iat: p.iat, p: p.p, u: p.u, v: p.v });
}

// Extract Bearer token from an Authorization header value.
export function bearer(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m && m[1] ? m[1].trim() : null;
}
