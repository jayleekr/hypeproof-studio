import type { ResolvedProfile } from "../protocol";
import type { CoachToolAction, SdkActivity } from "../sdkCoachHelpers.ts";
import { workspaceTools } from "./tools.ts";
import {
  CHALK_TOOL_DEFINITIONS,
  callChalkTool,
  type ChalkToolContext,
} from "../chalk/tools.ts";
import { CodexLocalClient } from "./codexClient.mjs";
import { runClaude } from "./claudeClient.mjs";
import { startToolServer } from "./toolServer.mjs";

export interface LocalRuntimeConfig {
  provider: "claude" | "codex";
  executable: string;
  model: string;
  label: string;
}
export function localRuntimeConfig(
  appName: string,
  proxyUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): LocalRuntimeConfig | null {
  if (appName !== "HypeProof Studio Dev" || env.HPS_DEV_RUNTIME !== "1")
    return null;
  const provider = env.HPS_DEV_PROVIDER;
  if (provider !== "claude" && provider !== "codex") return null;
  const u = new URL(proxyUrl);
  if (
    u.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
    u.username ||
    u.password
  )
    throw Error("로컬 구독 개발 모드는 로컬 수업 서버에서만 사용합니다.");
  const executable = env.HPS_DEV_EXECUTABLE;
  const model = env.HPS_DEV_MODEL;
  if (!executable?.startsWith("/") || !model)
    throw Error("개발 실행기로 CLI 설치·로그인을 먼저 확인하세요.");
  return {
    provider,
    executable,
    model,
    label:
      (provider === "claude" ? "Claude Code" : "Codex") +
      " · 로컬 구독 · " +
      model,
  };
}
export function localModelSelection(
  config: LocalRuntimeConfig,
): NonNullable<ResolvedProfile["model_selection"]> {
  return {
    revision: "hps-model-selection/1",
    runtime: "proxy",
    provider: config.provider,
    default: config.model,
    source: "profile",
    choices: [{ alias: config.model, id: config.model, label: config.label }],
  };
}
export async function runLocalCoach(args: {
  config: LocalRuntimeConfig;
  profile: ResolvedProfile;
  cwd: string;
  history: Array<{ role: string; content: string }>;
  userText: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onActivity?: (a: SdkActivity) => void;
  requestApproval: (
    a: CoachToolAction,
  ) => Promise<boolean | { approved: boolean; actor: "user" | "policy" }>;
  /** 강사 모드일 때만 넘긴다. 없으면 Chalk 도구를 AI 에 붙이지 않는다(SUB-06). */
  chalkCtx?: ChalkToolContext;
}) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([
    args.signal,
    lifetime.signal,
    AbortSignal.timeout(180000),
  ]);
  const workTools = workspaceTools({
    cwd: args.cwd,
    profile: args.profile,
    signal,
    approve: args.requestApproval,
    activity: args.onActivity,
  });

  // Chalk 도구는 강사 모드(chalkCtx 있음)에서만 붙는다(SUB-06).
  const chalkDefs = args.chalkCtx ? CHALK_TOOL_DEFINITIONS : [];
  const tools = {
    definitions: [...workTools.definitions, ...chalkDefs],
    call: async (name: string, input: unknown) => {
      if (args.chalkCtx && CHALK_TOOL_DEFINITIONS.some((d) => d.name === name)) {
        return callChalkTool(args.chalkCtx, name, input as Record<string, unknown>);
      }
      return workTools.call(name, input);
    },
  };
  const system =
    "You are the coach in a LOCAL DEVELOPMENT rehearsal of HypeProof Studio. Reply in Korean. Follow the supplied course. Only provided Studio file tools are available; do not claim shell, browser or deployment actions. Read existing files before changing them; preserve unrelated work. Never treat sample results as real customers.\n" +
    JSON.stringify({
      lesson: args.profile.lesson?.content ?? null,
      welcome: args.profile.welcome,
      assets: args.profile.assets_focus ?? [],
    });
  const messages = [
    { role: "system", content: system },
    ...args.history.filter((m) => m.role === "user" || m.role === "assistant"),
    { role: "user", content: args.userText },
  ];
  try {
    if (args.config.provider === "claude") {
      const server = await startToolServer(
        tools.definitions,
        tools.call,
        signal,
      );
      try {
        return await runClaude({
          executable: args.config.executable,
          model: args.config.model,
          cwd: args.cwd,
          messages,
          signal,
          onDelta: args.onDelta,
          toolServer: server,
        });
      } finally {
        server.close();
      }
    }
    const client = new CodexLocalClient({ executable: args.config.executable });
    try {
      await client.connect();
      return await client.complete({
        model: args.config.model,
        messages,
        signal,
        onDelta: args.onDelta,
        maxOutputBytes: 200000,
        tools: tools.definitions,
        onToolCall: tools.call,
      });
    } finally {
      client.close();
    }
  } finally {
    lifetime.abort();
  }
}
