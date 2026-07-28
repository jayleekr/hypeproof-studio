// #371 — agent.md handoff auto-save.
//
// The copyclone system prompt tells the coach to emit the handoff document
// inside a single ```agent-md fenced block. The host detects that fence at
// stream completion and writes workspace/agent.md (same sanctioned
// workspace-write pattern as index.html auto-save, REQ-D5) so a participant
// who runs out of time still walks away with a usable handoff file.
//
// Pure + vscode-free so it is Node-unit-testable; the actual fs write lives
// in chatPanelProvider (extension-pure-orchestration-split).

/**
 * Extract the body of the first ```agent-md fence, or null when absent/empty.
 * Tolerates a missing closing fence (stream truncation): everything to EOF
 * then counts, so a truncated handoff still saves what exists.
 *
 * NESTED FENCES (#431 실측). The old regex was non-greedy to the first ```,
 * so any code block INSIDE the handoff truncated it. A real run produced a
 * handoff that ended mid-document at `## 확정된 디자인 시스템` — the `:root {…}`
 * CSS block that followed opened a nested fence and the extraction stopped
 * there. 큐시트 결과물 4번(다른 컴퓨터로 이어가는 문서)이 통째로 반쪽이 됐다.
 *
 * A handoff naturally contains code — color tokens, a file tree, a snippet —
 * so nesting is the normal case, not an edge case. Walk lines and track depth:
 * a fence line WITH an info string (```css) opens a nested block; a bare ```
 * closes the innermost one, and at depth 0 it closes the handoff itself.
 */
export function extractAgentMd(text: string): string | null {
  if (typeof text !== "string") return null;
  const lines = text.split("\n");
  const openIdx = lines.findIndex((l) => /^\s*```agent-md\b/.test(l));
  if (openIdx === -1) return null;

  const body: string[] = [];
  let depth = 0;
  for (let i = openIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const info = fence[1].trim();
      if (info.length > 0) {
        depth++;            // ```css — nested block opens
      } else if (depth > 0) {
        depth--;            // bare ``` — nested block closes
      } else {
        break;              // bare ``` at depth 0 — the handoff ends here
      }
    }
    body.push(line);
  }

  const out = body.join("\n").trim();
  return out.length > 0 ? out + "\n" : null;
}
