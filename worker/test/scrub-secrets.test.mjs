// Gateway-side credential scrubbing (epic #431).
//
// The coach can run shell now, so a tool_result block carries whatever a
// command printed. That block becomes prompt content on the next turn and
// lands in our logs. These tests lock the two halves: the patterns catch what
// a workshop actually leaks, and the messages walk touches ONLY tool_result.
//
// Run: node --experimental-strip-types test/scrub-secrets.test.mjs

import assert from "node:assert/strict";

const { scrubSecrets, scrubToolResultSecrets } =
  await import("../src/lib/scrub-secrets.ts");

const GH_PAT = "ghp_" + "a".repeat(36);
const CF_LINE = "CLOUDFLARE_API_TOKEN=abcdef1234567890abcdef";
const GIT_CRED = "https://jiwoong:" + GH_PAT + "@github.com/boa/site.git";

// ─── patterns ────────────────────────────────────────────────────────────────
{
  for (const [secret, label] of [
    [GH_PAT, "classic PAT"],
    ["github_pat_" + "b".repeat(30), "fine-grained PAT"],
    ["gho_" + "c".repeat(36), "OAuth token"],
    ["sk-ant-api03-" + "d".repeat(40), "Anthropic key"],
    ["AKIA" + "E".repeat(16), "AWS key id"],
    [GIT_CRED, ".git-credentials line"],
    [CF_LINE, "env assignment"],
    // Real v2 token length — the pattern requires 20+ base64url chars per
    // segment on purpose, so an unrealistically short fixture would pass the
    // test while proving nothing.
    [
      "eyJjIjoiYm9haC1kZW50YWwtMjAyNi1hIiwidSI6Imppd29vbmciLCJ2IjoyfQ" +
        ".zosT3IuGaktqrtZ7hljoLI-SXBkq1eyL7IBJpIB3kCk",
      "workshop token",
    ],
  ]) {
    const out = scrubSecrets(`log\n${secret}\nend`);
    assert.ok(!out.includes(secret), `${label} masked`);
    assert.ok(out.includes("가려짐"), `${label} leaves a placeholder`);
  }

  // Ordinary deploy/build output must survive byte-identical, or scrubbing
  // becomes noise the coach has to reason around.
  for (const clean of [
    "✨ Deployed to https://boa-dental.pages.dev",
    "[main 1a2b3c4] 1차 초안\n 2 files changed",
    "added 214 packages in 3s",
    "On branch main\nnothing to commit, working tree clean",
  ]) {
    assert.equal(scrubSecrets(clean), clean, "untouched");
  }
  assert.equal(scrubSecrets(""), "", "empty");
}

// ─── messages walk — tool_result only ───────────────────────────────────────
{
  const messages = [
    { role: "user", content: [{ type: "text", text: `내 토큰은 ${GH_PAT} 이야` }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cat ~/.git-credentials" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: GIT_CRED }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: [{ type: "text", text: `deploy failed\n${CF_LINE}` }],
        },
      ],
    },
  ];

  const out = scrubToolResultSecrets(messages);
  const json = JSON.stringify(out);

  // Both tool_result shapes (bare string, nested blocks) are scrubbed.
  assert.ok(!json.includes(GIT_CRED), "string tool_result scrubbed");
  assert.ok(!json.includes("abcdef1234567890abcdef"), "nested tool_result scrubbed");

  // USER PROSE IS NOT TOUCHED. Deliberate: it is text the participant wrote and
  // expects back verbatim, and silently rewriting it would be a worse bug than
  // the one being prevented. This assertion is the guard on that decision — if
  // it ever flips, it must flip on purpose.
  assert.ok(json.includes(`내 토큰은 ${GH_PAT} 이야`), "user text left alone");

  // Untouched messages keep referential identity — no needless object churn on
  // the classroom's hot path.
  assert.equal(out[0], messages[0], "clean message not reallocated");
  assert.equal(out[1], messages[1], "tool_use block not reallocated");
  assert.notEqual(out[2], messages[2], "dirty message replaced");

  // The original array is not mutated (the caller still logs `raw`).
  assert.ok(JSON.stringify(messages).includes(GIT_CRED), "input untouched");
}

// ─── total on junk — a format change must not 500 the classroom ─────────────
{
  for (const junk of [null, undefined, 42, "str", {}, [null], [{ role: "user" }],
                      [{ role: "user", content: "plain string" }],
                      [{ role: "user", content: [null, 7, { type: "tool_result" }] }]]) {
    assert.doesNotThrow(() => scrubToolResultSecrets(junk), `total on ${JSON.stringify(junk)}`);
  }
  assert.equal(scrubToolResultSecrets("nope"), "nope", "non-array passthrough");
}

console.log("✓ scrub-secrets tests passed");
