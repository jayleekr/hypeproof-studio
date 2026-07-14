// Smoke tests for the AI disclosure session gate (#320, REQ-C14). Pure — no
// vscode. Anthropic Usage Policy requires consumer-facing chat to disclose
// "you are interacting with AI" at minimum at session start; ToS §D.3 wants
// users nudged to verify outputs. The host-side AiDisclosureGate decides WHEN
// the notice is due (webview state resets on every hide/show remount, so it
// can't remember on its own).
// Run: node --experimental-strip-types test/ai-disclosure.smoke.mjs

import assert from "node:assert/strict";

const { AI_DISCLOSURE_TEXT, AiDisclosureGate } = await import("../src/chatPanelHelpers.ts");

// ─── Copy contract — both policy sentences present ───────────────────────────
{
  // Sentence 1: "you are interacting with AI" (Usage Policy disclosure).
  assert.match(AI_DISCLOSURE_TEXT, /AI 코치와 대화하고 있어요/, "must disclose the AI interaction");
  // Sentence 2: outputs can be wrong — verify (ToS §D.3 + verification_reflex).
  assert.match(AI_DISCLOSURE_TEXT, /틀릴 수 있으니/, "must warn outputs can be wrong");
  assert.match(AI_DISCLOSURE_TEXT, /확인해요/, "must nudge the kid to verify");
}

// ─── Session start: first webview ready shows it exactly once ────────────────
{
  const gate = new AiDisclosureGate();
  assert.equal(gate.noticeForReady(), AI_DISCLOSURE_TEXT, "first mount of a session discloses");
  // Hide/show remounts within the same session: webview fires "ready" again,
  // but the gate stays silent — no repeated banner spam mid-session.
  assert.equal(gate.noticeForReady(), null, "remount #1 stays silent");
  assert.equal(gate.noticeForReady(), null, "remount #2 stays silent");
}

// ─── History clear = new session → disclose again, then silent again ─────────
{
  const gate = new AiDisclosureGate();
  assert.equal(gate.noticeForReady(), AI_DISCLOSURE_TEXT);

  // Clear: caller posts the returned text immediately (webview is mounted).
  assert.equal(gate.noticeForHistoryClear(), AI_DISCLOSURE_TEXT, "clear starts a new session");

  // The new session is now considered disclosed — remounts stay silent until
  // the next clear (or a fresh extension-host run, which is a fresh gate).
  assert.equal(gate.noticeForReady(), null, "remount after clear stays silent");
  assert.equal(gate.noticeForHistoryClear(), AI_DISCLOSURE_TEXT, "every clear re-discloses");
}

// ─── Clear before any mount (edge): notice not double-queued ─────────────────
// clearHistory() can run via the command palette before the panel ever
// resolved. The clear itself returns the text (post() drops it while the view
// is unresolved), and the FIRST ready after that would be a fresh mount of an
// already-disclosed session… except the kid never saw it. Locking the current
// contract: clear marks the session disclosed, ready stays silent. The next
// real conversation start (next clear or next launch) discloses. This is the
// deliberate trade-off for zero double-banners; revisit if clear-before-mount
// becomes a real flow (it isn't in autoOnboard, which focuses the panel first).
{
  const gate = new AiDisclosureGate();
  assert.equal(gate.noticeForHistoryClear(), AI_DISCLOSURE_TEXT);
  assert.equal(gate.noticeForReady(), null);
}

console.log("✓ #320: AI disclosure — policy copy + once-per-session gate (ready/remount/clear)");
