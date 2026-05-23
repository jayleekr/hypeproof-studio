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
const sessionUrl = `${adminBase()}/admin/cohorts/${COHORT}/session`;
// R4.7–R4.9 (#167) need an issuer with can_start_session in its scope.
// Without it, the start tests can only assert the negative path.
const sessionIssuerSkip =
  !process.env.SESSION_ISSUER_TOKEN && "SESSION_ISSUER_TOKEN not set";

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

// R4.7 (#167) — non-session-scoped issuer hitting POST /session → 403 with
// `can_start_session` hint. Uses the regular ISSUER_TOKEN; no extra env needed.
test(
  "R4.7 — plain issuer (no can_start_session) on POST /session → 403",
  { skip: issuerSkip },
  async () => {
    const nowIso = new Date().toISOString();
    const endIso = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const r = await fetchJson(sessionUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${ISSUER_TOKEN}` },
      body: { profile_id: PROFILE, starts_at: nowIso, ends_at: endIso },
      allowNon2xx: true,
    });
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${r.text.slice(0, 200)}`);
    if (r.json?.error) {
      assert.match(
        r.json.error.toLowerCase(),
        /can_start_session|not scoped/,
        `error body should mention scope: ${r.json.error}`,
      );
    }
  },
);

// R4.8 (#167) — session-scoped issuer can start a session at default duration.
// SESSION_ISSUER_TOKEN must be minted with --can-start-session.
test(
  "R4.8 — session-scoped issuer → opens then closes session",
  { skip: sessionIssuerSkip },
  async () => {
    const token = process.env.SESSION_ISSUER_TOKEN;
    const nowIso = new Date().toISOString();
    const endIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const open = await fetchJson(sessionUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: { profile_id: PROFILE, starts_at: nowIso, ends_at: endIso },
      allowNon2xx: true,
    });
    assert.equal(open.status, 200, `open failed: ${open.status} ${open.text.slice(0, 200)}`);
    assert.ok(open.json?.session, "no session in open response");

    const close = await fetchJson(sessionUrl, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
      allowNon2xx: true,
    });
    assert.equal(close.status, 200, `close failed: ${close.status} ${close.text.slice(0, 200)}`);
  },
);

// R4.9 (#167) — session-scoped issuer cannot exceed max_session_hours.
// Default max is 4h; we ask for 12h and expect 403.
test(
  "R4.9 — session-scoped issuer exceeding max_session_hours → 403",
  { skip: sessionIssuerSkip },
  async () => {
    const token = process.env.SESSION_ISSUER_TOKEN;
    const nowIso = new Date().toISOString();
    const endIso = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const r = await fetchJson(sessionUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: { profile_id: PROFILE, starts_at: nowIso, ends_at: endIso },
      allowNon2xx: true,
    });
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${r.text.slice(0, 200)}`);
    if (r.json?.error) {
      assert.match(
        r.json.error.toLowerCase(),
        /max|exceeds/,
        `error body should mention max: ${r.json.error}`,
      );
    }
  },
);
