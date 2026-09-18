// #1132 — 강사가 브라우저에서 누른 리허설 링크를 앱이 받는 자리.
//
// 계약은 ARC-03 이다: 수업의 신원은 (cohort_id, course_id, version)+sha256 넷이고
// 참여 코드는 신원이 아니라 자격증명이다. 그래서 **링크는 교환권 하나만 나른다.**
// 좌표도 자격증명도 URL 에 싣지 않는다 — ARC-02 가 "인증을 URL에 넣지 않는다" 를,
// TUX-SP-01 이 "원문을 URL·로그·webview 저장소에 남기지 않는다" 를 P0 로 요구한다.
//
// 이 파일은 vscode 를 import 하지 않는다. 그래서 앱 없이 대조군을 돌릴 수 있다.
// 유일한 I/O 인 `redeemRehearsalTicket` 은 `fetchImpl` 로 주입받으므로 테스트에서
// 실제 네트워크 없이 요청 모양까지 검사한다.

/** 링크에서 읽어도 되는 유일한 값. */
export const REHEARSAL_TICKET_PARAM = "ticket";

/**
 * 링크에 실려 오면 **거부해야 하는** 이름들. 좌표를 URL 로 나르는 설계는 기각됐고,
 * "임시로" 다시 들어올 자리를 남기지 않으려고 이름을 박아 둔다. 조용히 무시하지
 * 않고 거부하는 이유: 무시하면 보내는 쪽이 통한다고 믿고 계속 보낸다.
 */
export const REJECTED_URI_PARAMS = [
  "cohort", "cohort_id",
  "course", "course_id",
  "version",
  "sha256",
  "token",
  "profile", "profile_id",
] as const;

export type RehearsalUriParse =
  | { ok: true; ticket: string }
  | { ok: false; reason: "wrong_path" | "missing_ticket" | "malformed_ticket" | "forbidden_param"; detail?: string };

/** 교환권은 불투명 문자열이다. 의미를 읽지 않고 모양만 본다. */
const TICKET_SHAPE = /^[A-Za-z0-9_-]{16,256}$/;

export const REHEARSAL_URI_PATH = "/rehearse";

/**
 * `hypeproof-studio://hypeproof.hypeproof-chat/rehearse?ticket=…` 에서 교환권만 꺼낸다.
 * 좌표를 읽는 분기는 **의도적으로 없다.**
 */
export function parseRehearsalUri(uri: { path: string; query: string }): RehearsalUriParse {
  if (uri.path !== REHEARSAL_URI_PATH) return { ok: false, reason: "wrong_path" };
  const params = new URLSearchParams(uri.query ?? "");
  for (const name of REJECTED_URI_PARAMS) {
    if (params.has(name)) return { ok: false, reason: "forbidden_param", detail: name };
  }
  const ticket = params.get(REHEARSAL_TICKET_PARAM);
  if (!ticket) return { ok: false, reason: "missing_ticket" };
  if (!TICKET_SHAPE.test(ticket)) return { ok: false, reason: "malformed_ticket" };
  return { ok: true, ticket };
}

/**
 * Service 가 돌려주는 거부 사유. 판정은 전부 Service 가 한다 — 확장은 받아서 연다.
 * `already_used` 는 오류가 아니라 **정상 행동의 결과**다: 일회용이라고 정했으면
 * 강사가 링크를 다시 누르는 두 번째 클릭이 반드시 생긴다.
 */
export type RedeemFailureCode =
  | "already_used"
  | "expired"
  | "content_changed"
  | "not_found"
  | "unsupported"
  | "network"
  | "server";

export interface RedeemFailure {
  code: RedeemFailureCode;
  /** 강사에게 그대로 보여 줄 문장. 원인과 다음 행동을 함께 적는다. */
  friendly: string;
}

