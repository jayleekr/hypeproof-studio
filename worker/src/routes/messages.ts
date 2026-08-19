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
import { callAnthropic, countTokensUrl } from "../lib/anthropic";
import type { AnthropicRequest } from "../lib/translate";
import { MODEL_MAP, type ModelAlias, type Profile } from "../profiles/types";
import { extractTrialHeaders, lastUserMessageText, type TrialHeaders } from "../lib/chat-extract";
import { recordTurnIfOwned } from "../lib/storage";
import { tapAnthropicStream } from "../lib/sse";
import { logChat, persistUsage } from "../lib/analytics";
import { scrubToolResultSecrets } from "../lib/scrub-secrets";
import {
  isMinorCohort,
  screenText,
  reportModerationHit,
  MODERATION_BLOCK_MESSAGE_KO,
} from "../lib/moderation";

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

// Upstream 4xx statuses that pass through to the client AS-IS (#282 e2e
// BLOCKER, #257 discipline). These are request-shaped failures the SDK CLI
// must see verbatim to fail fast — collapsing them to 502 made the CLI treat
// them as transient and retry 10x per turn. The body stays sanitized (generic
// message + upstream status + request_id, NO raw upstream prose); only the
// status code and an Anthropic-native error.type are forwarded. Everything
// else (401/403 upstream key problems, 5xx, 529 overloaded) is still OUR
// gateway failure → 502.
const PASSTHROUGH_4XX = {
  400: "invalid_request_error",
  404: "not_found_error",
  413: "request_too_large",
  422: "invalid_request_error",
  429: "rate_limit_error",
} as const;
type Passthrough4xx = keyof typeof PASSTHROUGH_4XX;

function isPassthrough4xx(status: number): status is Passthrough4xx {
  return status in PASSTHROUGH_4XX;
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
 * 개행으로 구분된 목록 헤더. HTTP 헤더에는 개행을 넣을 수 없으므로 클라이언트가
 * `\n` 을 퍼센트 인코딩해 보내고 여기서 되돌린다. 상한을 둬서 학생이 node_modules
 * 를 만들어 놔도 프롬프트가 터지지 않게 한다.
 */
function decodeHeaderList(raw: string | null | undefined): string[] | undefined {
  const v = decodeHeader(raw);
  if (v === undefined) return undefined;
  const out = v
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 80);
  return out;
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

/**
 * #384 — downgrade `role:"system"` entries inside `messages` to user-role
 * context. Claude Code CLI 2.x sends them (mid-conversation-system beta) but
 * the pinned classroom models reject the role, 400-ing every SDK turn.
 * String content is wrapped in a <system-context> marker; block-array content
 * keeps its blocks (incl. cache_control) with a small marker block prepended.
 * Non-array/malformed input passes through untouched (upstream validates).
 */
export function normalizeSystemRoleMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || typeof m !== "object" || (m as { role?: unknown }).role !== "system") return m;
    const msg = m as { role: string; content?: unknown };
    if (typeof msg.content === "string") {
      return {
        ...msg,
        role: "user",
        content: [
          { type: "text", text: `<system-context>\n${msg.content}\n</system-context>` },
        ],
      };
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        role: "user",
        content: [
          { type: "text", text: "<system-context>" },
          ...msg.content,
          { type: "text", text: "</system-context>" },
        ],
      };
    }
    return { ...msg, role: "user" };
  });
}

/**
 * #406 — request params the CLIENT shapes for the model IT picked, which the
 * model this gateway PINS does not accept.
 *
 * The gateway owns the model (`resolveMessagesModel` rewrites whatever the SDK
 * asked for into the cohort catalog) but the body is forwarded spread-first, so
 * every other field still describes the client's model. Claude Code CLI 2.x
 * defaults to a newer generation than the classroom pin and always ships its
 * generation's params — the upstream then gets "old model + new feature set"
 * and 400s the whole turn. The SDK CLI swallows that 400 in its own retry loop,
 * so the student sees an endless "생각하는 중… ✨" instead of an error (#403).
 *
 * Third occurrence of one failure class (#384 was `role:"system"` messages).
 * The invariant this restores: WHOEVER OWNS THE MODEL OWNS THE MODEL-GATED
 * PARAMS. Verified on prod 2026-07-24, same token + cohort, one field at a time:
 *   baseline · +tools(52) · +thinking{adaptive}   → 200
 *   +output_config{effort:"xhigh"}                → 400
 *   +context_management{clear_thinking_…}         → 400
 *
 * Keyed on the RESOLVED model, not on "did we override it": the pinned model is
 * what upstream validates against, and a client that asked for our exact model
 * would 400 the same way. When a profile later pins a generation that does
 * support one of these, add its id to the param's `supportedBy` list — the
 * check then stops stripping for that model only.
 */
