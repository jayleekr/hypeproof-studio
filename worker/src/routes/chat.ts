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
import {
  getActiveSession,
  getCohortPause,
  getRoster,
  isSessionLive,
  isTokenRevoked,
} from "../lib/kv";
import { logChat, persistUsage } from "../lib/analytics";
import { runDeepHealth } from "../cron/health.ts";

export const chat = new Hono<{ Bindings: Env }>();

chat.get("/health", (c) =>
  c.json({ ok: true, service: "hypeproof-studio-api", version: "0.1.0", env: c.env.ENVIRONMENT }),
);

// Deep health probe (S-05 / #51). Live-tests every external dependency:
// the active LLM provider (incl. anthropic proxy URL when set), KV, D1.
// Used by:
//   - the 15-min heartbeat cron (#45) when it needs richer diagnostics
//   - operator console during 보아치과 티저 세션 (Jay polls)
//   - manual `wrangler tail` smoke before deploy
//
// Auth: admin Basic, OR an internal "x-cron-trigger: true" header (set by
// the scheduled() entry point — see worker/src/index.ts). This keeps the
// endpoint cheap to call from cron without burning the chat token path.
chat.get("/health/deep", async (c) => {
  // Lightweight auth: admin password OR internal cron flag. We deliberately
  // don't accept session tokens here — this is operator-only, not a path the
  // student app calls.
  const cronFlag = c.req.header("x-cron-trigger") === "true";
  if (!cronFlag) {
    const want = c.env.HPS_ADMIN_PASSWORD;
    if (!want) return c.json({ error: "admin not configured" }, 503);
    const authz = c.req.header("authorization") ?? "";
    const m = /^Basic\s+(.+)$/i.exec(authz);
    if (!m || !m[1]) return c.json({ error: "auth required" }, 401);
    const decoded = atob(m[1]);
    const [, pass] = decoded.split(":", 2);
    if (pass !== want) return c.json({ error: "auth required" }, 401);
  }
  const result = await runDeepHealth(c.env);
  return c.json(result, result.ok ? 200 : 503);
});

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
    // Drives the chat panel's tone (game vs search-webapp UI copy) (#159).
    game: { template_tier: profile.game.template_tier },
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

  // 2a. Issuer tokens cannot chat. They exist only to mint child tokens via
  // POST /admin/tokens/issue — sending one here is an obvious misuse.
  if (payload.role === "issuer") {
    return c.json(
      { error: { message: "issuer tokens cannot chat", type: "auth", code: "wrong_role" } },
      401,
    );
  }

  // 2b. Token revocation (S-01 / #46). Skipped for legacy tokens that
  // pre-date jti — they remain valid until exp but can't be killed
  // individually. Surfaced via x-token-legacy: 1 so clients/audits can spot
  // tokens that should be rotated.
  if (payload.jti) {
    const rev = await isTokenRevoked(env.HPS_KV, payload.jti);
    if (rev) {
      return c.json(
        { error: { message: "이 토큰은 더이상 사용할 수 없어요.", type: "auth", code: "revoked", since: rev.ts } },
        401,
      );
    }
  } else {
    c.header("x-token-legacy", "1");
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

  // 5b. Cohort kill-switch (S-12 / #47) — must precede any upstream call.
  // Checked AFTER auth/roster on purpose: anonymous probes can't observe
  // pause state, and the response shape stays cohort-specific.
  const pause = await getCohortPause(env.HPS_KV, payload.c);
  if (pause) {
    return c.json(
      {
        error: {
          message: "세션이 일시정지되었습니다. 강사에게 문의해주세요.",
          type: "cohort_paused",
          reason: pause.reason,
          since: pause.ts,
        },
      },
      503,
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
      // Route through the optional region-pinned proxy when set, otherwise
      // call api.anthropic.com directly. The proxy is passthrough (same key,
      // same headers, same SSE shape).
      const aBody = translate(body as any, profile, coach);
      aBody.stream = stream;
      modelLabel = aBody.model;
      upstream = await callAnthropic(aBody, apiKey, { url: env.ANTHROPIC_PROXY_URL });
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
