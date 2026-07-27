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

// #431 실측 회귀 — 중첩 코드펜스가 인계 문서를 자르던 버그.
// 실제 런에서 코치가 색 토큰 CSS 와 파일 트리를 담은 agent.md 를 냈는데,
// 저장된 파일이 `## 확정된 디자인 시스템` 헤더에서 끊겼다. 인계 문서에 코드가
// 들어가는 건 정상이지 예외가 아니다 — 색 토큰·파일 구조·스니펫은 다음 AI 가
// 이어받는 데 꼭 필요한 재료다.
{
  const text = [
    "인계 문서 만들었어요.",
    "```agent-md",
    "# 인계 문서",
    "## 병원 정보",
    "병원명: 정담치과",
    "",
    "## 확정된 디자인 시스템",
    "```css",
    ":root { --gold: #b8965a; }",
    "```",
    "",
    "## 파일 구조",
    "```text",
    "index.html",
    "context.md",
    "```",
    "",
    "## 남은 일",
    "- V1 만들기",
    "```",
    "파일이 안 보이면 위 내용을 복사해 agent.md 로 저장하세요.",
  ].join("\n");

  const md = extractAgentMd(text);
  assert.ok(md, "중첩 펜스가 있어도 추출된다");
  assert.ok(md.includes("## 병원 정보"), "앞부분");
  assert.ok(md.includes("--gold: #b8965a"), "중첩 CSS 블록 내용이 살아 있다");
  assert.ok(md.includes("index.html"), "중첩 text 블록 내용이 살아 있다");
  assert.ok(md.includes("## 남은 일"), "중첩 블록 뒤의 섹션까지 도달한다");
  assert.ok(md.includes("- V1 만들기"), "마지막 항목");
  assert.ok(!md.includes("파일이 안 보이면"), "닫는 펜스 뒤 산문은 안 들어간다");
  console.log("✓ #431: 중첩 코드펜스가 있는 인계 문서가 온전히 추출된다");
}

// 닫는 펜스가 없는 스트림 절단은 기존대로 EOF 까지 건진다.
{
  const md = extractAgentMd("```agent-md\n# 문서\n## 섹션\n```css\n:root{}\n```\n## 뒷부분");
  assert.ok(md.includes("## 뒷부분"), "닫는 펜스 없어도 EOF 까지");
  console.log("✓ 닫는 펜스 없는 절단도 건진다");
}
