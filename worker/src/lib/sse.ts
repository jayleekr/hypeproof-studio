// SSE forwarding: Anthropic's stream → OpenAI-format stream.
//
// We can't proxy raw bytes — Anthropic's events use a different JSON shape
// than OpenAI clients expect. So we parse line-by-line, translate, re-emit.

import { anthropicEventToOpenAIChunk } from "./translate";

export interface StreamUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

// #278 Phase 3 — per-stream accumulator for streamed tool_use blocks. Anthropic
// streams a tool call as content_block_start(tool_use) → input_json_delta* →
// content_block_stop; we buffer the partial JSON by block index and emit one
// `hps_tool_use` chunk when the block closes.
interface ToolAccum {
  byIndex: Map<number, { id: string; name: string; json: string }>;
}

export interface StreamTransformOptions {
  onTextDelta?: (delta: string) => void;
  onBeforeDone?: () => unknown | null | undefined;
  // #257 — correlates the sanitized client-facing stream_error with the full
  // server-side log line. Raw error prose never enters the SSE stream.
  requestId?: string;
  // #684 — a stream that opened 200 and then died is a FAILED turn, but the
  // status was already sent, so the route can only learn about it here. Fires
  // before `onUsage` (which runs in the reader's finally block), so the route
  // can flip the usage_log status before the row is written.
  onStreamError?: (err: unknown) => void;
}

// #257 — mid-stream failures used to forward String(err) to the client, which
// can carry upstream URLs, provider prose, or parser internals. Full detail
// goes to logs keyed by request_id; the client gets a generic message + the
// id to quote at the operator.
function enqueueStreamError(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  err: unknown,
  requestId: string | undefined,
) {
  const rid = requestId ?? "no-request-id";
  console.error(`[${rid}] stream error:`, err);
  const errPayload = JSON.stringify({
    error: {
      message: `stream interrupted — please retry (request_id: ${rid})`,
      type: "stream_error",
      request_id: rid,
    },
  });
  controller.enqueue(encoder.encode(`data: ${errPayload}\n\n`));
  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
}

/**
 * Transform Anthropic SSE → OpenAI SSE, captured usage stats in `onUsage`.
 * Both streams use `text/event-stream`, lines like `event: foo\ndata: {...}\n\n`.
 */
export function transformStream(
  anthropic: ReadableStream<Uint8Array>,
  model: string,
  onUsage: (u: StreamUsage) => void,
  options: StreamTransformOptions = {},
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const usage: StreamUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const toolAccum: ToolAccum = { byIndex: new Map() };
  let buffer = "";
  let usageEmitted = false;
  // #1 — flipped when the model stopped on max_tokens, so the student is told the
  // document is incomplete instead of silently receiving a broken page.
  const state = { truncated: false };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = anthropic.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE messages are separated by blank lines.
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            processBlock(block, controller, encoder, model, usage, toolAccum, options, state);
          }
        }
        // Tail
        if (buffer.trim().length > 0) {
          processBlock(buffer, controller, encoder, model, usage, toolAccum, options, state);
        }
        if (state.truncated) enqueueTruncationNotice(controller, encoder, model, options);
        enqueueFinalChunk(controller, encoder, options);
        enqueueUsageChunk(controller, encoder, model, usage, options.requestId);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        options.onStreamError?.(err);   // #684 — before onUsage writes the row
        enqueueStreamError(controller, encoder, err, options.requestId);
      } finally {
        if (!usageEmitted) onUsage(usage);
        usageEmitted = true;
        controller.close();
        reader.releaseLock();
      }
    },
  });
}

/**
 * Gemini's OpenAI-compatible endpoint already emits `chat.completion.chunk`
 * SSE — exactly what the client expects. So we forward each event unchanged
 * and only parse it to capture `usage` (present on the final chunk when the
 * request set `stream_options.include_usage`). Gemini uses OpenAI usage names
 * (prompt_tokens/completion_tokens); there is no prompt cache → cache = 0.
 */
