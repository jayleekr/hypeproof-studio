import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { bearer, verify } from "../lib/tokens";
import { gateChatRequest } from "../lib/chat-gate";
import {
  NATIVE_TRIAL_LIMITS,
  reserveNativeRequest,
  finishNativeRequest,
  readNativeGrant,
} from "../lib/native-trial-grants";
const signals = new WeakMap<Request, AbortSignal>();
export const nativeTrialSignal = (request: Request) => signals.get(request);
export const nativeTrialBudget: MiddlewareHandler<{ Bindings: Env }> = async (
  c,
  next,
) => {
  let p;
  try {
    const token = bearer(c.req.header("authorization"));
    if (!token) return next();
    p = await verify(token, c.env.HPS_SIGNING_SECRET);
  } catch {
    return next();
  }
  if (!p.native_trial) return next();
  const gate = await gateChatRequest(c);
  if (!gate.ok) return gate.response;
  if (c.req.path === "/v1/chat/completions")
    return c.json(
      {
        error: {
          code: "trial_requires_sdk",
          message: "이 체험은 최신 Studio에서 실행해 주세요.",
        },
      },
      409,
    );
  const reader = c.req.raw.clone().body?.getReader();
  let bytes = 0;
  if (reader) {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        bytes += r.value.length;
        if (bytes > NATIVE_TRIAL_LIMITS.input_bytes) {
          void reader.cancel();
          return c.json({ error: { code: "trial_input_limit" } }, 413);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  const retryId = c.req.header("x-hps-trial-request-id");
  if (retryId && !/^[a-f0-9-]{36}$/i.test(retryId))
    return c.json({ error: { code: "invalid_trial_request_id" } }, 400);
  const id = p.jti + ":" + (retryId ?? crypto.randomUUID());
  if (!(await reserveNativeRequest(c.env, p, id))) {
    const duplicate = await c.env.HPS_DB.prepare(
      "SELECT id FROM native_trial_requests WHERE id=?",
    )
      .bind(id)
      .first();
    if (duplicate)
      return c.json(
        {
          error: {
            code: "duplicate_trial_request",
            type: "invalid_request_error",
            message: "이미 처리한 요청입니다. 작업 기록을 확인해 주세요.",
          },
        },
        409,
      );
    const grant = await readNativeGrant(c.env, p);
    const busy = !!grant?.lease_id;
    return c.json(
      {
        error: {
          code: busy ? "trial_busy" : "trial_exhausted",
          type: "rate_limit_error",
          message: busy
            ? "이미 실행 중인 요청이 있습니다. 완료한 뒤 다시 시도해 주세요."
            : "개인 체험의 총 요청 한도에 도달했습니다.",
        },
      },
      429,
    );
  }
  const controller = new AbortController();
  signals.set(c.req.raw, controller.signal);
  const abortRequest = () => controller.abort();
  c.req.raw.signal.addEventListener("abort", abortRequest, { once: true });
  const timer = setTimeout(
    () => controller.abort(),
    NATIVE_TRIAL_LIMITS.request_timeout_ms,
  );
  let finished = false;
  const finish = async (success: boolean) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    c.req.raw.signal.removeEventListener("abort", abortRequest);
    signals.delete(c.req.raw);
    await finishNativeRequest(c.env, id, success);
  };
  try {
    await next();
    const response = c.res;
    if (
      !response.body ||
      !response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      await finish(response.ok);
      return;
    }
    const source = response.body.getReader();
    let closed = false;
    let output: ReadableStreamDefaultController<Uint8Array>;
    const stop = () => {
      if (closed) return;
      closed = true;
      void source
        .cancel()
        .catch(() => undefined)
        .then(() => finish(false))
        .then(() =>
          output.error(new DOMException("Trial request stopped", "AbortError")),
        );
    };
    const stream = new ReadableStream<Uint8Array>({
      start(out) {
        output = out;
        controller.signal.addEventListener("abort", stop, { once: true });
        if (controller.signal.aborted) stop();
      },
      async pull(out) {
        try {
          const r = await source.read();
          if (closed) return;
          if (r.done) {
            closed = true;
            controller.signal.removeEventListener("abort", stop);
            await finish(response.ok);
            out.close();
          } else out.enqueue(r.value);
        } catch (e) {
          if (closed) return;
          closed = true;
          controller.signal.removeEventListener("abort", stop);
          await finish(false);
          out.error(e);
        }
      },
      async cancel() {
        closed = true;
        controller.signal.removeEventListener("abort", stop);
        controller.abort();
        try {
          await source.cancel();
        } finally {
          await finish(false);
        }
      },
    });
    c.res = new Response(stream, {
      status: response.status,
      headers: response.headers,
    });
  } catch (e) {
    controller.abort();
    await finish(false);
    throw e;
  }
};
