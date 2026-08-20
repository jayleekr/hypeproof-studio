// One turn against the live gateway, streamed, fully measured.
//
// Shapes verified by reading the worker, not assumed (verification.md rule 1):
//
//   /v1/messages  — verbatim Anthropic SSE passthrough (routes/messages.ts:513
//                   tapAnthropicStream "only peeks; nothing is injected").
//                   usage: message_start.message.usage (input, cache_read,
//                   cache_creation) + message_delta.usage.output_tokens
//                   (lib/sse.ts:266-277).
//   /v1/chat/completions — OpenAI chunks; usage arrives as a synthetic final
//                   chunk carrying `hps_usage` with the cache fields
//                   (lib/sse.ts:459-492 enqueueUsageChunk). That chunk is
//                   SUPPRESSED when all four counters are 0, so a missing
//                   usage record means "not observed", never "zero tokens".
//
// The request body for the messages path copies the real Agent SDK CLI shape
// captured in tests/rehearsal/07-sdk-request-shape.test.mjs — including the
// CLI's own model id, which the gateway is supposed to clamp.

const ANTHROPIC_VERSION = "2023-06-01";

/** Rate-limit headers, if the gateway ever surfaces them. Recorded verbatim. */
const RL_HEADER_PREFIX = "anthropic-ratelimit";

function collectRateLimitHeaders(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    if (k.toLowerCase().startsWith(RL_HEADER_PREFIX)) out[k.toLowerCase()] = v;
  }
  return out;
}

/**
 * Put an incremental cache breakpoint on the LAST block of the LAST message —
 * what the Agent SDK CLI does, and what makes conversation history cacheable.
 *
 * Why this is not optional: the worker only marks the system prefix and the
 * last tool (translate.ts:500,605); it never marks history. Without a client
 * breakpoint the growing conversation is re-read uncached every turn. Measured
 * 2026-08-19 without it: cache_read froze at 7,933 (the system prefix) while
 * input_tokens climbed to 16,838 — a 42.7% cache ratio that would have been
 * reported as "prompt caching is broken" when in fact the HARNESS was not
 * asking for it. messages.ts:152 confirms client blocks keep their
 * cache_control, so this reaches upstream.
 *
 * Returns a shallow-copied history; the caller's array is not mutated.
 */
export function withCacheBreakpoint(history) {
  if (!history.length) return history;
  const out = history.slice();
  const lastIdx = out.length - 1;
  const last = out[lastIdx];

  const blocks = typeof last.content === "string"
    ? [{ type: "text", text: last.content }]
    : last.content.map((b) => ({ ...b }));

  if (!blocks.length) return history;
  blocks[blocks.length - 1] = {
    ...blocks[blocks.length - 1],
    cache_control: { type: "ephemeral" },
  };
  out[lastIdx] = { ...last, content: blocks };
  return out;
}

function emptyUsage() {
  return {
    input_tokens: null,
    output_tokens: null,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
    observed: false,
  };
}

function applyAnthropicEvent(ev, usage) {
  if (ev?.type === "message_start" && ev.message?.usage) {
    const u = ev.message.usage;
    if (typeof u.input_tokens === "number") usage.input_tokens = u.input_tokens;
    if (typeof u.cache_read_input_tokens === "number") usage.cache_read_input_tokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
    usage.observed = true;
  }
  if (ev?.type === "message_delta" && typeof ev.usage?.output_tokens === "number") {
    usage.output_tokens = ev.usage.output_tokens;
    usage.observed = true;
  }
}

function applyOpenAIChunk(ev, usage) {
  const h = ev?.hps_usage;
  if (h && typeof h === "object") {
    if (typeof h.input_tokens === "number") usage.input_tokens = h.input_tokens;
    if (typeof h.output_tokens === "number") usage.output_tokens = h.output_tokens;
    if (typeof h.cache_read_input_tokens === "number") usage.cache_read_input_tokens = h.cache_read_input_tokens;
    if (typeof h.cache_creation_input_tokens === "number") usage.cache_creation_input_tokens = h.cache_creation_input_tokens;
    usage.observed = true;
  }
}

/**
 * Run one streamed turn.
 *
 * @returns a fully-populated turn record. NEVER throws for HTTP/stream errors —
 *          a failed turn is data, not an exception. Only a programming bug
 *          escapes.
 */