export function passThroughOpenAIStream(
  upstream: ReadableStream<Uint8Array>,
  onUsage: (u: StreamUsage) => void,
  options: StreamTransformOptions = {},
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const usage: StreamUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  let buffer = "";
  let usageEmitted = false;

  // #1 — see TRUNCATION_NOTICE. OpenAI/Gemini signal a max_tokens stop with
  // finish_reason === "length".
  let truncated = false;
  let modelSeen = "";

  const scanBlock = (block: string) => {
    let isDoneBlock = false;
    for (const raw of block.split("\n")) {
      const line = raw.trimEnd();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        isDoneBlock = true;
        continue;
      }
      try {
        const ev = JSON.parse(data);
        if (!modelSeen && typeof ev?.model === "string") modelSeen = ev.model;
        if (ev?.choices?.[0]?.finish_reason === "length") truncated = true;
        const delta = ev?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) options.onTextDelta?.(delta);
        const u = ev?.usage;
        if (u) {
          if (typeof u.prompt_tokens === "number") usage.input_tokens = u.prompt_tokens;
          if (typeof u.completion_tokens === "number") usage.output_tokens = u.completion_tokens;
        }
      } catch { /* keepalive / non-JSON — forwarded verbatim anyway */ }
    }
    return isDoneBlock;
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const isDoneBlock = scanBlock(block);
            if (!isDoneBlock) controller.enqueue(encoder.encode(block + "\n\n"));   // verbatim
          }
        }
        if (buffer.trim().length > 0) {
          const isDoneBlock = scanBlock(buffer);
          if (!isDoneBlock) controller.enqueue(encoder.encode(buffer));
        }
        if (truncated) enqueueTruncationNotice(controller, encoder, modelSeen || "hypeproof", options);
        enqueueFinalChunk(controller, encoder, options);
        enqueueUsageChunk(controller, encoder, modelSeen || "hypeproof", usage, options.requestId);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        options.onStreamError?.(err);   // #684 — before onUsage writes the row
        enqueueStreamError(controller, encoder, err, options.requestId);
      } finally {
        if (!usageEmitted) onUsage(usage);
        usageEmitted = true;
        controller.close();
        reader.releaseLock();
      }
    },
  });
}

// #282 — mid-stream failure notice for the Anthropic-native /v1/messages
// gateway. Same #257 discipline as enqueueStreamError, but emitted in the
// Anthropic SSE error-event shape the Agent SDK client parses (an OpenAI
// `stream_error` chunk would be gibberish to it).
function enqueueAnthropicStreamError(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  err: unknown,
  requestId: string | undefined,
) {
  const rid = requestId ?? "no-request-id";
  console.error(`[${rid}] stream error:`, err);
  const errPayload = JSON.stringify({
    type: "error",
    error: {
      type: "api_error",
      message: `stream interrupted — please retry (request_id: ${rid})`,
    },
  });
  controller.enqueue(encoder.encode(`event: error\ndata: ${errPayload}\n\n`));
}

/**
 * #282 — Anthropic-native SSE passthrough with a usage tap, for the
 * POST /v1/messages gateway. Unlike transformStream (which rewrites Anthropic
 * events into OpenAI chunks for /v1/chat), this forwards the upstream bytes
 * VERBATIM — the consumer is an Anthropic-native client (the Agent SDK coach)
 * that parses the raw event stream itself. We only peek at each event to:
 *   - capture usage (message_start input/cache tokens, message_delta output
 *     tokens) so workshop quota accounting keeps working, and
 *   - surface text deltas to `options.onTextDelta` (trace response_chars).
 *
 * No [DONE] sentinel, no asset_score injection, no truncation-notice chunk —
 * those are OpenAI-stream conventions; injecting foreign events here would
 * corrupt the Anthropic protocol. Mid-stream failures follow #257: full
 * detail to logs keyed by request_id, sanitized Anthropic-shape `error`
 * event to the client.
 */
