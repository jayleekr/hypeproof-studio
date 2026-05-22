// fetch helpers with timeout + safe JSON parse. Zero deps — uses Node 22
// built-in fetch + AbortController.

export const DEFAULT_TIMEOUT_MS = 30_000;
export const LLM_TIMEOUT_MS = 60_000;

/** fetch with hard timeout. Throws on network failure or non-2xx unless
 *  `allowNon2xx: true` — handy for asserting error responses. */
export async function fetchJson(url, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    allowNon2xx = false,
    method = "GET",
    headers = {},
    body,
  } = options;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body && !headers["content-type"]
        ? { "content-type": "application/json", ...headers }
        : headers,
      body: typeof body === "object" ? JSON.stringify(body) : body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok && !allowNon2xx) {
    const text = await res.text().catch(() => "(no body)");
    const err = new Error(`HTTP ${res.status} ${res.statusText} on ${method} ${url}\n  body: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  const text = await res.text().catch(() => "");
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text, headers: res.headers };
}

/** One non-streamed chat turn. Returns { status, text, reply, raw }. */
export async function sendChat(workerUrl, token, userMessage, opts = {}) {
  const url = `${workerUrl}/chat/completions`;
  const body = {
    model: opts.model ?? "hypeproof-default",
    stream: false,
    max_tokens: opts.max_tokens ?? 300,
    messages: opts.history ?? [{ role: "user", content: userMessage }],
  };
  const r = await fetchJson(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body,
    timeoutMs: LLM_TIMEOUT_MS,
    allowNon2xx: true,
  });
  const reply =
    r.json?.choices?.[0]?.message?.content ??
    r.json?.choices?.[0]?.text ??
    "";
  return { status: r.status, text: r.text, reply, raw: r.json };
}

/** Retry harness for LLM-shape tests. Pass if predicate true ≥ minPasses of tries. */
export async function retryAssert(fn, predicate, opts = {}) {
  const tries = opts.tries ?? 3;
  const minPasses = opts.minPasses ?? 2;
  const results = [];
  let passes = 0;
  for (let i = 0; i < tries; i++) {
    const out = await fn();
    results.push(out);
    if (predicate(out)) passes++;
  }
  return { passed: passes >= minPasses, results, passCount: passes };
}

/** Hangul char ratio (excluding whitespace). For language-shape assertions. */
export function hangulRatio(s) {
  const compact = (s ?? "").replace(/\s/g, "");
  if (compact.length === 0) return 0;
  let h = 0;
  for (const ch of compact) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x3130 && code <= 0x318f)
    ) {
      h++;
    }
  }
  return h / compact.length;
}

/** Canonical game-vestige negation pattern (per memory korean-regex-single-
 *  char-trap — avoid bare /색/). Even "색을" alone false-matches "검**색을**"
 *  → use the v3 phrase context "색을 더" (palette change verb). Same for 모양만. */
export const GAME_VESTIGE_RE = /캐릭터|주인공|점수|색상|색깔|색을 더|모양만 바|공이 좌우|별이 떨어|장애물을 피|점프하는 게임/;

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
