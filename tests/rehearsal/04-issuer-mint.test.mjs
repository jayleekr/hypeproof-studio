// R4 — Issuer & mint edge.
// Issue #83. Requires ISSUER_TOKEN to exercise the gold path.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKER_URL,
  ISSUER_TOKEN,
  COHORT,
  PROFILE,
  adminBase,
} from "./helpers/env.mjs";
import { fetchJson } from "./helpers/api.mjs";

const issuerSkip = !ISSUER_TOKEN && "ISSUER_TOKEN not set";
const mintUrl = `${adminBase()}/admin/tokens/issue`;

test("R4.1 — garbage issuer token → 401/403", async () => {
  const r = await fetchJson(mintUrl, {
    method: "POST",
    headers: { authorization: "Bearer garbage_not_a_token" },
    body: { u: "x", c: COHORT, p: PROFILE, hours: 1 },
    allowNon2xx: true,
  });
  assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}: ${r.text.slice(0, 200)}`);
});

test("R4.2 — clearly-malformed/expired issuer → 401", async () => {
  const r = await fetchJson(mintUrl, {
    method: "POST",
    headers: { authorization: "Bearer eyJjIjoiZmFrZSJ9.bad_sig" },
    body: { u: "x", c: COHORT, p: PROFILE, hours: 1 },
    allowNon2xx: true,
  });
  assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
});

test(
  "R4.3 — student token used as issuer → 'not an issuer' error",
  { skip: !process.env.TOKEN && "TOKEN (student) not set" },
  async () => {
    const r = await fetchJson(mintUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.TOKEN}` },
      body: { u: "x", c: COHORT, p: PROFILE, hours: 1 },
      allowNon2xx: true,
    });
    assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}: ${r.text.slice(0, 200)}`);
    // Optional shape: error body mentions issuer
    if (r.json?.error) {
      assert.match(r.json.error.toLowerCase(), /issuer|scope|not.{0,5}an issuer/, `error body unclear: ${r.json.error}`);
    }
  },
);

test(
  "R4.4 — out-of-scope cohort → forbidden",
  { skip: issuerSkip },
  async () => {
    const r = await fetchJson(mintUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${ISSUER_TOKEN}` },
      body: { u: "x", c: "totally-fake-cohort-2099", p: "totally-fake-profile", hours: 1 },
      allowNon2xx: true,
    });
    // Either rejected for cohort not registered, or rejected for scope mismatch.
    assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}: ${r.text.slice(0, 200)}`);
  },
);

test(
  "R4.5 — gold mint → token/jti/exp + new student token immediately works",
  { skip: issuerSkip },
  async () => {
    const r = await fetchJson(mintUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${ISSUER_TOKEN}` },
      body: {
        u: `rehearsal-r45-${Date.now()}`,
        c: COHORT,
        p: PROFILE,
        hours: 1,
      },
      allowNon2xx: true,
    });
    assert.equal(r.status, 200, `mint failed: ${r.status} ${r.text.slice(0, 200)}`);
    assert.ok(r.json?.token, "no token in response");
    assert.ok(r.json?.jti, "no jti in response");
    assert.ok(typeof r.json?.exp === "number", "no exp in response");

    // Immediate liveness — new token should fetch /profile.
    const profileCheck = await fetchJson(`${WORKER_URL}/profile`, {
      headers: { authorization: `Bearer ${r.json.token}` },
      allowNon2xx: true,
    });
    assert.equal(profileCheck.status, 200, `new mint failed /profile: ${profileCheck.status}`);
  },
);

test(
  "R4.6 — same (u, c) twice → both valid, jti different",
  { skip: issuerSkip },
  async () => {
    const u = `rehearsal-r46-${Date.now()}`;
    const body = { u, c: COHORT, p: PROFILE, hours: 1 };

    const r1 = await fetchJson(mintUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${ISSUER_TOKEN}` },
      body,
      allowNon2xx: true,
    });
    const r2 = await fetchJson(mintUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${ISSUER_TOKEN}` },
      body,
      allowNon2xx: true,
    });

    assert.equal(r1.status, 200, `1st mint failed: ${r1.status}`);
    assert.equal(r2.status, 200, `2nd mint failed: ${r2.status}`);
    assert.notEqual(r1.json.jti, r2.json.jti, "jti collided across 2 mints — uniqueness invariant broken");
  },
);