const FRIENDLY: Record<RedeemFailureCode, string> = {
  already_used:
    "이 리허설 링크는 이미 사용했습니다. 링크는 한 번만 열 수 있습니다. 수업 작성 화면에서 리허설 링크를 다시 받아 주세요.",
  expired:
    "리허설 링크의 유효 시간이 지났습니다. 수업 작성 화면에서 새 링크를 받아 주세요.",
  content_changed:
    "링크를 받은 뒤 수업 내용이 바뀌었습니다. 바뀐 내용으로 리허설하려면 수업 작성 화면에서 새 링크를 받아 주세요.",
  not_found:
    "이 리허설 링크를 확인할 수 없습니다. 수업 작성 화면에서 새 링크를 받아 주세요.",
  unsupported:
    "이 앱 버전은 아직 리허설 링크를 지원하지 않습니다. 앱을 최신 버전으로 업데이트한 뒤 다시 시도해 주세요.",
  network:
    "리허설 링크를 확인하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.",
  server:
    "리허설을 시작하지 못했습니다. 잠시 후 다시 시도하고, 계속되면 운영 담당자에게 알려 주세요.",
};

/** 링크 자체가 잘못된 경우의 문구. Service 에 내보기 전에 걸린다. */
export function parseFailureMessage(parse: Extract<RehearsalUriParse, { ok: false }>): string {
  switch (parse.reason) {
    case "forbidden_param":
      // 좌표·자격증명을 URL 로 나르는 링크는 계약 위반이라 열지 않는다.
      return "이 링크는 열 수 없습니다. 수업 작성 화면에서 리허설 링크를 다시 받아 주세요.";
    case "missing_ticket":
    case "malformed_ticket":
    case "wrong_path":
    default:
      return "리허설 링크를 읽지 못했습니다. 수업 작성 화면에서 새 링크를 받아 주세요.";
  }
}

/** Service 응답의 오류 코드를 우리 코드로 옮긴다. 모르는 것은 server 로 둔다. */
export function classifyRedeemFailure(status: number, body: string): RedeemFailure {
  let code: RedeemFailureCode = "server";
  let parsed: { error?: unknown } | undefined;
  try { parsed = JSON.parse(body) as { error?: unknown }; } catch { parsed = undefined; }
  const error = typeof parsed?.error === "string" ? parsed.error : "";
  if (error === "already_used" || error === "ticket_used") code = "already_used";
  else if (error === "expired" || error === "ticket_expired") code = "expired";
  else if (error === "content_changed" || error === "sha256_mismatch") code = "content_changed";
  else if (status === 404 && !error) code = "unsupported"; // 엔드포인트가 아직 없는 배포
  else if (status === 404 || status === 410) code = "not_found";
  else if (status === 409) code = "content_changed";
  return { code, friendly: FRIENDLY[code] };
}

export function redeemFailure(code: RedeemFailureCode): RedeemFailure {
  return { code, friendly: FRIENDLY[code] };
}

/**
 * Service 응답에서 학생 조건 자격만 꺼낸다. 좌표는 토큰 안에 있고 앱이 따로 읽지 않는다.
 */
export function readRedeemedToken(payload: unknown): string | undefined {
  const token = (payload as { token?: unknown } | undefined)?.token;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

export type RedeemResult = { ok: true; token: string } | { ok: false; failure: RedeemFailure };

/** 교환권을 내고 학생 조건 자격을 받아 온다. 교환권은 본문에만 싣는다 — URL 에 두지 않는다. */
export async function redeemRehearsalTicket(args: {
  proxyUrl: string;
  ticket: string;
  fetchImpl?: typeof fetch;
}): Promise<RedeemResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const url = args.proxyUrl.replace(/\/$/, "") + "/rehearsal/redeem";
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: args.ticket }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // 서버에 닿지도 못했다 — 교환권은 용의자가 아니다.
    return { ok: false, failure: redeemFailure("network") };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, failure: classifyRedeemFailure(res.status, body) };
  }
  let payload: unknown;
  try { payload = await res.json(); } catch { return { ok: false, failure: redeemFailure("server") }; }
  const token = readRedeemedToken(payload);
  if (!token) return { ok: false, failure: redeemFailure("server") };
  return { ok: true, token };
}
