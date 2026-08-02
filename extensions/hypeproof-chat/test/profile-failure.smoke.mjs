// Smoke tests for #381 — first-run token entry must name the cause.
//
// Before this, fetchProfile() returned `null` for every failure, so the toast
// said one sentence for five different problems: an expired token, an
// instructor token in the participant box, a cohort the server doesn't know,
// a dead server, and no network at all. A brand-new participant could not act
// on any of it — the only recovery was to interrupt an instructor.
//
// Pure — no vscode, no fetch.
// Run: node --experimental-strip-types test/profile-failure.smoke.mjs

import assert from "node:assert/strict";

const {
  classifyProfileFailure,
  profileNetworkFailure,
  PROFILE_ISSUER_TOKEN_FRIENDLY,
  PROFILE_REJECTED_FRIENDLY,
  PROFILE_UNKNOWN_COHORT_FRIENDLY,
  PROFILE_SERVER_FRIENDLY,
  PROFILE_NETWORK_FRIENDLY,
  TOKEN_EXPIRED_FRIENDLY,
} = await import("../src/proxyClientHelpers.ts");

const { looksLikeIssuerTokenUnverified, decodeTokenPayloadUnverified } = await import(
  "../src/chatPanelHelpers.ts"
);

const b64u = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
const tokenFor = (payload) => `${b64u(payload)}.c2ln`;

const errBody = (code, type = "auth") =>
  JSON.stringify({ error: { message: "nope", type, code, request_id: "0e1f2a3b" } });

// ─── each server-side cause gets its own sentence ────────────────────────────
{
  const expired = classifyProfileFailure(401, errBody("expired"));
  assert.equal(expired.reason, "expired");
  assert.equal(expired.friendly, TOKEN_EXPIRED_FRIENDLY, "reuses the ONE expiry sentence");

  const issuer = classifyProfileFailure(401, errBody("wrong_role"));
  assert.equal(issuer.reason, "issuer_token");
  assert.equal(issuer.friendly, PROFILE_ISSUER_TOKEN_FRIENDLY);

  const rejected = classifyProfileFailure(401, errBody("signature"));
  assert.equal(rejected.reason, "rejected");
  assert.equal(rejected.friendly, PROFILE_REJECTED_FRIENDLY);
  // A 401 that isn't `expired` must NOT claim expiry — that assertion sent the
  // 2026-07-28 investigation down the wrong road for two days (REQ-M13).
  assert.doesNotMatch(PROFILE_REJECTED_FRIENDLY, /만료/, "never asserts expiry it can't know");

  const unknown = classifyProfileFailure(400, errBody("unknown_profile", "config"));
  assert.equal(unknown.reason, "unknown_cohort");
  assert.equal(unknown.friendly, PROFILE_UNKNOWN_COHORT_FRIENDLY);

  const server = classifyProfileFailure(503, errBody("config", "config"));
  assert.equal(server.reason, "server");
  assert.equal(server.friendly, PROFILE_SERVER_FRIENDLY);

  const net = profileNetworkFailure();
  assert.equal(net.reason, "network");
  assert.equal(net.friendly, PROFILE_NETWORK_FRIENDLY);
}

// ─── the five messages are actually distinguishable ──────────────────────────
{
  const messages = [
    TOKEN_EXPIRED_FRIENDLY,
    PROFILE_ISSUER_TOKEN_FRIENDLY,
    PROFILE_REJECTED_FRIENDLY,
    PROFILE_UNKNOWN_COHORT_FRIENDLY,
    PROFILE_SERVER_FRIENDLY,
    PROFILE_NETWORK_FRIENDLY,
  ];
  assert.equal(new Set(messages).size, messages.length, "no two causes share copy");
  for (const m of messages) {
    // Never leak raw diagnostics at a participant (some are 9-10 years old).
    assert.doesNotMatch(m, /\b(401|400|403|500|http|json|null)\b/i, `no jargon in: ${m}`);
  }
}

// ─── request_id survives, so a stuck participant can be traced (#49) ─────────
{
  const f = classifyProfileFailure(401, errBody("expired"));
  assert.equal(f.requestId, "0e1f2a3b");
  assert.equal(f.status, 401);
}

// ─── degrades safely on a non-JSON body (old worker, proxy HTML page) ────────
{
  const f = classifyProfileFailure(401, "<html>Gateway</html>");
  assert.equal(f.reason, "rejected", "unparseable 401 → generic-but-honest rejection");
  const g = classifyProfileFailure(502, "");
  assert.equal(g.reason, "server");
}

// ─── instructor token detected offline, before any request ───────────────────
{
  const issuer = tokenFor({ u: "jay", c: "__issuer__", p: "__issuer__", role: "issuer", v: 2 });
  const student = tokenFor({ u: "kid01", c: "sk-biopharm-2026-a", p: "prof-s1", v: 2 });

  assert.equal(looksLikeIssuerTokenUnverified(issuer), true, "role:issuer is named");
  assert.equal(looksLikeIssuerTokenUnverified(student), false, "a student token is not");
  // Older issuer tokens minted before an explicit role still carry the
  // placeholder cohort/profile.
  assert.equal(
    looksLikeIssuerTokenUnverified(tokenFor({ u: "jay", c: "__issuer__", p: "__issuer__", v: 2 })),
    true,
  );
  // Never throws on junk — it is diagnosis, never a gate.
  for (const junk of [undefined, null, "", "not-a-token", "a.b", "....", "eyJ"]) {
    assert.equal(looksLikeIssuerTokenUnverified(junk), false, `junk stays false: ${junk}`);
  }
}

// ─── payload decoder is total (never throws, never returns non-objects) ──────
{
  assert.deepEqual(decodeTokenPayloadUnverified(tokenFor({ c: "x" })), { c: "x" });
  assert.equal(decodeTokenPayloadUnverified(`${b64u([1, 2])}.sig`), undefined, "array is not a payload");
  assert.equal(decodeTokenPayloadUnverified("garbage.sig"), undefined);
}

console.log("profile-failure.smoke.mjs — all assertions passed");
