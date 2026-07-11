// OpenAI ChatCompletion request → Anthropic Messages request.
//
// The profile (loaded by route handler from token.p) supplies the system
// prompt. We DO NOT honor any client-supplied "system" message — that would
// let a workshop participant override the persona / safety constraints.

import { modelIdFor, type Profile, type ModelAlias } from "../profiles/types.ts";
import type { LLMProvider } from "../env.ts";
import { getSkeletonsForTier } from "../skeletons/index.ts";
// @ts-ignore — string import enabled via wrangler rules in wrangler.toml
import previewEnvContractMd from "../prompts/_preview-env-contract.md";
// @ts-ignore — string import enabled via wrangler rules in wrangler.toml
import previewEnvContractLiveServerMd from "../prompts/_preview-env-contract-live-server.md";
import { resolveSkills } from "../skills/index.ts";

// A polished single-file game (gradient bg, 3 states, score, juice) plus the
// coach's friendly intro runs ~3-6k output tokens. 4096 truncated games
// mid-code → broken (unclosed fence). 8192 leaves comfortable headroom.
const DEFAULT_MAX_TOKENS = 8192;

// OpenAI multimodal content block. `text` blocks carry prose; `image_url`
// blocks carry a data URL (pasted screenshot) or http(s) URL — the
// website-copyclone curriculum injects a target screenshot this way.
interface OpenAIContentBlock {
  type: string;                  // "text" | "image_url"
  text?: string;
  image_url?: { url: string };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentBlock[];
}

// A trusted conversation turn after filterMessages: same shape as an
// OpenAI user/assistant message (string or sanitized content blocks).
type Turn = { role: "user" | "assistant"; content: string | OpenAIContentBlock[] };

// Hard caps on inbound images — defense-in-depth against a client (or a
// compromised webview) sending huge or many image blocks. Anthropic's own
// per-image limit is ~5MB of base64; we cap a bit under that and bound the
// count so one turn can't blow the request size / token budget.
const MAX_IMAGES_PER_TURN = 4;
const MAX_IMAGE_DATAURL_CHARS = 6_500_000;   // base64 chars → ~4.8MB decoded, under Anthropic's ~5MB/image cap
const ALLOWED_IMAGE_URL = /^(data:image\/(png|jpe?g|gif|webp);base64,|https?:\/\/)/i;

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

// Anthropic content blocks. Image source is either inline base64 (from a
// pasted data URL) or a remote URL — both are accepted by the Messages API.
interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

// Function tools = MCP-passthrough (profile.sandbox.mcp_tools_enabled).
interface AnthropicFunctionTool {
  name: string;
  description: string;
  input_schema: unknown;
  cache_control?: { type: "ephemeral" };
}

// Server-hosted builtin tools (#168 M2). Anthropic runs these on its end —
// no schema, just a type tag + optional cap. Currently: web_search.
interface AnthropicBuiltinTool {
  type: "web_search_20250305";
  name: "web_search";
  max_uses?: number;
}

type AnthropicTool = AnthropicFunctionTool | AnthropicBuiltinTool;

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
  messages: Array<{ role: "system" | "user" | "assistant"; content: string | OpenAIContentBlock[] }>;
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
 *
 * Content is preserved as either a plain string OR sanitized OpenAI content
 * blocks (text + image_url). A turn that carries no image collapses back to
 * a string so text-only turns stay byte-identical to the old behavior (and
 * caching/snapshots don't churn). Image blocks survive — that is the fix for
 * the website-copyclone screenshot-injection path, which the old
 * `String(content)` coercion silently destroyed.
 */
function filterMessages(body: OpenAIRequest, allowImages: boolean): Turn[] {
  if (!Array.isArray(body.messages)) {
    throw new Error("messages must be an array");
  }
  const msgs: Turn[] = [];
  for (const m of body.messages) {
    if (m.role === "system" || m.role === "tool") continue;          // server-side system only
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (typeof m.content === "string") {
      msgs.push({ role: m.role, content: m.content });
      continue;
    }
    if (Array.isArray(m.content)) {
      const blocks = sanitizeContentBlocks(m.content, allowImages);
      // No surviving image → collapse to a string (preserve legacy shape).
      const hasImage = blocks.some((b) => b.type === "image_url");
      if (!hasImage) {
        const text = blocks.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("");
        msgs.push({ role: m.role, content: text });
      } else {
        msgs.push({ role: m.role, content: blocks });
      }
      continue;
    }
    msgs.push({ role: m.role, content: "" });
  }
  return msgs;
}

/**
 * Keep only the content blocks we trust: `text` and `image_url` whose URL is a
 * supported image data URL or an http(s) URL. Caps image count + size. Unknown
 * block types and unsupported URL schemes (file:, javascript:, vscode:, …) are
 * dropped — defense-in-depth against a hostile/buggy client.
 *
 * When `allowImages` is false (the profile didn't opt into `input.image_paste`)
 * ALL image blocks are dropped server-side, even if the client sent them — a
 * text-only cohort (e.g. a minor cohort) can't be coerced into an image flow.
 */
function sanitizeContentBlocks(blocks: OpenAIContentBlock[], allowImages: boolean): OpenAIContentBlock[] {
  const out: OpenAIContentBlock[] = [];
  let images = 0;
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") {
      out.push({ type: "text", text: b.text });
    } else if (allowImages && b.type === "image_url" && b.image_url && typeof b.image_url.url === "string") {
      const url = b.image_url.url;
      if (images >= MAX_IMAGES_PER_TURN) continue;
      if (url.length > MAX_IMAGE_DATAURL_CHARS) continue;
      if (!ALLOWED_IMAGE_URL.test(url)) continue;
      out.push({ type: "image_url", image_url: { url } });
      images++;
    }
  }
  return out;
}

