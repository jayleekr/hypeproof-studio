// POST /v1/chat/completions
//
// Pipeline:
//   1. Pull Bearer token (HMAC v2)
//   2. Verify signature + expiry
//   3. Load profile from token.p
//   4. Look up cohort active_session in KV
//   5. Ensure user is in roster + within session window
//   6. Translate OpenAI body → Anthropic with profile.system_prompt
//   7. Call Anthropic streaming endpoint
//   8. Transform SSE → OpenAI deltas, forward to client
//   9. Log usage to Analytics Engine + D1

import { Hono } from "hono";
import {
  resolveProvider,
  providerKey,
  speaksAnthropicWire,
  resolveWorkerVersion,
  type Env,
  type LLMProvider,
} from "../env";
import { bearer, verify, TokenError, type TokenPayload } from "../lib/tokens";
import { gateChatRequest } from "../lib/chat-gate";
import { resolveProfile } from "../lib/modules";
import { translate, translateOpenAI, type CoachContext } from "../lib/translate";
import { callAnthropicResilient } from "../lib/anthropic";
import { glmUpstreamUrl } from "../lib/glm";
import { callGeminiResilient } from "../lib/gemini";
import { callOpenAI } from "../lib/openai";
import { listWorlds, renderWorld, renderEngine, renderEngineFor } from "../skeletons/kids-quest/worlds";
import {
  extractTrialHeaders,
  lastUserMessageText,
  type TrialHeaders,
} from "../lib/chat-extract";
import { recordTurnIfOwned } from "../lib/storage";
import { transformStream, passThroughOpenAIStream } from "../lib/sse";
import { scoreTurnAssets } from "../lib/asset-scorer";
import {
  logChat,
  persistUsage,
  upstreamErrorKind,
  ERROR_KIND,
  type ChatLog,
} from "../lib/analytics";
import {
  isMinorCohort,
  screenText,
  reportModerationHit,
  MODERATION_BLOCK_MESSAGE_KO,
} from "../lib/moderation";
import { runDeepHealth } from "../cron/health.ts";

// #358 — request-shaped upstream 4xx that /v1/chat passes through with its REAL
// status + a sanitized OpenAI-shaped error `type`, instead of masking it as a
// generic 502. Sibling of routes/messages.ts PASSTHROUGH_4XX (Anthropic shape).
// The type guard narrows the status to a literal union so Hono's c.json accepts
// it as a StatusCode. 413 is the load-bearing case: an oversized pasted image
// pushes the body past the region-pinned Anthropic proxy's limit.
const CHAT_PASSTHROUGH_4XX = {
  400: "invalid_request_error",
  413: "request_too_large",
  422: "invalid_request_error",
  429: "rate_limit_error",
} as const;

function isChatPassthrough4xx(status: number): status is keyof typeof CHAT_PASSTHROUGH_4XX {
  return status in CHAT_PASSTHROUGH_4XX;
}

export const chat = new Hono<{ Bindings: Env }>();

// Task C (docs/plan/dag.yaml) — `version` used to be a hardcoded "0.1.0"
// literal that never changed: the same defect class as #684 (task B), a
// constant masquerading as an observation. resolveWorkerVersion() (../env)
// reports the real w* tag injected at deploy, or "unknown" — never a crash,
// never an empty string.
chat.get("/health", (c) =>
  c.json({
    ok: true,
    service: "hypeproof-studio-api",
    version: resolveWorkerVersion(c.env),
    env: c.env.ENVIRONMENT,
  }),
);

// Deep health probe (S-05 / #51). Live-tests every external dependency:
// the active LLM provider (incl. anthropic proxy URL when set), KV, D1.
// Used by:
//   - the 15-min heartbeat cron (#45) when it needs richer diagnostics
//   - operator console during 보아치과 티저 세션 (Jay polls)
//   - manual `wrangler tail` smoke before deploy
//
// Auth: admin Basic, OR an internal "x-cron-trigger: true" header (set by
// the scheduled() entry point — see worker/src/index.ts). This keeps the
// endpoint cheap to call from cron without burning the chat token path.
chat.get("/health/deep", async (c) => {
  // Lightweight auth: admin password OR internal cron flag. We deliberately
  // don't accept session tokens here — this is operator-only, not a path the
  // student app calls.
  const cronFlag = c.req.header("x-cron-trigger") === "true";
  if (!cronFlag) {
    const want = c.env.HPS_ADMIN_PASSWORD;
    if (!want) return c.json({ error: "admin not configured" }, 503);
    const authz = c.req.header("authorization") ?? "";
    const m = /^Basic\s+(.+)$/i.exec(authz);
    if (!m || !m[1]) return c.json({ error: "auth required" }, 401);
    const decoded = atob(m[1]);
    const [, pass] = decoded.split(":", 2);
    if (pass !== want) return c.json({ error: "auth required" }, 401);
  }
  const result = await runDeepHealth(c.env);
  return c.json(result, result.ok ? 200 : 503);
});

