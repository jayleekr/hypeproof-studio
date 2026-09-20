// 강사가 자기 수업을 학생 조건으로 돌려 보는 한 번 — 순수 로직 (#1205, RUN-01 · ARC-03).
//
// vscode 를 import 하지 않는다. 앱 없이 대조군을 돌릴 수 있어야 하기 때문이다.
// I/O 는 전부 `fetchImpl` 로 주입받으므로 시험이 **나가는 요청의 모양까지** 검사한다 —
// 이 파일의 존재 이유가 사실상 그것이다.
//
// ── 무엇이 바뀌고 무엇이 안 바뀌는가 ─────────────────────────────────────
// 설계(`docs/design/rehearsal-entry-in-app-switch.md` §1)가 못 박은 대로,
// **바뀌는 것은 하나다: 채팅·도구 경로가 어떤 자격을 싣는가.**
//
//   교환권 발급  → issuer Bearer        (저작 API 다. 강사는 계속 강사다)
//   교환         → **인증 헤더 없음**    (교환권 자체가 자격증명이다)
//   리허설 중 채팅 → 좌석 토큰            (issuer 는 절대 안 나간다)
//
// 가운데 줄이 직관에 반해서 시험으로 박아 둔다. 교환에 issuer 를 실으면
// `ARC-02` 가 막으려던 것이 되살아난다 (worker `routes/rehearsal.ts` 헤더 참조).
//
// ── 딥링크는 쓰지 않는다 ─────────────────────────────────────────────────
// 강사와 학생이 같은 앱이므로(2026-09-21 A안) 앱 밖으로 나갈 일이 없다.
// 교환권은 **남긴다** — 없애면 `ARC-03` 의 "한 번만 통과" 가 사라진다. URL 만
// 없앤 것이고, 그래서 교환권의 노출 구간이 "사람이 누르는 링크" 에서 "프로세스 안
// 변수" 로 줄었다. 계약을 우회하는 게 아니라 계약이 막으려던 것을 없앤 것이다.

import { adminBaseFor } from "./mintStudentTokenHelpers.ts";
import {
  classifyRedeemFailure,
  redeemFailure,
  type RedeemFailure,
} from "./rehearsalEntryHelpers.ts";

/** 리허설할 수업을 가리키는 좌표. `ARC-03` 의 넷 중 앞의 셋. */
export interface LessonRef {
  cohort: string;
  course: string;
  version: string;
}

/**
 * 교환권 발급 경로.
 *
 * `/admin` 아래다 — `routes/admin.ts` 가 `admin.route("/", authoring)` 으로 저작
 * 라우터를 얹고, 그 root 가 `/cohorts/:cohort/authoring/:course` 다. `/v1` 이 아니다.
 *
 * 첫 판본은 `/v1/authoring/...` 이었고 **스텁이 그 실수를 받아 줬다**
 * (`url.includes("/rehearsal-tickets")` 로 느슨하게 맞췄다). 실물 worker 를 물려
 * 보고서야 드러났다 — 스텁은 내가 기대하는 서버를 흉내내므로 내 오해까지 같이
 * 흉내낸다. 그래서 이 경로는 **짐작이 아니라 라우터 등록을 읽고** 적었다.
 */
export function ticketPath(ref: LessonRef): string {
  return (
    `/admin/cohorts/${encodeURIComponent(ref.cohort)}` +
    `/authoring/${encodeURIComponent(ref.course)}` +
    `/versions/${encodeURIComponent(ref.version)}/rehearsal-tickets`
  );
}

/**
 * 교환권 발급 요청의 헤더. **여기에만 issuer 가 실린다.**
 * 저작 API 이므로 강사 자격이 맞다 (설계 §1 "저작 호출: 리허설 중에도 issuer").
 */
export function ticketRequestHeaders(issuerToken: string): Record<string, string> {
  return { authorization: `Bearer ${issuerToken}`, "content-type": "application/json" };
}

/**
 * 교환 요청의 헤더. **`authorization` 이 없다 — 있으면 안 된다.**
 *
 * 함수로 만들어 둔 이유: 빈 객체를 호출부에서 조립하면 나중에 누가 "인증이 있어야
 * 맞겠지" 하고 한 줄 넣는다. 이름 붙은 자리가 있으면 그 한 줄이 시험에 걸린다.
 */
export function redeemRequestHeaders(): Record<string, string> {
  return { "content-type": "application/json" };
}

/** 리허설 중 나가는 채팅·도구 요청의 자격. 좌석 토큰이고 issuer 가 아니다. */
export function rehearsalAuthToken(state: RehearsalState): string | undefined {
  return state.phase === "active" ? state.seatToken : undefined;
}

