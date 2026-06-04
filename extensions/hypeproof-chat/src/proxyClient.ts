import type { AssetScoreChunk, ChatMessage, Citation, ResolvedProfile } from "./protocol";
import { buildProxyHeaders } from "./proxyClientHelpers";

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
      return new ProxyAuthError(
        "expired",
        "토큰이 만료됐어요. 선생님께 새 토큰을 받아서 다시 넣어주세요. 🔑",
      );
    }
    return new ProxyAuthError(
      "missing",
      "토큰이 필요해요. 선생님께 받은 토큰을 넣어주세요. 🔑",
    );
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

interface ProxyChatArgs {
  proxyUrl: string;
  model: string;
  token: string | undefined;
  history: ChatMessage[];
  userText: string;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  /** #173 — fires for each citations chunk in the SSE stream. */
  onCitations?: (citations: Citation[]) => void;
  /** #204 — fires when the worker emits the final 7-asset score chunk. */
  onAssetScore?: (assetScore: AssetScoreChunk) => void;
  coachName?: string;
  coachPersonality?: string;
}

// Streaming OpenAI-compatible chat completion call against the HypeProof Proxy.
// Expects SSE-style `data: {json}\n\n` chunks.
export async function proxyChat(args: ProxyChatArgs): Promise<void> {
  const {
    proxyUrl,
    model,
    token,
    history,
    userText,
    signal,
    onDelta,
    onCitations,
    onAssetScore,
    coachName,
    coachPersonality,
  } = args;

  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userText },
  ];

  const url = proxyUrl.replace(/\/$/, "") + "/chat/completions";
  const headers = buildProxyHeaders({ token, coachName, coachPersonality });

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
    // Generic fallback — never dump raw JSON at a 9-10 year old; the
    // request_id is appended so the operator can DM a single string.
    throw new ProxyTransportError(
      "앗, 잠깐 문제가 생겼어요. 다시 한 번 해보거나 선생님을 불러주세요.",
      rid,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
      if (data === "[DONE]") return;
      try {
        const j = JSON.parse(data);
        if (j?.type === "asset_score" && isAssetScoreChunk(j) && onAssetScore) {
          onAssetScore(j);
          continue;
        }
        const choice = j?.choices?.[0]?.delta;
        const delta = choice?.content;
        if (typeof delta === "string" && delta.length) onDelta(delta);
        // #173 — citations chunk
        const cites = choice?.hps_citations;
        if (Array.isArray(cites) && cites.length > 0 && onCitations) {
          onCitations(cites as Citation[]);
        }
      } catch {
        // ignore malformed line
      }
    }
  }
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
