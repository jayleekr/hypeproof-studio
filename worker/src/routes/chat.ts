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
import { gateChatRequest } from "../lib/chat-gate";
import { getProfile } from "../profiles";
import { translate, translateOpenAI, type CoachContext } from "../lib/translate";
import { callAnthropic } from "../lib/anthropic";
import { callGeminiResilient } from "../lib/gemini";
import { callOpenAI } from "../lib/openai";
import {
  extractTrialHeaders,
  lastUserMessageText,
  type TrialHeaders,
} from "../lib/chat-extract";
import { recordTurnIfOwned } from "../lib/storage";
import { transformStream, passThroughOpenAIStream } from "../lib/sse";
import { scoreTurnAssets } from "../lib/asset-scorer";
import { logChat, persistUsage } from "../lib/analytics";
import {
  isMinorCohort,
  screenText,
  reportModerationHit,
  MODERATION_BLOCK_MESSAGE_KO,
} from "../lib/moderation";
import { runDeepHealth } from "../cron/health.ts";

// #358 — request-shaped upstream 4xx that /v1/chat passes through with its REAL
// status + a sanitized OpenAI-shaped error `type`, instead of masking it as a
// generic 502. Sibling of routes/messages.ts PASSTHROUGH_4XX (Anthropic shape).
// The type guard narrows the status to a literal union so Hono's c.json accepts
// it as a StatusCode. 413 is the load-bearing case: an oversized pasted image
// pushes the body past the region-pinned Anthropic proxy's limit.
const CHAT_PASSTHROUGH_4XX = {
  400: "invalid_request_error",
  413: "request_too_large",
  422: "invalid_request_error",
  429: "rate_limit_error",
} as const;

function isChatPassthrough4xx(status: number): status is keyof typeof CHAT_PASSTHROUGH_4XX {
  return status in CHAT_PASSTHROUGH_4XX;
}

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
    assets_focus: profile.assets_focus,
    welcome: profile.welcome,
    ux: profile.ux,
    publishing: { enabled: profile.publishing.enabled, strategy: profile.publishing.strategy },
    preview: profile.preview,
    // #422 — the cohort's on-disk workspace folder. The chat extension opens
    // this folder on onboarding (and GitHub Pages publishing pushes it later).
    // Absent → the client keeps its legacy default. Exposing it here is what
    // lets the client stop hardcoding "~/HypeProofGames" for every cohort.
    workspace_root: profile.sandbox.workspace_root ?? null,
    // #278 — input capabilities, default off (minor-safe). Drives whether the
    // chat panel exposes "페이지를 코치에게" / image paste.
    input: {
      page_context: profile.input?.page_context === true,
      image_paste: profile.input?.image_paste === true,
    },
    // #278 Phase 3 — the coach's browser control loop. The host runs the loop +
    // CDP executor only when enabled; max_iterations caps the loop.
    browser_control: {
      enabled: profile.browser_control?.enabled === true,
      max_iterations: profile.browser_control?.max_iterations ?? 8,
    },
    // #306 — per-cohort hardened native-browser session. Minor cohorts send
    // mode="safe"; the Studio host maps it to hypeproof.browser.safeSession so
    // the integrated browser uses the locked-down persist:hp-safe session.
    // Default browse (adult), so unchanged for existing cohorts.
    browser_session: {
      mode: profile.browser_session?.mode ?? "browse",
      allowlist: profile.browser_session?.allowlist ?? [],
    },
    // #320 — minors compliance flag (REQ-O1). True when the profile is
    // explicitly flagged OR its age_range upper bound is under 18. Lets the
    // client render minor-specific UX (AI disclosure etc.) without hardcoding
    // cohort knowledge.
    minor_cohort: isMinorCohort(profile),
    // Drives the chat panel's tone (game vs search-webapp UI copy) (#159).
    game: { template_tier: profile.game.template_tier },
    // #282 — expose the cohort's provider-tool opt-in so the Studio Agent SDK
    // coach grants WebSearch only where the profile explicitly enabled it
    // (the profile owns tool policy; the client never infers it).
    tools: { web_search: profile.tools?.web_search === true },
    // #282 Phase 2 — Agent SDK workspace tools. Profile owns the policy
    // (ADR 0003); absent flags normalize to false (fail closed, minor-safe).
    sdk_tools: {
      read: profile.sdk_tools?.read === true,
      write: profile.sdk_tools?.write === true,
      // #282 P2 slice 2 — native-browser MCP tools (browser_open/screenshot/
      // live_preview). Adults only; minors stay false until safe-session
      // ships (#306/#318) — harness child_sdk_browser FAIL enforces it.
      browser: profile.sdk_tools?.browser === true,
      // #282 P2 slice 3 — read-only 코드리뷰어/리서처 subagents. Adults only;
      // minors stay false until a pedagogy decision lands — harness
      // child_sdk_subagents FAIL enforces it.
      subagents: profile.sdk_tools?.subagents === true,
      // epic #431 — shell. This serializer is the LAST hop: a profile can set
      // `shell: true` and it still never reaches the client unless it is listed
      // here, and the client's permittedToolsFor reads only what arrives. The
      // whole grant is inert without this line (found by probing prod after the
      // deploy — the profile said true, the API served four keys).
      shell: profile.sdk_tools?.shell === true,
    },
    // #371/#282 — profile-requested coach runtime. Only an ADULT cohort that
    // opts into sdk_tools may request "agent-sdk" (real file Read/Write/Edit →
    // durable task/rubric tracking). Minors are force-pinned to proxy here so
    // a profile mistake can never route a child to the file/exec-capable
    // runtime. Absent → proxy. The client still gates every tool via
    // canUseTool and honors the machine-scoped runtime setting.
    coach_runtime:
      profile.coach_runtime === "agent-sdk" && !isMinorCohort(profile)
        ? "agent-sdk"
        : "proxy",
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
    // #257 — only TokenError prose is curated for users; anything else
    // (crypto/config failures) stays server-side.
    const msg = err instanceof TokenError ? err.message : "invalid token";
    return { ok: false, payload: {} as TokenPayload, message: msg };
  }
}


