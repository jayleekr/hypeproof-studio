import type { AssetScoreChunk, ChatMessage, Citation, ResolvedProfile } from "./protocol";
import {
  buildProxyHeaders,
  friendlyTransportMessage,
  TOKEN_EXPIRED_FRIENDLY,
  TOKEN_MISSING_FRIENDLY,
} from "./proxyClientHelpers";

/**
 * Auth/session failures need different handling than generic errors:
 * the kid should see a friendly message AND the host should re-prompt for a
 * token (expired/missing) or tell them to call the teacher (session/roster).
 */
export class ProxyAuthError extends Error {
  kind: "expired" | "missing" | "session_inactive" | "session_window" | "not_in_roster" | "other";
  friendly: string;
  requestId?: string;        // S-07 / #49 — surfaced in webview ErrorBanner
  runbookUrl?: string;       // #165 — when present, banner renders as clickable link
  constructor(
    kind: ProxyAuthError["kind"],
    friendly: string,
    requestId?: string,
    runbookUrl?: string,
  ) {
    super(friendly);
    this.kind = kind;
    this.friendly = friendly;
    this.requestId = requestId;
    this.runbookUrl = runbookUrl;
  }
}

/**
 * S-07 (#49): generic transport error that carries the request_id forwarded
 * from the server. Used when the upstream is non-auth-related (5xx, network
 * drop, etc). The webview ErrorBanner shows the request_id so the operator
 * can paste it into a DM and Jay greps Workers Logs.
 */
export class ProxyTransportError extends Error {
  requestId?: string;
  constructor(message: string, requestId?: string) {
    super(message);
    this.requestId = requestId;
  }
}

function classifyError(status: number, bodyText: string): ProxyAuthError | null {
  let parsed:
    | { error?: { message?: string; type?: string; code?: string; runbook_url?: string } }
    | null = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = null;
  }
  const type = parsed?.error?.type;
  const code = parsed?.error?.code;
  const serverMsg = parsed?.error?.message;
  const runbookUrl = parsed?.error?.runbook_url;

  if (status === 401) {
    if (code === "expired") {
      return new ProxyAuthError("expired", TOKEN_EXPIRED_FRIENDLY);
    }
    return new ProxyAuthError("missing", TOKEN_MISSING_FRIENDLY);
  }
  if (status === 403) {
    if (type === "session_inactive") {
      return new ProxyAuthError(
        "session_inactive",
        serverMsg ?? "수업이 아직 시작 전이에요. 강사가 곧 열어줄 거예요 — 잠시 후 다시 보내보세요.",
        undefined,
        runbookUrl,
      );
    }
    if (type === "session_window") {
      return new ProxyAuthError("session_window", serverMsg ?? "수업 시간이 끝났어요. 다음 시간에 다시 만나요.");
    }
    if (type === "not_in_roster") {
      return new ProxyAuthError("not_in_roster", serverMsg ?? "등록이 안 됐어요. 선생님께 알려주세요.");
    }
    if (type === "session_profile_mismatch") {
      return new ProxyAuthError("other", serverMsg ?? "이 토큰은 다른 시간 거예요. 선생님께 새 토큰을 받아주세요.");
    }
    return new ProxyAuthError("other", serverMsg ?? "지금은 사용할 수 없어요. 선생님을 불러주세요.");
  }
  return null;
}

/** #278 Phase 3 — a tool_use block the coach emitted (from an hps_tool_use chunk). */
export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** #278 Phase 3 — what one streamed turn produced, so the loop can decide to run
 *  tools + continue (toolUses non-empty) or finish. */
export interface ProxyChatResult {
  finishReason: string | null;
  toolUses: ToolUseBlock[];
  text: string;
}

interface ProxyChatArgs {
  proxyUrl: string;
  model: string;
  token: string | undefined;
  history: ChatMessage[];
  userText: string;
  /**
   * Pasted-image data URLs attached to THIS user turn (website-copyclone).
   * Only the current turn carries images — `history` is mapped text-only
   * below, so a screenshot is injected to the model exactly once.
   */
  images?: string[];
  /**
   * #278 Phase 3 — scratch turns for the agentic browser loop: the assistant's
   * prior tool_use turn(s) + the user's tool_result turn(s), Anthropic-shaped
   * content blocks. Appended AFTER the current user turn so the model has its
   * own tool calls + results in context on re-invocation. Ephemeral (never
   * persisted to history).
   */
  toolTurns?: Array<{ role: "user" | "assistant"; content: unknown }>;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  /** #173 — fires for each citations chunk in the SSE stream. */
  onCitations?: (citations: Citation[]) => void;
  /** #204 — fires when the worker emits the final 7-asset score chunk. */
  onAssetScore?: (assetScore: AssetScoreChunk) => void;
  /** #278 Phase 3 — fires per streamed tool_use block (browser control loop). */
  onToolUse?: (block: ToolUseBlock) => void;
  coachName?: string;
  coachPersonality?: string;
  /** #507 — 지금 떠 있는 라이브 서버 주소(없으면 생략). 워커가 문구를 만든다. */
  previewUrl?: string;
}

