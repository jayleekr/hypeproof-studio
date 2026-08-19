// Smoke heartbeat — fires from a Cron Trigger (default every 15 min).
//
// Calls the SAME upstream LLM real chat uses (resolveProvider picks). Body is
// "ping" / max_tokens=4 so the cost is negligible (claude-haiku-4-5 / gemini-
// 2.5-flash). Writes a single KV slot Jay can poll, and increments a
// fail-streak counter. After 3 consecutive failures, writes an alert key.
//
// Bypasses cohort/session/roster/D1 entirely — the heartbeat must survive
// cohort kill-switch (#47) and roster mutations. Independence from chat.ts
// state is the whole point.

import type { Env } from "../env.ts";
import { resolveProvider, type LLMProvider } from "../env.ts";
import { callAnthropic } from "../lib/anthropic.ts";
import { callGemini } from "../lib/gemini.ts";
import { callOpenAI } from "../lib/openai.ts";

const KV_LAST = "heartbeat:last";
const KV_FAIL_STREAK = "heartbeat:fail_streak";
const KV_ALERT = "heartbeat:alert";

// 24h on the success/streak slots — if the cron itself stops firing the slot
// disappears and Jay sees "missing" instead of a stale "ok" from yesterday.
// 7d on alerts so a transient incident is still visible after recovery.
const TTL_LAST_S = 60 * 60 * 24;
const TTL_ALERT_S = 60 * 60 * 24 * 7;

const ALERT_STREAK_THRESHOLD = 3;
const TIMEOUT_MS = 8000;

export interface HeartbeatResult {
  ts: string;          // ISO
  ok: boolean;
  latency_ms: number;
  provider: LLMProvider | "unknown";
  status?: number;     // upstream HTTP status when reachable
  error?: string;      // short error string when !ok
  streak?: number;     // current fail streak after this attempt (only on fail)
}

export async function runHeartbeat(env: Env): Promise<HeartbeatResult> {
  const ts = new Date().toISOString();
  const startedAt = Date.now();

  let provider: HeartbeatResult["provider"] = "unknown";
  let apiKey = "";
  try {
    const resolved = resolveProvider(env);
    provider = resolved.provider;
    apiKey = resolved.apiKey;
  } catch (err) {
    return recordFail(env, {
      ts, ok: false, latency_ms: 0, provider,
      error: `resolveProvider: ${(err as Error).message}`,
    });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("heartbeat-timeout"), TIMEOUT_MS);

  try {
    const res = await callUpstream(provider, apiKey, env, ctrl.signal);
    clearTimeout(timer);
    const latency_ms = Date.now() - startedAt;

    // Drain body — we don't read the content, just check status. Leaving the
    // body undrained leaks the underlying socket on some runtimes.
    try { await res.body?.cancel(); } catch { /* already closed */ }

    if (!res.ok) {
      return recordFail(env, {
        ts, ok: false, latency_ms, provider,
        status: res.status,
        error: `upstream_${res.status}`,
      });
    }
    return recordOk(env, { ts, ok: true, latency_ms, provider, status: res.status });
  } catch (err) {
    clearTimeout(timer);
    const latency_ms = Date.now() - startedAt;
    const msg = err instanceof Error ? err.message : String(err);
    return recordFail(env, {
      ts, ok: false, latency_ms, provider,
      error: msg.includes("abort") ? "timeout" : msg.slice(0, 200),
    });
  }
}

function callUpstream(
  provider: HeartbeatResult["provider"],
  apiKey: string,
  env: Env,
  signal: AbortSignal,
): Promise<Response> {
  if (provider === "anthropic") {
    return callAnthropic(
      {
        model: "claude-haiku-4-5",
        max_tokens: 4,
        system: [{ type: "text", text: "Reply with exactly one word." }],
        messages: [{ role: "user", content: "ping" }],
      },
      apiKey,
      { url: env.ANTHROPIC_PROXY_URL, signal, proxySecret: env.ANTHROPIC_PROXY_SECRET },
    );
  }
  if (provider === "gemini") {
    return callGemini(
      {
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4,
      },
      apiKey,
      signal,
    );
  }
  if (provider === "openai") {
    return callOpenAI(
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4,
      },
      apiKey,
      signal,
    );
  }
  // resolveProvider would have thrown — this branch keeps TS exhaustive.
  return Promise.reject(new Error(`unknown provider: ${provider}`));
}

async function recordOk(env: Env, result: HeartbeatResult): Promise<HeartbeatResult> {
  await Promise.all([
    env.HPS_KV.put(KV_LAST, JSON.stringify(result), { expirationTtl: TTL_LAST_S }),
    env.HPS_KV.put(KV_FAIL_STREAK, "0", { expirationTtl: TTL_LAST_S }),
    env.HPS_KV.delete(KV_ALERT),
  ]);
  writeAnalytics(env, result, 0);
  return result;
}

async function recordFail(env: Env, result: HeartbeatResult): Promise<HeartbeatResult> {
  const prev = parseInt((await env.HPS_KV.get(KV_FAIL_STREAK)) ?? "0", 10) || 0;
  const streak = prev + 1;
  result.streak = streak;

  const ops: Promise<unknown>[] = [
    env.HPS_KV.put(KV_LAST, JSON.stringify(result), { expirationTtl: TTL_LAST_S }),
    env.HPS_KV.put(KV_FAIL_STREAK, String(streak), { expirationTtl: TTL_LAST_S }),
  ];
  if (streak >= ALERT_STREAK_THRESHOLD) {
    ops.push(
      env.HPS_KV.put(
        KV_ALERT,
        JSON.stringify({
          ts: result.ts,
          streak,
          provider: result.provider,
          last_status: result.status,
          last_error: result.error,
        }),
        { expirationTtl: TTL_ALERT_S },
      ),
    );
  }
  await Promise.all(ops);
  writeAnalytics(env, result, streak);
  return result;
}

function writeAnalytics(env: Env, r: HeartbeatResult, streak: number): void {
  // Analytics Engine is best-effort — never fail the heartbeat on it.
  try {
    env.HPS_ANALYTICS?.writeDataPoint({
      blobs: [
        "heartbeat",
        r.provider,
        r.ok ? "ok" : "fail",
        r.error ?? "",
      ],
      doubles: [r.latency_ms, streak, r.status ?? 0],
      indexes: ["heartbeat"],
    });
  } catch { /* swallow */ }
}