chat.post("/chat/completions", async (c) => {
  const env = c.env;
  const startedAt = Date.now();

  // 1-5b. Auth → revocation → profile → session/roster → kill-switch.
  // Shared with POST /v1/messages (#282) via gateChatRequest so the two
  // LLM-serving routes enforce identical trust gates.
  const gate = await gateChatRequest(c);
  if (!gate.ok) return gate.response;
  const { payload, profile, session } = gate;

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

  // #320 — gateway moderation, MINOR cohorts only (REQ-O2). Deterministic
  // conservative screen of the latest user text BEFORE any upstream call:
  // a blocked turn costs zero tokens and never reaches the model. Adult
  // cohorts skip this entirely (REQ-O4 — no behavior change). This covers
  // the inbound side of BOTH stream and non-stream requests; outbound
  // streaming moderation is a documented follow-up (we do not buffer
  // streams — see lib/moderation.ts header).
  if (isMinorCohort(profile)) {
    const hit = screenText(promptText);
    if (hit) {
      reportModerationHit(
        env,
        c.get("requestId"),
        { cohort_id: payload.c, user_id: payload.u, profile_id: profile.id, direction: "inbound" },
        hit,
      );
      return c.json(
        {
          error: {
            message: MODERATION_BLOCK_MESSAGE_KO,
            type: "moderation_block",
            category: hit.category,
            request_id: c.get("requestId"),
          },
        },
        400,
      );
    }
  }

  // Pick the upstream LLM (switchable peers; default Gemini — see
  // resolveProvider). translate / translateOpenAI both drop client
  // system+tool messages — the trust model is identical either way.
  let provider: LLMProvider;
  let apiKey: string;
  try {
    ({ provider, apiKey } = resolveProvider(env));
  } catch (err) {
    // #257 — config prose (env var names, provider wiring) stays in logs.
    console.error(`[${c.get("requestId")}] provider config error:`, err);
    return c.json(
      {
        error: {
          message: "LLM provider is not configured — contact the operator",
          type: "config",
          request_id: c.get("requestId"),
        },
      },
      502,
    );
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
      //
      // No clientBeta threading here (#282 — unlike routes/messages.ts):
      // /v1/chat clients speak the OpenAI schema, never send an
      // anthropic-beta header or beta-gated body fields, and translate()
      // builds the Anthropic body from scratch — only the worker's own
      // prompt-caching beta is needed upstream.
      const aBody = translate(body as any, profile, coach);
      aBody.stream = stream;
      modelLabel = aBody.model;
      upstream = await callAnthropic(aBody, apiKey, {
        url: env.ANTHROPIC_PROXY_URL,
        proxySecret: env.ANTHROPIC_PROXY_SECRET,
      });
    }
  } catch (err) {
    // #257 — translation/fetch errors can embed upstream URLs, header names,
    // or body shapes. Log full, return generic.
    console.error(`[${c.get("requestId")}] upstream call failed:`, err);
    return c.json(
      { error: { message: "upstream request failed", type: "request", request_id: c.get("requestId") } },
      400,
    );
  }

  // 7. Upstream guard
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    // #257 — the upstream error body (provider prose, key hints, quota info)
    // goes to logs only; the client learns the status code + request_id.
    console.error(`[${c.get("requestId")}] upstream ${upstream.status}: ${text.slice(0, 500)}`);
    // #358 — pass a request-shaped 4xx through with its REAL status + sanitized
    // type so the webview can show a specific, friendly message (esp. 413 →
    // "이미지가 너무 커요") instead of the generic card. Raw upstream prose stays
    // in logs only. Everything else (5xx / network) is OUR gateway failure → 502.
    if (isChatPassthrough4xx(upstream.status)) {
      return c.json(
        {
          error: {
            message: `upstream error (status ${upstream.status})`,
            type: CHAT_PASSTHROUGH_4XX[upstream.status],
            request_id: c.get("requestId"),
          },
        },
        upstream.status,
      );
    }
    return c.json(
      {
        error: {
          message: `upstream error (status ${upstream.status})`,
          type: "upstream",
          request_id: c.get("requestId"),
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
    // #320 — outbound moderation, MINOR cohorts, non-stream only (REQ-O3).
    // Usage was recorded above (the tokens were genuinely spent) but the
    // blocked text never reaches the client and the trace turn body is not
    // persisted. Streaming outbound is the documented follow-up.
    if (isMinorCohort(profile)) {
      const hit = screenText(text);
      if (hit) {
        reportModerationHit(
          env,
          c.get("requestId"),
          { cohort_id: payload.c, user_id: payload.u, profile_id: profile.id, direction: "outbound" },
          hit,
        );
        return c.json(
          {
            error: {
              message: MODERATION_BLOCK_MESSAGE_KO,
              type: "moderation_block",
              category: hit.category,
              request_id: c.get("requestId"),
            },
          },
          400,
        );
      }
    }
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
  let streamedAssistantText = "";
  const streamOptions = {
    // #257 — lets the SSE layer emit a sanitized stream_error carrying the
    // request_id instead of raw internal prose.
    requestId: c.get("requestId"),
    onTextDelta: (delta: string) => {
      streamedAssistantText += delta;
    },
    onBeforeDone: () => ({
      type: "asset_score",
      ...scoreTurnAssets(streamedAssistantText),
    }),
  };
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
      ? transformStream(upstream.body, modelLabel, onUsage, streamOptions)
      : passThroughOpenAIStream(upstream.body, onUsage, streamOptions);

  const streamHeaders: Record<string, string> = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
    "x-hps-model": modelLabel,
  };
  if (fellBack) streamHeaders["x-hps-fallback"] = "1";
  return new Response(outStream, { headers: streamHeaders });
});
