// Smoke tests for buildProxyHeaders (#96 / REQ-C2). Pure helper — no vscode,
// no fetch. Run: node --experimental-strip-types test/proxy-headers.smoke.mjs

import assert from "node:assert/strict";

const { buildProxyHeaders } = await import("../src/proxyClientHelpers.ts");

// ─── Baseline: always-present headers ───────────────────────────────
{
  const h = buildProxyHeaders({});
  assert.equal(h["content-type"], "application/json");
  assert.equal(h["accept"], "text/event-stream");
  console.log("✅ baseline content-type + accept always set");
}

// ─── Authorization ──────────────────────────────────────────────────
{
  const h = buildProxyHeaders({ token: "eyJ.test.token" });
  assert.equal(h.authorization, "Bearer eyJ.test.token");
  console.log("✅ token → Bearer authorization");
}
{
  const h = buildProxyHeaders({});
  assert.equal(h.authorization, undefined, "no token → no authorization header");
  console.log("✅ missing token → no authorization (anonymous fallback)");
}
{
  const h = buildProxyHeaders({ token: "" });
  assert.equal(h.authorization, undefined, "empty-string token → no header");
  console.log("✅ empty token → no authorization");
}

// ─── ASCII coach name ──────────────────────────────────────────────
{
  const h = buildProxyHeaders({ coachName: "Tony" });
  assert.equal(h["x-hps-coach-name"], "Tony");
  console.log("✅ ASCII coach name passes through unchanged");
}

// ─── Korean coach name (the critical one) ──────────────────────────
{
  const h = buildProxyHeaders({ coachName: "코디" });
  assert.equal(h["x-hps-coach-name"], "%EC%BD%94%EB%94%94");
  // Byte-safe check: every char in the value must be ASCII
  for (const c of h["x-hps-coach-name"]) {
    assert.ok(c.charCodeAt(0) < 128, `non-ASCII byte leaked: ${c}`);
  }
  // Round-trip
  assert.equal(decodeURIComponent(h["x-hps-coach-name"]), "코디");
  console.log("✅ Korean coach name URL-encoded byte-safe + round-trip");
}

// ─── Multi-char Korean + emoji ─────────────────────────────────────
{
  const h = buildProxyHeaders({ coachName: "친절한 코치 🦷" });
  for (const c of h["x-hps-coach-name"]) {
    assert.ok(c.charCodeAt(0) < 128, `non-ASCII byte leaked: ${c}`);
  }
  assert.equal(decodeURIComponent(h["x-hps-coach-name"]), "친절한 코치 🦷");
  console.log("✅ name with space + emoji round-trips byte-safe");
}

// ─── Empty / whitespace name → header absent ───────────────────────
{
  assert.equal(buildProxyHeaders({})["x-hps-coach-name"], undefined);
  assert.equal(buildProxyHeaders({ coachName: "" })["x-hps-coach-name"], undefined);
  assert.equal(buildProxyHeaders({ coachName: "   " })["x-hps-coach-name"], undefined);
  console.log("✅ empty/whitespace name → header absent");
}

// ─── Coach name trimmed before encoding ────────────────────────────
{
  const h = buildProxyHeaders({ coachName: "  Tony  " });
  assert.equal(h["x-hps-coach-name"], "Tony");
  console.log("✅ leading/trailing whitespace trimmed");
}

// ─── Personality: same byte-safety + round-trip ────────────────────
{
  const personality = "친절하고\n엉뚱한 친구\t🎮";
  const h = buildProxyHeaders({ coachPersonality: personality });
  for (const c of h["x-hps-coach-personality"]) {
    assert.ok(c.charCodeAt(0) < 128, `non-ASCII byte leaked: ${c}`);
  }
  assert.equal(decodeURIComponent(h["x-hps-coach-personality"]), personality);
  console.log("✅ personality with newline+tab+emoji byte-safe + round-trip");
}

{
  assert.equal(buildProxyHeaders({ coachPersonality: "" })["x-hps-coach-personality"], undefined);
  assert.equal(buildProxyHeaders({ coachPersonality: "   " })["x-hps-coach-personality"], undefined);
  console.log("✅ empty personality → header absent");
}

// ─── All inputs combined ───────────────────────────────────────────
{
  const h = buildProxyHeaders({
    token: "tok123",
    coachName: "코디",
    coachPersonality: "친절",
  });
  assert.equal(h["content-type"], "application/json");
  assert.equal(h["accept"], "text/event-stream");
  assert.equal(h.authorization, "Bearer tok123");
  assert.equal(decodeURIComponent(h["x-hps-coach-name"]), "코디");
  assert.equal(decodeURIComponent(h["x-hps-coach-personality"]), "친절");
  console.log("✅ all fields combined");
}

// ─── Header values are spec-compliant (visible-ASCII + space/tab) ──
{
  const h = buildProxyHeaders({
    token: "abc",
    coachName: "한글이름테스트",
    coachPersonality: "긴 인격 설명 줄바꿈\n포함",
  });
  for (const [name, value] of Object.entries(h)) {
    for (const c of value) {
      const code = c.charCodeAt(0);
      // RFC 7230 token + VCHAR rules — be strict: VCHAR (0x21-0x7E) plus
      // space/tab. URL-encoded output is in this range by construction.
      assert.ok(
        code === 0x09 || code === 0x20 || (code >= 0x21 && code <= 0x7E),
        `header "${name}" has out-of-range char 0x${code.toString(16)}`,
      );
    }
  }
  console.log("✅ every header value is RFC-7230-safe");
}

console.log("\nAll proxy-header smoke tests passed.");
