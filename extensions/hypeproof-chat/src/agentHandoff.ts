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
 */
export function extractAgentMd(text: string): string | null {
  if (typeof text !== "string") return null;
  const m = /```agent-md[^\n]*\n([\s\S]*?)(?:```|$)/.exec(text);
  if (!m) return null;
  const body = m[1].trim();
  return body.length > 0 ? body + "\n" : null;
}
