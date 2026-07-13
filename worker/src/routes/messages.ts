// POST /v1/messages — Anthropic Messages API-compatible gateway (#282).
//
// Worker-side foundation for the Agent SDK coach runtime (ADR 0003): the
// Studio extension spawns the SDK with ANTHROPIC_BASE_URL=<this worker> and
// ANTHROPIC_AUTH_TOKEN=<workshop token> (#284 / REQ-M6), so the SDK's model
// calls arrive here as `Authorization: Bearer <workshop token>` — the SAME
// HMAC v2 tokens /v1/chat/completions verifies. The classroom Anthropic key
// never leaves the worker.
//
// Pipeline:
//   1. gateChatRequest — token / revocation / profile / session / roster /
//      cohort-pause gates, byte-identical to chat.ts (lib/chat-gate.ts)
//   2. Server-side system prompt: the client-supplied `system` field is
//      DROPPED and replaced with the cohort profile's blocks — same trust
//      model as translate.ts ("we DO NOT honor any client-supplied system")
//   3. Model policy: requested model clamped to the profile's alias catalog
//      (default / fallback / fast) — cost-bounded per cohort
//   4. Proxy to the Anthropic upstream — ANTHROPIC_PROXY_URL-aware (sediment
//      region-pin, #26), exactly like chat.ts's anthropic branch
//   5. stream: VERBATIM Anthropic SSE passthrough + usage tap (lib/sse.ts
//      tapAnthropicStream); non-stream: verbatim JSON passthrough
//   6. usage_log / turns accounting — same rows chat.ts writes, so workshop
//      quotas + trace analytics keep working across both runtimes
//
// Everything else in the body (messages incl. tool_use/tool_result blocks,
// tools, tool_choice, temperature, stop_sequences, metadata, …) passes
// through untouched: tools are DEFINED here but EXECUTED client-side by the
// SDK, where #284's canUseTool + cohort tool policy gate them (REQ-M1/M5).
// Server-side tool-policy enforcement is the ADR's Phase-2 item — the
// profile becomes the canonical owner — and is intentionally not in this
// slice.
//
// Error shape note: this route's own failures (bad body, upstream, config)
// use the Anthropic error envelope {type:"error", error:{type, message}}
// because the consumer is an Anthropic-native client. Gate failures reuse
// chat.ts's envelopes/status codes verbatim — the gates are shared code and
// the status codes (401/403/503) are what the SDK acts on.

import { Hono } from "hono";
import type { Env } from "../env";
import { gateChatRequest } from "../lib/chat-gate";
import {
  buildAnthropicSystemBlocks,
  clampMaxTokens,
  type CoachContext,
} from "../lib/translate";
import { callAnthropic } from "../lib/anthropic";
import type { AnthropicRequest } from "../lib/translate";
import { MODEL_MAP, type ModelAlias, type Profile } from "../profiles/types";
import { extractTrialHeaders, lastUserMessageText, type TrialHeaders } from "../lib/chat-extract";
import { recordTurnIfOwned } from "../lib/storage";
import { tapAnthropicStream } from "../lib/sse";
import { logChat, persistUsage } from "../lib/analytics";

export const messages = new Hono<{ Bindings: Env }>();

function anthropicError(
  c: { get: (k: "requestId") => string | undefined },
  type: string,
  message: string,
): { type: "error"; error: { type: string; message: string }; request_id: string } {
  return {
    type: "error",
    error: { type, message },
    request_id: c.get("requestId") ?? "no-request-id",
  };
}

