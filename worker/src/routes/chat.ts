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
import { resolveProvider, type Env, type LLMProvider } from "../env";
import { bearer, verify, TokenError, type TokenPayload } from "../lib/tokens";
import { getProfile } from "../profiles";
import { translate, translateOpenAI, type CoachContext } from "../lib/translate";
import { callAnthropic } from "../lib/anthropic";
import { callGeminiResilient } from "../lib/gemini";
import { callOpenAI } from "../lib/openai";
import {
  extractTrialHeaders,
  lastUserMessageText,
  recordTurnIfOwned,
  type TrialHeaders,
} from "../lib/storage";
import { transformStream, passThroughOpenAIStream } from "../lib/sse";
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

  // 6. Build the upstream request (with optional coach context from headers)
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

  // #9c trace hook — client opts in by POST /v1/trace/event{trialStart} and
  // sending the returned trial_id (+ a per-turn idx) as headers. Without
  // headers, chat continues to work as before; no turn row written.
  const trial: TrialHeaders | null = extractTrialHeaders((h) => c.req.header(h) ?? null);
  const promptText = lastUserMessageText(body);
  const promptChars = promptText.length;
  const persistBody = profile.analytics.log_user_messages === true;

  // Pick the upstream LLM (switchable peers; default Gemini — see
  // resolveProvider). translate / translateOpenAI both drop client
  // system+tool messages — the trust model is identical either way.
  let provider: LLMProvider;
  let apiKey: string;
  try {
    ({ provider, apiKey } = resolveProvider(env));
  } catch (err) {
    return c.json({ error: { message: String(err), type: "config" } }, 502);
  }

  const stream = (body as any)?.stream === true;
  let upstream: Response;
  let modelLabel: string;
  let fellBack = false;
  try {
    if (provider === "gemini") {
      const gBody = translateOpenAI(body as any, profile, coach, "gemini");
      gBody.stream = stream;
      if (stream) gBody.stream_options = { include_usage: true };
      // Retry transient 503s, then fall back to gemini-2.5-flash.
      const g = await callGeminiResilient(gBody, apiKey);
      upstream = g.response;
      modelLabel = g.model;        // analytics + response reflect the real model
      fellBack = g.fellBack;
    } else if (provider === "openai") {
      // OpenAI is the canonical OpenAI schema → translateOpenAI handles
      // system-prompt injection + alias→openai model id; the body is passed
      // straight through.
      const oBody = translateOpenAI(body as any, profile, coach, "openai");
      oBody.stream = stream;
      if (stream) oBody.stream_options = { include_usage: true };
      modelLabel = oBody.model;
      upstream = await callOpenAI(oBody, apiKey);
    } else {
      // anthropic — Messages API (different schema; transformStream handles it).
      const aBody = translate(body as any, profile, coach);
      aBody.stream = stream;
      modelLabel = aBody.model;
      upstream = await callAnthropic(aBody, apiKey);
    }
  } catch (err) {
    return c.json({ error: { message: String(err), type: "request" } }, 400);
  }

  // 7. Upstream guard
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

  const mkLog = (
    tokens_in: number,
    tokens_out: number,
    cache_read: number,
    cache_create: number,
  ) => ({
    cohort_id: payload.c,
    user_id: payload.u,
    profile_id: profile.id,
    model: modelLabel,
    status: 200,
    tokens_in,
    tokens_out,
    cache_read,
    cache_create,
    latency_ms: Date.now() - startedAt,
  });
  const record = (log: ReturnType<typeof mkLog>) => {
    logChat(env, log);
    c.executionCtx.waitUntil(persistUsage(env, { ...log, session_id: session.session_id }));
  };

  if (!stream) {
    // Non-streaming: normalize either provider's body to an OpenAI response.
    const j = (await upstream.json()) as any;
    let text = "";
    let tin = 0;
    let tout = 0;
    let cr = 0;
    let cc = 0;
    let finish = "stop";
    if (provider === "anthropic") {
      // Anthropic Messages API native shape
      text = (j.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      finish = j.stop_reason ?? "stop";
      tin = j.usage?.input_tokens ?? 0;
      tout = j.usage?.output_tokens ?? 0;
      cr = j.usage?.cache_read_input_tokens ?? 0;
      cc = j.usage?.cache_creation_input_tokens ?? 0;
    } else {
      // OpenAI-shape response (gemini OpenAI-compat endpoint + native openai)
      text = j.choices?.[0]?.message?.content ?? "";
      finish = j.choices?.[0]?.finish_reason ?? "stop";
      tin = j.usage?.prompt_tokens ?? 0;
      tout = j.usage?.completion_tokens ?? 0;
    }
    const log = mkLog(tin, tout, cr, cc);
    record(log);
    // #9c trace: persist turn meta + optional R2 body. Fire-and-forget — must
    // not block the response. Skipped when client did not send trial headers.
    if (trial) {
      c.executionCtx.waitUntil(
        recordTurnIfOwned(
          env,
          {
            trial_id: trial.trial_id,
            turn_idx: trial.turn_idx,
            prompt_chars: promptChars,
            response_chars: text.length,
            tokens_in: tin,
            tokens_out: tout,
            latency_ms: Date.now() - startedAt,
            model: modelLabel,
          },
          payload.u,
          payload.c,
          persistBody
            ? { persistBody: true, body: { prompt: promptText, response: text } }
            : {},
        ).catch((err) => console.error("recordTurnIfOwned (non-stream) failed:", err)),
      );
    }
    c.header("x-hps-model", modelLabel);
    if (fellBack) c.header("x-hps-fallback", "1");
    return c.json({
      id: j.id ?? "chatcmpl-hps",
      object: "chat.completion",
      model: modelLabel,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finish }],
      usage: {
        prompt_tokens: tin,
        completion_tokens: tout,
        total_tokens: tin + tout,
      },
    });
  }

  // 8. Streaming: Gemini + OpenAI both emit OpenAI chat.completion.chunk SSE
  //    (passthrough + usage tap); Anthropic events are transformed to OpenAI
  //    chunks.
  const onUsage = (u: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  }) => {
    record(mkLog(u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens));
    // #9c trace: streaming turn meta. response_chars=0 here — stream-body
    // capture (R2 turn_body) requires a stream tee + per-provider SSE parser
    // and is intentionally a follow-up; the meta still feeds Efficiency +
    // Iteration scoring.
    if (trial) {
      c.executionCtx.waitUntil(
        recordTurnIfOwned(
          env,
          {
            trial_id: trial.trial_id,
            turn_idx: trial.turn_idx,
            prompt_chars: promptChars,
            response_chars: 0,
            tokens_in: u.input_tokens,
            tokens_out: u.output_tokens,
            latency_ms: Date.now() - startedAt,
            model: modelLabel,
          },
          payload.u,
          payload.c,
        ).catch((err) => console.error("recordTurnIfOwned (stream) failed:", err)),
      );
    }
  };

  const outStream =
    provider === "anthropic"
      ? transformStream(upstream.body, modelLabel, onUsage)
      : passThroughOpenAIStream(upstream.body, onUsage);

  const streamHeaders: Record<string, string> = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
    "x-hps-model": modelLabel,
  };
  if (fellBack) streamHeaders["x-hps-fallback"] = "1";
  return new Response(outStream, { headers: streamHeaders });
});
