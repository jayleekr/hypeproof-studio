// Integration-test harness for the full worker app (#255 A#11).
//
// Boots the REAL Hono app from src/index.ts (middleware + guards + routers,
// in production mount order) against an in-memory mock Env, so tests exercise
// the same request path production traffic takes — unlike the per-router
// tests in smoke.mjs which mount a single router directly.
//
// Pieces:
//   bootApp()            → the default export of src/index.ts ({ fetch, scheduled })
//   createMockEnv(opts)  → Env with Map-backed KV, recording D1/R2/Analytics stubs
//   makeCtx()            → ExecutionContext whose waitUntil promises can be awaited
//                          via ctx.settle() (fire-and-forget writes become assertable)
//   withMockUpstream()   → swap globalThis.fetch for the duration of a test so the
//                          worker's upstream LLM call hits a scripted response
//   openAIJsonBody / openAIStreamBody → canned OpenAI-shape upstream payloads

import "./loader.mjs";

// Same well-known cohort/profile/user triple smoke.mjs uses — getProfile()
// resolves it from the real profile registry, no stubbing needed.
export const COHORT = "sk-biopharm-2026-a";
export const PROFILE = "sk-biopharm-kids-2026-grade-3-4-s1";
export const USER = "kid01";
export const TEST_SECRET = "test-secret-0123456789abcdef";

let appPromise;
/** Import (once) and return the real app: `{ fetch, scheduled }`. */
export function bootApp() {
  appPromise ??= import("../../src/index.ts").then((m) => m.default);
  return appPromise;
}

/** ExecutionContext stub. `await ctx.settle()` drains all waitUntil work. */
export function makeCtx() {
  const pending = [];
  return {
    waitUntil(p) {
      pending.push(Promise.resolve(p).catch(() => {}));
    },
    passThroughOnException() {},
    async settle() {
      // Drain in waves — a waitUntil callback may register more waitUntils.
      let seen = 0;
      while (seen < pending.length) {
        const batch = pending.slice(seen);
        seen = pending.length;
        await Promise.all(batch);
      }
    },
  };
}

/**
 * Build a mock Env. Defaults to a "live class" state: production environment,
 * strong signing secret, active session + roster for COHORT/USER, openai as
 * the upstream provider (its call path is a straight passthrough — simplest
 * to script).
 *
 * opts:
 *   withSession / withRoster : false → omit that KV key (403 paths)
 *   paused                   : true → cohort kill-switch set
 *   trials                   : { [trial_id]: { user_id, cohort_id } } for
 *                              verifyTrialOwnership SELECTs (default: none)
 *   secret / environment     : override HPS_SIGNING_SECRET / ENVIRONMENT
 *   env                      : shallow-merged last (arbitrary overrides)
 *
 * Recorders (assert on these): _kv (Map), _dbCalls [{sql, bindings}],
 * _r2Puts [{key, value}], _datapoints [analytics writeDataPoint args].
 */
export function createMockEnv(opts = {}) {
  const kvStore = new Map();
  const now = Date.now();
  if (opts.withSession !== false) {
    kvStore.set(
      `cohort:${COHORT}:active_session`,
      JSON.stringify({
        session_id: "sess-int-1",
        profile_id: PROFILE,
        starts_at: new Date(now - 60_000).toISOString(),
        ends_at: new Date(now + 60 * 60_000).toISOString(),
      }),
    );
  }
  if (opts.withRoster !== false) {
    kvStore.set(
      `cohort:${COHORT}:roster`,
      JSON.stringify({ users: [USER], updated_at: new Date(now).toISOString() }),
    );
  }
  if (opts.paused) {
    kvStore.set(
      `cohort:${COHORT}:paused`,
      JSON.stringify({ ts: new Date(now).toISOString(), reason: "test" }),
    );
  }

  const trials = opts.trials ?? {};
  const dbCalls = [];
  const r2Puts = [];
  const datapoints = [];

  return {
    // Vars / secrets
    ENVIRONMENT: opts.environment ?? "production",
    HPS_SIGNING_SECRET: opts.secret ?? TEST_SECRET,
    HPS_ADMIN_PASSWORD: opts.adminPassword,
    LLM_PROVIDER: "openai",
    OPENAI_API_KEY: "test-openai-key",

    // Bindings
    HPS_KV: {
      async get(key, fmt) {
        const v = kvStore.get(key);
        if (v == null) return null;
        return fmt === "json" ? JSON.parse(v) : v;
      },
      async put(key, val) {
        kvStore.set(key, typeof val === "string" ? val : JSON.stringify(val));
      },
      async delete(key) {
        kvStore.delete(key);
      },
      async list({ prefix = "", limit = 1000 } = {}) {
        const keys = [...kvStore.keys()]
          .filter((k) => k.startsWith(prefix))
          .slice(0, limit)
          .map((name) => ({ name }));
        return { keys, list_complete: true };
      },
    },
    HPS_DB: {
      prepare(sql) {
        const call = { sql, bindings: null };
        return {
          bind(...args) {
            call.bindings = args;
            return this;
          },
          // meta.changes mirrors D1 (#33 A#12: endTrial reads it). Default 1
          // = a row matched, so happy-path endTrial doesn't false-warn.
          async run() {
            dbCalls.push(call);
            return { success: true, meta: { changes: opts.d1Changes ?? 1 } };
          },
          async first() {
            dbCalls.push(call);
            // Trial-ownership SELECT (verifyTrialOwnership) is the only
            // .first() the trace/chat path issues; answer from opts.trials.
            if (/SELECT user_id, cohort_id FROM trials/.test(call.sql)) {
              return trials[call.bindings?.[0]] ?? null;
            }
            return null;
          },
          async all() {
            dbCalls.push(call);
            return { results: [], success: true };
          },
        };
      },
    },
    HPS_TRACES: {
      async put(key, value) {
        r2Puts.push({ key, value });
      },
      async get() {
        return null;
      },
    },
    HPS_ANALYTICS: {
      writeDataPoint(p) {
        datapoints.push(p);
      },
    },

    // Recorders for assertions
    _kv: kvStore,
    _dbCalls: dbCalls,
    _r2Puts: r2Puts,
    _datapoints: datapoints,

    ...(opts.env ?? {}),
  };
}

/**
 * Swap globalThis.fetch for the duration of `fn`. `responder(url, init)`
 * returns (or resolves to) the upstream Response. `fn` receives the recorded
 * call list [{ url, init }]. Always restores the real fetch.
 */
export async function withMockUpstream(responder, fn) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** Canned OpenAI-shape non-streaming completion body. */
export function openAIJsonBody({ content, model = "gpt-test", tokensIn = 11, tokensOut = 7 }) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    model,
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut },
  };
}

/** Canned OpenAI-shape SSE stream: content deltas, then a usage chunk, then [DONE]. */
export function openAIStreamBody(deltas, { model = "gpt-test", tokensIn = 11, tokensOut = 7 } = {}) {
  let s = "";
  for (const d of deltas) {
    s += `data: ${JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { content: d }, finish_reason: null }],
    })}\n\n`;
  }
  s += `data: ${JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut },
  })}\n\n`;
  s += "data: [DONE]\n\n";
  return s;
}

/** Wrap a string as an SSE upstream Response. */
export function sseResponse(bodyText, status = 200) {
  return new Response(bodyText, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}
