// OpenAI ChatCompletion request → Anthropic Messages request.
//
// The profile (loaded by route handler from token.p) supplies the system
// prompt. We DO NOT honor any client-supplied "system" message — that would
// let a workshop participant override the persona / safety constraints.

import { modelIdFor, type Profile, type ModelAlias } from "../profiles/types.ts";
import type { LLMProvider } from "../env.ts";
import { getSkeletonsForTier } from "../skeletons/index.ts";

// A polished single-file game (gradient bg, 3 states, score, juice) plus the
// coach's friendly intro runs ~3-6k output tokens. 4096 truncated games
// mid-code → broken (unclosed fence). 8192 leaves comfortable headroom.
const DEFAULT_MAX_TOKENS = 8192;

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

/** OpenAI-compatible request (Gemini's `/v1beta/openai/chat/completions`). */
export interface OpenAIChatRequest {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  max_tokens: number;
  temperature?: number;
  stream?: boolean;
  stream_options?: { include_usage: true };
  tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }>;
}

/**
 * Filter the client's messages down to the conversation turns we trust.
 * Client-supplied `system`/`tool` messages are dropped — only the worker
 * supplies the system prompt (anti-injection: identical for both providers).
 */
function filterMessages(body: OpenAIRequest): Array<{ role: "user" | "assistant"; content: string }> {
  if (!Array.isArray(body.messages)) {
    throw new Error("messages must be an array");
  }
  const msgs: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of body.messages) {
    if (m.role === "system" || m.role === "tool") continue;          // server-side system only
    if (m.role !== "user" && m.role !== "assistant") continue;
    const content = typeof m.content === "string" ? m.content : (m.content ?? "");
    msgs.push({ role: m.role, content: String(content) });
  }
  return msgs;
}

/**
 * The cached/static system prefix = profile system prompt + the tier's
 * skeleton library. Identical text for every user in a cohort.
 */
function buildCachedPrefix(profile: Profile): string {
  return profile.system_prompt + "\n\n" + buildSkeletonLibrary(profile);
}

export function translate(
  body: OpenAIRequest,
  profile: Profile,
  coach: CoachContext = {},
): AnthropicRequest {
  const msgs: AnthropicMessage[] = filterMessages(body);

  const model = modelIdFor(resolveAlias(body.model, profile), "anthropic");

  // System block: cached prefix + non-cached per-user coach tail.
  // Cached prefix = system prompt + the tier's skeleton library. Static per
  // cohort → high cache hit rate. Per-user coach tail stays uncached after.
  const systemBlocks: AnthropicSystemBlock[] = [
    { type: "text", text: buildCachedPrefix(profile), cache_control: { type: "ephemeral" } },
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

/**
 * OpenAI → Gemini (OpenAI-compatible endpoint). Same trust model as
 * translate(): client system/tool messages dropped, the worker supplies the
 * system prompt. Gemini has no prompt-cache concept, so prefix + coach tail
 * collapse into a single leading `system` message.
 */
export function translateOpenAI(
  body: OpenAIRequest,
  profile: Profile,
  coach: CoachContext = {},
  provider: LLMProvider = "gemini",
): OpenAIChatRequest {
  const turns = filterMessages(body);

  let systemText = buildCachedPrefix(profile);
  const coachTail = buildCoachTail(coach);
  if (coachTail) systemText += "\n\n" + coachTail;

  const out: OpenAIChatRequest = {
    model: modelIdFor(resolveAlias(body.model, profile), provider),
    messages: [{ role: "system", content: systemText }, ...turns],
    max_tokens: clampInt(body.max_tokens, 1, 16384, DEFAULT_MAX_TOKENS),
  };

  if (typeof body.temperature === "number") {
    out.temperature = body.temperature;
  }
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };   // final chunk carries usage
  }

  if (Array.isArray(body.tools) && body.tools.length > 0 && profile.sandbox.mcp_tools_enabled.length > 0) {
    // Same gate as translate(): only profile-permitted tools pass through.
    // 1회차 has mcp_tools_enabled = [] so tools are dropped.
    const tools: OpenAIChatRequest["tools"] = [];
    for (let i = 0; i < body.tools.length; i++) {
      const fn = body.tools[i]?.function;
      if (!fn?.name) continue;
      if (!profile.sandbox.mcp_tools_enabled.includes(fn.name)) continue;
      tools.push({
        type: "function",
        function: {
          name: fn.name,
          description: fn.description ?? "",
          parameters: fn.parameters ?? { type: "object" },
        },
      });
    }
    if (tools.length > 0) out.tools = tools;
  }

  return out;
}

/**
 * The skeleton library for this profile's tier, embedded in the cached system
 * prompt. The model MUST start from one of these, not invent structure.
 */
function buildSkeletonLibrary(profile: Profile): string {
  const tier = profile.game?.template_tier ?? "kids-basic";
  const skels = getSkeletonsForTier(tier);
  if (skels.length === 0) return "";

  const parts: string[] = [
    "# 게임 스켈레톤 라이브러리 (반드시 사용)",
    "",
    "아래는 완성도 검증이 끝난 게임 템플릿입니다. **새 게임을 처음부터 쓰지 마세요.**",
    "자녀 요청에 가장 가까운 스켈레톤 1개를 고르고, `%%...%%` 자리표시자만 자녀 요청대로 채우세요:",
    "- `%%TITLE%%` 게임 제목 (자녀 테마)",
    "- `%%PLAYER_EMOJI%%` 등 이모지 → 자녀가 원하는 캐릭터로",
    "- `%%BG_TOP%%`/`%%BG_BOT%%` → 테마에 맞는 그라데이션 색 (예: 우주 #0b0b2a/#241b4a)",
    "- `// %%CUSTOMIZE%%` 주석 부분만 살짝 변형 가능. **구조·게임루프·하단 조작바(`#controls`)는 절대 건드리지 마세요.**",
    "",
    "출력 규칙: 고른 스켈레톤 전체를 자리표시자 채운 **완전한 단일 HTML**로. 자리표시자(`%%`)가 남아있으면 안 됩니다.",
    "수정 요청이면 직전 게임(이미 채워진 스켈레톤)을 통째로 다시 출력하며 그 변경만 반영.",
    "조작법은 이미 화면 하단 바에 항상 표시됩니다 — 그 바를 유지하고, 규칙을 바꾸면 바 문구도 같이 갱신하세요.",
    "",
  ];
  for (const s of skels) {
    parts.push(`## 스켈레톤: ${s.id} — ${s.genre}`);
    parts.push(`용도: ${s.summary_ko}`);
    parts.push(`매칭 키워드: ${s.tags.join(", ")}`);
    parts.push("```html");
    parts.push(s.html.trim());
    parts.push("```");
    parts.push("");
  }
  return parts.join("\n");
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
