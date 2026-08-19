// PUT /v1/logs/:sessionId/:filename?day=YYYY-MM-DD — #596 (#580 업로드 계층)
//
// Studio 로컬 스풀(#580, PR #595)의 세션 디렉토리를 파일 단위로 R2 에 적재한다.
// 키는 서버가 조립한다:
//
//   studio-logs/<c>/<u>/<day>/<sessionId>/<filename>
//
// <c>/<u> 는 **검증된 토큰 payload** 에서만 온다 — 클라이언트는 자기 신원
// 프리픽스를 고를 수 없다(경로 위조 불가). 클라이언트 업로더는 manifest.json
// 을 마지막에 올린다 — manifest 가 있는 세션 = 완결(부분 업로드 판별,
// 멱등 재시도는 R2 put 덮어쓰기가 보장).
//
// 인증은 trace.ts 를 본뜬 의도적 복제다(채팅 핫패스 리팩토링 회피 — trace.ts
// 137행과 같은 판단). 단 **한 가지가 다르고 그게 이 라우트의 존재 이유다**:
// active-session 게이트가 없다. 업로드는 수업이 끝난 뒤("세션 종료 감지 배너")
// 일어나는 게 정상 경로라, chat 처럼 session_inactive/window 로 막으면 기능이
// 성립하지 않는다. 토큰 유효기간(수업일 +N시간)이 시간 창을 대신 좁힌다.
//
// 프라이버시: 질문 원문이 PC 를 떠나는 지점이므로 코호트 opt-in 이 서버에서
// fail-closed 로 강제된다 — profile.analytics.upload_session_logs === true 인
// 코호트만 통과. R2 턴 원문의 log_user_messages 와 같은 규율(기본 OFF,
// 동의·보존정책 후 opt-in — wrangler.toml 주석의 기존 팀 결정).

import { Hono } from "hono";
import type { Env } from "../env";
import { bearer, verify, TokenError, type TokenPayload } from "../lib/tokens";
import { getProfile } from "../profiles";
import { getRoster, isTokenRevoked, bumpRateCounter } from "../lib/kv";
import { isUuid } from "../lib/storage";

export const logs = new Hono<{ Bindings: Env }>();

