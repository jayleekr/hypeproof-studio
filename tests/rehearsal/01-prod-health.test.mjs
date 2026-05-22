// R1 — Prod health & contract.
// Issue #83. Cross-platform Node 22 (built-in fetch + node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKER_URL,
  TOKEN,
  ADMIN_PASSWORD,
  adminBase,
  basicAuthHeader,
} from "./helpers/env.mjs";
import { fetchJson, GAME_VESTIGE_RE } from "./helpers/api.mjs";

test("R1.1 — /v1/health returns 200 + ok:true", async () => {
  const r = await fetchJson(`${WORKER_URL}/health`);
  assert.equal(r.status, 200);
  assert.equal(r.json?.ok, true, `expected ok:true, got: ${r.text.slice(0, 200)}`);
});

test(
  "R1.2 — /v1/health/deep (admin) — gemini · anthropic · KV · D1 all ok",
  { skip: !ADMIN_PASSWORD && "ADMIN_PASSWORD not set" },
  async () => {
    const r = await fetchJson(`${WORKER_URL}/health/deep`, {
      headers: { authorization: basicAuthHeader(ADMIN_PASSWORD) },
      timeoutMs: 15_000,
    });
    assert.equal(r.status, 200);
    const body = r.json ?? {};
    // Actual shape (worker /v1/health/deep response):
    //   { ok, ts, providers: { active, gemini:{ok,...}, anthropic:{ok,...} }, kv:{ok,...}, d1:{ok,...} }
    assert.equal(body.ok, true, `top-level ok not true: ${JSON.stringify(body)}`);
    const providers = body.providers ?? {};
    const activeProv = providers.active;
    assert.ok(activeProv, `providers.active missing: ${JSON.stringify(providers)}`);
    assert.ok(providers[activeProv]?.ok === true, `active provider '${activeProv}' not ok: ${JSON.stringify(providers[activeProv])}`);
    assert.ok(body.kv?.ok === true, `kv not ok: ${JSON.stringify(body.kv)}`);
    assert.ok(body.d1?.ok === true, `d1 not ok: ${JSON.stringify(body.d1)}`);
  },
);

test(
  "R1.3 — /v1/profile (cohort token) — greeting has 슈퍼서치엔진 + 원장님 (dental cohort)",
  { skip: !TOKEN && "TOKEN not set" },
  async () => {
    const r = await fetchJson(`${WORKER_URL}/profile`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(r.status, 200);
    const p = r.json;
    assert.ok(p?.profile_id, "profile_id missing");
    if (p.profile_id.includes("boah-dental")) {
      assert.ok(p.welcome.greeting_md.includes("슈퍼서치엔진"), `greeting missing '슈퍼서치엔진': ${p.welcome.greeting_md}`);
      assert.ok(p.welcome.greeting_md.includes("원장님을 이겨"), `greeting missing '원장님을 이겨': ${p.welcome.greeting_md}`);
    }
    // essences_focus should NOT be exposed by /v1/profile (it's filtered).
    assert.equal(p.essences_focus, undefined, "essences_focus should NOT be exposed via /v1/profile");
  },
);

test(
  "R1.4 — /v1/profile follow_up — 7 chips, each caption has E#",
  { skip: !TOKEN && "TOKEN not set" },
  async () => {
    const r = await fetchJson(`${WORKER_URL}/profile`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const p = r.json;
    if (!p.profile_id.includes("boah-dental")) {
      // Other cohorts have their own follow_up shape; this test is dental-specific.
      assert.ok(p.ux.suggestions.follow_up.length > 0, "follow_up empty");
      return;
    }
    assert.equal(p.ux.suggestions.follow_up.length, 7);
    const re = /E(2|7|9|11|12|13|14)\b/;
    const seen = new Set();
    for (const chip of p.ux.suggestions.follow_up) {
      assert.ok(re.test(chip.caption ?? ""), `caption missing E#: ${chip.caption}`);
      const m = chip.caption.match(re);
      if (m) seen.add(m[1]);
    }
    assert.equal(seen.size, 7, `follow_up should cover 7 distinct Essence numbers, got ${[...seen]}`);
  },
);

test(
  "R1.5 — v3 game-vestige tokens absent from /v1/profile JSON",
  { skip: !TOKEN && "TOKEN not set" },
  async () => {
    const r = await fetchJson(`${WORKER_URL}/profile`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const serialized = JSON.stringify(r.json);
    // Per memory korean-regex-single-char-trap: ban game-palette compound tokens, not bare /색/.
    assert.doesNotMatch(serialized, GAME_VESTIGE_RE, "profile contains v3 game vestige");
  },
);