/** Map a sanitized OpenAI turn's content into Anthropic content. */
function toAnthropicContent(content: string | OpenAIContentBlock[]): string | AnthropicContentBlock[] {
  if (typeof content === "string") return content;
  const out: AnthropicContentBlock[] = [];
  for (const b of content) {
    if (b.type === "text" && typeof b.text === "string") {
      out.push({ type: "text", text: b.text });
    } else if (b.type === "image_url" && b.image_url?.url) {
      const img = imageUrlToAnthropicImage(b.image_url.url);
      if (img) out.push(img);
    }
  }
  // An all-dropped array would be an invalid empty content — fall back to "".
  return out.length > 0 ? out : "";
}

/**
 * OpenAI `image_url` → Anthropic image block. Inline data URLs become base64
 * sources; http(s) URLs become url sources. Anything else returns null (the
 * caller drops it). Mirrors the ALLOWED_IMAGE_URL allowlist.
 */
function imageUrlToAnthropicImage(url: string): AnthropicImageBlock | null {
  const dataUrl = /^data:([^;,]+);base64,(.+)$/.exec(url);
  if (dataUrl && dataUrl[1] && dataUrl[2]) {
    return { type: "image", source: { type: "base64", media_type: dataUrl[1], data: dataUrl[2] } };
  }
  if (/^https?:\/\//i.test(url)) {
    return { type: "image", source: { type: "url", url } };
  }
  return null;
}

/**
 * The cached/static system prefix = profile system prompt + preview-env
 * contract + bundled skills (#168 M1) + the tier's skeleton library. Identical
 * text for every user in a cohort, so prompt caching kicks in across the
 * workshop.
 *
 * Order is deliberate:
 *  1. system_prompt — cohort tone / coaching behavior
 *  2. preview-env contract — technical invariants of the Studio iframe
 *     (sandbox + inherited CSP). Same for every cohort, so live in one file
 *     and injected here, not duplicated in every prompts/<cohort>.md.
 *  3. skills — behavioral how-to (e.g., how to coach)
 *  4. skeleton library — raw HTML templates the behavior fills in
 */
function buildCachedPrefix(profile: Profile): string {
  const skillsMd = resolveSkills(profile.skills);
  // #278 Phase 1 — live_server cohorts get a relaxed contract: a real
  // http://127.0.0.1 origin (native browser), so multi-file / relative paths /
  // same-origin fetch / storage / navigation are all allowed. The default
  // iframe contract (single-file, no external, base64-inline) would fight a
  // multi-file homepage.
  const previewContract =
    profile.preview?.type === "live_server"
      ? (previewEnvContractLiveServerMd as unknown as string)
      : (previewEnvContractMd as unknown as string);
  const sections = [
    profile.system_prompt,
    previewContract,
    skillsMd,
    buildSkeletonLibrary(profile),
  ].filter((s) => s && s.length > 0);
  return sections.join("\n\n");
}

