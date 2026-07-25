// Smoke tests for the #427 + #428 fixes — both pure, both regressions from a real
// lecture-day failure on the boah-dental-director-copyclone cohort:
//
//   1. sanitizeWorkshopToken — the instructor console's ONLY copy button emitted
//      "이름: 토큰", the app stored it verbatim, and the paste 401'd with
//      `password: true` hiding the evidence.
//   2. withWorkspaceContext — a string `systemPrompt` replaces the SDK preamble
//      that normally carries the working-directory env block, so the coach
//      answered "내 워킹디렉토리 절대경로" with an invented "/app/workdir" while
//      its tools resolved against the real folder.
//
// Run: node --experimental-strip-types test/token-and-workspace.smoke.mjs

import assert from "node:assert/strict";

const { sanitizeWorkshopToken, looksLikeWorkshopToken } =
  await import("../src/chatPanelHelpers.ts");
const { withWorkspaceContext, buildSdkQueryOptions, profileToAgentOptions } =
  await import("../src/sdkCoachHelpers.ts");

// A real v2 token shape: base64url payload "." base64url signature.
const TOKEN =
  "eyJjIjoiYm9haC1kZW50YWwtMjAyNi1hIiwidSI6Imppd29vbmciLCJ2IjoyfQ" +
  ".zosT3IuGaktqrtZ7hljoLI-SXBkq1eyL7IBJpIB3kCk";

// ─── sanitizeWorkshopToken ───────────────────────────────────────────────────
{
  assert.equal(sanitizeWorkshopToken(TOKEN), TOKEN, "clean token passes through");
  assert.equal(sanitizeWorkshopToken(`  ${TOKEN}\n`), TOKEN, "surrounding whitespace");

  // THE regression: the console's bulk-copy format.
  assert.equal(sanitizeWorkshopToken(`jiwoong: ${TOKEN}`), TOKEN, "이름: 토큰 prefix");
  assert.equal(sanitizeWorkshopToken(`jiwoong:${TOKEN}`), TOKEN, "no space after colon");

  // A relay (KakaoTalk, a doc) hard-wraps the token; the quick input joins the
  // lines but keeps the wrap indent INSIDE the string, which trim() misses.
  const wrapped = TOKEN.slice(0, 40) + "\n  " + TOKEN.slice(40);
  assert.equal(sanitizeWorkshopToken(wrapped), TOKEN, "internal newline + indent");

  assert.equal(sanitizeWorkshopToken(`Bearer ${TOKEN}`), TOKEN, "Bearer prefix");
  assert.equal(sanitizeWorkshopToken(`bearer ${TOKEN}`), TOKEN, "lowercase bearer");
  assert.equal(sanitizeWorkshopToken(`"${TOKEN}"`), TOKEN, "quoted");
  assert.equal(sanitizeWorkshopToken("`" + TOKEN + "`"), TOKEN, "backticked");
  assert.equal(
    sanitizeWorkshopToken(`  jiwoong: "Bearer ${TOKEN}"  `),
    TOKEN,
    "every wrapper at once",
  );

  // Clearing the token must still work — the caller keys off "" to delete the
  // secret, so whitespace-only input cannot come back as anything else.
  assert.equal(sanitizeWorkshopToken(""), "", "empty stays empty");
  assert.equal(sanitizeWorkshopToken("   \n  "), "", "whitespace-only clears");

  // A colon can never occur inside base64url, so slicing past the last one is
  // safe. Guard the property rather than trusting the comment.
  assert.ok(!/[:\s]/.test(TOKEN), "token alphabet has no colon or whitespace");
}

// ─── looksLikeWorkshopToken — diagnosis only, never a gate ───────────────────
{
  assert.equal(looksLikeWorkshopToken(TOKEN), true, "real token shape");
  assert.equal(looksLikeWorkshopToken(`jiwoong: ${TOKEN}`), false, "unsanitized paste");
  assert.equal(looksLikeWorkshopToken(""), false, "empty");
  assert.equal(looksLikeWorkshopToken("eyJhbGciOiJIUzI1NiJ9"), false, "no dot → one segment");
  assert.equal(looksLikeWorkshopToken("a.b.c"), false, "three segments is not our shape");

  // The pairing that matters: anything sanitize() can rescue must then pass the
  // shape check, or the toast would blame the paste after we already fixed it.
  for (const messy of [`jiwoong: ${TOKEN}`, `Bearer ${TOKEN}`, `"${TOKEN}"`]) {
    assert.equal(
      looksLikeWorkshopToken(sanitizeWorkshopToken(messy)),
      true,
      `sanitize then shape-check: ${messy.slice(0, 20)}…`,
    );
  }
}

// ─── withWorkspaceContext ────────────────────────────────────────────────────
{
  const CWD = "/Users/jwcorp/HypeProofClinic";
  const out = withWorkspaceContext("코치 프롬프트", CWD);
  assert.ok(out.startsWith("코치 프롬프트"), "cohort prompt stays first + intact");
  assert.ok(out.includes(CWD), "absolute cwd is stated verbatim");
  assert.ok(/추측하거나 지어내지 않는다/.test(out), "carries the no-guessing instruction");

  // No folder open (dev, or before onboarding resolves one) → prompt untouched
  // rather than decorated with a bogus path.
  assert.equal(withWorkspaceContext("p", undefined), "p", "no cwd → unchanged");
  assert.equal(withWorkspaceContext("p", ""), "p", "empty cwd → unchanged");
}

// ─── wiring: the env block actually reaches the SDK options ──────────────────
// withWorkspaceContext being correct is worthless if buildSdkQueryOptions still
// passes the raw prompt through, which is exactly what it did before #428.
{
  const profile = {
    profile_id: "boah-dental-director-copyclone-2026-s1",
    sdk_tools: { read: true, write: true },
    game: { template_tier: "website" },
  };
  const agent = profileToAgentOptions(profile, {
    model: "hypeproof-default",
    systemPrompt: "코치 프롬프트",
  });
  const CWD = "/Users/jwcorp/HypeProofClinic";

  const opts = buildSdkQueryOptions(agent, {
    proxyUrl: "https://api.hypeproof-ai.xyz/v1",
    token: TOKEN,
    cwd: CWD,
    baseEnv: {},
  });
  assert.ok(opts.systemPrompt.includes(CWD), "cwd reaches Options.systemPrompt");
  assert.equal(opts.cwd, CWD, "cwd still set as an option too (tools resolve here)");

  // The coach has no shell to recover the path with — that is WHY the prompt
  // has to carry it. Lock the invariant so a future grant is a deliberate act.
  assert.ok(!opts.tools.includes("Bash"), "no profile flag can grant Bash");

  const noCwd = buildSdkQueryOptions(agent, {
    proxyUrl: "https://api.hypeproof-ai.xyz/v1",
    token: TOKEN,
    baseEnv: {},
  });
  assert.equal(noCwd.systemPrompt, "코치 프롬프트", "no cwd → prompt unchanged");
}

console.log("✓ token-and-workspace smoke passed");
