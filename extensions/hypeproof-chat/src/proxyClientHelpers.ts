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
 * agent-sdk 경로 전용 (#320 수정). 프록시 경로는 게이트웨이가 준 `error.code`
 * 로 만료 여부를 **읽을 수 있지만**, SDK 경로는 `api_retry` 이벤트의 상태코드
 * 밖에 못 본다 — 401 이 만료인지, 자격증명이 잘못 실렸는지, roster 문제인지
 * 구분할 근거가 없다.
 *
 * 그런데도 여기서 "만료됐어요" 를 띄우면 두 가지가 동시에 망가진다: 원인이
 * 만료로 오인돼 추적이 막히고(2026-07-28 실측: 원인은 ambient OAuth 자격증명
 * 이었다 — sdkConfigDirFor 참조), `kind: "expired"` 가 **멀쩡한 토큰을 지운다**.
 * 그래서 SDK 경로는 단정하지 않는 문장을 쓰고 kind 도 파괴적이지 않은 쪽을 쓴다.
 */
export const GATEWAY_AUTH_FAILED_FRIENDLY =
  "코치가 로그인에 실패했어요. 토큰을 다시 넣어보고, 그래도 같으면 선생님께 알려주세요. 🔑";

/** 400 은 인증 문제가 아니다 — 토큰 얘기를 꺼내면 안 된다. */
export const GATEWAY_BAD_REQUEST_FRIENDLY =
  "요청이 게이트웨이에서 거절됐어요. 다시 보내보고, 계속 같으면 선생님께 알려주세요. 🛠️";

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
  /**
   * #507 — 지금 떠 있는 라이브 서버 주소. 워커가 `x-hps-preview-url` 로 받아
   * 시스템 블록에 넣는다(문구는 워커가 소유 — 클라이언트는 주소만 보낸다).
   * 서버가 안 떠 있으면 보내지 않는다: 없는 주소를 지어내는 것보다 침묵이 낫다.
   */
  previewUrl?: string;
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
  if (args.previewUrl && args.previewUrl.trim()) {
    headers["x-hps-preview-url"] = encodeURIComponent(args.previewUrl.trim());
  }
  return headers;
}