export function translate(
  body: OpenAIRequest,
  profile: Profile,
  coach: CoachContext = {},
): AnthropicRequest {
  const msgs: AnthropicMessage[] = filterMessages(body, profile.input?.image_paste === true).map((t) => ({
    role: t.role,
    content: toAnthropicContent(t.content),
  }));

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

  // Assemble outbound tools array from two sources:
  // 1. Anthropic-hosted builtin tools the profile opts into (#168 M2) —
  //    e.g. web_search. Static per cohort, so safe to cache.
  // 2. Client-supplied function tools, intersected with the profile's
  //    mcp_tools_enabled allowlist.
  const tools: AnthropicTool[] = [];

  if (profile.tools?.web_search === true) {
    const maxUses = profile.tools.max_uses ?? 5;
    tools.push({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: maxUses,
    });
  }

  if (Array.isArray(body.tools) && body.tools.length > 0 && profile.sandbox.mcp_tools_enabled.length > 0) {
    // Function tools are passed through only if the profile permits MCP tools.
    // For 1회차 (chat-only) mcp_tools_enabled is [], so function tools are dropped.
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
  }

  if (tools.length > 0) {
    // cache_control goes on the LAST function tool only (builtin tools don't
    // support cache_control per Anthropic). If the only tool is a builtin,
    // skip the marker — Anthropic caches the entire tools block by default
    // when no marker is present and the block is static.
    const last = tools[tools.length - 1];
    if (last && !("type" in last)) {
      last.cache_control = { type: "ephemeral" };
    }
    out.tools = tools;
  }

  return out;
}

/**
 * OpenAI → Gemini (OpenAI-compatible endpoint). Same trust model as
 * translate(): client system/tool messages dropped, the worker supplies the
 * system prompt. Gemini has no prompt-cache concept, so prefix + coach tail
 * collapse into a single leading `system` message.
 *
 * #168 M2 NOTE: `profile.tools.web_search` is intentionally ignored on this
 * path. Google's OpenAI-compatible endpoint does not expose the native
 * `googleSearch` grounding tool — that requires switching to the native
 * Gemini endpoint (`/v1beta/models/{model}:streamGenerateContent`) with a
 * different request shape and a different SSE format. Tracked as a follow-up
 * to this milestone. Prod runs LLM_PROVIDER=anthropic, so the boah-dental
 * workshop is served by the translate() path above.
 */
