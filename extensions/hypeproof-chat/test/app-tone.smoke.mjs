// Smoke tests for app-tone labels (#159).
// Pure helpers — no vscode host.
// Run: node --experimental-strip-types test/app-tone.smoke.mjs

import assert from "node:assert/strict";

const { appToneOf, labelsForProfile, TONE_LABELS } = await import(
  "../src/chatPanelHelpers.ts"
);

// ─── appToneOf — tier discrimination ─────────────────────────────────
{
  assert.equal(appToneOf({ game: { template_tier: "search-webapp" } }), "search");
  assert.equal(appToneOf({ game: { template_tier: "kids-basic" } }), "game");
  assert.equal(appToneOf({ game: { template_tier: "kids-rich" } }), "game");
  assert.equal(appToneOf({ game: { template_tier: "teen" } }), "game");
  assert.equal(appToneOf({ game: { template_tier: "pro-3d" } }), "game");
}

// ─── appToneOf — robust to missing profile / game block ──────────────
{
  assert.equal(appToneOf(null), "game");
  assert.equal(appToneOf(undefined), "game");
  assert.equal(appToneOf({}), "game");
  assert.equal(appToneOf({ game: {} }), "game");
}

// ─── TONE_LABELS — both tones present with all required slots ────────
{
  const required = [
    "buildingLabel",
    "namingEmoji",
    "previewTitle",
    "previewPlaceholder",
    "tokenConfirmTail",
    "showIntentReply",
    "aboutTitle",
    "aboutSubtitle",
  ];
  for (const tone of ["game", "search"]) {
    const labels = TONE_LABELS[tone];
    for (const slot of required) {
      assert.ok(
        typeof labels[slot] === "string" && labels[slot].length > 0,
        `${tone}.${slot} must be a non-empty string`,
      );
    }
  }
}

// ─── labels are tone-distinct (no shared copy that hides bugs) ───────
{
  for (const slot of ["buildingLabel", "previewTitle", "showIntentReply"]) {
    assert.notEqual(
      TONE_LABELS.game[slot],
      TONE_LABELS.search[slot],
      `${slot} must differ between tones`,
    );
  }
}

// ─── search tone uses search vocabulary, no game leakage ─────────────
{
  const s = TONE_LABELS.search;
  for (const slot of ["buildingLabel", "previewTitle", "showIntentReply", "aboutTitle", "aboutSubtitle"]) {
    assert.doesNotMatch(s[slot], /게임|🎮|점프|캐릭터|점수/, `search.${slot} leaks game copy: ${s[slot]}`);
  }
}

// ─── game tone keeps its legacy vocabulary ───────────────────────────
{
  const g = TONE_LABELS.game;
  assert.match(g.previewTitle, /게임|🎮/);
  assert.match(g.aboutTitle, /게임|🎮/);
}

// ─── labelsForProfile = TONE_LABELS[appToneOf(p)] ────────────────────
{
  const p = { game: { template_tier: "search-webapp" } };
  const expected = TONE_LABELS.search;
  const actual = labelsForProfile(p);
  assert.deepEqual(actual, expected);
}

console.log("✅ app-tone: 6 case groups passed");
