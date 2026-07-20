// Pure helpers for the mint-student-token command (#66). Kept vscode-free so
// they can be unit-tested under plain Node — mirrors updateCheckerHelpers.ts.

export const ISSUER_TOKEN_KEY = "hypeproofChat.issuerToken";

export interface MintRequest {
  u: string;
  c: string;
  p: string;
  hours: number;
}

export interface MintResponse {
  token: string;
  jti: string;
  exp: number;
}

/** Derive the admin-endpoint origin from the OpenAI-style proxyUrl.
 *  proxyUrl: https://api.hypeproof-ai.xyz/v1   →   https://api.hypeproof-ai.xyz
 *  Trailing `/v1` and any trailing slashes are stripped.
 */
export function adminBaseFor(proxyUrl: string): string {
  return proxyUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

/** Map a server error string to a friendly Korean line. */
export function mapMintError(raw: string): string {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("not an issuer")) {
    return "본인 토큰이 issuer 토큰이 아니에요. 학생 토큰 말고 강사 토큰이 필요합니다.";
  }
  if (s.includes("expired")) {
    return "issuer 토큰이 만료됐어요. Jay에게 새 토큰을 요청하세요.";
  }
  if (s.includes("scope") || s.includes("forbidden")) {
    return "이 cohort 발급 권한이 없는 issuer 토큰이에요. Jay에게 본인 cohort 권한을 요청하세요.";
  }
  if (s.includes("unauthorized") || s.startsWith("http 401")) {
    return "issuer 토큰 인증 실패. 다시 붙여넣어 보세요.";
  }
  if (s.includes("network") || s.includes("fetch failed")) {
    return "워커 응답이 없어요. 네트워크를 확인하거나 잠시 후 다시 시도하세요.";
  }
  return raw;
}

/** Validate user-supplied mint inputs before calling the API. */
export function validateInputs(
  u: string,
  c: string,
  p: string,
  hours: number,
): { ok: true } | { ok: false; reason: string } {
  if (!u || u.trim().length === 0) return { ok: false, reason: "user id 가 비어있어요" };
  if (u.length > 64) return { ok: false, reason: "user id 가 너무 길어요 (≤64자)" };
  if (!/^[A-Za-z0-9._-]+$/.test(u)) {
    return { ok: false, reason: "user id 는 영문/숫자/'._-' 만 허용해요" };
  }
  if (!c || c.trim().length === 0) return { ok: false, reason: "cohort 가 비어있어요" };
  if (!p || p.trim().length === 0) return { ok: false, reason: "profile 이 비어있어요" };
  if (!Number.isInteger(hours) || hours < 1 || hours > 1440) {
    return { ok: false, reason: "유효 시간은 1..1440 시간 사이여야 해요" };
  }
  return { ok: true };
}

/**
 * One scope entry inside an issuer token payload.
 *
 * SOURCE OF TRUTH: `IssuerScope` in worker/src/lib/tokens.ts — the worker
 * signs these, so this is a read-only mirror. If the two drift apart, every
 * function below silently returns nothing (that was #347: this file read a
 * `scope.cohorts` shape the worker never minted, so the cohort default was
 * dead and a hardcoded fallback surfaced instead). The smoke test mints its
 * fixtures with the worker's real issueIssuer() so drift breaks the test.
 */
export interface IssuerScope {
  cohort: string;
  profiles?: string[];
  max_hours?: number;
  can_start_session?: boolean;
  max_session_hours?: number;
}

/**
 * Decode the payload of a HypeProof token.
 *
 * Wire format is `base64url(payload) "." base64url(sig)` (tokens.ts) — TWO
 * segments, not a 3-segment JWT. The payload is therefore parts[0].
 * Returns undefined for any unrecognized structure — never throws.
 */
function decodeTokenPayload(token: string): Record<string, unknown> | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return undefined;
    const raw = parts[0];
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    const payload: unknown = JSON.parse(json);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    return payload as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Every well-formed scope an issuer token carries. `[]` when the token is not
 *  an issuer token, is unparseable, or carries no usable scopes. Never throws. */
export function issuerScopes(issuerToken: string): IssuerScope[] {
  const raw = decodeTokenPayload(issuerToken)?.scopes;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is IssuerScope =>
      !!s && typeof s === "object" && typeof (s as IssuerScope).cohort === "string",
  );
}

/** Distinct cohorts this issuer may mint into, in scope order. */
export function issuerCohorts(issuerToken: string): string[] {
  const out: string[] = [];
  for (const s of issuerScopes(issuerToken)) {
    if (!out.includes(s.cohort)) out.push(s.cohort);
  }
  return out;
}

/**
 * The single cohort the issuer is scoped to — a safe default for the cohort
 * prompt. Returns undefined when the token grants several cohorts (the caller
 * must ask) or none could be read: prefilling a *guess* is worse than an empty
 * box, because mint succeeds and the student only fails later at chat time
 * with `token cohort/profile mismatch` (#347).
 */
export function issuerDefaultCohort(issuerToken: string): string | undefined {
  const cohorts = issuerCohorts(issuerToken);
  return cohorts.length === 1 ? cohorts[0] : undefined;
}

/** Profiles this issuer may mint for `cohort`, in scope order, deduped. */
export function issuerProfilesFor(issuerToken: string, cohort: string): string[] {
  const out: string[] = [];
  for (const s of issuerScopes(issuerToken)) {
    if (s.cohort !== cohort || !Array.isArray(s.profiles)) continue;
    for (const p of s.profiles) {
      if (typeof p === "string" && !out.includes(p)) out.push(p);
    }
  }
  return out;
}
