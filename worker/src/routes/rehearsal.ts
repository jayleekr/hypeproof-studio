// 리허설 교환권 → 학생 조건 좌석 (#1189 C-2).
//
// `#1164` 가 발급과 보관까지 했고 *"멱등 창의 길이와 붙여 둔 자격의 정리 방식은 교환(C-2)의
// 몫"* 이라며 남긴 자리가 여기다.
//
// 경로와 응답 모양은 **내가 정하지 않았다.** 앱 쪽 클라이언트(`rehearsalEntryHelpers.ts`,
// `#1180`)가 이미 `POST <proxy>/rehearsal/redeem` 에 `{ticket}` 을 보내고 `{token}` 을 읽으며,
// 실패를 `{error:"<code>"}` + 상태 코드로 분류한다. 그쪽을 읽고 맞췄다 — 짐작하면 배포된
// 앱이 "엔드포인트가 아직 없는 배포"(`unsupported`)로 읽는다.
//
// **인증 헤더가 없다. 교환권 자체가 자격증명이다.** 128비트 난수이고 저장소에는 해시로만
// 들어간다(`ticketKey`). 그래서 이 경로는 Bearer 를 보지 않으며, 봐서도 안 된다 — 강사의
// issuer 를 여기로 흘리면 `ARC-02` 가 막으려던 것이 되살아난다.
//
// `ARC-01` — 자격은 Service 가 낸다. 여기서 새로 **서명하지 않는다**: 좌석 토큰은 발급
// 시점에 이미 서명돼 KV 에 들어 있고, 교환은 그것을 **꺼내 주는** 일이다. 클라이언트는
// 어떤 경우에도 자격을 만들지 않는다.

import { Hono } from "hono";
import type { Env } from "../env";
import { ticketKey, decodeStoredTicket, REHEARSAL_TICKET_TTL_SECONDS } from "../lib/rehearsal-ticket";
import { verify } from "../lib/tokens";
import { resolveTokenLesson } from "../lib/lesson-delivery";

export const rehearsal = new Hono<{ Bindings: Env }>();

/** 앱이 링크에서 읽는 모양과 **같은** 제약. 저장소를 긁기 전에 모양부터 거른다. */
const TICKET_SHAPE = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * 멱등 창. **응답이 유실된 클라이언트가 같은 교환권으로 다시 물어볼 수 있는 시간.**
 *
 * 왜 필요한가: 즉시 지워 버리면 네트워크가 한 번 끊긴 것만으로 리허설이 영구히 타 버린다.
 * 강사는 "한 번 눌렀는데 아무 일도 안 일어났고 다시 누르니 이미 썼다고 한다" 를 만난다.
 *
 * 왜 `ARC-03`("교환권은 한 번만 통과한다")을 깨지 않는가: 불변식은 **"교환권 하나가 서로
 * 다른 자격을 두 개 만들지 않는다"** 이다. 창 안의 재요청은 **같은 좌석 토큰**을 돌려준다 —
 * 두 번째 통과가 아니라 첫 번째 응답의 재전송이다. 새 좌석은 절대 생기지 않는다.
 *
 * 길이: 재시도 한 번을 덮을 만큼 길고, 새어 나간 표가 오래 살지 않을 만큼 짧게.
 *
 * ── 상태: 🅡 Router 결정 2026-09-21 · JY 검토 전 · **확정 계약 아님** ──
 *
 * **`#1131` 에는 멱등 창 조항이 없다.** 있다고 쓰지 마라 — 직접 세어 확인했다.
 * 결정 권한이 여기 있는 근거는 `docs/design/rehearsal-entry-failure-paths.md` §2.1 이다:
 * *"재제출 정책은 교환 경로를 만드는 작업(C-2)이 정한다"*. 이 파일이 그 C-2 다.
 *
 * **2026-09-19 의 "창 5분" 결정을 대체한다.** 그 값은 같은 문서 §2.1 이
 * *"한 번 🅡 로 올라갔다가 **철회됐다** … **숫자를 인용하지 말 것** — 특히 '5분' 은
 * 근거 없는 값이었다"* 라고 적어 둔 것이다. 120초는 근거에서 나왔다: **응답 유실 재시도
 * 한 번**을 덮는 길이. 어딘가 5분이 남아 있으면 이 값이 이긴다 — 둘이 공존하면 안 된다.
 */
export const REDEEM_IDEMPOTENCY_WINDOW_SECONDS = 120;

interface RedeemState {
  token: string;
  /** 처음 교환된 시각(unix 초). 없으면 아직 안 쓴 표다. */
  used_at?: number;
}

/**
 * 저장된 값을 읽는다. `#1164` 의 `decodeStoredTicket` 이 토큰의 유효성을 판정하고,
 * 여기서는 그 위에 **사용 표시**만 얹어 읽는다 — 그쪽 모듈을 고치지 않기 위해서다.
 * 모양이 깨졌으면 `null`(= 없는 것으로 취급)이라는 그쪽 규율을 그대로 따른다.
 */
