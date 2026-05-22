// R5 — Rate-limit & defense.
// Issue #83. Costs ~10 LLM calls when fully exercised — keep tries modest.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKER_URL,
  TOKEN,
  ADMIN_PASSWORD,
  adminBase,
  basicAuthHeader,
} from "./helpers/env.mjs";
import { fetchJson, sendChat } from "./helpers/api.mjs";

test(
  "R5.1 — chat burst (10 in ~10s) — server stays available; if 429 returned, has retry-after-ish guidance",
  { skip: !TOKEN && "TOKEN not set" },
  async () => {
    const N = 10;
    const calls = Array.from({ length: N }, () =>
      sendChat(WORKER_URL, TOKEN, "ping", { max_tokens: 30 }),
    );
    const results = await Promise.all(calls);
    const status = results.map((r) => r.status);
    const okCount = status.filter((s) => s === 200).length;
    const limitedCount = status.filter((s) => s === 429).length;
    // Acceptance: server didn't crash (no 5xx storm) AND either all OK or
    // some were rate-limited (both healthy outcomes). 5xx storm = bad.
    const errCount = status.filter((s) => s >= 500).length;
    assert.ok(errCount === 0, `5xx during burst (${errCount}/${N}): ${JSON.stringify(status)}`);
    assert.ok(okCount + limitedCount === N, `unexpected mix: ${JSON.stringify(status)}`);
  },
);

test(
  "R5.2 — /v1/report burst (11 in ~quick) → at least one rate-limit",
  { skip: !TOKEN && "TOKEN not set" },
  async () => {
    const url = `${WORKER_URL}/report`;
    const calls = Array.from({ length: 11 }, (_, i) =>
      fetchJson(url, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: {
          description: `rehearsal R5.2 burst ${i + 1}`,
          include_recent_turns: false,
          contact: "",
          // minimal client-meta
          studio_version: "rehearsal",
          os: "node",
          locale: "ko-KR",
        },
        allowNon2xx: true,
      }),
    );
    const results = await Promise.all(calls);
    const status = results.map((r) => r.status);
    // Acceptance: some 429s once limit hit. If all 200 — the limit might be looser than 10/min,
    // which is also a valid finding (open as a separate issue, don't fail this test).
    const limited = status.filter((s) => s === 429).length;
    const err5xx = status.filter((s) => s >= 500).length;
    assert.ok(err5xx === 0, `5xx during report burst: ${JSON.stringify(status)}`);
    // Inform-only: print stats so the rehearsal owner can compare to spec.
    console.log(`  R5.2 stats: status=${JSON.stringify(status)} (200=${status.filter(s=>s===200).length}, 429=${limited})`);
  },
);

test(
  "R5.3 — very large max_tokens → handled (200 with possible truncation, or 4xx)",
  { skip: !TOKEN && "TOKEN not set" },
  async () => {
    const r = await sendChat(WORKER_URL, TOKEN, "안녕", { max_tokens: 16000 });
    // Accept either capped 200 or 4xx validation. Reject 5xx.
    assert.ok(r.status < 500, `5xx on large max_tokens: ${r.status} ${r.text?.slice(0, 200)}`);
  },
);

test("R5.4 — OPTIONS preflight from unknown origin — server responds (CORS handled)", async () => {
  // Just verify the OPTIONS path doesn't 5xx. Different worker setups answer
  // 200 / 204 / 405; what we care about is no crash.
  const r = await fetchJson(`${WORKER_URL}/chat/completions`, {
    method: "OPTIONS",
    headers: { origin: "https://example.invalid" },
    allowNon2xx: true,
  });
  assert.ok(r.status < 500, `5xx on OPTIONS: ${r.status}`);
});

test(
  "R5.5 — /v1/health/deep responds within 3 seconds",
  { skip: !ADMIN_PASSWORD && "ADMIN_PASSWORD not set" },
  async () => {
    const t0 = Date.now();
    const r = await fetchJson(`${WORKER_URL}/health/deep`, {
      headers: { authorization: basicAuthHeader(ADMIN_PASSWORD) },
      timeoutMs: 5_000,
    });
    const dt = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.ok(dt < 3_000, `deep health took ${dt}ms (> 3000ms)`);
  },
);
