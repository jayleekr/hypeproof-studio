import type { AssetScoreChunk, ChatMessage, Citation, ResolvedProfile } from "./protocol";
import {
  buildProxyHeaders,
  classifyProfileFailure,
  friendlyTransportMessage,
  profileNetworkFailure,
  usageFromStreamChunk,
  PROFILE_ISSUER_TOKEN_FRIENDLY,
  TOKEN_EXPIRED_FRIENDLY,
  TOKEN_MISSING_FRIENDLY,
  type ProfileFailure,
  type ProxyStreamUsage,
} from "./proxyClientHelpers.ts";

/**
 * Auth/session failures need different handling than generic errors:
 * the kid should see a friendly message AND the host should re-prompt for a
 * token (expired/missing) or tell them to call the teacher (session/roster).
 */
export class ProxyAuthError extends Error {
  kind:
    | "expired"
    | "missing"
    | "wrong_role"
    | "session_inactive"
    | "session_window"
    | "not_in_roster"
    | "other";
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
    // #381 — an instructor token in the participant box. Naming it is the
    // difference between a 5-second fix and finding an instructor.
    if (code === "wrong_role") {
      return new ProxyAuthError("wrong_role", PROFILE_ISSUER_TOKEN_FRIENDLY);
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
  /**
   * #580 — 이 호출 1건(= 워커로 나간 요청 1건)의 토큰 usage. 스트림이 정상
   * 종료될 때 **한 번만** 발화한다 — usage 청크가 여러 번 보여도(업스트림
   * verbatim + 워커 최종 청크) 마지막 값 하나만 쓴다. requestKey 는 워커의
   * x-request-id 응답 헤더 (없으면 null → 스풀이 기록을 포기한다).
   */
  onUsage?: (u: ProxyStreamUsage & { requestKey: string | null; model: string | null }) => void;
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
    onUsage,
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
  // #580 — 스트림에서 마지막으로 본 usage(최종치)와 그 청크의 model. 정상
  // 종료 시 onUsage 로 한 번만 낸다. 에러/abort 로 던져지면 안 낸다 — 그 턴은
  // turn_end(status:error) 로 남고, 서버 D1 기록이 남는다.
  //
  // requestKey 3단: 워커가 청크에 실은 hps_request_id → x-request-id 응답
  // 헤더 → 로컬 생성 키. 로컬 키는 서버 로그와 조인이 안 되지만(`local-`
  // 프리픽스로 표시), proxy 경로는 호출당 정확히 1회 발화가 구조적이라
  // dedupe 목적으로는 안전하다 — 키가 없다고 usage 를 버리면 이 경로의
  // 기록이 통째로 사라진다(리뷰 실측: 과거 스트리밍 200 엔 헤더가 없었다).
  // 알려진 한계: 워커 request id 는 cf-ray 앞 8자(≈100ms 시간 버킷)라, 같은
  // 세션의 두 요청이 같은 버킷에 떨어지면 뒤 레코드가 dedupe 로 조용히
  // 빠진다. 채팅 케이던스(요청 간 수 초)에선 실질 0 — 클라가 병렬화되면
  // 워커가 full ray 를 싣도록 바꿀 것.
  let lastUsage: ProxyStreamUsage | null = null;
  let usageModel: string | null = null;
  let chunkRequestId: string | null = null;
  // usageEmitted 는 미래의 비-return 호출부에 대한 벨트다 — 현재 두 호출부는
  // 모두 `return result()` 라 구조적으로 1회다.
  let usageEmitted = false;
  const result = (): ProxyChatResult => {
    if (onUsage && lastUsage && !usageEmitted) {
      usageEmitted = true;
      const requestKey =
        chunkRequestId ??
        res.headers.get("x-request-id") ??
        `local-${crypto.randomUUID()}`;
      onUsage({ ...lastUsage, requestKey, model: usageModel });
    }
    return { finishReason, toolUses, text };
  };

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
        // #257/#580 — 워커의 mid-stream stream_error. 이전에는 조용히 무시돼
        // 학생은 끊긴 응답을 정상처럼 봤고, 스풀은 그 턴을 ok 로 적었다.
        // 던져서 보이게 한다 — 재시도 UX(retryMessage)와 turn_end(error)가
        // 같이 맞는다.
        if (j?.error?.type === "stream_error") {
          throw new ProxyTransportError(
            "앗, 응답이 중간에 끊겼어요. 다시 한 번 보내볼까요?",
            typeof j.error.request_id === "string"
              ? j.error.request_id
              : res.headers.get("x-request-id") ?? undefined,
          );
        }
        // #580 — usage 청크 (워커 hps_usage 또는 업스트림 OpenAI usage).
        const streamUsage = usageFromStreamChunk(j);
        if (streamUsage) {
          lastUsage = streamUsage;
          if (typeof j?.model === "string" && j.model) usageModel = j.model;
        }
        if (typeof j?.hps_request_id === "string" && j.hps_request_id) {
          chunkRequestId = j.hps_request_id;
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
      } catch (err) {
        // stream_error 는 위에서 의도적으로 던진 것 — 삼키면 끊긴 응답이
        // 정상처럼 끝난다. 나머지(깨진 JSON 라인)만 무시.
        if (err instanceof ProxyTransportError) throw err;
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

/**
 * #381 — the outcome of a profile fetch, cause included. `null` used to be the
 * only answer, which is why first-run could not tell a participant what went
 * wrong.
 */
export type ProfileFetchResult =
  | { ok: true; profile: ResolvedProfile }
  | { ok: false; failure: ProfileFailure };

/** GET /v1/profile — used by extension host to cache cohort UX config. */
export async function fetchProfileResult(args: FetchProfileArgs): Promise<ProfileFetchResult> {
  const { proxyUrl, token } = args;
  const url = proxyUrl.replace(/\/$/, "") + "/profile";
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // We never reached the server — the token is not the suspect.
    return { ok: false, failure: profileNetworkFailure() };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, failure: classifyProfileFailure(res.status, body) };
  }
  try {
    return { ok: true, profile: (await res.json()) as ResolvedProfile };
  } catch {
    // 200 with an unparseable body — a captive portal / proxy page, not a token
    // problem. Classified as server-side so the copy doesn't blame the paste.
    return { ok: false, failure: classifyProfileFailure(res.status, "") };
  }
}
