// Pure helpers for proxyClient.ts. Kept vscode-free + fetch-free so they can
// be unit-tested under plain Node — mirrors mintStudentTokenHelpers.ts.

/**
 * Student-friendly copy for a dead/absent workshop token (REQ-B5). Single
 * source of truth: the proxy path (proxyClient.classifyError on 401) and the
 * agent-sdk fast-fail path (sdkCoach on a 401/400 api_retry event, #320) must
 * surface the SAME sentences — never fork or reword one side.
 */
export const TOKEN_EXPIRED_FRIENDLY =
  "토큰이 만료됐어요. 선생님께 새 토큰을 받아서 다시 넣어주세요. 🔑";
export const TOKEN_MISSING_FRIENDLY =
  "토큰이 필요해요. 선생님께 받은 토큰을 넣어주세요. 🔑";

/**
 * #358 — student-friendly copy for a 413 (payload too large), which in this
 * app means an oversized pasted screenshot pushed the request past the
 * region-pinned Anthropic proxy's body limit. Without this the webview showed
 * the generic error card and the cause was invisible.
 */
export const IMAGE_TOO_LARGE_FRIENDLY =
  "붙여넣은 이미지가 너무 커요. 더 작은 화면을 캡처하거나 이미지 크기를 줄여서 다시 보내주세요. 🖼️";

/**
 * Map a non-auth upstream status to a specific, kid-friendly message, or null
 * when there's nothing better than the generic card. Kept pure for unit tests;
 * auth statuses (401/403) are handled separately in classifyError.
 */
export function friendlyTransportMessage(status: number): string | null {
  if (status === 413) return IMAGE_TOO_LARGE_FRIENDLY;
  return null;
}

interface BuildHeadersArgs {
  token?: string;
  coachName?: string;
  coachPersonality?: string;
}

/**
 * Build the request headers for POST /v1/chat/completions.
 *
 * HTTP header values must be byte-safe (RFC 7230). Korean (and any non-ASCII)
 * coach names + personalities get URL-encoded; the Worker decodes on receipt.
 *
 * A naive `headers["x-hps-coach-name"] = coachName` would throw
 * `TypeError: invalid character in header content` the moment a Korean coach
 * name is set — silent failure for half our user base.
 */
export function buildProxyHeaders(args: BuildHeadersArgs): Record<string, string> {
  const { token, coachName, coachPersonality } = args;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (coachName && coachName.trim()) {
    headers["x-hps-coach-name"] = encodeURIComponent(coachName.trim());
  }
  if (coachPersonality && coachPersonality.trim()) {
    headers["x-hps-coach-personality"] = encodeURIComponent(coachPersonality.trim());
  }
  return headers;
}