export function tapAnthropicStream(
  upstream: ReadableStream<Uint8Array>,
  onUsage: (u: StreamUsage) => void,
  options: StreamTransformOptions = {},
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const usage: StreamUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  let buffer = "";
  let usageEmitted = false;

  const scanBlock = (block: string) => {
    for (const raw of block.split("\n")) {
      const line = raw.trimEnd();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      try {
        const event = JSON.parse(data);
        if (event?.type === "message_start" && event.message?.usage) {
          const u = event.message.usage;
          if (typeof u.input_tokens === "number") usage.input_tokens = u.input_tokens;
          if (typeof u.cache_read_input_tokens === "number") {
            usage.cache_read_input_tokens = u.cache_read_input_tokens;
          }
          if (typeof u.cache_creation_input_tokens === "number") {
            usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
          }
        }
        if (event?.type === "message_delta" && typeof event.usage?.output_tokens === "number") {
          usage.output_tokens = event.usage.output_tokens;
        }
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const delta = event.delta.text;
          if (typeof delta === "string" && delta.length > 0) options.onTextDelta?.(delta);
        }
      } catch {
        /* keepalive / non-JSON — forwarded verbatim anyway */
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            scanBlock(block);
            controller.enqueue(encoder.encode(block + "\n\n")); // verbatim
          }
        }
        if (buffer.trim().length > 0) {
          scanBlock(buffer);
          controller.enqueue(encoder.encode(buffer));
        }
      } catch (err) {
        options.onStreamError?.(err);   // #684 — before onUsage writes the row
        enqueueAnthropicStreamError(controller, encoder, err, options.requestId);
      } finally {
        if (!usageEmitted) onUsage(usage);
        usageEmitted = true;
        controller.close();
        reader.releaseLock();
      }
    },
  });
}

function processBlock(
  block: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  model: string,
  usage: StreamUsage,
  toolAccum: ToolAccum,
  options: StreamTransformOptions,
  state?: { truncated: boolean },
) {
  let dataLine: string | null = null;
  for (const raw of block.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("data:")) dataLine = line.slice(5).trim();
  }
  if (!dataLine || dataLine === "[DONE]") return;

  let event: any;
  try {
    event = JSON.parse(dataLine);
  } catch {
    return;
  }

  // Capture usage from message_start + message_delta
  if (event?.type === "message_start" && event.message?.usage) {
    const u = event.message.usage;
    if (typeof u.input_tokens === "number") usage.input_tokens = u.input_tokens;
    if (typeof u.cache_read_input_tokens === "number") usage.cache_read_input_tokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
  }
  if (event?.type === "message_delta") {
    if (typeof event.usage?.output_tokens === "number") usage.output_tokens = event.usage.output_tokens;
    if (event.delta?.stop_reason === "max_tokens" && state) state.truncated = true;
  }
  if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
    const delta = event.delta.text;
    if (typeof delta === "string" && delta.length > 0) options.onTextDelta?.(delta);
  }

  // #278 Phase 3 — assemble streamed tool_use blocks and emit an hps_tool_use
  // chunk when a block closes. anthropicEventToOpenAIChunk returns null for
  // these events, so nothing double-emits; the finish path is unchanged.
  if (
    event?.type === "content_block_start" &&
    event.content_block?.type === "tool_use" &&
    typeof event.index === "number" &&
    typeof event.content_block.id === "string" &&
    typeof event.content_block.name === "string"
  ) {
    toolAccum.byIndex.set(event.index, {
      id: event.content_block.id,
      name: event.content_block.name,
      json: "",
    });
  } else if (
    event?.type === "content_block_delta" &&
    event.delta?.type === "input_json_delta" &&
    typeof event.index === "number"
  ) {
    const acc = toolAccum.byIndex.get(event.index);
    if (acc && typeof event.delta.partial_json === "string") acc.json += event.delta.partial_json;
  } else if (event?.type === "content_block_stop" && typeof event.index === "number") {
    const acc = toolAccum.byIndex.get(event.index);
    if (acc) {
      toolAccum.byIndex.delete(event.index);
      let input: unknown = {};
      try {
        input = acc.json ? JSON.parse(acc.json) : {};
      } catch {
        input = {};
      }
      const toolChunk = JSON.stringify({
        id: "chatcmpl-hps",
        object: "chat.completion.chunk",
        model,
        choices: [
          { index: 0, delta: { hps_tool_use: { id: acc.id, name: acc.name, input } }, finish_reason: null },
        ],
      });
      controller.enqueue(encoder.encode(`data: ${toolChunk}\n\n`));
    }
  }

  const out = anthropicEventToOpenAIChunk(event, model);
  if (out !== null) {
    controller.enqueue(encoder.encode(`data: ${out}\n\n`));
  }
}

