// 리허설 교환권 — 발급 쪽 (C-1, #1131).
//
// 상태: **Router 결정 (2026-09-19) · Jay 검토 전.** 확정 계약이 아니다.
// 표기의 정본은 `docs/design/rehearsal-entry-failure-paths.md` 의 🅡 범례이고,
// 좌석 규약은 #1131 의 Router 코멘트다. 뒤집히면 여기도 같이 뒤집는다.
//
// WHY 이 모듈이 따로 있나
//   강사가 자기 수업을 리허설하려면 **학생 조건 자격**이 필요하다 —
//   issuer 토큰은 앱에 들어가지 못한다(`routes/chat.ts:235` 가 `wrong_role` 401).
//   그런데 기존 학생 자격 발급 경로(`routes/authoring.ts` 의 `participants`)는
//   **로스터 등록을 요구**하고, #1131 이 그 길을 명시적으로 막았다:
//
//     "강사가 리허설하려고 자기를 운영 로스터에 넣는 것은 데이터 오염이다."
//
//   그래서 리허설은 로스터 게이트를 **뚫는 것이 아니라 지나가지 않는다** —
//   애초에 다른 경로이고, 권한은 로스터 멤버십이 아니라 **강사 스코프**로 판정한다
//   (`routes/admin.ts:258-262` 와 같은 판정). 그게 "이 수업을 만든 사람인가" 를
//   직접 묻는 것이라 로스터보다 약하지 않다.
//
// 좌석에 리허설임을 **두 겹으로** 박는다
//   1. `u` 의 고정 접두사 `rehearsal-` — **사람이 읽는 쪽.** 몇 달 뒤 운영 데이터를
//      훑는 사람이 한 번의 필터로 전부 걸러낼 수 있어야 한다.
//   2. 토큰 클레임 `rehearsal: true` — **코드가 읽는 쪽.** 문자열 접두사로 판정하지
//      않는다(핸들에 우연히 그 글자가 들어갈 수 있고, 접두사는 표시이지 권한이 아니다).
//
//   **둘은 반드시 같이 만들어진다** (`rehearsalSeat()` 하나가 둘 다 낸다). 두 곳에서
//   따로 만들면 갈린다 — 이 저장소가 오늘 하루 동안 센 실패가 정확히 그 형태다.
//
// 이 모듈이 정하지 않는 것
//   멱등 창의 길이와 붙여 둔 자격의 정리 방식은 `rehearsal-entry-failure-paths.md:129`
//   가 ⬜ 로 남기고 **"교환 엔드포인트 구현에서 정한다"** 고 적었다. 그건 교환(C-2)의
//   몫이라 여기서 앞당겨 정하지 않는다. 여기는 **발급과 보관**까지다.

// 해시는 여기서 직접 계산한다. `lib/modules.ts` 의 sha256Hex 를 빌려 오면 프로필
// 레지스트리 전체가 딸려 온다(modules → ../profiles) — 자격증명 옆에 서는 원시함수가
// 수업 카탈로그에 의존할 이유가 없고, 그래야 이 모듈이 단독으로 시험된다.
// `crypto.subtle` 은 Workers 와 Node 19+ 양쪽에 있다(tokens.ts 가 crypto.randomUUID 로
// 이미 같은 가정을 쓴다). 출력 형식은 modules.sha256Hex 와 같은 소문자 hex 다.
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 좌석 식별자의 고정 접두사. 사람이 읽고 필터링하는 쪽. */
export const REHEARSAL_SEAT_PREFIX = "rehearsal-";

/**
 * 교환권이 살아 있는 시간. 링크를 받은 강사가 앱을 열 때까지 버텨야 하므로
 * 분 단위가 아니라 시간 단위다. 자격 자체의 수명(`hours`)과는 별개 —
 * 교환권은 **자격을 꺼내는 표**이지 자격이 아니다.
 */
export const REHEARSAL_TICKET_TTL_SECONDS = 24 * 3600;

/** KV 키 접두사. 값 자체가 아니라 **해시**를 키로 쓴다 — 아래 `ticketKey` 참조. */
const TICKET_KEY_PREFIX = "rehearsal:ticket:";

/**
 * 교환권 → KV 키. **교환권 원문을 키로 쓰지 않는다.**
 *
 * 저장소를 덤프해도 **쓸 수 있는 교환권이 나오지 않아야** 한다. 키가 원문이면
 * 키 목록이 곧 유효한 표의 목록이다. 해시는 싸고 그 성질을 없앤다.
 */
export async function ticketKey(ticket: string): Promise<string> {
  return TICKET_KEY_PREFIX + (await sha256Hex(ticket));
}

/**
 * 새 교환권. URL 에 실려 다니므로 URL-safe 여야 하고, 추측 불가여야 한다.
 * 128비트 난수를 base64url 로 — 좌표도 자격증명도 담지 않는다(#1131 `ARC-02`).
 */
export function newTicket(random: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(16))): string {
  const bytes = random();
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 리허설 좌석 하나. **접두사와 클레임을 한 곳에서 같이 낸다** — 호출부가 둘을
 * 따로 조립할 수 없게 하는 것이 이 함수의 존재 이유다.
 */
export function rehearsalSeat(
  instructorHandle: string,
  random: () => string = () => Math.random().toString(36).slice(2, 8),
): { u: string; rehearsal: true } {
  // 핸들에 이미 접두사가 있어도 두 번 붙이지 않는다 — 필터가 `rehearsal-rehearsal-…`
  // 를 만나면 사람이 그걸 다른 종류로 읽는다.
  const handle = instructorHandle.startsWith(REHEARSAL_SEAT_PREFIX)
    ? instructorHandle.slice(REHEARSAL_SEAT_PREFIX.length)
    : instructorHandle;
  return { u: `${REHEARSAL_SEAT_PREFIX}${handle}-${random()}`, rehearsal: true };
}

/**
 * 사람이 읽는 쪽의 판정 — 운영 데이터에서 리허설 좌석을 걸러낼 때 쓴다.
 *
 * **권한 판정에 쓰지 마라.** 권한은 토큰 클레임(`rehearsal`)이 답한다. 이 함수는
 * "이 행을 실제 학생으로 셀 것인가" 에만 답한다.
 */
export function isRehearsalSeatId(u: string): boolean {
  return u.startsWith(REHEARSAL_SEAT_PREFIX);
}

/** 교환권에 붙여 두는 것 — **토큰 하나뿐**이다. */
export interface StoredTicket {
  /** 발급된 학생 조건 자격. 좌표·프로필·코호트는 담지 않는다 — 이미 토큰 안에 있다. */
  token: string;
}

/** KV 에 담기는 모양을 한 곳에서 고정한다(교환 쪽이 같은 모양을 읽는다). */
export function encodeStoredTicket(token: string): string {
  return JSON.stringify({ token } satisfies StoredTicket);
}

/**
 * 교환 쪽이 읽을 때 쓰는 파서. 모양이 다르면 **없는 것으로 취급**한다 —
 * 반쯤 읽은 값으로 자격을 내주느니 "확인할 수 없음" 이 낫다.
 */
export function decodeStoredTicket(raw: string | null): StoredTicket | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { token?: unknown };
    return typeof v?.token === "string" && v.token.length > 0 ? { token: v.token } : null;
  } catch {
    return null;
  }
}
