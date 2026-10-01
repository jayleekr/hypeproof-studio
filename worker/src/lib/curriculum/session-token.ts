// The participant session token (recon §6, `GET <test-origin>/l/:link/*`; CR-19, CR-21).
//
// Issued by the Service with the served entry page: an HMAC over the link id, a
// server-chosen session id and an expiry of hours, never later than the link's own expiry.
// The participant snippet sends it with every event (cr-evidence adds the events route and
// re-reads the link's state on every event, so a revoked or expired link refuses events
// whatever this token's own expiry says).
//
// Deliberately NOT a TokenPayload: `verify()` (tokens.ts) rejects it, so it can never be
// replayed against a student route. Same shape discipline as the operations credential.

import { assertSigningSecret } from "../tokens.ts";

const PREFIX = "hpsts1";
/** Hours, not days (recon §6). */
export const SESSION_TOKEN_MAX_MS = 6 * 3600_000;

export interface SessionClaims {
  link: string;
  session: string;
  exp: number;
}

const enc = new TextEncoder();
function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function unb64u(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(`hps-participant-session/1:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** A random session id chosen by the Service (CR-65: random, never derived from the device). */
export function newSessionId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return `ps-${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export async function signSessionToken(claims: { link: string; session: string; linkExpiresAt: number; now: number }, secret: string): Promise<{ token: string; exp: number }> {
  assertSigningSecret(secret);
  const exp = Math.min(claims.now + SESSION_TOKEN_MAX_MS, claims.linkExpiresAt);
  const body = enc.encode(JSON.stringify({ e: exp, l: claims.link, s: claims.session }));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), body));
  return { token: `${PREFIX}.${b64u(body)}.${b64u(sig)}`, exp };
}

/** The claims, or null for a missing, forged, expired or other-link token. */
export async function verifySessionToken(token: unknown, expectedLink: string, now: number, secret: string): Promise<SessionClaims | null> {
  assertSigningSecret(secret);
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  let body: Uint8Array;
  let sig: Uint8Array;
  try {
    body = unb64u(parts[1]!);
    sig = unb64u(parts[2]!);
  } catch {
    return null;
  }
  if (!(await crypto.subtle.verify("HMAC", await key(secret), sig, body))) return null;
  let c: { e?: unknown; l?: unknown; s?: unknown };
  try {
    c = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (typeof c.e !== "number" || typeof c.l !== "string" || typeof c.s !== "string") return null;
  if (c.l !== expectedLink || !(now < c.e)) return null;
  return { link: c.l, session: c.s, exp: c.e };
}