/**
 * #1 — a response that stops because it hit max_tokens used to reach the student
 * as a silently broken document (HTML cut mid-tag, no `</html>`). Providers do
 * signal it (Anthropic `message_delta.delta.stop_reason === "max_tokens"`,
 * OpenAI/Gemini `finish_reason === "length"`), so we surface it as visible text.
 */
export const TRUNCATION_NOTICE =
  "\n\n---\n⚠️ **응답이 길이 제한에 걸려 잘렸습니다 — 문서가 완성되지 않았어요.**\n" +
  '"더 간결하게, 반드시 `</html>`까지 완결해서 다시 만들어줘" 라고 요청해 주세요.';

function enqueueTruncationNotice(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  model: string,
  options: StreamTransformOptions,
) {
  options.onTextDelta?.(TRUNCATION_NOTICE);
  const chunk = {
    id: "chatcmpl-truncation-notice",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content: TRUNCATION_NOTICE }, finish_reason: null }],
  };
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
}

function enqueueFinalChunk(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  options: StreamTransformOptions,
) {
  const chunk = options.onBeforeDone?.();
  if (chunk === null || chunk === undefined) return;
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
}

/**
 * #580 — [DONE] 직전에 이 요청이 쓴 토큰 usage 를 클라이언트에 알린다.
 * Anthropic 업스트림의 합성 스트림에는 usage 가 실릴 자리가 없어서, 클라이언트
 * (Studio 로컬 스풀)가 요청 단위 토큰 기록을 남길 방법이 원천적으로 없었다.
 *
 * Additive 다: `choices: []` + `usage` 는 OpenAI `stream_options.include_usage`
 * 의 표준 최종 청크 형태라 기존 파서(웹뷰·구버전 확장)는 delta 없음 → 그냥
 * 지나간다. `hps_usage` 는 OpenAI usage 에 없는 캐시 필드까지 실은 전량이다.
 * D1 usage_log 기록(onUsage 콜백)과 같은 accumulator 를 쓰므로 두 기록은
 * 정의상 일치한다.
 */
function enqueueUsageChunk(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  model: string,
  usage: StreamUsage,
  requestId?: string,
) {
  // 업스트림이 usage 를 아예 안 준 스트림(비정상 종료 등)에서 0 값 청크를 내면
  // "0 토큰 썼음"이라는 지어낸 데이터가 된다 — 없으면 없는 채로 둔다. 실요청의
  // input_tokens 는 0 일 수 없으므로 all-zero = usage 미관측이다.
  if (
    usage.input_tokens === 0 && usage.output_tokens === 0 &&
    usage.cache_read_input_tokens === 0 && usage.cache_creation_input_tokens === 0
  ) {
    return;
  }
  const chunk = {
    id: "chatcmpl-hps-usage",
    object: "chat.completion.chunk",
    model,
    choices: [],
    usage: {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.input_tokens + usage.output_tokens,
    },
    hps_usage: { ...usage },
    // 클라이언트 스풀의 requestKey — 서버 로그·D1 과 조인 가능한 요청 id.
    // 헤더(x-request-id)로도 나가지만, 청크에 실으면 헤더를 못 읽는/안 읽는
    // 소비자도 같은 키를 얻는다.
    ...(requestId ? { hps_request_id: requestId } : {}),
  };
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
}
