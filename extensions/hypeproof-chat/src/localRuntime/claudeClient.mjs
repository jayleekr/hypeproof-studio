import { execFileSync } from "node:child_process";
import { jsonProcess, subscriptionEnv } from "./process.mjs";

export function claudeStatus(executable = "claude") {
  let status;
  try {
    status = JSON.parse(
      execFileSync(executable, ["auth", "status"], {
        env: subscriptionEnv(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
      }),
    );
  } catch {
    throw Error(
      "Claude Code를 설치하고 터미널에서 claude auth login을 실행하세요.",
    );
  }
  if (!status.loggedIn || status.authMethod !== "claude.ai")
    throw Error("Claude Code의 로컬 구독 로그인이 필요합니다.");
  return {
    provider: "claude",
    model: "sonnet",
    label: "Claude Code · 로컬 구독",
  };
}

export async function runClaude({
  executable = "claude",
  cwd,
  model = "sonnet",
  messages,
  signal,
  onDelta,
  toolServer,
}) {
  claudeStatus(executable);
  const config = {
    mcpServers: {
      studio: {
        type: "http",
        url: toolServer.url,
        headers: { Authorization: "Bearer " + toolServer.token },
      },
    },
  };
  let streamed = false;
  const result = await jsonProcess(
    executable,
    [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--no-session-persistence",
      "--model",
      model,
      "--effort",
      "low",
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify(config),
      "--allowedTools",
      "mcp__studio__*",
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "",
      "--settings",
      JSON.stringify({ disableAllHooks: true }),
      "--no-chrome",
      "--system-prompt",
      messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n"),
    ],
    {
      cwd,
      input: JSON.stringify(messages.filter((m) => m.role !== "system")),
      signal,
      onEvent: (event) => {
        const delta =
          event.type === "stream_event" &&
          event.event?.type === "content_block_delta" &&
          event.event.delta?.type === "text_delta"
            ? event.event.delta.text
            : undefined;
        if (delta) {
          streamed = true;
          onDelta(delta);
        }
      },
    },
  );
  if (!result || result.is_error || result.subtype !== "success")
    throw Error(
      "Claude Code가 요청을 완료하지 못했습니다. 로그인·구독 한도와 도구 승인 상태를 확인하세요.",
    );
  if (!streamed && result.result) onDelta(result.result);
  return { model, usage: result.usage ?? null };
}