export interface TicketResult {
  ticket: string;
  expires_at?: number;
}

export type TicketOutcome =
  | { ok: true; result: TicketResult }
  | { ok: false; failure: RedeemFailure };

/**
 * 교환권을 받아 온다. 실패 분류는 교환 쪽과 **같은 함수**를 쓴다
 * (`classifyRedeemFailure`) — 강사에게는 "리허설을 시작하지 못했다" 하나의 일이고,
 * 발급에서 깨졌는지 교환에서 깨졌는지로 문구가 갈리면 설명만 늘어난다.
 */
export async function requestRehearsalTicket(args: {
  proxyUrl: string;
  issuerToken: string;
  ref: LessonRef;
  hours?: number;
  fetchImpl?: typeof fetch;
}): Promise<TicketOutcome> {
  const doFetch = args.fetchImpl ?? fetch;
  const url = adminBaseFor(args.proxyUrl) + ticketPath(args.ref);
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: ticketRequestHeaders(args.issuerToken),
      body: JSON.stringify(args.hours ? { hours: args.hours } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, failure: redeemFailure("network") };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, failure: classifyRedeemFailure(res.status, body) };
  }
  let payload: unknown;
  try { payload = await res.json(); } catch { return { ok: false, failure: redeemFailure("server") }; }
  const ticket = (payload as { ticket?: unknown } | undefined)?.ticket;
  if (typeof ticket !== "string" || ticket.length === 0) {
    return { ok: false, failure: redeemFailure("server") };
  }
  const exp = (payload as { expires_at?: unknown }).expires_at;
  return { ok: true, result: { ticket, expires_at: typeof exp === "number" ? exp : undefined } };
}

// ─── 상태기계 ─────────────────────────────────────────────────────────
//
// 들어가는 것보다 **돌아오는 것**이 어렵다. 돌아올 곳을 들어가기 전에 적어 두지
// 않으면 돌아올 수 없고, 그래서 `previous` 는 `enter()` 가 아니라 `begin()` 에서
// 잡는다 — 교환이 실패해도 원래 자리를 잃지 않는다.

/** 리허설 전에 이 창이 붙어 있던 곳. 돌아갈 자리. */
export interface PreviousConnection {
  /** 직전 참여 자격. 붙어 있지 않았으면 undefined — 그것도 복원할 상태다. */
  token?: string;
}

export type RehearsalState =
  | { phase: "idle" }
  | { phase: "starting"; ref: LessonRef; previous: PreviousConnection }
  | { phase: "active"; ref: LessonRef; previous: PreviousConnection; seatToken: string; seat?: string }
  | { phase: "returning"; previous: PreviousConnection };

export const IDLE: RehearsalState = { phase: "idle" };

export function begin(ref: LessonRef, previous: PreviousConnection): RehearsalState {
  return { phase: "starting", ref, previous };
}

/** 교환이 성공했다. 좌석을 손에 쥐었을 때만 `active` 가 된다. */
export function activate(
  state: RehearsalState,
  seatToken: string,
  seat?: string,
): RehearsalState {
  if (state.phase !== "starting") return state;
  return { phase: "active", ref: state.ref, previous: state.previous, seatToken, seat };
}

/**
 * 시작에 실패했다. **원래 자리로 그대로 돌아간다** — 실패했는데 어정쩡한 상태로
 * 남는 것이 가장 나쁘다. 강사는 뭐가 걸렸는지 모른 채 수업 직전에 서 있게 된다.
 */
export function abort(state: RehearsalState): RehearsalState {
  return state.phase === "starting" ? { phase: "returning", previous: state.previous } : IDLE;
}

/** 리허설을 끝낸다. 좌석은 여기서 버려진다 — 메모리 밖으로 나가지 않는다. */
export function finish(state: RehearsalState): RehearsalState {
  return state.phase === "active" ? { phase: "returning", previous: state.previous } : IDLE;
}

/** 복원이 끝났다. */
export function settled(): RehearsalState {
  return IDLE;
}

/** 지금 리허설 중인가. 화면 문구와 `when` 절이 이것만 본다. */
export function isRehearsing(state: RehearsalState): boolean {
  return state.phase === "active";
}

/** 상태줄에 쓸 한 줄. 리허설 중이 아니면 빈 문자열. */
export function rehearsalLabel(state: RehearsalState): string {
  if (state.phase !== "active") return "";
  return `리허설 중 · ${state.ref.course} ${state.ref.version}`;
}
