// POST /v1/chat/completions
//
// Pipeline:
//   1. Pull Bearer token (HMAC v2)
//   2. Verify signature + expiry
//   3. Load profile from token.p
//   4. Look up cohort active_session in KV
//   5. Ensure user is in roster + within session window
//   6. Translate OpenAI body → Anthropic with profile.system_prompt
//   7. Call Anthropic streaming endpoint
//   8. Transform SSE → OpenAI deltas, forward to client
//   9. Log usage to Analytics Engine + D1

import { Hono } from "hono";
import type { Env } from "../env";
import { bearer, verify, TokenError, type TokenPayload } from "../lib/tokens";
import { getProfile } from "../profiles";
import { translate, type CoachContext } from "../lib/translate";
import { callAnthropic } from "../lib/anthropic";
import { transformStream } from "../lib/sse";
import { getActiveSession, getRoster, isSessionLive } from "../lib/kv";
import { logChat, persistUsage } from "../lib/analytics";

export const chat = new Hono<{ Bindings: Env }>();

chat.get("/health", (c) =>
  c.json({ ok: true, service: "hypeproof-studio-api", version: "0.1.0", env: c.env.ENVIRONMENT }),
);

// ---------------------------------------------------------------------------
// GET /v1/profile
//
// Returns the UX-relevant subset of the participant's profile so the chat
// extension can render cohort-specific chips/hints/coach flow without the
// extension needing to know about cohorts at compile time.
//
// The system_prompt is NOT included — only the worker injects that.
// ---------------------------------------------------------------------------

chat.get("/profile", async (c) => {
  const auth = await authenticateToken(c.req.header("authorization"), c.env.HPS_SIGNING_SECRET);
  if (!auth.ok) return c.json({ error: { message: auth.message, type: "auth" } }, 401);
  const profile = getProfile(auth.payload.p);
  if (!profile) return c.json({ error: { message: "unknown profile", type: "config" } }, 400);

  return c.json({
    profile_id: profile.id,
    display_name: profile.display_name,
    language: profile.audience.language,
    series_index: profile.session.series_index,
    series_total: profile.session.series_total,
    welcome: profile.welcome,
    ux: profile.ux,
    publishing: { enabled: profile.publishing.enabled, strategy: profile.publishing.strategy },
    preview: profile.preview,
  });
});

interface AuthResult {
  ok: boolean;
  payload: TokenPayload;
  message: string;
}

function decodeHeader(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function authenticateToken(
  authHeader: string | null | undefined,
  secret: string,
): Promise<AuthResult> {
  const token = bearer(authHeader);
  if (!token) {
    return { ok: false, payload: {} as TokenPayload, message: "missing bearer token" };
  }
  try {
    const payload = await verify(token, secret);
    return { ok: true, payload, message: "" };
  } catch (err) {
    const msg = err instanceof TokenError ? err.message : String(err);
    return { ok: false, payload: {} as TokenPayload, message: msg };
  }
}


chat.post("/chat/completions", async (c) => {
  const env = c.env;
  const startedAt = Date.now();

  // 1-2. Auth
  const token = bearer(c.req.header("authorization"));
  if (!token) return c.json({ error: { message: "missing bearer token", type: "auth" } }, 401);

  let payload;
  try {
    payload = await verify(token, env.HPS_SIGNING_SECRET);
  } catch (err) {
    const code = err instanceof TokenError ? err.code : "unknown";
    return c.json({ error: { message: String(err), type: "auth", code } }, 401);
  }

  // 3. Profile
  const profile = getProfile(payload.p);
  if (!profile) {
    return c.json({ error: { message: `unknown profile: ${payload.p}`, type: "config" } }, 400);
  }
  // Sanity: token cohort must match profile cohort
  if (payload.c !== profile.session.cohort_id) {
    return c.json({ error: { message: "token cohort/profile mismatch", type: "auth" } }, 401);
  }

  // 4-5. Session window + roster
  const session = await getActiveSession(env.HPS_KV, payload.c);
  if (!session) {
    return c.json(
      { error: { message: "수업이 시작되지 않았어요. 강사에게 문의해주세요.", type: "session_inactive" } },
      403,
    );
  }
  if (!isSessionLive(session)) {
    return c.json(
      { error: { message: "수업 시간이 끝났어요. 다음 시간에 다시 만나요.", type: "session_window" } },
      403,
    );
  }
  if (session.profile_id !== profile.id) {
    return c.json(
      { error: { message: "이 토큰은 다른 회차용이에요.", type: "session_profile_mismatch" } },
      403,
    );
  }
  const roster = await getRoster(env.HPS_KV, payload.c);
  if (!roster || !roster.users.includes(payload.u)) {
    return c.json(
      { error: { message: "등록된 참가자가 아니에요. 강사에게 알려주세요.", type: "not_in_roster" } },
      403,
    );
  }

  // 6. Translate (with optional coach context from headers)
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "bad json body", type: "request" } }, 400);
  }
  const coach: CoachContext = {
    name: decodeHeader(c.req.header("x-hps-coach-name")),
    personality: decodeHeader(c.req.header("x-hps-coach-personality")),
  };
  let anthropicBody;
  try {
    anthropicBody = translate(body as any, profile, coach);
  } catch (err) {
    return c.json({ error: { message: String(err), type: "request" } }, 400);
  }

  const stream = (body as any)?.stream === true;
  anthropicBody.stream = stream;
  const modelLabel = anthropicBody.model;

  // 7. Upstream
  const upstream = await callAnthropic(anthropicBody, env.ANTHROPIC_API_KEY);
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return c.json(
      {
        error: {
          message: `upstream ${upstream.status}: ${text.slice(0, 200)}`,
          type: "upstream",
        },
      },
      502,
    );
  }

  if (!stream) {
    // Non-streaming: collect and translate
    const j = (await upstream.json()) as any;
    const text = (j.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    const u = j.usage ?? {};
    const log = {
      cohort_id: payload.c,
      user_id: payload.u,
      profile_id: profile.id,
      model: modelLabel,
      status: 200,
      tokens_in: u.input_tokens ?? 0,
      tokens_out: u.output_tokens ?? 0,
      cache_read: u.cache_read_input_tokens ?? 0,
      cache_create: u.cache_creation_input_tokens ?? 0,
      latency_ms: Date.now() - startedAt,
    };
    logChat(env, log);
    c.executionCtx.waitUntil(persistUsage(env, { ...log, session_id: session.session_id }));
    return c.json({
      id: j.id,
      object: "chat.completion",
      model: modelLabel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: j.stop_reason ?? "stop",
        },
      ],
      usage: {
        prompt_tokens: log.tokens_in,
        completion_tokens: log.tokens_out,
        total_tokens: log.tokens_in + log.tokens_out,
      },
    });
  }

  // 8. Streaming: pipe transformed SSE
  const transformed = transformStream(upstream.body, modelLabel, (u) => {
    const log = {
      cohort_id: payload.c,
      user_id: payload.u,
      profile_id: profile.id,
      model: modelLabel,
      status: 200,
      tokens_in: u.input_tokens,
      tokens_out: u.output_tokens,
      cache_read: u.cache_read_input_tokens,
      cache_create: u.cache_creation_input_tokens,
      latency_ms: Date.now() - startedAt,
    };
    logChat(env, log);
    c.executionCtx.waitUntil(persistUsage(env, { ...log, session_id: session.session_id }));
  });

  return new Response(transformed, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
});
