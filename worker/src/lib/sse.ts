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

export interface StreamTransformOptions {
  onTextDelta?: (delta: string) => void;
  onBeforeDone?: () => unknown | null | undefined;
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
            processBlock(block, controller, encoder, model, usage, options, state);
          }
        }
        // Tail
        if (buffer.trim().length > 0) {
          processBlock(buffer, controller, encoder, model, usage, options, state);
        }
        if (state.truncated) enqueueTruncationNotice(controller, encoder, model, options);
        enqueueFinalChunk(controller, encoder, options);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        const errPayload = JSON.stringify({
          error: { message: String(err), type: "stream_error" },
        });
        controller.enqueue(encoder.encode(`data: ${errPayload}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        const errPayload = JSON.stringify({ error: { message: String(err), type: "stream_error" } });
        controller.enqueue(encoder.encode(`data: ${errPayload}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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
