// Smoke tests for the browser control pure helpers (#278 Phase 3): URL
// whitelist (security), AX-snapshot ref assignment, click-point math.
// vscode-free. Run:
//   node --experimental-strip-types test/browser-control-helpers.smoke.mjs

import assert from "node:assert/strict";

const { safeNavigateUrl, quadCenter, buildAxSnapshot } =
  await import("../src/browserControlHelpers.ts");

// ─── safeNavigateUrl (security boundary) ───
{
  assert.equal(safeNavigateUrl("https://example.com"), "https://example.com");
  assert.equal(safeNavigateUrl("http://a.b/c"), "http://a.b/c");
  assert.equal(safeNavigateUrl("file:///tmp/x.html"), "file:///tmp/x.html");
  assert.equal(safeNavigateUrl("localhost:5173/x"), "http://localhost:5173/x");
  assert.equal(safeNavigateUrl("127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(safeNavigateUrl("example.com/path"), "https://example.com/path"); // bare host → https
  // Disallowed schemes / shapes → null.
  assert.equal(safeNavigateUrl("javascript:alert(1)"), null);
  assert.equal(safeNavigateUrl("data:text/html,<b>x"), null);
  assert.equal(safeNavigateUrl("vscode://foo"), null);
  assert.equal(safeNavigateUrl("/etc/passwd"), null);
  assert.equal(safeNavigateUrl(""), null);
  assert.equal(safeNavigateUrl("   "), null);
  console.log("✓ safeNavigateUrl: http/https/file/localhost/bare-host allowed; js/data/vscode/paths rejected");
}

// ─── quadCenter ───
{
  // Unit square 0..10 → center 5,5.
  assert.deepEqual(quadCenter([0, 0, 10, 0, 10, 10, 0, 10]), { x: 5, y: 5 });
  assert.equal(quadCenter([1, 2, 3]), null, "short quad → null");
  assert.equal(quadCenter("nope"), null, "non-array → null");
  console.log("✓ quadCenter: averages the 4 corners; rejects malformed quads");
}

// ─── buildAxSnapshot ───
{
  const nodes = [
    { role: { value: "heading" }, name: { value: "가격 안내" }, backendDOMNodeId: 1 },
    { role: { value: "button" }, name: { value: "예약하기" }, backendDOMNodeId: 2 },
    { role: { value: "textbox" }, name: { value: "이름" }, backendDOMNodeId: 3 },
    { role: { value: "generic" }, name: { value: "" }, backendDOMNodeId: 4 }, // skipped (not interactive, no name)
    { role: { value: "link" }, name: { value: "오시는 길" }, backendDOMNodeId: 5, ignored: true }, // ignored
  ];
  const { text, refs } = buildAxSnapshot(nodes);
  // Interactive nodes get sequential refs mapped to their backendDOMNodeId.
  assert.equal(refs.get("e1"), 2, "first interactive (button) → e1 → backendId 2");
  assert.equal(refs.get("e2"), 3, "second interactive (textbox) → e2 → backendId 3");
  assert.equal(refs.size, 2, "only interactive, non-ignored nodes get refs");
  assert.ok(text.includes('[ref=e1] button "예약하기"'), "button rendered with ref + name");
  assert.ok(text.includes('[ref=e2] textbox "이름"'), "textbox rendered with ref + name");
  assert.ok(text.includes("heading: 가격 안내"), "heading rendered as text context (no ref)");
  assert.ok(!text.includes("오시는 길"), "ignored node excluded");

  // Empty / no interactive → friendly placeholder.
  const empty = buildAxSnapshot([]);
  assert.equal(empty.refs.size, 0);
  assert.ok(empty.text.includes("찾지 못했"), "empty snapshot has a placeholder");
  console.log("✓ buildAxSnapshot: interactive→[ref=eN]+backendId map, text context, ignored excluded");
}

console.log("All browser-control-helpers smoke tests passed.");