export function translateOpenAI(
  body: OpenAIRequest,
  profile: Profile,
  coach: CoachContext = {},
  provider: LLMProvider = "gemini",
): OpenAIChatRequest {
  const turns = filterMessages(body, profile.input?.image_paste === true);

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

  const isSearchWebapp = tier === "search-webapp";

  // Tier-conditional intro — game tiers vs search-webapp use different framing.
  // Mixing the game intro into a clinical workshop is what caused #141
  // ("게임을 만드는 중" leak in dental responses).
  const parts: string[] = isSearchWebapp
    ? [
        "# 검색 웹앱 스켈레톤 라이브러리 (반드시 사용)",
        "",
        "아래는 완성도 검증이 끝난 검색 웹앱 템플릿입니다. **새로 처음부터 쓰지 마세요.**",
        "참가자 워크숍 맥락에 가장 가까운 스켈레톤 1개를 고르고, `%%...%%` 자리표시자만 실제 값으로 채우세요:",
        "- `%%CLINIC_NAME%%` 병원/조직명",
        "- `%%SEARCH_TOPIC%%` 이번 V1이 검색하려는 주제 (한 줄)",
        "- `%%DECISION%%` 이 검색이 도와야 하는 결정 (한 줄)",
        "- `%%SOURCES%%` 결과 리스트 `<li>` 항목들. 각 항목에 trust badge(`good`/`warn`/`bad`).",
        "",
        "출력 규칙: 고른 스켈레톤 전체를 자리표시자 채운 **완전한 단일 HTML**로. 출력에 `%%` 문자가 단 하나도 남으면 안 됩니다.",
        "수정 요청이면 직전 V1(이미 채워진 스켈레톤)을 통째로 다시 출력하며 그 변경만 반영.",
        "절대 금지: `게임`, `점프`, `캐릭터`, `점수`, `장애물` 같은 게임 어휘를 응답·코드에 사용하지 마세요. 이 워크숍은 게임이 아니라 검색엔진 제작입니다.",
        "",
      ]
    : [
        "# 게임 스켈레톤 라이브러리 (반드시 사용)",
        "",
        "아래는 완성도 검증이 끝난 게임 템플릿입니다. **새 게임을 처음부터 쓰지 마세요.**",
        "자녀 요청에 가장 가까운 스켈레톤 1개를 고르고, `%%...%%` 자리표시자만 자녀 요청대로 채우세요:",
        "- `%%TITLE%%` 게임 제목 (자녀 테마)",
        "- `%%PLAYER_EMOJI%%` 등 이모지 → 자녀가 원하는 캐릭터로",
        "- `%%BG_TOP%%`/`%%BG_BOT%%` → 테마에 맞는 그라데이션 색 (예: 우주 #0b0b2a/#241b4a)",
        "- `// CUSTOMIZE` 주석으로 표시된 줄만 살짝 변형 가능. **구조·게임루프·하단 조작바(`#controls`)는 절대 건드리지 마세요.**",
        "",
        "출력 규칙: 고른 스켈레톤 전체를 자리표시자 채운 **완전한 단일 HTML**로. 출력에 `%%` 문자가 단 하나도 남으면 안 됩니다 (모든 `%%...%%`를 실제 값으로 치환).",
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

// #173 — Web-search citation, OpenAI-extension-shaped delta payload. The
// webview reads `delta.hps_citations` and renders a chip rack under the
// streaming assistant message. `tier` is computed server-side from `domain`
// so all clients agree on the same trust palette (학회/edu/gov → green,
// pubmed/doi → teal, 제조사·회사 공식 → yellow, 블로그/유튜브/기타 → gray).
export interface CitationChip {
  url: string;
  title: string;
  domain: string;
  tier: 1 | 2 | 3 | 4;
}

// Domain → trust tier classifier. Pure — exported so smoke tests can hit it
// without mocking SSE. Order matters: more specific patterns first.
export function tierForUrl(url: string): { domain: string; tier: 1 | 2 | 3 | 4 } {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { domain: "", tier: 4 };
  }
  // Tier 1 — 학회 / 대학병원 / 정부 / .edu / .gov
  if (
    /\.(edu|gov|ac\.kr)$/.test(host) ||
    /(^|\.)hospital\./.test(host) ||
    /(^|\.)(who|cdc|nih|fda|kdca)\./.test(host) ||
    /(^|\.)(snubh|amc|samsunghospital|cmcseoul|severance|kmedi|kma)\./.test(host) ||
    /(^|\.)(iti|aaid|eao|aap|aaoms|kaomi|aaomp)\./.test(host)
  ) {
    return { domain: host, tier: 1 };
  }
  // Tier 2 — 논문 / 리뷰 / DOI
  if (
    /(^|\.)(pubmed|ncbi\.nlm\.nih|doi|cochrane|scholar\.google|sciencedirect|springer|wiley|jstor|jamanetwork|nejm|nature|elsevier)\./.test(
      host,
    )
  ) {
    return { domain: host, tier: 2 };
  }
  // Tier 3 — 제조사 / 회사 공식 (often ".com" with known brand markers)
  if (
    /(^|\.)(straumann|nobelbiocare|dentsply|zimmer|osstem|dentium|neobiotech|megagen|astratech|ankylos)\./.test(
      host,
    )
  ) {
    return { domain: host, tier: 3 };
  }
  // Tier 4 — 블로그 / 유튜브 / 기타 (default)
  return { domain: host, tier: 4 };
}

// SSE event translation: Anthropic stream event → OpenAI chunk JSON.
// Returns null for events that should not be forwarded (e.g. ping, start).
export function anthropicEventToOpenAIChunk(event: unknown, model: string): string | null {
  if (!event || typeof event !== "object") return null;
  const e = event as {
    type?: string;
    delta?: { text?: string; type?: string };
    content_block?: { type?: string; content?: unknown };
    usage?: unknown;
  };
  if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && typeof e.delta.text === "string") {
    return JSON.stringify({
      id: "chatcmpl-hps",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { content: e.delta.text }, finish_reason: null }],
    });
  }
  // #173 — server-side web_search results arrive in a single content_block_start
  // event with the full content[] array (results are already executed
  // server-side; no streaming deltas inside the block). Translate to
  // `delta.hps_citations` for the webview.
  if (e.type === "content_block_start" && e.content_block?.type === "web_search_tool_result") {
    const raw = Array.isArray(e.content_block.content) ? e.content_block.content : [];
    const chips: CitationChip[] = [];
    for (const item of raw) {
      const r = item as { type?: string; url?: string; title?: string };
      if (r?.type === "web_search_result" && typeof r.url === "string" && r.url.length > 0) {
        const { domain, tier } = tierForUrl(r.url);
        chips.push({ url: r.url, title: typeof r.title === "string" ? r.title : "", domain, tier });
      }
    }
    if (chips.length === 0) return null;
    return JSON.stringify({
      id: "chatcmpl-hps",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { hps_citations: chips }, finish_reason: null }],
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