function decodeHeader(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Clamp the requested model to the cohort's catalog. The SDK sends real
 * Anthropic model ids (not our aliases), so the policy is:
 *   - profile default / fallback alias (by alias name or by mapped id) → honored
 *   - hypeproof-fast (by alias name or id, or any claude-*haiku* id) → honored
 *     as our fast pin — the SDK routes small aux calls to a haiku-class model
 *     and silently upgrading those to the default would multiply their cost
 *   - anything else → forced to the profile default (a participant cannot
 *     escalate to opus unless the profile lists it — same trust model as
 *     resolveAlias on the /v1/chat path)
 */
export function resolveMessagesModel(requested: unknown, profile: Profile): string {
  const aliases: ModelAlias[] = [profile.model.default];
  if (profile.model.fallback) aliases.push(profile.model.fallback);
  if (!aliases.includes("hypeproof-fast")) aliases.push("hypeproof-fast");

  if (typeof requested === "string" && requested.length > 0) {
    for (const a of aliases) {
      if (requested === a || requested === MODEL_MAP[a]) return MODEL_MAP[a];
    }
    if (/^claude-.*haiku/.test(requested)) return MODEL_MAP["hypeproof-fast"];
  }
  return MODEL_MAP[profile.model.default];
}

messages.post("/messages", async (c) => {
  const env = c.env;
  const startedAt = Date.now();

  // 1-5b. Same trust gates as /v1/chat/completions (shared module).
  const gate = await gateChatRequest(c);
  if (!gate.ok) return gate.response;
  const { payload, profile, session } = gate;

  // Body
  let raw: Record<string, unknown>;
  try {
    const parsed = await c.req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    raw = parsed as Record<string, unknown>;
  } catch {
    return c.json(anthropicError(c, "invalid_request_error", "bad json body"), 400);
  }
  if (!Array.isArray(raw.messages)) {
    return c.json(anthropicError(c, "invalid_request_error", "messages must be an array"), 400);
  }

  // Anthropic-native route: this endpoint speaks the Messages protocol only,
  // so it always uses the Anthropic key regardless of LLM_PROVIDER (which
  // selects the /v1/chat translation target, not this passthrough).
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    // #257 — config prose (env var names, provider wiring) stays in logs.
    console.error(`[${c.get("requestId")}] /v1/messages: ANTHROPIC_API_KEY is not set`);
    return c.json(
      anthropicError(c, "api_error", "Anthropic upstream is not configured — contact the operator"),
      502,
    );
  }

  const coach: CoachContext = {
    name: decodeHeader(c.req.header("x-hps-coach-name")),
    personality: decodeHeader(c.req.header("x-hps-coach-personality")),
  };

  // #9c trace hook — identical opt-in to chat.ts (trial headers).
  const trial: TrialHeaders | null = extractTrialHeaders((h) => c.req.header(h) ?? null);
  const promptText = lastUserMessageText(raw);
  const promptChars = promptText.length;
  const persistBody = profile.analytics.log_user_messages === true;

  const stream = raw.stream === true;
  const modelLabel = resolveMessagesModel(raw.model, profile);

  // 2-3. Enforced fields. Spread-first keeps unknown Messages-API fields
  // (metadata, tool_choice, thinking, …) flowing through; the enforced keys
  // then override whatever the client sent. `system` is REPLACED, never
  // merged — a client block appended after ours would still be an injection
  // channel ("ignore the above"), so it does not survive at all.
  const upstreamBody = {
    ...raw,
    model: modelLabel,
    system: buildAnthropicSystemBlocks(profile, coach),
    max_tokens: clampMaxTokens(raw.max_tokens, profile),
    stream,
  } as unknown as AnthropicRequest;

  // 4. Upstream call — same proxy indirection as chat.ts's anthropic branch.
  let upstream: Response;
  try {
    upstream = await callAnthropic(upstreamBody, apiKey, {
      url: env.ANTHROPIC_PROXY_URL,
      proxySecret: env.ANTHROPIC_PROXY_SECRET,
    });
  } catch (err) {
    // #257 — fetch errors can embed upstream URLs or header names. Log full,
    // return generic.
    console.error(`[${c.get("requestId")}] upstream call failed:`, err);
    return c.json(anthropicError(c, "api_error", "upstream request failed"), 502);
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    // #257 — the upstream error body (provider prose, key hints, quota info)
    // goes to logs only; the client learns the status code + request_id.
    console.error(`[${c.get("requestId")}] upstream ${upstream.status}: ${text.slice(0, 500)}`);
    return c.json(
      anthropicError(c, "api_error", `upstream error (status ${upstream.status})`),
      502,
    );
  }

  // 6. Accounting — same usage_log/analytics rows as chat.ts, so workshop
  // quota dashboards see SDK-coach traffic identically. (No #255 migration
  // columns here — prod schema is not migrated yet.)
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
    // 5. Non-streaming: verbatim JSON passthrough (native Anthropic shape —
    // the SDK client parses it directly), usage tapped from the body.
    const j = (await upstream.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    const tin = j.usage?.input_tokens ?? 0;
    const tout = j.usage?.output_tokens ?? 0;
    const cr = j.usage?.cache_read_input_tokens ?? 0;
    const cc = j.usage?.cache_creation_input_tokens ?? 0;
    const text = (j.content ?? [])
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    record(mkLog(tin, tout, cr, cc));
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
          persistBody ? { persistBody: true, body: { prompt: promptText, response: text } } : {},
        ).catch((err) => console.error("recordTurnIfOwned (messages non-stream) failed:", err)),
      );
    }
    c.header("x-hps-model", modelLabel);
    return c.json(j as Record<string, unknown>);
  }

  // 5. Streaming: verbatim Anthropic SSE passthrough. tapAnthropicStream only
  // peeks (usage + text-delta length); nothing is injected into the protocol.
  let responseChars = 0;
  const onUsage = (u: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  }) => {
    record(mkLog(u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens));
    if (trial) {
      c.executionCtx.waitUntil(
        recordTurnIfOwned(
          env,
          {
            trial_id: trial.trial_id,
            turn_idx: trial.turn_idx,
            prompt_chars: promptChars,
            // Counted from the tapped text deltas (we already parse each
            // event here, unlike chat.ts's OpenAI passthrough where body
            // capture is a follow-up).
            response_chars: responseChars,
            tokens_in: u.input_tokens,
            tokens_out: u.output_tokens,
            latency_ms: Date.now() - startedAt,
            model: modelLabel,
          },
          payload.u,
          payload.c,
        ).catch((err) => console.error("recordTurnIfOwned (messages stream) failed:", err)),
      );
    }
  };

  const outStream = tapAnthropicStream(upstream.body, onUsage, {
    requestId: c.get("requestId"),
    onTextDelta: (delta) => {
      responseChars += delta.length;
    },
  });

  return new Response(outStream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      "x-hps-model": modelLabel,
    },
  });
});
