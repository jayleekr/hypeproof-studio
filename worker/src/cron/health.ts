// Deep health probe (S-05 / #51). Live-tests every external dependency the
// chat path touches, in parallel, with tight per-probe timeouts. Returns a
// structured object that:
//   - GET /v1/health/deep can hand back to operators (admin auth)
//   - the 15-min heartbeat cron (#45) can shovel into Analytics + KV when it
//     wants more than the existing single-shot "ping" probe
//
// Each probe is independent — one provider being down doesn't fail KV's check.

import type { Env } from "../env.ts";
import { resolveProvider } from "../env.ts";

const PROBE_TIMEOUT_MS = 5000;

export interface ProbeResult {
  ok: boolean;
  latency_ms: number;
  status?: number;
  via?: string;
  error?: string;
}

export interface DeepHealthResult {
  ok: boolean;          // true iff ALL probes ok
  ts: string;
  providers: {
    gemini?: ProbeResult;
    anthropic?: ProbeResult;
    openai?: ProbeResult;
    active: "gemini" | "anthropic" | "openai" | "unknown";
  };
  kv: ProbeResult;
  d1: ProbeResult;
}

export async function runDeepHealth(env: Env): Promise<DeepHealthResult> {
  const ts = new Date().toISOString();

  // Determine the active provider so the operator can see which path's status
  // actually matters for the chat flow today.
  let active: DeepHealthResult["providers"]["active"] = "unknown";
  try {
    active = resolveProvider(env).provider;
  } catch {
    /* surfaced via per-provider probe below */
  }

  // Probe ONLY providers whose keys are configured. Saves cost + avoids false
  // "fail" on unused providers.
  const probes: Promise<unknown>[] = [];
  const out: DeepHealthResult = {
    ok: true,
    ts,
    providers: { active },
    kv: { ok: false, latency_ms: 0 },
    d1: { ok: false, latency_ms: 0 },
  };

  if (env.GEMINI_API_KEY) {
    probes.push(
      probeGemini(env.GEMINI_API_KEY).then((r) => { out.providers.gemini = r; }),
    );
  }
  if (env.ANTHROPIC_API_KEY) {
    probes.push(
      probeAnthropic(env.ANTHROPIC_API_KEY, env.ANTHROPIC_PROXY_URL).then((r) => {
        out.providers.anthropic = r;
      }),
    );
  }
  if (env.OPENAI_API_KEY) {
    probes.push(
      probeOpenAI(env.OPENAI_API_KEY).then((r) => { out.providers.openai = r; }),
    );
  }
  probes.push(probeKV(env).then((r) => { out.kv = r; }));
  probes.push(probeD1(env).then((r) => { out.d1 = r; }));

  await Promise.all(probes);

  // `ok` aggregates the active provider's probe + KV + D1. Inactive providers
  // failing is informational but doesn't flip the overall flag.
  const activeProbe = out.providers[active === "unknown" ? "gemini" : active];
  out.ok = (activeProbe?.ok ?? false) && out.kv.ok && out.d1.ok;

  return out;
}

// ---- provider probes (cheapest path that round-trips real auth) ------------

/** Gemini: hit the OpenAI-compat list-models endpoint — tiny + auth-checked. */
async function probeGemini(apiKey: string): Promise<ProbeResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/openai/models`;
  return timedFetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
}

/** Anthropic via the configured proxy (when set) or direct. */
async function probeAnthropic(apiKey: string, proxyUrl?: string): Promise<ProbeResult> {
  // The proxy is transparent passthrough — we can hit its /v1/messages with a
  // tiny POST. Cheapest tokens model (haiku) keeps cost at ~$0/call when capped
  // at max_tokens=1. Note: max_tokens=0 is invalid for Anthropic, so use 1.
  const base = proxyUrl ?? "https://api.anthropic.com/v1/messages";
  const r = await timedFetch(base, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "." }],
    }),
  });
  // Annotate which path was used so an HKG block vs a proxy outage is
  // distinguishable in the dashboard.
  r.via = proxyUrl ? new URL(proxyUrl).host : "api.anthropic.com";
  return r;
}

/** OpenAI: list-models — cheap + auth-checked. */
async function probeOpenAI(apiKey: string): Promise<ProbeResult> {
  return timedFetch("https://api.openai.com/v1/models", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
}

/** KV: round-trip read of a sentinel key (always-empty is fine — we want the I/O). */
async function probeKV(env: Env): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    // Read-only probe; absence is fine, we're measuring I/O not the value.
    await env.HPS_KV.get("__health_probe__");
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - t0, error: (err as Error).message };
  }
}

/** D1: SELECT 1 — measures the connection roundtrip. */
async function probeD1(env: Env): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const r = await env.HPS_DB.prepare("SELECT 1 AS one").first<{ one: number }>();
    if (r?.one === 1) return { ok: true, latency_ms: Date.now() - t0 };
    return { ok: false, latency_ms: Date.now() - t0, error: "unexpected D1 result" };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - t0, error: (err as Error).message };
  }
}

/** Timed fetch with shared timeout. 2xx → ok; 401/403 still counts as "ok-ish"
 *  (auth ran, server reachable) — but we annotate the status so an audit can
 *  see when the key is rejected. We treat 4xx as fail to surface real config
 *  errors loudly; 401 specifically means the key/proxy is wrong.
 */
async function timedFetch(url: string, init: RequestInit = {}): Promise<ProbeResult> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("probe-timeout"), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    clearTimeout(timer);
    try { await res.body?.cancel(); } catch { /* socket already closed */ }
    return {
      ok: res.ok,
      status: res.status,
      latency_ms: Date.now() - t0,
      ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      latency_ms: Date.now() - t0,
      error: (err as Error).message?.includes("abort") ? "timeout" : (err as Error).message,
    };
  }
}