// Streaming OpenAI-compatible chat completion call against the HypeProof Proxy.
// Expects SSE-style `data: {json}\n\n` chunks.
export async function proxyChat(args: ProxyChatArgs): Promise<ProxyChatResult> {
  const {
    proxyUrl,
    model,
    token,
    history,
    userText,
    images,
    toolTurns,
    signal,
    onDelta,
    onCitations,
    onAssetScore,
    onToolUse,
    coachName,
    coachPersonality,
    previewUrl,
  } = args;

  // History is sent text-only (drops any in-memory thumbnails from earlier
  // turns); the only multimodal turn is the current one. When images are
  // attached, the user turn becomes OpenAI-style content blocks — a text
  // block (only if there's text) plus one image_url block per pasted image.
  const userContent =
    images && images.length > 0
      ? [
          ...(userText ? [{ type: "text", text: userText }] : []),
          ...images.map((url) => ({ type: "image_url", image_url: { url } })),
        ]
      : userText;
  const messages = [
    // #503 — 툴 줄(role:"tool")은 화면·히스토리 전용이다. 호출부(handleSend)에서
    // 이미 걸러 오지만, 이 함수는 모델로 나가는 마지막 문이라 여기서도 막는다.
    ...history.filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userContent },
    // #278 Phase 3 — the loop's scratch tool_use/tool_result turns (if any).
    ...(toolTurns ?? []),
  ];

  const url = proxyUrl.replace(/\/$/, "") + "/chat/completions";
  const headers = buildProxyHeaders({ token, coachName, coachPersonality, previewUrl });

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    const rid = res.headers.get("x-request-id") ?? undefined;
    const authErr = classifyError(res.status, text);
    if (authErr) {
      authErr.requestId = rid;
      throw authErr;
    }
    // #358 — a few non-auth statuses have a specific, friendlier message than
    // the generic card (today: 413 = oversized pasted image). Fall back to the
    // generic copy otherwise. Never dump raw JSON at a 9-10 year old; the
    // request_id is appended so the operator can DM a single string.
    throw new ProxyTransportError(
      friendlyTransportMessage(res.status) ??
        "앗, 잠깐 문제가 생겼어요. 다시 한 번 해보거나 선생님을 불러주세요.",
      rid,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // #278 Phase 3 — accumulate what this turn produced for the loop caller.
  let text = "";
  let finishReason: string | null = null;
  const toolUses: ToolUseBlock[] = [];
  const result = (): ProxyChatResult => ({ finishReason, toolUses, text });

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return result();
      try {
        const j = JSON.parse(data);
        if (j?.type === "asset_score" && isAssetScoreChunk(j) && onAssetScore) {
          onAssetScore(j);
          continue;
        }
        const c0 = j?.choices?.[0];
        const choice = c0?.delta;
        const delta = choice?.content;
        if (typeof delta === "string" && delta.length) {
          onDelta(delta);
          text += delta;
        }
        // #173 — citations chunk
        const cites = choice?.hps_citations;
        if (Array.isArray(cites) && cites.length > 0 && onCitations) {
          onCitations(cites as Citation[]);
        }
        // #278 Phase 3 — tool_use chunk (browser control loop).
        const tu = choice?.hps_tool_use;
        if (tu && typeof tu.id === "string" && typeof tu.name === "string") {
          const block: ToolUseBlock = {
            id: tu.id,
            name: tu.name,
            input: (tu.input ?? {}) as Record<string, unknown>,
          };
          toolUses.push(block);
          onToolUse?.(block);
        }
        if (typeof c0?.finish_reason === "string") finishReason = c0.finish_reason;
      } catch {
        // ignore malformed line
      }
    }
  }
  return result();
}

function isAssetScoreChunk(value: unknown): value is AssetScoreChunk {
  const chunk = value as AssetScoreChunk | null;
  if (!chunk || chunk.type !== "asset_score" || chunk.version !== 1 || chunk.method !== "heuristic-v1") {
    return false;
  }
  const scores = chunk.scores as Record<string, unknown> | undefined;
  return !!scores && typeof scores === "object";
}

interface FetchProfileArgs {
  proxyUrl: string;
  token: string;
}

/** GET /v1/profile — used by extension host to cache cohort UX config. */
export async function fetchProfile(args: FetchProfileArgs): Promise<ResolvedProfile | null> {
  const { proxyUrl, token } = args;
  const url = proxyUrl.replace(/\/$/, "") + "/profile";
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as ResolvedProfile;
    return j;
  } catch {
    return null;
  }
}