const MODEL_GATED_PARAMS: readonly { param: string; supportedBy: readonly string[] }[] = [
  // Effort control — newer-generation only. No classroom pin accepts it today.
  { param: "output_config", supportedBy: [] },
  // Server-side context editing (context-management beta). Same story.
  { param: "context_management", supportedBy: [] },
];

/**
 * Drop the model-gated params the resolved model cannot accept. Pure; returns a
 * new body plus the names dropped so the caller can log them — an SDK bump that
 * introduces the NEXT such param must surface as a log line, not as another
 * silent classroom outage.
 */
export function stripModelGatedParams(
  body: Record<string, unknown>,
  resolvedModel: string,
): { body: Record<string, unknown>; dropped: string[] } {
  const dropped: string[] = [];
  let out = body;
  for (const { param, supportedBy } of MODEL_GATED_PARAMS) {
    if (!(param in body) || body[param] === undefined) continue;
    if (supportedBy.includes(resolvedModel)) continue;
    if (out === body) out = { ...body };
    delete out[param];
    dropped.push(param);
  }
  return { body: out, dropped };
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
    // #431 — 작업 폴더는 학생 머신마다 다르므로 프로필에 넣을 수 없고, 클라이언트
    // system 은 통째로 교체되므로 거기 실어 보낼 수도 없다. 헤더가 유일한 통로다.
    workspace: decodeHeader(c.req.header("x-hps-workspace")),
    workspaceFiles: decodeHeaderList(c.req.header("x-hps-workspace-files")),
    // #507 — 떠 있는 라이브 서버 주소. 같은 이유로 헤더가 유일한 통로다.
    previewUrl: decodeHeader(c.req.header("x-hps-preview-url")),
  };

  // #9c trace hook — identical opt-in to chat.ts (trial headers).
  const trial: TrialHeaders | null = extractTrialHeaders((h) => c.req.header(h) ?? null);
  const promptText = lastUserMessageText(raw);
  const promptChars = promptText.length;
  const persistBody = profile.analytics.log_user_messages === true;

  // #320 — gateway moderation, MINOR cohorts only (REQ-O2), same layer as
  // /v1/chat/completions: the latest user text is screened BEFORE the
  // upstream call. Applies to stream and non-stream requests alike (it's
  // the inbound side); outbound STREAMING moderation is a documented
  // follow-up — the SDK path streams and we do not buffer streams (see
  // lib/moderation.ts header). Adult cohorts skip entirely (REQ-O4). The
  // 400 status doubles as the SDK's fast-fail signal (REQ-M15) so the CLI
  // does not retry a deterministic block.
  if (isMinorCohort(profile)) {
    const hit = screenText(promptText);
    if (hit) {
      reportModerationHit(
        env,
        c.get("requestId"),
        { cohort_id: payload.c, user_id: payload.u, profile_id: profile.id, direction: "inbound" },
        hit,
      );
      return c.json(anthropicError(c, "moderation_block", MODERATION_BLOCK_MESSAGE_KO), 400);
    }
  }

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
    // 2026-08-19 실기기(sk-biopharm 3·4, claude-sonnet-4-6) — 아이가 "도움닫기 점프"
    // 같은 새 규칙을 말하면 SDK 코치의 적응형 씽킹이 한 턴에 65k 토큰까지 폭주해
    // 10~17분 침묵 후 에러로 끝났다(스풀 실측 2회). 재시도 스톨 감시(240s)는
    // 토큰이 흐르는 동안 안 끊는다. 미성년 코호트는 깊은 사고가 필요 없는
    // 짧은 편집 루프라 effort=low 로 고정한다 — 이 게이트웨이에서 직접 확인:
    // adaptive+effort:low → 200(thinking 0), budget_tokens → 400(4.6 거부).
    // 성인 트랙은 건드리지 않는다.
    ...(profile.minor_cohort === true
      ? {
          output_config: { ...((raw as Record<string, unknown>).output_config as Record<string, unknown> | undefined), effort: "low" },
          // 2026-08-19 실기기 — "Claude's response exceeded the 32000 output token maximum":
          // 코치가 도트 스프라이트 맵(반복 패턴 줄) 덩어리를 다시 쓰다 반복 루프에 빠져
          // 한 응답에 32k+ 를 뱉었다(앞서 65k 턴도 같은 증상). 아동 트랙의 정상 턴은
          // Edit 몇 번(<3k)이라 8k 면 충분하고, 폭주는 1~2분 안에 끊긴다.
          max_tokens: Math.min(typeof raw.max_tokens === "number" ? raw.max_tokens : 8000, 8000),
        }
      : {}),
    // #384 — Claude Code CLI 2.x emits mid-conversation `role:"system"`
    // messages (beta mid-conversation-system-2026-04-07). The classroom
    // models this gateway pins reject that role even with the beta — every
    // SDK-runtime turn 400'd. Downgrade them to user-role context (verified:
    // same request 200s once converted). No privilege is conferred: the
    // top-level `system` is still replaced with the profile blocks below.
    // epic #431 — the coach can run shell now, so a tool_result block may
    // carry whatever a command printed: a PAT from ~/.git-credentials, an
    // API token echoed by a failing wrangler deploy, a stray `env` dump.
    // Mask before it becomes prompt content and before it reaches our logs.
    // Server-side on purpose — an old or modified client cannot skip it.
    messages: scrubToolResultSecrets(normalizeSystemRoleMessages(raw.messages)),
    // #520 — "sdk": this route's tools are the CLIENT's in-process MCP set
    // (browserMcp.ts), not the worker-injected BROWSER_TOOLS. The browser
    // contract must describe the tools the coach actually holds here.
    system: buildAnthropicSystemBlocks(profile, coach, "sdk"),
    max_tokens: clampMaxTokens(raw.max_tokens, profile),
    stream,
  } as unknown as AnthropicRequest;

  // #406 — the model is ours, so the model-gated params are ours too. Without
  // this every SDK turn 400s (see stripModelGatedParams).
  const stripped = stripModelGatedParams(
    upstreamBody as unknown as Record<string, unknown>,
    modelLabel,
  );
  if (stripped.dropped.length > 0) {
    console.warn(
      `[${c.get("requestId")}] #406 dropped model-gated param(s) [${stripped.dropped.join(", ")}] ` +
        `— client asked for model ${JSON.stringify(raw.model)}, gateway pinned ${modelLabel}. ` +
        `If the SDK now needs these, repin the profile model instead of forwarding them.`,
    );
  }

  // 4. Upstream call — same proxy indirection as chat.ts's anthropic branch.
  // clientBeta/beta: the Agent SDK sets its own anthropic-beta header (e.g.
  // context-management-2025-06-27 for the context_management body field) and
  // calls /v1/messages?beta=true — both must survive to the upstream (#282
  // e2e BLOCKER: dropping the header 400'd every SDK turn).
  let upstream: Response;
  try {
    upstream = await callAnthropic(stripped.body as unknown as AnthropicRequest, apiKey, {
      url: env.ANTHROPIC_PROXY_URL,
      proxySecret: env.ANTHROPIC_PROXY_SECRET,
      clientBeta: c.req.header("anthropic-beta"),
      beta: c.req.query("beta") === "true",
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
    if (isPassthrough4xx(upstream.status)) {
      // Request-shaped upstream 4xx → same status, sanitized body, so the
      // SDK fails fast instead of retrying a permanent error 10x.
      return c.json(
        anthropicError(c, PASSTHROUGH_4XX[upstream.status], `upstream error (status ${upstream.status})`),
        upstream.status,
      );
    }
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
    // #320 — outbound moderation, MINOR cohorts, non-stream only (REQ-O3).
    // Usage stays recorded (tokens were spent); the blocked text never
    // reaches the client and the trace turn body is not persisted.
    if (isMinorCohort(profile)) {
      const hit = screenText(text);
      if (hit) {
        reportModerationHit(
          env,
          c.get("requestId"),
          { cohort_id: payload.c, user_id: payload.u, profile_id: profile.id, direction: "outbound" },
          hit,
        );
        return c.json(anthropicError(c, "moderation_block", MODERATION_BLOCK_MESSAGE_KO), 400);
      }
    }
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

// POST /v1/messages/count_tokens — Anthropic token-counting passthrough.
//
// The Agent SDK calls this during the agent loop to budget context (compaction
// triggers, max_tokens headroom). Without it the gateway 404s and the SDK's
// budgeting silently degrades — the known gap from #316.
//
// Same trust pipeline as /v1/messages above:
//   - gateChatRequest (token / revocation / session / roster / pause)
//   - client `system` DROPPED and replaced with the cohort blocks — the count
//     must reflect what /v1/messages would actually send upstream, otherwise
//     the SDK budgets against a prompt that never exists
//   - resolveMessagesModel clamp (counts are tokenizer/model-specific)
//   - ANTHROPIC_PROXY_URL indirection (transparent /proxy/anthropic/* proxy)
//   - #257 sanitized errors
//
// Deliberately NO usage_log / turns rows: count_tokens is free upstream (not
// billed, no completion) and is not a conversational turn — recording it
// would pollute workshop quota dashboards and trial analytics with zero-output
// noise rows. Reasoning spelled out in the PR for #282.
messages.post("/messages/count_tokens", async (c) => {
  const env = c.env;

  // 1. Same trust gates as /v1/messages (shared module).
  const gate = await gateChatRequest(c);
  if (!gate.ok) return gate.response;
  const { profile } = gate;

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

  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    // #257 — config prose (env var names) stays in logs.
    console.error(`[${c.get("requestId")}] /v1/messages/count_tokens: ANTHROPIC_API_KEY is not set`);
    return c.json(
      anthropicError(c, "api_error", "Anthropic upstream is not configured — contact the operator"),
      502,
    );
  }

  const coach: CoachContext = {
    name: decodeHeader(c.req.header("x-hps-coach-name")),
    personality: decodeHeader(c.req.header("x-hps-coach-personality")),
    // #431 — 작업 폴더는 학생 머신마다 다르므로 프로필에 넣을 수 없고, 클라이언트
    // system 은 통째로 교체되므로 거기 실어 보낼 수도 없다. 헤더가 유일한 통로다.
    workspace: decodeHeader(c.req.header("x-hps-workspace")),
    workspaceFiles: decodeHeaderList(c.req.header("x-hps-workspace-files")),
    // #507 — 떠 있는 라이브 서버 주소. 같은 이유로 헤더가 유일한 통로다.
    previewUrl: decodeHeader(c.req.header("x-hps-preview-url")),
  };

  // 2-3. Enforced fields, mirroring /v1/messages: spread-first keeps unknown
  // count_tokens fields (tools, tool_choice, thinking, …) flowing through;
  // `system` is REPLACED with the cohort blocks and the model is clamped so
  // the count matches the request /v1/messages would actually send. The
  // count_tokens contract has no max_tokens/stream — strip them in case a
  // client blindly reuses a messages body (upstream 400s on unknown params).
  const modelLabel = resolveMessagesModel(raw.model, profile);
  const upstreamBody = {
    ...raw,
    model: modelLabel,
    system: buildAnthropicSystemBlocks(profile, coach, "sdk"),
  } as Record<string, unknown>;
  delete upstreamBody.max_tokens;
  delete upstreamBody.stream;
  // #406 — same model-gated strip as /v1/messages. The count MUST be made
  // against the body /v1/messages would actually send, and a 400 here breaks
  // the SDK's context budgeting just as silently.
  const strippedCount = stripModelGatedParams(upstreamBody, modelLabel);
  if (strippedCount.dropped.length > 0) {
    console.warn(
      `[${c.get("requestId")}] #406 count_tokens dropped model-gated param(s) ` +
        `[${strippedCount.dropped.join(", ")}] — gateway pinned ${modelLabel}.`,
    );
  }

  // 4. Upstream call — same key + proxy indirection, count_tokens subpath.
  // Same clientBeta/beta threading as /v1/messages: the SDK sends the same
  // anthropic-beta header (and body beta fields like context_management) on
  // its count_tokens calls, so the count must be made under the same flags.
  let upstream: Response;
  try {
    upstream = await callAnthropic(strippedCount.body as unknown as AnthropicRequest, apiKey, {
      url: countTokensUrl(env.ANTHROPIC_PROXY_URL),
      proxySecret: env.ANTHROPIC_PROXY_SECRET,
      clientBeta: c.req.header("anthropic-beta"),
      beta: c.req.query("beta") === "true",
    });
  } catch (err) {
    // #257 — fetch errors can embed upstream URLs or header names.
    console.error(`[${c.get("requestId")}] count_tokens upstream call failed:`, err);
    return c.json(anthropicError(c, "api_error", "upstream request failed"), 502);
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    // #257 — upstream error prose to logs only; client gets status + request_id.
    console.error(`[${c.get("requestId")}] count_tokens upstream ${upstream.status}: ${text.slice(0, 500)}`);
    if (isPassthrough4xx(upstream.status)) {
      // Same fail-fast contract as /v1/messages: request-shaped 4xx pass
      // through with a sanitized body; everything else is a 502.
      return c.json(
        anthropicError(c, PASSTHROUGH_4XX[upstream.status], `upstream error (status ${upstream.status})`),
        upstream.status,
      );
    }
    return c.json(
      anthropicError(c, "api_error", `upstream error (status ${upstream.status})`),
      502,
    );
  }

  // 5. Verbatim JSON passthrough ({"input_tokens": N}) — no usage_log, no
  // turns row (see header comment).
  const j = (await upstream.json()) as Record<string, unknown>;
  c.header("x-hps-model", modelLabel);
  return c.json(j);
});