// 파일명 allowlist — 스풀 세션 디렉토리의 정식 산출물 3종만. 그 외(임시 파일,
// 경로 문자 포함, 업로더 로컬 마커 등)는 전부 거부한다.
const ALLOWED_FILES: Record<string, { maxBytes: number; contentType: string }> = {
  "session.meta.json": { maxBytes: 64 * 1024, contentType: "application/json" },
  "events.jsonl": { maxBytes: 8 * 1024 * 1024, contentType: "application/x-ndjson" },
  "manifest.json": { maxBytes: 256 * 1024, contentType: "application/json" },
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// 세션 1개 = put 3회. 재시도까지 감안해도 분당 60 은 넉넉하고, 폭주만 막는다.
const UPLOAD_RATE_LIMIT = 60;
const UPLOAD_RATE_WINDOW_SEC = 60;

export function uploadObjectKey(
  payload: Pick<TokenPayload, "c" | "u">,
  day: string,
  sessionId: string,
  filename: string,
): string {
  return `studio-logs/${payload.c}/${payload.u}/${day}/${sessionId}/${filename}`;
}

logs.put("/:sessionId/:filename", async (c) => {
  const env = c.env;

  // 1. Auth — 서명 + 만료
  const token = bearer(c.req.header("authorization"));
  if (!token) return c.json({ error: { message: "missing bearer token", type: "auth" } }, 401);
  let payload: TokenPayload;
  try {
    payload = await verify(token, env.HPS_SIGNING_SECRET);
  } catch (err) {
    const code = err instanceof TokenError ? err.code : "unknown";
    if (!(err instanceof TokenError)) {
      console.error(`[${c.get("requestId")}] logs token verify failed:`, err);
    }
    const message = err instanceof TokenError ? err.message : "invalid token";
    return c.json({ error: { message, type: "auth", code } }, 401);
  }

  // 2. Issuer 토큰은 업로드하지 않는다 — 학생 데이터의 귀속 주체가 아니다.
  if (payload.role === "issuer") {
    return c.json(
      { error: { message: "issuer tokens cannot upload logs", type: "auth", code: "wrong_role" } },
      401,
    );
  }

  // 2b. 폐기 검사 — 업로드는 수업 후에도 열려 있는 경로라 폐기가 특히 중요하다.
  if (payload.jti) {
    const rev = await isTokenRevoked(env.HPS_KV, payload.jti);
    if (rev) {
      return c.json(
        { error: { message: "이 토큰은 더이상 사용할 수 없어요.", type: "auth", code: "revoked" } },
        401,
      );
    }
  }

  // 3. Profile + cohort 정합
  const profile = getProfile(payload.p);
  if (!profile) {
    return c.json({ error: { message: `unknown profile: ${payload.p}`, type: "config" } }, 400);
  }
  if (payload.c !== profile.session.cohort_id) {
    return c.json({ error: { message: "token cohort/profile mismatch", type: "auth" } }, 401);
  }

  // 4. 코호트 opt-in — fail closed. 플래그 없는/false 코호트는 서버가 거부한다.
  if (profile.analytics.upload_session_logs !== true) {
    return c.json(
      {
        error: {
          message: "이 수업은 기록 업로드를 사용하지 않아요.",
          type: "upload_disabled",
        },
      },
      403,
    );
  }

  // 5. Roster — 명단에 없는 핸들은 쓰기 불가. (active-session 게이트는 의도적
  // 부재 — 헤더 주석 참고. pause 도 검사하지 않는다: pause 는 채팅 차단이지
  // 수업 후 기록 회수까지 막을 이유가 없다.)
  const roster = await getRoster(env.HPS_KV, payload.c);
  if (!roster || !roster.users.includes(payload.u)) {
    return c.json({ error: { message: "not in roster", type: "not_in_roster" } }, 403);
  }

  // 6. Rate limit
  const rl = await bumpRateCounter(
    env.HPS_KV,
    `rate:logs:${payload.c}:${payload.u}`,
    UPLOAD_RATE_LIMIT,
    UPLOAD_RATE_WINDOW_SEC,
  );
  if (!rl.allowed) {
    return c.json({ error: { message: "too many uploads", type: "rate_limit" } }, 429);
  }

  // 7. 파라미터 검증 — 키에 들어가는 모든 조각은 형식이 고정돼 있다.
  const sessionId = c.req.param("sessionId");
  const filename = c.req.param("filename");
  const day = c.req.query("day") ?? "";
  if (!isUuid(sessionId)) {
    return c.json({ error: { message: "sessionId must be a uuid", type: "request" } }, 400);
  }
  const spec = ALLOWED_FILES[filename];
  if (!spec) {
    return c.json(
      { error: { message: "filename must be one of session.meta.json / events.jsonl / manifest.json", type: "request" } },
      400,
    );
  }
  if (!DAY_RE.test(day)) {
    return c.json({ error: { message: "day query must be YYYY-MM-DD", type: "request" } }, 400);
  }

  // 8. 크기 캡 — Content-Length 로 선차단(trace.ts F#7 과 같은 이유), 실측이 정답.
  const declaredLen = Number(c.req.header("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > spec.maxBytes) {
    return c.json(
      { error: { message: `${filename} exceeds ${spec.maxBytes} bytes`, type: "request" } },
      413,
    );
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength > spec.maxBytes) {
    return c.json(
      { error: { message: `${filename} exceeds ${spec.maxBytes} bytes`, type: "request" } },
      413,
    );
  }
  if (body.byteLength === 0) {
    return c.json({ error: { message: "empty body", type: "request" } }, 400);
  }

  // 9. R2 적재 — 같은 키 재업로드는 덮어쓰기(멱등 재시도).
  const key = uploadObjectKey(payload, day, sessionId, filename);
  await env.HPS_TRACES.put(key, body, {
    httpMetadata: { contentType: spec.contentType },
  });

  return c.json({ ok: true, key });
});
