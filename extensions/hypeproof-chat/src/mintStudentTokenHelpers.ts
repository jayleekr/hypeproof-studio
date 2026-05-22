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
 * Given an issuer token (HypeProof shape `<base64(payload)>.<sig>`),
 * return the single cohort the issuer is scoped to. Useful as a default for
 * the cohort prompt. Returns undefined for any unrecognized structure —
 * never throws.
 */
export function issuerDefaultCohort(issuerToken: string): string | undefined {
  try {
    const parts = issuerToken.split(".");
    if (parts.length !== 2 && parts.length !== 3) return undefined;
    const raw = parts[0];
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    const payload = JSON.parse(json);
    const cohorts: unknown = payload?.scope?.cohorts;
    if (Array.isArray(cohorts) && cohorts.length === 1 && typeof cohorts[0] === "string") {
      return cohorts[0];
    }
    return undefined;
  } catch {
    return undefined;
  }
}
