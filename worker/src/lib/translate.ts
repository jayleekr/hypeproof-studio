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
// @ts-ignore — string import enabled via wrangler rules in wrangler.toml
import browserControlContractProxyMd from "../prompts/_browser-control-contract-proxy.md";
// @ts-ignore — string import enabled via wrangler rules in wrangler.toml
import browserControlContractSdkMd from "../prompts/_browser-control-contract-sdk.md";
// @ts-ignore — string import enabled via wrangler rules in wrangler.toml
import runtimeDegradedNoticeMd from "../prompts/_runtime-degraded-notice.md";
import { BROWSER_TOOLS } from "./browser-tools.ts";
import { isMinorCohort } from "./moderation.ts";
import { resolveSkills } from "../skills/index.ts";

// A polished single-file game (gradient bg, 3 states, score, juice) plus the
// coach's friendly intro runs ~3-6k output tokens. 4096 truncated games
// mid-code → broken (unclosed fence). 8192 leaves comfortable headroom.
const DEFAULT_MAX_TOKENS = 8192;

// OpenAI multimodal content block. `text` blocks carry prose; `image_url`
// blocks carry a data URL (pasted screenshot) or http(s) URL — the
// website-copyclone curriculum injects a target screenshot this way.
interface OpenAIContentBlock {
  type: string;                  // "text" | "image_url" | "tool_use" | "tool_result"
  text?: string;
  image_url?: { url: string };
  // #278 Phase 3 — tool_use (assistant turn) / tool_result (user turn) blocks
  // for the client-driven browser tool loop. Gated on browser_control.
  id?: string;                   // tool_use: the tool call id
  name?: string;                 // tool_use: the tool name
  input?: unknown;               // tool_use: the tool arguments
  tool_use_id?: string;          // tool_result: which tool_use it answers
  content?: OpenAIContentBlock[]; // tool_result: nested text/image blocks
  is_error?: boolean;            // tool_result: the tool failed
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

export interface AnthropicSystemBlock {
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
// #278 Phase 3 — agentic browser tool loop blocks (client-driven). The coach
// emits tool_use; the extension executes it via CDP and echoes a tool_result.
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: Array<AnthropicTextBlock | AnthropicImageBlock>;
  is_error?: boolean;
}
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

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
  /**
   * 학생 컴퓨터의 작업 폴더 절대경로. 클라이언트가 `x-hps-workspace` 헤더로 보낸다.
   *
   * 왜 헤더인가 (2026-07-27 실측). 앱은 시스템 프롬프트에 `<env>` 블록으로 이걸
   * 붙여 왔지만(#428·#457), 워커는 클라이언트 `system` 을 **통째로 교체**한다
   * (messages.ts: "REPLACED, never merged" — 주입 통로를 막는 올바른 설계).
   * 그래서 세 번의 수정이 전부 무력이었고 코치는 SDK 경로에서 자기 작업 폴더를
   * 한 번도 받은 적이 없다. 매 턴 `/app/workdir`·`/Users/workspace/` 같은 경로를
   * 지어내고, 실패하고, `pwd` 로 복구하느라 한 턴에 34~164초를 태웠다.
   *
   * 경로만 받고 **문구는 워커가 소유한다.** 클라이언트는 문장을 넣을 수 없으므로
   * 교체 설계의 안티-인젝션 성질이 유지된다.
   */
  workspace?: string;
  /** 작업 폴더에 지금 있는 파일들 (루트 기준 상대경로). `x-hps-workspace-files`. */
  workspaceFiles?: string[];
  /**
   * #507 — 지금 떠 있는 로컬 라이브 서버 주소. 클라이언트가 `x-hps-preview-url`
   * 로 보낸다.
   *
   * 왜 필요한가 (2026-07-28 실측). Studio 의 라이브 서버는 `listen(0)` 으로 매
   * 실행마다 **다른 에페메랄 포트**를 받는다(실측 58085). 그런데 그 주소가 코치
   * 컨텍스트로 들어가는 통로가 없었다 — Run 버튼은 확장이 URL 을 직접 받아서
   * 멀쩡했고, 코치만 알 방법이 없어 `127.0.0.1:3000` 을 반사적으로 추측하다
   * `ERR_CONNECTION_REFUSED` 로 멈췄다(#470 재발, 코드 어디에도 3000 은 없다).
   *
   * 주소만 받고 **문구는 워커가 소유한다** — workspace 와 같은 계약이라 교체
   * 설계의 안티-인젝션 성질이 그대로 유지된다. 루프백 http(s) 가 아니면 버린다.
   */
  previewUrl?: string;
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
function filterMessages(body: OpenAIRequest, allowImages: boolean, allowToolBlocks: boolean): Turn[] {
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
      const blocks = sanitizeContentBlocks(m.content, allowImages, allowToolBlocks);
      // No image AND no tool block → collapse to a string (preserve legacy
      // shape so text-only turns stay byte-identical + cache-stable).
      const hasRich = blocks.some(
        (b) => b.type === "image_url" || b.type === "tool_use" || b.type === "tool_result",
      );
      if (!hasRich) {
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
function sanitizeContentBlocks(
  blocks: OpenAIContentBlock[],
  allowImages: boolean,
  allowToolBlocks: boolean,
): OpenAIContentBlock[] {
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
    } else if (allowToolBlocks && b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
      // Assistant turn echoed back by the client so the model has its own
      // prior tool call in context.
      out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} });
    } else if (allowToolBlocks && b.type === "tool_result" && typeof b.tool_use_id === "string") {
      // The tool's result. Its nested content is agent-generated (e.g. a
      // screenshot the coach requested), so images are allowed here regardless
      // of image_paste — the browser_control gate governs it.
      const inner = Array.isArray(b.content) ? sanitizeContentBlocks(b.content, true, false) : [];
      out.push({
        type: "tool_result",
        tool_use_id: b.tool_use_id,
        content: inner,
        ...(b.is_error === true ? { is_error: true } : {}),
      });
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
    } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
      out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} });
    } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
      const inner: Array<AnthropicTextBlock | AnthropicImageBlock> = [];
      for (const ib of Array.isArray(b.content) ? b.content : []) {
        if (ib.type === "text" && typeof ib.text === "string") {
          inner.push({ type: "text", text: ib.text });
        } else if (ib.type === "image_url" && ib.image_url?.url) {
          const img = imageUrlToAnthropicImage(ib.image_url.url);
          if (img) inner.push(img);
        }
      }
      out.push({
        type: "tool_result",
        tool_use_id: b.tool_use_id,
        content: inner,
        ...(b.is_error === true ? { is_error: true } : {}),
      });
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
 * Which coach runtime this request is being served for (#520).
 *
 * It is the ROUTE, not the profile, that decides: `/v1/chat/completions` +
 * `/v1/messages` differ in who owns the tool list, so the same cohort profile
 * can produce two different tool sets. `profile.coach_runtime` is only a
 * *request* from the cohort author (and the client can be overridden by a
 * machine-scoped setting), so it is not the ground truth here.
 *
 *  - "proxy" — lib/translate.ts, /v1/chat. The WORKER injects the tools
 *    (BROWSER_TOOLS, browser-tools.ts) and the extension host executes them
 *    via CDP.
 *  - "sdk"   — routes/messages.ts, the Anthropic-native gateway (#282). The
 *    CLIENT owns the tool list; the worker passes `tools` through untouched.
 *    Browser capability arrives as in-process MCP tools (browserMcp.ts).
 */
export type CoachRuntime = "proxy" | "sdk";

/**
 * The browser-tool contract for this runtime, or "" when the runtime grants no
 * browser tools at all.
 *
 * #520 — the two runtimes hold DIFFERENT tool sets, so they must not be taught
 * the same contract. Before this split, the proxy contract (navigate / back /
 * forward / dialog) was injected on both paths, so the SDK coach learned four
 * tools it does not have and never learned the two it does (`browser_open`,
 * `live_preview_start`).
 *
 * The gates differ too, and deliberately mirror where each runtime's tools
 * actually come from:
 *  - proxy → `browser_control.enabled`, the same flag that injects
 *    BROWSER_TOOLS below (translate(), "worker-defined browser control tools").
 *  - sdk   → `sdk_tools.browser`, the same flag `permittedMcpToolsFor()`
 *    (sdkCoachHelpers.ts) reads, minus minors. The client strips browser MCP
 *    tools for minor tiers regardless of the flag (#306/#318), so teaching the
 *    contract there would recreate exactly this bug for kids cohorts. Mirrored
 *    here, fail-closed: an unknown tier counts as minor.
 */
function browserContractFor(profile: Profile, runtime: CoachRuntime): string {
  if (runtime === "sdk") {
    if (profile.sdk_tools?.browser !== true) return "";
    // Mirrors isMinorTier() in sdkCoachHelpers.ts — keep the tier list in sync.
    const workshopTier =
      profile.game.template_tier === "search-webapp" || profile.game.template_tier === "website";
    if (!workshopTier || isMinorCohort(profile)) return "";
    return browserControlContractSdkMd as unknown as string;
  }
  return profile.browser_control?.enabled === true
    ? (browserControlContractProxyMd as unknown as string)
    : "";
}

/**
 * 코치가 **자기 능력을 알게** 하는 블록, 또는 "" (#476).
 *
 * 왜 필요한가: 클라이언트는 SDK 네이티브 바이너리를 못 찾으면 프록시 런타임으로
 * 폴백한다(#387 — 미시딩 머신에서도 수업이 죽지 않게 하는 의도된 설계). 그런데
 * 코호트 프롬프트와 스킬은 파일·셸이 있다는 전제로 쓰여 있다. 예:
 * `boah-dental-director-copyclone-2026-s1.md` 는 "index.html 을 만들어
 * **저장합니다**" 라고 지시하고, `github-repo`/`publish-homepage` 스킬은 통째로
 * 셸 절차다. 도구가 0개인 코치가 그 역할을 자임하면 다음이 나온다(2026-07-27 실측):
 *
 *   "제가 위에서 코드를 채팅창에 붙여넣었는데, 그걸 직접 파일로 저장하는 작업을
 *    빠뜨렸어요. Studio 워크스페이스에 index.html 로 저장해주시겠어요?"
 *
 * 망각이 아니라 `Write` 가 없었던 것이고, 참가자는 해결할 수 없는 요청을 받는다.
 * #476 은 이 오진이 능력 상실 자체보다 비쌌다고 기록한다 — 이슈 3건(#470·#471·
 * #472)이 같은 원인을 각각 다른 제품 결함으로 진단했다.
 *
 * **왜 여기(워커)인가:** ① #520 이후 런타임의 ground truth 는 **라우트**다 —
 * 워커는 클라이언트에게 묻지 않고도 이 요청이 프록시 경로임을 안다. ② 프롬프트의
 * 소유자가 워커다(REQ-M10). ③ 스킬 마크다운과 마찬가지로 **워커 배포만으로
 * 반영**되어 앱 릴리스를 기다리지 않는다.
 *
 * **왜 사고 보고가 아니라 능력 설명인가:** 이 조건은 폴백 말고도 성립한다 —
 * 강사가 `hypeproofChat.coachRuntime` 을 프록시로 고정한 경우다. 문구가 "SDK 를
 * 못 찾았다"고 단정하면 그 경우에 거짓이 된다. 도구 목록만 말하면 언제나 참이다.
 *
 * 게이트가 `coach_runtime === "agent-sdk"` 인 이유: 애초에 프록시로 설계된
 * 코호트(teaser·kids)는 프롬프트가 파일·셸을 약속하지 않으므로 정정할 것이
 * 없다. 미성년은 워커가 의도적으로 프록시에 고정하는 쪽이라(chat.ts) 제외한다 —
 * 그쪽은 degraded 가 아니라 설계다.
 *
 * 프롬프트 캐시: #520 이 이미 런타임별로 프리픽스를 둘로 갈라 놓았고, 이 블록은
 * 그 두 변형 안에서만 달라지므로 **캐시 변형 수가 늘지 않는다.**
 */
function degradedRuntimeNoticeFor(profile: Profile, runtime: CoachRuntime): string {
  if (runtime !== "proxy") return "";
  if (profile.coach_runtime !== "agent-sdk") return "";
  // 2026-08-11 — 미성년 제외를 걷어낸다. 아동 코호트가 agent-sdk 를 opt-in 할 수
  // 있게 된 뒤로는(chat.ts) 그쪽에도 폴백이 성립하고, 폴백했는데 코치가 파일을
  // 다룰 수 있다고 믿으면 #476 이 기록한 그 오진("저장해주시겠어요?")이 아이에게
  // 그대로 간다. opt-in 하지 않은 아동 프로필은 아래 grantsHostTools 에서 걸러진다.
  const t = profile.sdk_tools;
  const grantsHostTools = t?.read === true || t?.write === true || t?.shell === true;
  if (!grantsHostTools) return "";
  return runtimeDegradedNoticeMd as unknown as string;
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
function buildCachedPrefix(profile: Profile, runtime: CoachRuntime = "proxy"): string {
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
  // #278 Phase 3 / #520 — teach the coach the browser tools + discipline. The
  // contract is RUNTIME-SPECIFIC because the tool sets are: see
  // browserContractFor().
  const browserContract = browserContractFor(profile, runtime);
  // #476 — 능력 정정은 **스킬 뒤**에 온다. 스킬(github-repo·publish-homepage)이
  // 셸 절차를 176줄에 걸쳐 가르치는데 그 앞에서 "셸이 없다"고 말하면, 뒤에 오는
  // 긴 절차가 앞의 한 문단을 덮는다. 마지막에 두어 정정이 마지막 말이 되게 한다.
  const degradedNotice = degradedRuntimeNoticeFor(profile, runtime);
  const sections = [
    profile.system_prompt,
    previewContract,
    browserContract,
    skillsMd,
    buildSkeletonLibrary(profile, runtime),
    degradedNotice,
  ].filter((s) => s && s.length > 0);
  return sections.join("\n\n");
}

/**
 * The Anthropic system blocks the worker enforces: cached cohort prefix
 * (system prompt + contracts + skills + skeletons) followed by the uncached
 * per-user coach tail. Shared by translate() (OpenAI-compat /v1/chat path)
 * and routes/messages.ts (Anthropic-native gateway, #282) so both paths
 * inject the same cohort prompt — the client-supplied `system` never survives
 * on either route.
 *
 * #520 — the ONE part that is deliberately not byte-identical is the browser
 * contract: each runtime is taught the tools it actually has. Callers must
 * pass their `runtime`; the "proxy" default keeps the pre-#520 behavior for
 * any path that has no browser tools either way.
 */
export function buildAnthropicSystemBlocks(
  profile: Profile,
  coach: CoachContext = {},
  runtime: CoachRuntime = "proxy",
): AnthropicSystemBlock[] {
  const systemBlocks: AnthropicSystemBlock[] = [
    {
      type: "text",
      text: buildCachedPrefix(profile, runtime),
      cache_control: { type: "ephemeral" },
    },
  ];
  const coachTail = buildCoachTail(coach);
  if (coachTail) {
    systemBlocks.push({ type: "text", text: coachTail });
  }
  return systemBlocks;
}

/**
 * Clamp a client-requested max_tokens into the worker's accepted range,
 * falling back to the profile's tuned budget. Shared by both LLM routes.
 */
export function clampMaxTokens(requested: unknown, profile: Profile): number {
  return clampInt(requested, 1, 16384, profile.model.max_tokens ?? DEFAULT_MAX_TOKENS);
}

export function translate(
  body: OpenAIRequest,
  profile: Profile,
  coach: CoachContext = {},
  // Anthropic 스키마를 말하는 상류가 둘이다 — Anthropic 과 GLM(Z.ai 호환 경로).
  // 스키마는 같고 **모델 id 만 다르므로** 프로바이더만 받아 alias 를 해석한다.
  // translateOpenAI 가 gemini/openai 를 같은 방식으로 가르는 것과 대칭이다.
  provider: "anthropic" | "glm" = "anthropic",
): AnthropicRequest {
  const msgs: AnthropicMessage[] = filterMessages(
    body,
    profile.input?.image_paste === true,
    profile.browser_control?.enabled === true,
  ).map((t) => ({
    role: t.role,
    content: toAnthropicContent(t.content),
  }));

  const model = modelIdFor(resolveAlias(body.model, profile), provider);

  // System block: cached prefix + non-cached per-user coach tail.
  // Cached prefix = system prompt + the tier's skeleton library. Static per
  // cohort → high cache hit rate. Per-user coach tail stays uncached after.
  const systemBlocks = buildAnthropicSystemBlocks(profile, coach);

  const out: AnthropicRequest = {
    model,
    messages: msgs,
    max_tokens: clampInt(body.max_tokens, 1, 16384, profile.model.max_tokens ?? DEFAULT_MAX_TOKENS),
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

  // #278 Phase 3 — worker-defined browser control tools (client-driven loop).
  // Static per cohort → cache with the other function tools. Only injected when
  // the profile opts in; the extension host executes them via CDP.
  if (profile.browser_control?.enabled === true) {
    for (const t of BROWSER_TOOLS) {
      tools.push({ name: t.name, description: t.description, input_schema: t.input_schema });
    }
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
  // The agentic browser tool loop is Anthropic-only (v1); the Gemini/OpenAI
  // path never carries tool blocks.
  const turns = filterMessages(body, profile.input?.image_paste === true, false);

  let systemText = buildCachedPrefix(profile);
  const coachTail = buildCoachTail(coach);
  if (coachTail) systemText += "\n\n" + coachTail;

  const out: OpenAIChatRequest = {
    model: modelIdFor(resolveAlias(body.model, profile), provider),
    messages: [{ role: "system", content: systemText }, ...turns],
    max_tokens: clampInt(body.max_tokens, 1, 16384, profile.model.max_tokens ?? DEFAULT_MAX_TOKENS),
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
function buildSkeletonLibrary(profile: Profile, runtime: CoachRuntime = "proxy"): string {
  const tier = profile.game?.template_tier ?? "kids-basic";
  const skels = getSkeletonsForTier(tier);
  if (skels.length === 0) return "";

  // 2026-08-19 — kids-quest × agent-sdk: 세상은 이미 파일로 있다(사전 완성본을
  // Studio 가 index.html 에 저장). 도트 엔진 9개(~110KB, ~36k 토큰)를 매 턴 프롬프트에
  // 싣지 않고, 코치는 파일을 Read 해서 고친다. 프록시 런타임(파일 도구 없음)은 그대로.
  if (tier === "kids-quest" && runtime === "sdk") {
    return [
      "# 게스트의 세상 — 파일로 있다",
      "",
      "아이가 게스트를 고르면 Studio 가 그 세상(문제 상태 기본값)을 작업 폴더 `index.html` 에 저장하고 화면에 띄웁니다(메시지 앞 `[Studio 안내: …]`).",
      "바꾸기 요청이 오면: ①**필요한 곳만** — 전체 Read 금지. `Grep` 으로 바꿀 이름(`WORLD`·`flood`·`function loop`)의 줄을 찾고 `Read` 에 offset/limit 으로 그 구간(20~40줄)만. `S_` 스프라이트 배열과 도트 엔진 블록은 읽지도 고치지도 않는다 ②**규모 파악·계획** — 코드 전에 바꿀 곳(상수·함수·호출 위치)을 정하고 아이에게는 한 줄(\"장애물 → 옆점프 → 도움닫기 순으로 바꿀게요, 1분쯤\") ③**MultiEdit 한 번**으로 바꿀 곳을 전부 묶어 고침(한 곳이면 Edit 한 번) ④\"다 됐어요!\" 한 줄. 값·플래그 하나는 계획 없이 Edit 한 번. **Write 로 파일 전체를 다시 쓰지 마세요** — 3~4분이 걸리고 도중에 끊깁니다. Write 는 파일이 없을 때만. Edit 는 20줄 이하로 짧게. 스프라이트 맵(`S_…` 배열)·`도트 엔진` 블록은 절대 다시 쓰지 않습니다(새 그림은 새 이름 배열을 추가만). 파일 안에 `CONFIG`(자리표시자는 이미 채워짐)와 `WORLD={…}` 플래그, 그리고 도트 엔진이 있습니다 — 무엇이든 고쳐도 되지만 `#guest` 말풍선과 `report()` 는 지키고, 세상을 바꿨으면 `WORLD` 값을 맞춰 두세요(게스트가 `hp:result` 의 `world` 를 봅니다).",
      "파일이 없거나 `[Studio 안내]` 가 없으면 — 아이가 이름만 말해 Studio 가 못 알아들은 것이다. **세상을 직접 만들지 마라**(몇 분이 걸린다). 친구 버튼은 대화가 비어 있을 때만 보인다(지금은 없다). 한 줄로 \"채팅창 위 오른쪽 **Clear** 를 누르면 친구들이 다시 나와요 — 거기서 **○○ 세상에 가볼래** 를 눌러요\" 라고만 하라.",
      "화면 글자는 `txt(문구, y, 크기, 색, x)` — x 를 주면 그 자리(왼쪽 위 60, 오른쪽 위 W-60), 안 주면 가운데. 아이가 말한 자리에 정확히 붙여라.",
      "답에 `User:` · `assistant:` 같은 라벨을 쓰지 마라 — 대화 기록 표시일 뿐이고 코치는 자기 말만 한다.",
      "절대 금지: 응답에서 `게임` 이라는 낱말. 이건 게스트가 사는 세상입니다.",
    ].join("\n");
  }

  const isSearchWebapp = tier === "search-webapp";
  const isKidsQuest = tier === "kids-quest";

  // Tier-conditional intro — game tiers vs search-webapp vs kids-quest use
  // different framing. Mixing the game intro into a clinical workshop is what
  // caused #141 ("게임을 만드는 중" leak in dental responses); the kids-quest
  // curriculum bans the word "게임" outright (curriculum/quests/QUESTS.md).
  const parts: string[] = isKidsQuest
    ? [
        "# 게스트의 세상 스켈레톤 라이브러리 (반드시 여기서 시작)",
        "",
        "아래는 게스트 9명이 사는 **문제투성이 세상**입니다. 각 스켈레톤은 그 게스트의 세상 자체입니다 — 문제가 화면에 보이고 기계적으로도 작동합니다(물이 차오르고, 꽃이 시들고, 해가 이글거립니다).",
        "아이가 게스트를 고르면 그 `kq-*` 하나를 골라 `%%...%%` 자리표시자를 **문제 상태 기본값**(각 줄 주석의 \"문제 세상 N\")으로 채워 완전한 단일 HTML로 띄우세요. 아이가 먼저 겪어야 합니다.",
        "- `%%TITLE%%` `%%GUEST_EMOJI%%` `%%GUEST_NAME%%` `%%GUEST_LINE%%`(게스트가 자기 세상을 말하는 첫 대사) · `%%PLAYER_EMOJI%%` · `%%ITEM_A%%` `%%ITEM_B%%` · `%%SPEED%%` `%%RATE%%` `%%GOAL%%` `%%SPECIAL%%`(숫자) · `%%BG_TOP%%` `%%BG_BOT%%`",
        "- `WORLD = { … }` 블록이 이 세상의 문제 플래그입니다. 처음엔 그대로 둡니다.",
        "",
        "그 다음부터 아이가 말하면 **직전 HTML을 아이 말대로 무엇이든 고쳐 통째로** 다시 출력합니다 — CONFIG 값, `WORLD` 플래그, 오브젝트, 배경, 새 규칙, 새 코드 전부 허용. 아이가 말한 것은 반드시 화면에 있어야 합니다. 세상을 바꿨으면 `WORLD` 값을 맞춰 두세요(물을 뺐으면 `flood:false`) — 게스트가 `hp:result`의 `world`를 보고 반응합니다.",
        "**`engine.js` 는 절대 읽지 마라** — 9개 세상이 공용으로 쓰는 그림·엔진이라 펭귄·얼음처럼 지금 세상과 무관한 것이 들어 있다. 읽으면 다른 세상 이야기가 섞인다(실기기: 초코 세상에서 얼음). 이전 세상 파일(`*.html`)도 마찬가지. 오직 `index.html`.",
      "지키는 것 둘: `#guest` 말풍선(gface/gsay/say)과 `report()`(hp:result + world). 출력에 `%%` 문자가 남으면 안 됩니다. 외부 URL 금지.",
        "절대 금지: 응답에서 `게임` 이라는 낱말을 쓰지 마세요. 이건 게스트가 사는 세상입니다.",
        "",
      ]
    : isSearchWebapp
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

/**
 * 작업 폴더 블록. 경로가 없으면 아무것도 내지 않는다 — 없는 경로를 지어내라고
 * 부추기는 빈 블록보다 침묵이 낫다.
 *
 * 파일 목록까지 주는 이유: 경로만 알려 줬을 때 코치는 여전히 `Glob` → `ls` →
 * `find` 로 "여기 뭐가 있지"를 툴로 물었다(2026-07-26 실측, 한 턴의 80%). 목록이
 * 있으면 물어볼 이유가 없다.
 */
function buildWorkspaceBlock(coach: CoachContext): string | null {
  const cwd = sanitizePath(coach.workspace);
  if (!cwd) return null;
  const files = (coach.workspaceFiles ?? [])
    .map((f) => sanitizePath(f))
    .filter((f): f is string => !!f)
    .slice(0, 80);
  const lines = [
    "# 작업 폴더",
    `절대경로: ${cwd}`,
    files.length
      ? `지금 있는 파일:\n${files.map((f) => `  ${f}`).join("\n")}`
      : "지금 있는 파일: (없음 — 아직 아무것도 만들지 않았다)",
    "",
    "파일 도구(Read/Write/Edit)에는 **위 절대경로 기준의 절대경로**를 넘긴다 — " +
      "상대경로는 거부된다. 경로를 추측하거나 지어내지 않는다. 위 목록에 있는 " +
      "파일을 찾으려고 탐색(find·ls·Glob)하지 않는다.",
  ];
  return lines.join("\n");
}

/**
 * 미리보기(라이브 서버) 블록 (#507). 주소가 없으면 아무것도 내지 않는다 —
 * 서버가 안 떠 있는 상태에서 "주소는 …" 이라고 운을 떼면 그게 곧 추측을
 * 부추긴다. 그 경우의 규칙("포트를 추측하지 마라")은 코호트 프롬프트의
 * preview-env contract 가 담당한다.
 */
function buildPreviewBlock(coach: CoachContext): string | null {
  const url = sanitizeLoopbackUrl(coach.previewUrl);
  if (!url) return null;
  return [
    "# 미리보기 (라이브 서버)",
    `지금 떠 있는 주소: ${url}`,
    "브라우저로 참가자의 결과물을 볼 때는 **이 주소를 그대로** 쓴다. 포트는 실행할 때마다 " +
      "무작위로 배정되므로 3000·5500·8080 같은 흔한 번호는 **반드시 틀린다** — " +
      "추측해서 이동하지 말고, 참가자에게 포트 번호를 묻지도 않는다.",
  ].join("\n");
}

/**
 * 라이브 서버 주소 살균 (#507). **루프백 http(s) 주소만** 통과시킨다. 클라이언트가
 * 보내는 값이므로, 여기가 느슨하면 시스템 블록에 임의 문장/주소를 넣는 통로가 된다.
 */
function sanitizeLoopbackUrl(s: string | undefined): string | null {
  const v = (s ?? "").trim();
  if (!v || v.length > 200) return null;
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/[^\s"'`]*)?$/i.test(v)) {
    return null;
  }
  return v;
}

/** 경로 살균 — 개행/따옴표 제거, 길이 제한. 블록을 깨거나 문장을 주입할 수 없게. */
function sanitizePath(s: string | undefined): string | null {
  const v = (s ?? "").replace(/[\r\n]+/g, " ").replace(/["'`]/g, "").trim().slice(0, 400);
  return v.length > 0 ? v : null;
}

function buildCoachTail(coach: CoachContext): string | null {
  const workspace = buildWorkspaceBlock(coach);
  // #507 — 작업 폴더 바로 다음에 미리보기 주소. 둘 다 "지어내지 마라"를 없애는
  // 사실 블록이라 붙어 있는 편이 읽기 좋다.
  const preview = buildPreviewBlock(coach);
  const head = [workspace, preview].filter((b): b is string => !!b).join("\n\n");
  const name = (coach.name ?? "").trim();
  const personality = (coach.personality ?? "").trim();
  if (!name && !personality) return head || null;
  const parts: string[] = [];
  if (head) parts.push(head, "");
  parts.push("# 사용자의 코치 설정");
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
