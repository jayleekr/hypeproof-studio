// Smoke tests for the #371 agent.md handoff extractor. Pure — no vscode.
// Run: node --experimental-strip-types test/agent-handoff.smoke.mjs

import assert from "node:assert/strict";

const { extractAgentMd } = await import("../src/agentHandoff.ts");

// ─── happy path: fenced handoff extracted, trailing newline normalized ───────
{
  const text =
    "네! 인수인계 문서 만들었어요.\n\n```agent-md\n# agent.md — 정담치과\n\n## 남은 일\n- 후기 섹션\n```\n\n파일이 안 보이면 복사해 저장하세요.";
  const md = extractAgentMd(text);
  assert.ok(md, "fence extracted");
  assert.ok(md.startsWith("# agent.md — 정담치과"), "body starts at content");
  assert.ok(md.endsWith("- 후기 섹션\n"), "single trailing newline");
  assert.ok(!md.includes("```"), "no fence markers in the saved body");
}

// ─── truncated stream: missing closing fence still saves what exists ─────────
{
  const md = extractAgentMd("```agent-md\n# agent.md\n## 개요\n병원: 정담치과");
  assert.ok(md && md.includes("병원: 정담치과"), "truncated fence body preserved");
}

// ─── non-matches: absent fence, other languages, empty body ─────────────────
{
  assert.equal(extractAgentMd("그냥 답변이에요"), null);
  assert.equal(extractAgentMd("```html\n<html></html>\n```"), null, "html fence ignored");
  assert.equal(extractAgentMd("```agent-md\n\n```"), null, "empty body → null");
  assert.equal(extractAgentMd(""), null);
  // @ts-ignore — defensive input
  assert.equal(extractAgentMd(undefined), null);
}

// ─── html + agent-md in one reply: only the agent-md body is returned ────────
{
  const text = "```html\n<html><body>x</body></html>\n```\n설명\n```agent-md\n# agent.md\n내용\n```";
  const md = extractAgentMd(text);
  assert.ok(md && !md.includes("<html>"), "html fence not captured");
  assert.ok(md.includes("내용"));
}

console.log("All agent-handoff smoke tests passed.");
