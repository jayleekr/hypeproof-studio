// Smoke tests for browserToolLogLine (#278 Phase 3) — the action-log line the
// chat panel shows as the coach drives the browser. vscode-free. Run:
//   node --experimental-strip-types test/browser-tool-log.smoke.mjs

import assert from "node:assert/strict";

const { browserToolLogLine } = await import("../src/chatPanelHelpers.ts");

{
  assert.deepEqual(browserToolLogLine("browser_navigate", { url: "https://example.com/pricing" }), {
    icon: "🔗",
    label: "example.com 로 이동",
  });
  // bare host + localhost with port → host extracted (scheme prepended internally).
  assert.deepEqual(browserToolLogLine("browser_navigate", { url: "localhost:5173/x" }), {
    icon: "🔗",
    label: "localhost:5173 로 이동",
  });
  assert.deepEqual(browserToolLogLine("browser_read", {}), { icon: "👀", label: "페이지 읽는 중" });
  assert.deepEqual(browserToolLogLine("browser_screenshot", {}), { icon: "📸", label: "화면 캡처" });
  assert.deepEqual(browserToolLogLine("browser_click", { ref: "e3" }), { icon: "👆", label: "e3 클릭" });
  assert.equal(
    browserToolLogLine("browser_type", { text: "임플란트 가격" }).label,
    '입력: "임플란트 가격"',
  );
  assert.deepEqual(browserToolLogLine("browser_back", {}), { icon: "◀", label: "뒤로" });
  assert.deepEqual(browserToolLogLine("browser_forward", {}), { icon: "▶", label: "앞으로" });
  assert.equal(browserToolLogLine("browser_dialog", { action: "accept" }).label, "대화상자 accept");

  // Long input truncated with an ellipsis.
  const long = browserToolLogLine("browser_type", { text: "가".repeat(50) });
  assert.ok(long.label.includes("…"), "long text truncated");

  // Unknown tool → generic.
  assert.deepEqual(browserToolLogLine("weird_tool", {}), { icon: "🤖", label: "weird_tool" });
  console.log("✓ browserToolLogLine: per-tool icon+label, host extraction, truncation, unknown fallback");
}

console.log("All browser-tool-log smoke tests passed.");