export function decodeRedeemState(raw: string | null): RedeemState | null {
  const base = decodeStoredTicket(raw);
  if (!base) return null;
  let used_at: number | undefined;
  try {
    const v = JSON.parse(raw as string) as { used_at?: unknown };
    if (typeof v?.used_at === "number" && Number.isFinite(v.used_at)) used_at = v.used_at;
  } catch { /* decodeStoredTicket 이 이미 통과시킨 값이라 여기 오지 않는다 */ }
  return used_at === undefined ? { token: base.token } : { token: base.token, used_at };
}

export function encodeRedeemState(state: RedeemState): string {
  return JSON.stringify(state);
}

/** 창이 지났는가. 시간 판정을 한 곳에 모아 둔다 — 시험이 이 함수만 흔들면 된다. */
export function idempotencyWindowClosed(usedAt: number, nowSeconds: number): boolean {
  return nowSeconds - usedAt > REDEEM_IDEMPOTENCY_WINDOW_SECONDS;
}

rehearsal.post("/rehearsal/redeem", async (c) => {
  c.header("cache-control", "no-store");
  const body = await c.req.json<{ ticket?: unknown }>().catch(() => null);
  const ticket = typeof body?.ticket === "string" ? body.ticket : "";
  // 400 은 클라이언트가 모양 검사를 건너뛴 경우에만 나온다(앱은 이미 같은 정규식으로 거른다).
  if (!TICKET_SHAPE.test(ticket)) return c.json({ error: "malformed_ticket" }, 400);

  const key = await ticketKey(ticket);
  const state = decodeRedeemState(await c.env.HPS_KV.get(key));
  // 없는 표와 TTL 로 지워진 표는 **구분할 수 없다.** 구분되는 척하지 않는다 —
  // `ticket_expired` 로 단정하면 "만료" 라고 쓰인 화면을 보고 아무도 진짜 원인을 안 본다.
  // (`.claude/rules/verification.md` — 401 을 만료로 읽는 습관이 이틀을 태웠다.)
  if (!state) return c.json({ error: "not_found" }, 410);

  const now = Math.floor(Date.now() / 1000);
  if (state.used_at !== undefined && idempotencyWindowClosed(state.used_at, now)) {
    // `already_used` 는 오류가 아니라 **정상 행동의 결과**다. 일회용이라고 정했으면
    // 강사가 링크를 다시 누르는 두 번째 클릭이 반드시 생긴다(`#1180` 이 적어 둔 그대로).
    return c.json({ error: "already_used" }, 409);
  }

  // 좌석 토큰이 스스로 아직 유효한가. KV TTL 과 토큰 `exp` 는 서로 다른 시계다.
  let payload;
  try { payload = await verify(state.token, c.env.HPS_SIGNING_SECRET); }
  catch { return c.json({ error: "ticket_expired" }, 410); }

  // 고정된 수업이 아직 그대로인가. 게이트(`chat-gate`)가 매 요청 다시 보지만, 여기서
  // 먼저 보면 강사가 **시작하기 전에** 원인을 안다. `VER-02` 의 같은 집행을 앞당기는 것이다.
  if (!payload.lesson || !(await resolveTokenLesson(c.env, payload))) {
    return c.json({ error: "content_changed" }, 409);
  }

  // 사용 표시. 남은 TTL 을 다시 길게 주지 않는다 — 표는 원래 수명만큼만 산다.
  // (`expirationTtl` 최소값이 60초라 그 아래로는 내리지 않는다.)
  if (state.used_at === undefined) {
    const remaining = Math.max(60, Math.min(REHEARSAL_TICKET_TTL_SECONDS, payload.exp - now));
    await c.env.HPS_KV.put(key, encodeRedeemState({ token: state.token, used_at: now }), { expirationTtl: remaining });
  }
  // ⚠️ `expires_at` 이라는 이름이 **발급 응답과 여기서 서로 다른 것을 뜻한다.**
  //   발급(`authoring.ts` rehearsal-tickets): expires_at = **교환권**의 수명(24h),
  //                                           credential_expires_at = **좌석**의 수명
  //   교환(여기):                              expires_at = **좌석**의 수명
  // 실측으로 확인했다(2026-09-21): 교환의 expires_at 값이 발급의 credential_expires_at
  // 과 **같은 수**다. 앱이 두 응답을 같은 이름으로 읽으면 24시간짜리를 좌석 만료로
  // 띄운다 — 강사가 이미 죽은 좌석을 살아 있다고 본다.
  // `expires_at` 은 이미 나가 있는 계약이라 바꾸지 않고, **좌석을 뜻하는 이름을 둘 다에
  // 존재하게** 한다. 앱은 `credential_expires_at` 하나만 읽으면 두 응답에서 같은 뜻이다.
  return c.json({ token: state.token, seat: payload.u, lesson: payload.lesson,
    expires_at: payload.exp, credential_expires_at: payload.exp });
});
