// Shared pre-flight gate for LLM-serving routes (#282).
//
// POST /v1/chat/completions (OpenAI-compatible proxy) and POST /v1/messages
// (Anthropic-native Agent SDK gateway) must enforce the exact same trust
// pipeline. Extracted verbatim from routes/chat.ts so the two routes cannot
// drift:
//
//   1. Bearer token (HMAC v2) — signature + expiry
//   2. Issuer-role rejection (issuer tokens mint, they don't chat)
//   3. Token revocation (S-01 / #46); legacy pre-jti tokens surfaced via
//      the x-token-legacy header
//   4. Profile resolution + token↔profile cohort match
//   5. Active session + live window + session↔profile match
//   6. Roster membership
//   7. Cohort kill-switch (S-12 / #47) — checked AFTER auth/roster on
//      purpose: anonymous probes can't observe pause state
//
// Error responses keep the exact bodies/status codes chat.ts has always
// returned (student-facing Korean copy, runbook links, #257 sanitization).

import type { Context } from "hono";
import type { Env } from "../env";
import { bearer, verify, TokenError, type TokenPayload } from "./tokens";
import { getProfile } from "../profiles";
import type { Profile } from "../profiles/types";
import {
  getActiveSession,
  getCohortPause,
  getRoster,
  isSessionLive,
  isTokenRevoked,
  type ActiveSession,
} from "./kv";

export type ChatGateResult =
  | { ok: true; payload: TokenPayload; profile: Profile; session: ActiveSession }
  | { ok: false; response: Response };

type GateContext = Context<{ Bindings: Env }>;

export async function gateChatRequest(c: GateContext): Promise<ChatGateResult> {
  const env = c.env;

  // 1-2. Auth
  const token = bearer(c.req.header("authorization"));
  if (!token) {
    return {
      ok: false,
      response: c.json({ error: { message: "missing bearer token", type: "auth" } }, 401),
    };
  }

  let payload: TokenPayload;
  try {
    payload = await verify(token, env.HPS_SIGNING_SECRET);
  } catch (err) {
    const code = err instanceof TokenError ? err.code : "unknown";
    // #257 — TokenError messages are curated user-facing prose; anything
    // else is an internal failure and must not reach the client raw.
    if (!(err instanceof TokenError)) {
      console.error(`[${c.get("requestId")}] token verify failed:`, err);
    }
    const message = err instanceof TokenError ? err.message : "invalid token";
    return {
      ok: false,
      response: c.json(
        { error: { message, type: "auth", code, request_id: c.get("requestId") } },
        401,
      ),
    };
  }

  // 2a. Issuer tokens cannot chat. They exist only to mint child tokens via
  // POST /admin/tokens/issue — sending one here is an obvious misuse.
  if (payload.role === "issuer") {
    return {
      ok: false,
      response: c.json(
        { error: { message: "issuer tokens cannot chat", type: "auth", code: "wrong_role" } },
        401,
      ),
    };
  }

  // 2b. Token revocation (S-01 / #46). Skipped for legacy tokens that
  // pre-date jti — they remain valid until exp but can't be killed
  // individually. Surfaced via x-token-legacy: 1 so clients/audits can spot
  // tokens that should be rotated.
  if (payload.jti) {
    const rev = await isTokenRevoked(env.HPS_KV, payload.jti);
    if (rev) {
      return {
        ok: false,
        response: c.json(
          {
            error: {
              message: "이 토큰은 더이상 사용할 수 없어요.",
              type: "auth",
              code: "revoked",
              since: rev.ts,
            },
          },
          401,
        ),
      };
    }
  } else {
    c.header("x-token-legacy", "1");
  }

  // 3. Profile
  const profile = getProfile(payload.p);
  if (!profile) {
    return {
      ok: false,
      response: c.json(
        { error: { message: `unknown profile: ${payload.p}`, type: "config" } },
        400,
      ),
    };
  }
  // Sanity: token cohort must match profile cohort
  if (payload.c !== profile.session.cohort_id) {
    return {
      ok: false,
      response: c.json({ error: { message: "token cohort/profile mismatch", type: "auth" } }, 401),
    };
  }

  // 4-5. Session window + roster
  const session = await getActiveSession(env.HPS_KV, payload.c);
  if (!session) {
    // #165 — student-facing copy is no longer a dead-end. The chat panel's
    // error banner pairs the `runbook_url` link below with this text, so the
    // person who can fix it (instructor) has a one-click path.
    return {
      ok: false,
      response: c.json(
        {
          error: {
            message: "수업이 아직 시작 전이에요. 강사가 곧 열어줄 거예요 — 잠시 후 다시 보내보세요.",
            type: "session_inactive",
            runbook_url: "https://github.com/jayleekr/hypeproof-studio/blob/main/docs/runbook.md#start-session",
          },
        },
        403,
      ),
    };
  }
  if (!isSessionLive(session)) {
    return {
      ok: false,
      response: c.json(
        { error: { message: "수업 시간이 끝났어요. 다음 시간에 다시 만나요.", type: "session_window" } },
        403,
      ),
    };
  }
  if (session.profile_id !== profile.id) {
    return {
      ok: false,
      response: c.json(
        { error: { message: "이 토큰은 다른 회차용이에요.", type: "session_profile_mismatch" } },
        403,
      ),
    };
  }
  const roster = await getRoster(env.HPS_KV, payload.c);
  if (!roster || !roster.users.includes(payload.u)) {
    return {
      ok: false,
      response: c.json(
        { error: { message: "등록된 참가자가 아니에요. 강사에게 알려주세요.", type: "not_in_roster" } },
        403,
      ),
    };
  }

  // 5b. Cohort kill-switch (S-12 / #47) — must precede any upstream call.
  const pause = await getCohortPause(env.HPS_KV, payload.c);
  if (pause) {
    return {
      ok: false,
      response: c.json(
        {
          error: {
            message: "세션이 일시정지되었습니다. 강사에게 문의해주세요.",
            type: "cohort_paused",
            reason: pause.reason,
            since: pause.ts,
          },
        },
        503,
      ),
    };
  }

  return { ok: true, payload, profile, session };
}
