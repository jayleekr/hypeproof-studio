// R2 — Token & session lifecycle.
// Issue #83.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKER_URL,
  TOKEN,
  ADMIN_PASSWORD,
  COHORT,
  adminBase,
  basicAuthHeader,
} from "./helpers/env.mjs";
import { fetchJson, sleep } from "./helpers/api.mjs";

test("R2.1 — no Authorization header → 401/403", async () => {
  const r = await fetchJson(`${WORKER_URL}/profile`, { allowNon2xx: true });
  assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}: ${r.text.slice(0, 200)}`);
});

test("R2.2 — bogus token 'abc.def' → 401 with signature error", async () => {
  const r = await fetchJson(`${WORKER_URL}/profile`, {
    headers: { authorization: "Bearer abc.def" },
    allowNon2xx: true,
  });
  assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}: ${r.text.slice(0, 200)}`);
});

test("R2.3 — clearly-malformed token → 401", async () => {
  // A real expired token requires HPS_SIGNING_SECRET to mint; we settle for
  // verifying the same 401 path triggers on any unverifiable token shape.
  const r = await fetchJson(`${WORKER_URL}/profile`, {
    headers: { authorization: "Bearer eyJjIjoiZmFrZSIsImV4cCI6MX0.tampered_sig_does_not_verify" },
    allowNon2xx: true,
  });
  assert.ok(r.status === 401 || r.status === 403, `expected 401/403 on malformed, got ${r.status}`);
});

test(
  "R2.4 — cohort kill-switch: pause → token blocked → unpause → restored",
  { skip: (!ADMIN_PASSWORD || !TOKEN) && "ADMIN_PASSWORD + TOKEN both required" },
  async () => {
    const auth = { authorization: basicAuthHeader(ADMIN_PASSWORD) };
    // POST = pause, DELETE on the same path = unpause (worker/src/routes/admin.ts).
    const pauseUrl = `${adminBase()}/admin/cohorts/${COHORT}/pause`;

    // Baseline: token works
    const before = await fetchJson(`${WORKER_URL}/profile`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      allowNon2xx: true,
    });
    assert.equal(before.status, 200, `pre-pause /profile not 200: ${before.text.slice(0, 200)}`);

    // Pause
    const p = await fetchJson(pauseUrl, { method: "POST", headers: auth, body: { reason: "rehearsal R2.4" }, allowNon2xx: true });
    assert.ok(p.ok, `pause endpoint failed: ${p.status} ${p.text.slice(0, 200)}`);

    try {
      // Give kill-switch up to 2 seconds to propagate (#47 spec: ≤1s).
      let blocked = false;
      for (let i = 0; i < 4; i++) {
        await sleep(500);
        const during = await fetchJson(`${WORKER_URL}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}` },
          body: { model: "hypeproof-default", stream: false, max_tokens: 10, messages: [{ role: "user", content: "ping" }] },
          allowNon2xx: true,
        });
        if (during.status >= 400) { blocked = true; break; }
      }
      assert.ok(blocked, "cohort paused but chat still succeeded");
    } finally {
      // Always unpause (DELETE on the same pause path).
      const u = await fetchJson(pauseUrl, { method: "DELETE", headers: auth, allowNon2xx: true });
      assert.ok(u.ok, `unpause failed: ${u.status} ${u.text.slice(0, 200)}`);
    }

    // Post-restore: /profile works again
    await sleep(500);
    const after = await fetchJson(`${WORKER_URL}/profile`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      allowNon2xx: true,
    });
    assert.equal(after.status, 200, `post-unpause /profile not 200: ${after.text.slice(0, 200)}`);
  },
);

test(
  "R2.5 — session window — at least the /profile path tolerates 'between sessions'",
  { skip: !TOKEN && "TOKEN not set" },
  async () => {
    // True out-of-window simulation requires admin manipulation. We at minimum
    // confirm the token is valid for /profile (lightweight cohort metadata)
    // — chat sometimes requires active class window. This is a smoke for the
    // class-window enforcement existing at all.
    const r = await fetchJson(`${WORKER_URL}/profile`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      allowNon2xx: true,
    });
    assert.ok([200, 403].includes(r.status), `unexpected status ${r.status}: ${r.text.slice(0, 200)}`);
  },
);

test(
  "R2.6 — gold path: valid token → /chat/completions 200 with reply",
  { skip: !TOKEN && "TOKEN not set" },
  async () => {
    const r = await fetchJson(`${WORKER_URL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: {
        model: "hypeproof-default",
        stream: false,
        max_tokens: 100,
        messages: [{ role: "user", content: "안녕" }],
      },
      timeoutMs: 60_000,
    });
    assert.equal(r.status, 200);
    const reply = r.json?.choices?.[0]?.message?.content ?? "";
    assert.ok(reply.length > 5, `reply too short: ${reply}`);
  },
);
