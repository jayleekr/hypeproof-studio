// Local test adapter only. The official App Server owns ChatGPT credentials.
// Not an OpenAI API call, not a shared OAuth token, and never a production Worker import.
export function validateCodexRequest(body) {
  if (!body || !Array.isArray(body.messages) || !body.messages.length) throw Error('codex_invalid_messages');
  if (body.messages.some(m => !['system','user','assistant'].includes(m.role) || typeof m.content !== 'string')) throw Error('codex_text_only');
  if (body.stream !== true) throw Error('codex_stream_required');
  if (body.tools?.length || body.tool_choice || body.response_format) throw Error('codex_unsupported_request');
  if (Buffer.byteLength(JSON.stringify(body.messages)) > 100000) throw Error('codex_input_limit');
}

export function codexRehearsalResponse(client, body, { signal, record }) {
  validateCodexRequest(body);
  const encoder = new TextEncoder(), started = Date.now();
  const controller = new AbortController();
  const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(60000), ...(signal ? [signal] : [])]);
  let closed = false;
  const stream = new ReadableStream({
    start(output) {
      const emit = value => { if (!closed) output.enqueue(encoder.encode('data: '+JSON.stringify(value)+'\n\n')); };
      client.complete({ model: body.model, messages: body.messages, signal: combined,
        onDelta: delta => emit({ model: body.model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] }),
      }).then(result => {
        record({ status: 'completed', provider: 'codex-app-server', auth: 'chatgpt', model: result.model,
          usage: result.usage, elapsed_ms: Date.now()-started, input_bytes: Buffer.byteLength(JSON.stringify(body.messages)) });
        emit({ model: result.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          ...(result.usage ? {usage:{prompt_tokens:result.usage.inputTokens,completion_tokens:result.usage.outputTokens,total_tokens:result.usage.totalTokens}} : {}) });
        if (!closed) { output.enqueue(encoder.encode('data: [DONE]\n\n')); closed=true; output.close(); }
      }, error => {
        record({ status: 'failed', provider: 'codex-app-server', auth: 'chatgpt', model: body.model,
          error: error.message, elapsed_ms: Date.now()-started, usage: null });
        if (!closed) { closed=true; output.error(new Error('Local GPT response interrupted')); }
      });
    },
    cancel() { closed=true; controller.abort(); },
  });
  return new Response(stream, { headers: { 'content-type':'text/event-stream', 'x-hps-local-provider':'codex-app-server' } });
}