export async function runTurn({
  workerUrl,
  path,            // "messages" | "chat"
  token,
  history,         // [{role, content}] — accumulated, caller owns it
  maxTokens,
  timeoutMs,
  tools = null,    // Anthropic tool defs; messages path only
  cacheBreakpoint = true,
  workspace = "~/HypeProofQuests",
  coachName = "코치",
}) {
  const isMessages = path === "messages";
  const url = isMessages ? `${workerUrl}/messages?beta=true` : `${workerUrl}/chat/completions`;

  // Only the Anthropic-native path carries cache_control; translate() rebuilds
  // the body on the proxy path, so a breakpoint there would be theatre.
  const sendMessages = isMessages && cacheBreakpoint ? withCacheBreakpoint(history) : history;

  const body = isMessages
    ? {
        // The SDK CLI's own model id — the gateway MUST rewrite it
        // (resolveMessagesModel). If it ever reaches upstream verbatim that is
        // a policy break, so we record what came back.
        model: "claude-fable-5",
        max_tokens: maxTokens,
        messages: sendMessages,
        stream: true,
        metadata: { user_id: "load-harness" },
        ...(tools && tools.length ? { tools } : {}),
      }
    : {
        model: "hypeproof-default",
        max_tokens: maxTokens,
        messages: history,
        stream: true,
      };

  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-hps-coach-name": encodeURIComponent(coachName),
    "x-hps-workspace": encodeURIComponent(workspace),
  };
  if (isMessages) {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    headers["anthropic-beta"] = "context-management-2025-06-27";
  }

  const usage = emptyUsage();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`turn timeout ${timeoutMs}ms`)), timeoutMs);

  const t0 = Date.now();
  const rec = {
    started_at: new Date(t0).toISOString(),
    t_start: t0,
    status: null,
    ok: false,
    error: null,
    error_type: null,
    ttfb_ms: null,      // first SSE byte (message_start) — not visible to a child
    ttft_ms: null,      // first TEXT delta — what the child actually sees
    total_ms: null,
    text_chars: 0,
    model: null,
    request_id: null,
    stop_reason: null,
    rate_limit_headers: {},
    usage,
  };

  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    rec.total_ms = Date.now() - t0;
    rec.error = String(err?.message ?? err);
    rec.error_type = "network";
    return rec;
  }

  rec.status = res.status;
  rec.model = res.headers.get("x-hps-model");
  rec.request_id = res.headers.get("x-request-id");
  rec.rate_limit_headers = collectRateLimitHeaders(res.headers);

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    clearTimeout(timer);
    rec.total_ms = Date.now() - t0;
    rec.error = text.slice(0, 400);
    // The gateway's own error envelope carries a machine-readable type
    // (session_inactive / not_in_roster / moderation_block / …). Keep it —
    // 403 session_inactive is an operator state, not a product failure.
    try {
      const j = JSON.parse(text);
      rec.error_type = j?.error?.type ?? j?.type ?? "http";
    } catch {
      rec.error_type = "http";
    }
    return rec;
  }

  let assistantText = "";
  // Assistant content blocks, rebuilt from the stream so the caller can feed a
  // well-formed assistant turn back into history (required for a tool loop).
  // tool_use inputs arrive as `input_json_delta` fragments and must be
  // concatenated before parsing — a partial fragment is not valid JSON.
  const blocks = [];
  const jsonFrag = new Map();     // block index -> accumulated partial_json
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (rec.ttfb_ms === null) rec.ttfb_ms = Date.now() - t0;
      buf += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let ev;
          try {
            ev = JSON.parse(payload);
          } catch {
            continue;
          }
          if (isMessages) {
            applyAnthropicEvent(ev, usage);
            if (ev?.type === "content_block_start" && ev.content_block) {
              const cb = ev.content_block;
              if (cb.type === "tool_use") {
                blocks[ev.index] = { type: "tool_use", id: cb.id, name: cb.name, input: {} };
                jsonFrag.set(ev.index, "");
              } else if (cb.type === "text") {
                blocks[ev.index] = { type: "text", text: "" };
              }
            }
            if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
              if (rec.ttft_ms === null) rec.ttft_ms = Date.now() - t0;
              assistantText += ev.delta.text;
              const b = blocks[ev.index];
              if (b?.type === "text") b.text += ev.delta.text;
            }
            if (ev?.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
              jsonFrag.set(ev.index, (jsonFrag.get(ev.index) ?? "") + (ev.delta.partial_json ?? ""));
            }
            if (ev?.type === "content_block_stop") {
              const b = blocks[ev.index];
              if (b?.type === "tool_use") {
                const raw = jsonFrag.get(ev.index) ?? "";
                try {
                  b.input = raw ? JSON.parse(raw) : {};
                } catch {
                  // A truncated tool_use (hit max_tokens mid-JSON) is real and
                  // worth seeing — record it rather than pretending it parsed.
                  b.input = {};
                  b.truncated_json_chars = raw.length;
                }
              }
            }
            if (ev?.type === "message_delta" && ev.delta?.stop_reason) rec.stop_reason = ev.delta.stop_reason;
            if (ev?.type === "error") {
              rec.error = JSON.stringify(ev).slice(0, 400);
              rec.error_type = ev?.error?.type ?? "stream_error";
            }
          } else {
            applyOpenAIChunk(ev, usage);
            const delta = ev?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              if (rec.ttft_ms === null) rec.ttft_ms = Date.now() - t0;
              assistantText += delta;
            }
            const fr = ev?.choices?.[0]?.finish_reason;
            if (fr) rec.stop_reason = fr;
            if (ev?.type === "stream_error" || ev?.error) {
              rec.error = JSON.stringify(ev).slice(0, 400);
              rec.error_type = "stream_error";
            }
            if (typeof ev?.hps_request_id === "string" && !rec.request_id) rec.request_id = ev.hps_request_id;
          }
        }
      }
    }
    rec.ok = rec.error === null;
  } catch (err) {
    rec.error = String(err?.message ?? err);
    rec.error_type = rec.error_type ?? "stream_abort";
  } finally {
    clearTimeout(timer);
  }

  rec.total_ms = Date.now() - t0;
  rec.text_chars = assistantText.length;
  rec.assistant_text = assistantText;
  rec.blocks = blocks.filter(Boolean);
  rec.tool_uses = rec.blocks.filter((b) => b.type === "tool_use").map((b) => b.name);
  return rec;
}
