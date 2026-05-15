// OpenAI ChatCompletion request → Anthropic Messages request.
//
// The profile (loaded by route handler from token.p) supplies the system
// prompt. We DO NOT honor any client-supplied "system" message — that would
// let a workshop participant override the persona / safety constraints.

import { MODEL_MAP, type Profile, type ModelAlias } from "../profiles/types.ts";

const DEFAULT_MAX_TOKENS = 4096;

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string }>;
}

interface OpenAIRequest {
  model?: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: Array<{ function?: { name?: string; description?: string; parameters?: unknown } }>;
}

interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string }>;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: unknown;
  cache_control?: { type: "ephemeral" };
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: AnthropicSystemBlock[];
  temperature?: number;
  tools?: AnthropicTool[];
  stream?: boolean;
}

/**
 * Per-user metadata that gets appended to the system block AFTER the cached
 * prefix. Keeps caching effective while letting each kid have their own coach.
 */
export interface CoachContext {
  name?: string;
  personality?: string;
}

export function translate(
  body: OpenAIRequest,
  profile: Profile,
  coach: CoachContext = {},
): AnthropicRequest {
  if (!Array.isArray(body.messages)) {
    throw new Error("messages must be an array");
  }

  const msgs: AnthropicMessage[] = [];
  for (const m of body.messages) {
    if (m.role === "system" || m.role === "tool") continue;          // server-side system only
    if (m.role !== "user" && m.role !== "assistant") continue;
    const content = typeof m.content === "string" ? m.content : (m.content ?? "");
    msgs.push({ role: m.role, content });
  }

  const model = MODEL_MAP[resolveAlias(body.model, profile)];

  // System block: cached prefix + non-cached per-user coach tail.
  const systemBlocks: AnthropicSystemBlock[] = [
    { type: "text", text: profile.system_prompt, cache_control: { type: "ephemeral" } },
  ];
  const coachTail = buildCoachTail(coach);
  if (coachTail) {
    systemBlocks.push({ type: "text", text: coachTail });
  }

  const out: AnthropicRequest = {
    model,
    messages: msgs,
    max_tokens: clampInt(body.max_tokens, 1, 16384, DEFAULT_MAX_TOKENS),
    system: systemBlocks,
  };

  if (typeof body.temperature === "number") {
    out.temperature = body.temperature;
  }

  if (body.stream === true) {
    out.stream = true;
  }

  if (Array.isArray(body.tools) && body.tools.length > 0 && profile.sandbox.mcp_tools_enabled.length > 0) {
    // Tools are passed through only if the profile permits MCP tools at all.
    // For 1회차 (chat-only) mcp_tools_enabled is [], so tools are dropped.
    const tools: AnthropicTool[] = [];
    for (let i = 0; i < body.tools.length; i++) {
      const fn = body.tools[i]?.function;
      if (!fn?.name) continue;
      if (!profile.sandbox.mcp_tools_enabled.includes(fn.name)) continue;
      tools.push({
        name: fn.name,
        description: fn.description ?? "",
        input_schema: fn.parameters ?? { type: "object" },
      });
    }
    if (tools.length > 0) {
      tools[tools.length - 1]!.cache_control = { type: "ephemeral" };
      out.tools = tools;
    }
  }

  return out;
}

function buildCoachTail(coach: CoachContext): string | null {
  const name = (coach.name ?? "").trim();
  const personality = (coach.personality ?? "").trim();
  if (!name && !personality) return null;
  const parts: string[] = ["# 사용자의 코치 설정"];
  if (name) {
    parts.push(`이 자녀는 당신을 **'${sanitizeForPrompt(name)}'**라고 부릅니다. 응답할 때 자신을 그렇게 칭하세요.`);
  }
  if (personality) {
    parts.push(`자녀가 적은 당신의 성격: "${sanitizeForPrompt(personality)}". 이 톤을 매 응답에 자연스럽게 반영하세요.`);
  }
  parts.push("이름과 성격은 자녀가 직접 정한 것입니다. 안전·코드품질·교육원칙은 base system prompt가 항상 우선합니다.");
  return parts.join("\n");
}

// Trim and remove characters that could break out of the system block.
function sanitizeForPrompt(s: string): string {
  return s.replace(/[\r\n]+/g, " ").replace(/["'`]/g, "").slice(0, 200);
}

function resolveAlias(requested: string | undefined, profile: Profile): ModelAlias {
  // Client may request an alias; profile sets the default. The profile wins
  // unless the client picked a profile-listed fallback.
  if (requested === profile.model.default) return profile.model.default;
  if (profile.model.fallback && requested === profile.model.fallback) return profile.model.fallback;
  return profile.model.default;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

// SSE event translation: Anthropic stream event → OpenAI chunk JSON.
// Returns null for events that should not be forwarded (e.g. ping, start).
export function anthropicEventToOpenAIChunk(event: unknown, model: string): string | null {
  if (!event || typeof event !== "object") return null;
  const e = event as { type?: string; delta?: { text?: string; type?: string }; usage?: unknown };
  if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && typeof e.delta.text === "string") {
    return JSON.stringify({
      id: "chatcmpl-hps",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { content: e.delta.text }, finish_reason: null }],
    });
  }
  if (e.type === "message_stop") {
    return JSON.stringify({
      id: "chatcmpl-hps",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
  }
  return null;
}