// ---------------------------------------------------------------------------
// GET /v1/profile
//
// Returns the UX-relevant subset of the participant's profile so the chat
// extension can render cohort-specific chips/hints/coach flow without the
// extension needing to know about cohorts at compile time.
//
// The system_prompt is NOT included — only the worker injects that.
//
// #381 — every failure here carries an `error.code`. This is the FIRST call a
// new participant's app makes, so it is also the only place the app can learn
// why a paste failed. Without a code the client can only say "확인이 안 돼요",
// which is what blocked first-run: expired / wrong-role / unknown-cohort were
// indistinguishable. Codes mirror gateChatRequest so the two paths agree.
// ---------------------------------------------------------------------------


// GET /v1/worlds/:id — 게스트의 세상 사전 완성본 HTML (2026-08-19).
// 학생 토큰이면 누구나. 코치가 만들 필요 없이 Studio 가 즉시 띄운다.
// GET /v1/worlds/:id/engine.js — **그 세상만의** 엔진 (2026-08-20).
// 공용본에는 9개 세상 스프라이트가 다 들어 있어, 코치가 읽으면 남의 세상이 섞인다
// (실기기: 초코 세상에서 얼음). 이 경로는 그 세상이 쓰는 그림만 남겨 내려준다.
chat.get("/worlds/:id/engine.js", async (c) => {
  const auth = await authenticateToken(c.req.header("authorization"), c.env.HPS_SIGNING_SECRET);
  if (!auth.ok) return c.json({ error: { message: auth.message, type: "auth", code: auth.code, request_id: c.get("requestId") } }, 401);
  const js = renderEngineFor(c.req.param("id"));
  if (!js) return c.json({ error: { message: "unknown world", type: "config", code: "unknown_world", request_id: c.get("requestId") } }, 404);
  return new Response(js, { status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
});

// GET /v1/worlds/engine.js — 9개 세상이 공유하는 도트 엔진 + 스프라이트 (#629).
// Studio 가 index.html 과 같은 폴더에 저장하고, 세상 HTML 이 <script src="engine.js"> 로 부른다.
chat.get("/worlds/engine.js", async (c) => {
  const auth = await authenticateToken(c.req.header("authorization"), c.env.HPS_SIGNING_SECRET);
  if (!auth.ok) return c.json({ error: { message: auth.message, type: "auth", code: auth.code, request_id: c.get("requestId") } }, 401);
  return new Response(renderEngine(), { status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
});

chat.get("/worlds/:id", async (c) => {
  const auth = await authenticateToken(c.req.header("authorization"), c.env.HPS_SIGNING_SECRET);
  if (!auth.ok) return c.json({ error: { message: auth.message, type: "auth", code: auth.code, request_id: c.get("requestId") } }, 401);
  const id = c.req.param("id");
  let html: string | null = null;
  try { html = renderWorld(id); } catch (e) { return c.json({ error: { message: String(e), type: "config", code: "world_render_failed", request_id: c.get("requestId") } }, 500); }
  if (!html) return c.json({ error: { message: "unknown world", type: "config", code: "unknown_world", request_id: c.get("requestId") } }, 404);
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
});

chat.get("/profile", async (c) => {
  const auth = await authenticateToken(c.req.header("authorization"), c.env.HPS_SIGNING_SECRET);
  if (!auth.ok) {
    return c.json(
      {
        error: {
          message: auth.message,
          type: "auth",
          code: auth.code,
          request_id: c.get("requestId"),
        },
      },
      401,
    );
  }
  // An issuer (instructor) token pasted into the student field used to fall
  // through to `unknown profile` (400) because issuer payloads carry no usable
  // `p`. Name it: chat-gate already rejects issuer tokens with `wrong_role`.
  if (auth.payload.role === "issuer") {
    return c.json(
      {
        error: {
          message: "issuer tokens cannot open a participant session",
          type: "auth",
          code: "wrong_role",
          request_id: c.get("requestId"),
        },
      },
      401,
    );
  }
  const resolved = await resolveProfile(c.env, auth.payload.p);
  if (!resolved) {
    return c.json(
      {
        error: {
          message: "unknown profile",
          type: "config",
          code: "unknown_profile",
          request_id: c.get("requestId"),
        },
      },
      400,
    );
  }
  const { profile, module } = resolved;

  return c.json({
    profile_id: profile.id,
    // dag task H — which curriculum module this seat is running. Observability
    // only (the prompt itself never leaves the worker): lets e2e/observe and
    // the instructor tell "which curriculum" without a D1 query.
    module: { version: module.version, source: module.source, fallback: module.fallback ?? null },
    display_name: profile.display_name,
    language: profile.audience.language,
    series_index: profile.session.series_index,
    series_total: profile.session.series_total,
    assets_focus: profile.assets_focus,
    welcome: profile.welcome,
    ux: profile.ux,
    publishing: { enabled: profile.publishing.enabled, strategy: profile.publishing.strategy },
    // #596 — 세션 로그 업로드 opt-in. 클라이언트는 이걸로 "기록 보내기" UI 를
    // 낼지만 판단한다 — 강제는 어차피 PUT /v1/logs 가 서버에서 한다(fail closed).
    analytics: { upload_session_logs: profile.analytics.upload_session_logs === true },
    preview: profile.preview,
    // #422 — the cohort's on-disk workspace folder. The chat extension opens
    // this folder on onboarding (and GitHub Pages publishing pushes it later).
    // Absent → the client keeps its legacy default. Exposing it here is what
    // lets the client stop hardcoding "~/HypeProofGames" for every cohort.
    workspace_root: profile.sandbox.workspace_root ?? null,
    // 2026-08-19 — 게스트의 세상 사전 완성본 목록. kids-quest tier 에서만. 확장이
    // 아이의 "🐕 초코 세상에 가볼래"를 이 목록으로 매칭해 GET /v1/worlds/:id 를 즉시 띄운다.
    worlds: profile.game?.template_tier === "kids-quest" ? listWorlds() : undefined,
    // #278 — input capabilities, default off (minor-safe). Drives whether the
    // chat panel exposes "페이지를 코치에게" / image paste.
    input: {
      page_context: profile.input?.page_context === true,
      image_paste: profile.input?.image_paste === true,
    },
    // #278 Phase 3 — the coach's browser control loop. The host runs the loop +
    // CDP executor only when enabled; max_iterations caps the loop.
    browser_control: {
      enabled: profile.browser_control?.enabled === true,
      max_iterations: profile.browser_control?.max_iterations ?? 8,
    },
    // #306 — per-cohort hardened native-browser session. Minor cohorts send
    // mode="safe"; the Studio host maps it to hypeproof.browser.safeSession so
    // the integrated browser uses the locked-down persist:hp-safe session.
    // Default browse (adult), so unchanged for existing cohorts.
    browser_session: {
      mode: profile.browser_session?.mode ?? "browse",
      allowlist: profile.browser_session?.allowlist ?? [],
    },
    // #320 — minors compliance flag (REQ-O1). True when the profile is
    // explicitly flagged OR its age_range upper bound is under 18. Lets the
    // client render minor-specific UX (AI disclosure etc.) without hardcoding
    // cohort knowledge.
    minor_cohort: isMinorCohort(profile),
    // Drives the chat panel's tone (game vs search-webapp UI copy) (#159).
    game: { template_tier: profile.game.template_tier },
    // #282 — expose the cohort's provider-tool opt-in so the Studio Agent SDK
    // coach grants WebSearch only where the profile explicitly enabled it
    // (the profile owns tool policy; the client never infers it).
    tools: { web_search: profile.tools?.web_search === true },
    // #282 Phase 2 — Agent SDK workspace tools. Profile owns the policy
    // (ADR 0003); absent flags normalize to false (fail closed, minor-safe).
    sdk_tools: {
      read: profile.sdk_tools?.read === true,
      write: profile.sdk_tools?.write === true,
      // #282 P2 slice 2 — native-browser MCP tools (browser_open/screenshot/
      // live_preview). Adults only; minors stay false until safe-session
      // ships (#306/#318) — harness child_sdk_browser FAIL enforces it.
      browser: profile.sdk_tools?.browser === true,
      // #282 P2 slice 3 — read-only 코드리뷰어/리서처 subagents. Adults only;
      // minors stay false until a pedagogy decision lands — harness
      // child_sdk_subagents FAIL enforces it.
      subagents: profile.sdk_tools?.subagents === true,
      // epic #431 — shell. This serializer is the LAST hop: a profile can set
      // `shell: true` and it still never reaches the client unless it is listed
      // here, and the client's permittedToolsFor reads only what arrives. The
      // whole grant is inert without this line (found by probing prod after the
      // deploy — the profile said true, the API served four keys).
      shell: profile.sdk_tools?.shell === true,
    },
    // #371/#282 — profile-requested coach runtime. Only an ADULT cohort that
    // opts into sdk_tools may request "agent-sdk" (real file Read/Write/Edit →
    // durable task/rubric tracking). Minors are force-pinned to proxy here so
    // a profile mistake can never route a child to the file/exec-capable
    // runtime. Absent → proxy. The client still gates every tool via
    // canUseTool and honors the machine-scoped runtime setting.
    // 2026-08-11 결정 — 미성년 코호트도 프로필이 명시적으로 opt-in 하면
    // agent-sdk 에 도달한다. SK 아동 워크숍의 커리큘럼이 "코치가 워크스페이스의
    // 파일을 읽고 고친다" 를 전제로 바뀌었고, 그러려면 파일 도구가 실행될
    // 런타임이 필요하다. 이전에는 여기서 무조건 proxy 로 핀했다.
    //
    // **무엇이 바뀌지 않았는가 (중요):**
    //   - 모더레이션 — 인바운드/아웃바운드 스크린은 isMinorCohort 로 그대로 돈다
    //     (이 파일 322·513행, messages.ts 298·444행). 이 변경과 무관한 계층이다.
    //   - 도구 범위 — shell·browser·subagents 는 아동 프로필에 여전히 없고
    //     하네스가 hard fail 로 막는다. 열린 것은 read/write 뿐이다.
    //   - 경로 봉쇄 + 승인 모달 — 모든 툴 호출은 canUseTool 을 지나고
    //     워크스페이스 밖 경로는 거부된다(evaluateSdkToolUse).
    //
    // 즉 "미성년은 무조건 proxy" 가 아니라 "미성년은 프로필이 명시하지 않으면
    // proxy" 로 바뀐 것이다. 프로필에 sdk_tools 를 두지 않은 아동 코호트는
    // 이전과 동작이 완전히 같다.
    coach_runtime: profile.coach_runtime === "agent-sdk" ? "agent-sdk" : "proxy",
  });
});

interface AuthResult {
  ok: boolean;
  payload: TokenPayload;
  message: string;
  /**
   * #381 — TokenError code ("expired" | "signature" | "malformed" | …) so
   * /v1/profile can tell the app WHICH failure it was. "unknown" when the
   * throw was not a TokenError (never surfaced verbatim; see #257).
   */
  code?: string;
}

function decodeHeader(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function authenticateToken(
  authHeader: string | null | undefined,
  secret: string,
): Promise<AuthResult> {
  const token = bearer(authHeader);
  if (!token) {
    return {
      ok: false,
      payload: {} as TokenPayload,
      message: "missing bearer token",
      code: "missing",
    };
  }
  try {
    const payload = await verify(token, secret);
    return { ok: true, payload, message: "" };
  } catch (err) {
    // #257 — only TokenError prose is curated for users; anything else
    // (crypto/config failures) stays server-side.
    const msg = err instanceof TokenError ? err.message : "invalid token";
    const code = err instanceof TokenError ? err.code : "unknown";
    return { ok: false, payload: {} as TokenPayload, message: msg, code };
  }
}


chat.post("/chat/completions", async (c) => {
  const env = c.env;
  const startedAt = Date.now();

  // 1-5b. Auth → revocation → profile → session/roster → kill-switch.
  // Shared with POST /v1/messages (#282) via gateChatRequest so the two
  // LLM-serving routes enforce identical trust gates.
  const gate = await gateChatRequest(c);
  if (!gate.ok) return gate.response;
  const { payload, profile, session, module } = gate;

  // #684 — accounting is declared HERE, above every failure exit, not down at
  // the success path where it used to live.
  //
  // The old shape wrote `status: 200` as a literal and only ran on the happy
  // path, so seven weeks of production (16,564 rows, 2026-07-14..08-23) held
  // status=200 and nothing else, and a student whose every turn failed looked
  // exactly like a student who never opened Studio. A row with a real status
  // is the only thing that tells those two apart.
  //
  // `modelLabel` starts at the profile's declared model so a failure that dies
  // before provider selection still attributes to something truthful; the
  // upstream branches overwrite it with the id actually sent.
  let modelLabel: string = profile.model.default;
  const mkLog = (
    tokens_in: number,
    tokens_out: number,
    cache_read: number,
    cache_create: number,
    status = 200,
    error_kind: string | null = null,
  ): ChatLog => ({
    cohort_id: payload.c,
    user_id: payload.u,
    profile_id: profile.id,
    model: modelLabel,
    status,
    error_kind,
    tokens_in,
    tokens_out,
    cache_read,
    cache_create,
    latency_ms: Date.now() - startedAt,
    // task H — the curriculum that produced this turn (lib/modules.ts).
    module_version: module.version,
    module_fallback: module.fallback?.pinned ?? null,
  });
  const record = (log: ChatLog) => {
    logChat(env, log);
    c.executionCtx.waitUntil(persistUsage(env, { ...log, session_id: session.session_id }));
  };
  /** #684 — a turn that never produced tokens. The row is the whole point. */
  const recordFailure = (status: number, error_kind: string) =>
    record(mkLog(0, 0, 0, 0, status, error_kind));
  // task H — every response names its curriculum, so a spool/e2e can attribute
  // without the ledger. Set once here for the c.json paths; the raw streaming
  // Response below carries it explicitly (Hono does not merge c.header there).
  c.header("x-hps-module", module.version);
  if (module.fallback) c.header("x-hps-module-fallback", module.fallback.pinned);

  // 6. Build the upstream request (with optional coach context from headers)
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    recordFailure(400, ERROR_KIND.BAD_REQUEST);
    return c.json({ error: { message: "bad json body", type: "request" } }, 400);
  }
  const coach: CoachContext = {
    name: decodeHeader(c.req.header("x-hps-coach-name")),
    personality: decodeHeader(c.req.header("x-hps-coach-personality")),
    // #507 — 프록시 경로의 브라우저 루프도 같은 주소를 알아야 한다. 클라이언트는
    // 주소만 보내고, 문구는 워커가 만든다(주입 통로가 되지 않게).
    previewUrl: decodeHeader(c.req.header("x-hps-preview-url")),
  };

  // #9c trace hook — client opts in by POST /v1/trace/event{trialStart} and
  // sending the returned trial_id (+ a per-turn idx) as headers. Without
  // headers, chat continues to work as before; no turn row written.
  const trial: TrialHeaders | null = extractTrialHeaders((h) => c.req.header(h) ?? null);
  const promptText = lastUserMessageText(body);
  const promptChars = promptText.length;
  const persistBody = profile.analytics.log_user_messages === true;

  // #320 — gateway moderation, MINOR cohorts only (REQ-O2). Deterministic
  // conservative screen of the latest user text BEFORE any upstream call:
  // a blocked turn costs zero tokens and never reaches the model. Adult
  // cohorts skip this entirely (REQ-O4 — no behavior change). This covers
  // the inbound side of BOTH stream and non-stream requests; outbound
  // streaming moderation is a documented follow-up (we do not buffer
  // streams — see lib/moderation.ts header).
  if (isMinorCohort(profile)) {
    const hit = screenText(promptText);
    if (hit) {
      reportModerationHit(
        env,
        c.get("requestId"),
        { cohort_id: payload.c, user_id: payload.u, profile_id: profile.id, direction: "inbound" },
        hit,
      );
      // #684 — a blocked turn costs zero tokens but is NOT a non-event: a
      // child hitting the filter repeatedly is exactly the seat an instructor
      // needs to see. It has its own moderation datapoint (#320), but that
      // dataset is not the per-seat ledger the board reads.
      recordFailure(400, ERROR_KIND.MODERATION_BLOCK);
      return c.json(
        {
          error: {
            message: MODERATION_BLOCK_MESSAGE_KO,
            type: "moderation_block",
            category: hit.category,
            request_id: c.get("requestId"),
          },
        },
        400,
      );
    }
  }

  // Pick the upstream LLM. 우선순위는 **프로필 → 배포 기본값** 이다.
  //
  // 쓰임새마다 맞는 모델이 다르다 — 아이들 수업은 싸고 빠른 쪽, 고위험 산출물은 비싸도
  // 정확한 쪽. 배포 전체를 한 모델로 묶을 이유가 없어서, 프로필이 `model.provider` 를
  // 선언하면 그 요청만 그쪽으로 나간다. 선언하지 않은 프로필은 지금까지와 똑같이
  // LLM_PROVIDER 를 따른다 (기존 배포의 동작이 바뀌지 않는다).
  //
  // translate / translateOpenAI both drop client system+tool messages — the
  // trust model is identical either way.
  let provider: LLMProvider;
  let apiKey: string;
  try {
    const pinned = profile.model.provider;
    if (pinned) {
      provider = pinned;
      apiKey = providerKey(env, pinned);
    } else {
      ({ provider, apiKey } = resolveProvider(env));
    }
  } catch (err) {
    // #257 — config prose (env var names, provider wiring) stays in logs.
    console.error(`[${c.get("requestId")}] provider config error:`, err);
    recordFailure(502, ERROR_KIND.CONFIG);
    return c.json(
      {
        error: {
          message: "LLM provider is not configured — contact the operator",
          type: "config",
          request_id: c.get("requestId"),
        },
      },
      502,
    );
  }

  const stream = (body as any)?.stream === true;
  let upstream: Response;
  // modelLabel is hoisted above (#684) so failure rows still name a model.
  let fellBack = false;
  try {
    if (provider === "gemini") {
      const gBody = translateOpenAI(body as any, profile, coach, "gemini");
      gBody.stream = stream;
      if (stream) gBody.stream_options = { include_usage: true };
      // Retry transient 503s, then fall back to gemini-2.5-flash.
      const g = await callGeminiResilient(gBody, apiKey);
      upstream = g.response;
      modelLabel = g.model;        // analytics + response reflect the real model
      fellBack = g.fellBack;
    } else if (provider === "openai") {
      // OpenAI is the canonical OpenAI schema → translateOpenAI handles
      // system-prompt injection + alias→openai model id; the body is passed
      // straight through.
      const oBody = translateOpenAI(body as any, profile, coach, "openai");
      oBody.stream = stream;
      if (stream) oBody.stream_options = { include_usage: true };
      modelLabel = oBody.model;
      upstream = await callOpenAI(oBody, apiKey, undefined, c.env.OPENAI_BASE_URL);
    } else if (provider === "glm") {
      // GLM (Z.ai) — Anthropic 호환 경로라 **번역기와 스트림 처리를 그대로 재사용**한다.
      // 새로 쓰는 것은 URL 하나뿐이다 (lib/glm.ts 에 실측 근거를 적어 뒀다).
      //
      // Anthropic 프록시/시크릿은 붙이지 않는다 — 그건 지역 차단된 api.anthropic.com
      // 우회용이고 z.ai 에는 해당이 없다. 붙이면 프록시가 403 을 낸다.
      //
      // 캐시는 자동이 아니다: cache_control 을 명시해야 걸린다 (실측 81% 절감).
      // 그 지시를 넣는 것은 translate() 쪽 일이라 이 wrapper 범위 밖이다 — #545.
      const gBody = translate(body as any, profile, coach, "glm");
      gBody.stream = stream;
      modelLabel = gBody.model;
      upstream = await callAnthropicResilient(gBody, apiKey, { url: glmUpstreamUrl() });
    } else {
      // anthropic — Messages API (different schema; transformStream handles it).
      // Route through the optional region-pinned proxy when set, otherwise
      // call api.anthropic.com directly. The proxy is passthrough (same key,
      // same headers, same SSE shape).
      //
      // No clientBeta threading here (#282 — unlike routes/messages.ts):
      // /v1/chat clients speak the OpenAI schema, never send an
      // anthropic-beta header or beta-gated body fields, and translate()
      // builds the Anthropic body from scratch — only the worker's own
      // prompt-caching beta is needed upstream.
      const aBody = translate(body as any, profile, coach);
      aBody.stream = stream;
      modelLabel = aBody.model;
      // #373 — retry transient 429/5xx (same model, bounded backoff) so a
      // burst from the shared org token pool during the 23-concurrent SK
      // Biopharm class is absorbed invisibly instead of dying on a child's
      // screen. The gemini branch above already had callGeminiResilient; this
      // brings the prod (anthropic) path to parity. No model fallback here.
      upstream = await callAnthropicResilient(aBody, apiKey, {
        url: env.ANTHROPIC_PROXY_URL,
        proxySecret: env.ANTHROPIC_PROXY_SECRET,
      });
    }
  } catch (err) {
    // #257 — translation/fetch errors can embed upstream URLs, header names,
    // or body shapes. Log full, return generic.
    console.error(`[${c.get("requestId")}] upstream call failed:`, err);
    // #684 — fetch() threw, so there is NO upstream status to observe. The row
    // records a synthetic 502 (our gateway could not reach upstream) rather
    // than the 400 the client is handed: the column answers "what happened
    // upstream", and calling a network outage a client error would repeat the
    // original defect one layer down.
    recordFailure(502, ERROR_KIND.UPSTREAM_UNREACHABLE);
    return c.json(
      { error: { message: "upstream request failed", type: "request", request_id: c.get("requestId") } },
      400,
    );
  }

  // 7. Upstream guard
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    // #257 — the upstream error body (provider prose, key hints, quota info)
    // goes to logs only; the client learns the status code + request_id.
    console.error(`[${c.get("requestId")}] upstream ${upstream.status}: ${text.slice(0, 500)}`);
    // #684 — the REAL upstream status, before the 502 masking below. This is
    // the row the instructor board reads; masking every 5xx as 502 here would
    // throw away the only place the true status survives.
    recordFailure(upstream.status, upstreamErrorKind(upstream.status));
    // #358 — pass a request-shaped 4xx through with its REAL status + sanitized
    // type so the webview can show a specific, friendly message (esp. 413 →
    // "이미지가 너무 커요") instead of the generic card. Raw upstream prose stays
    // in logs only. Everything else (5xx / network) is OUR gateway failure → 502.
    if (isChatPassthrough4xx(upstream.status)) {
      return c.json(
        {
          error: {
            message: `upstream error (status ${upstream.status})`,
            type: CHAT_PASSTHROUGH_4XX[upstream.status],
            request_id: c.get("requestId"),
          },
        },
        upstream.status,
      );
    }
    return c.json(
      {
        error: {
          message: `upstream error (status ${upstream.status})`,
          type: "upstream",
          request_id: c.get("requestId"),
        },
      },
      502,
    );
  }

  if (!stream) {
    // Non-streaming: normalize either provider's body to an OpenAI response.
    const j = (await upstream.json()) as any;
    let text = "";
    let tin = 0;
    let tout = 0;
    let cr = 0;
    let cc = 0;
    let finish = "stop";
    if (speaksAnthropicWire(provider)) {
      // Anthropic Messages API native shape (anthropic + glm)
      text = (j.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      finish = j.stop_reason ?? "stop";
      tin = j.usage?.input_tokens ?? 0;
      tout = j.usage?.output_tokens ?? 0;
      cr = j.usage?.cache_read_input_tokens ?? 0;
      cc = j.usage?.cache_creation_input_tokens ?? 0;
    } else {
      // OpenAI-shape response (gemini OpenAI-compat endpoint + native openai)
      text = j.choices?.[0]?.message?.content ?? "";
      finish = j.choices?.[0]?.finish_reason ?? "stop";
      tin = j.usage?.prompt_tokens ?? 0;
      tout = j.usage?.completion_tokens ?? 0;
    }
    // #320 — outbound moderation, MINOR cohorts, non-stream only (REQ-O3).
    // The blocked text never reaches the client and the trace turn body is not
    // persisted. Streaming outbound is the documented follow-up.
    //
    // The screen runs BEFORE the usage row is written (dag task L). It used to
    // run after `record(mkLog(...))` with the default 200, so an outbound block
    // wrote a healthy-looking 200 carrying real tokens: a child whose every
    // turn was refused emitted normal-cadence 200s and rendered on the
    // instructor board as one of the MORE active seats. That is the exact
    // failure #684 exists to eliminate, surviving on one of the two moderation
    // paths — the inbound path has always written 400/MODERATION_BLOCK.
    //
    // Both directions now write the same row shape, because the student
    // experience is the same ("I typed something and the coach refused me").
    // The tokens stay on the row and stay billable (USAGE_BILLABLE counts
    // spend, not success) — they were genuinely charged by upstream, and
    // zeroing them to make the board look right would falsify the ledger.
    const outboundHit = isMinorCohort(profile) ? screenText(text) : null;
    if (outboundHit) {
      record(mkLog(tin, tout, cr, cc, 400, ERROR_KIND.MODERATION_BLOCK));
      reportModerationHit(
        env,
        c.get("requestId"),
        { cohort_id: payload.c, user_id: payload.u, profile_id: profile.id, direction: "outbound" },
        outboundHit,
      );
      return c.json(
        {
          error: {
            message: MODERATION_BLOCK_MESSAGE_KO,
            type: "moderation_block",
            category: outboundHit.category,
            request_id: c.get("requestId"),
          },
        },
        400,
      );
    }
    record(mkLog(tin, tout, cr, cc));
    // #9c trace: persist turn meta + optional R2 body. Fire-and-forget — must
    // not block the response. Skipped when client did not send trial headers.
    if (trial) {
      c.executionCtx.waitUntil(
        recordTurnIfOwned(
          env,
          {
            trial_id: trial.trial_id,
            turn_idx: trial.turn_idx,
            prompt_chars: promptChars,
            response_chars: text.length,
            tokens_in: tin,
            tokens_out: tout,
            latency_ms: Date.now() - startedAt,
            model: modelLabel,
          },
          payload.u,
          payload.c,
          persistBody
            ? { persistBody: true, body: { prompt: promptText, response: text } }
            : {},
        ).catch((err) => console.error("recordTurnIfOwned (non-stream) failed:", err)),
      );
    }
    c.header("x-hps-model", modelLabel);
    if (fellBack) c.header("x-hps-fallback", "1");
    return c.json({
      id: j.id ?? "chatcmpl-hps",
      object: "chat.completion",
      model: modelLabel,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finish }],
      usage: {
        prompt_tokens: tin,
        completion_tokens: tout,
        total_tokens: tin + tout,
      },
    });
  }

  // 8. Streaming: Gemini + OpenAI both emit OpenAI chat.completion.chunk SSE
  //    (passthrough + usage tap); Anthropic events are transformed to OpenAI
  //    chunks.
  let streamedAssistantText = "";
  // #684 — the "중단" case from the issue. The stream opened 200, so the client
  // already has a status; the only place the gateway learns the turn actually
  // died is this hook, which the SSE layer fires BEFORE onUsage.
  let streamFailed = false;
  const streamOptions = {
    // #257 — lets the SSE layer emit a sanitized stream_error carrying the
    // request_id instead of raw internal prose.
    requestId: c.get("requestId"),
    onTextDelta: (delta: string) => {
      streamedAssistantText += delta;
    },
    onStreamError: () => {
      streamFailed = true;
    },
    onBeforeDone: () => ({
      type: "asset_score",
      ...scoreTurnAssets(streamedAssistantText),
    }),
  };
  const onUsage = (u: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  }) => {
    // Tokens produced before the break are KEPT on the row: they were really
    // spent, so they are really billed (USAGE_BILLABLE counts spend, not
    // success — dag task L). The 502 is what makes the seat render as a
    // failure on the board; the two answers no longer have to agree.
    record(
      mkLog(
        u.input_tokens,
        u.output_tokens,
        u.cache_read_input_tokens,
        u.cache_creation_input_tokens,
        streamFailed ? 502 : 200,
        streamFailed ? ERROR_KIND.STREAM_INTERRUPTED : null,
      ),
    );
    // #9c trace: streaming turn meta. response_chars=0 here — stream-body
    // capture (R2 turn_body) requires a stream tee + per-provider SSE parser
    // and is intentionally a follow-up; the meta still feeds Efficiency +
    // Iteration scoring.
    if (trial) {
      c.executionCtx.waitUntil(
        recordTurnIfOwned(
          env,
          {
            trial_id: trial.trial_id,
            turn_idx: trial.turn_idx,
            prompt_chars: promptChars,
            response_chars: 0,
            tokens_in: u.input_tokens,
            tokens_out: u.output_tokens,
            latency_ms: Date.now() - startedAt,
            model: modelLabel,
          },
          payload.u,
          payload.c,
        ).catch((err) => console.error("recordTurnIfOwned (stream) failed:", err)),
      );
    }
  };

  const outStream = speaksAnthropicWire(provider)
    ? transformStream(upstream.body, modelLabel, onUsage, streamOptions)
    : passThroughOpenAIStream(upstream.body, onUsage, streamOptions);

  const streamHeaders: Record<string, string> = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
    "x-hps-model": modelLabel,
    "x-hps-module": module.version,
    ...(module.fallback ? { "x-hps-module-fallback": module.fallback.pinned } : {}),
    // #580 — raw Response 반환은 request-id 미들웨어의 c.header() 를 우회한다
    // (Hono 는 핸들러가 만든 Response 에 미들웨어 헤더를 합치지 않는다). 4xx
    // (c.json) 경로에만 있던 x-request-id 를 스트리밍 200 에도 직접 싣는다 —
    // 클라이언트 스풀의 usage requestKey 와 #64 신고 플로우가 이 값을 쓴다.
    "x-request-id": c.get("requestId"),
  };
  if (fellBack) streamHeaders["x-hps-fallback"] = "1";
  return new Response(outStream, { headers: streamHeaders });
});
