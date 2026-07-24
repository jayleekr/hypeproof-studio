// #282 Phase 2 slice 2 — PURE builder for the in-process "hypeproof" SDK MCP
// server that exposes the native integrated browser (#309/#278) to the Agent
// SDK coach as tools:
//   browser_open(url)      — open the integrated browser tab (outward action:
//                            URL policy + the approval modal both apply);
//   browser_screenshot()   — capture the active browser tab as an image the
//                            model can SEE (vision) — the coach checking the
//                            student's page is verification_reflex pedagogy;
//   live_preview_start()   — serve the workspace over the #309 live server and
//                            open/refresh the integrated browser at its URL.
//
// PURE means: no `vscode`, no SDK import. Host capabilities (open a tab,
// capture via CDP, start the live server) come in as a BrowserMcpHost the
// orchestration layer (chatPanelProvider) implements, and the SDK factory
// functions (createSdkMcpServer / tool) + the zod module are injected by
// sdkCoach.ts, which loads them dynamically alongside the SDK. That keeps this
// file testable under `node --strip-types` with fakes (extension pure/
// orchestration split convention).
//
// SECURITY MODEL (REQ-M19/M20/M21): the server is registered ONLY when the
// worker profile grants `sdk_tools.browser` (permittedMcpToolsFor — minors are
// stripped unconditionally). Every call still routes through canUseTool
// (allowedTools stays []): browser_open → "ask" (modal), screenshot/preview →
// "allow" once the grant exists. The handlers below re-validate the URL policy
// (safeNavigateUrl) even though canUseTool already did — belt over suspenders.
// #415: browser_open 이 이미 열려 있는 페이지를 요청받으면 아무것도 열지 않으며,
// 그 경우 canUseTool 도 같은 판정(resolveAlreadyOpen)으로 모달을 건너뛴다 —
// "항상 모달"은 **실제로 여는 경우**를 뜻한다. 모든 도구 결과 끝에는 현재 열린
// 페이지 한 줄이 붙어, 모델이 브라우저 상태를 추측하지 않게 한다.

// Explicit .ts specifier: this pure-module graph must load under
// `node --experimental-strip-types` (smoke tests), which resolves ESM
// specifiers literally. esbuild + tsc (allowImportingTsExtensions) accept it.
import { safeNavigateUrl, isSameBrowserUrl } from "./browserControlHelpers.ts";

/** Server key in the SDK `mcpServers` option → tool prefix `mcp__hypeproof__`. */
export const HYPEPROOF_MCP_SERVER_NAME = "hypeproof";

// Full tool names as the model (and canUseTool) sees them.
export const MCP_BROWSER_OPEN = "mcp__hypeproof__browser_open";
export const MCP_BROWSER_SCREENSHOT = "mcp__hypeproof__browser_screenshot";
export const MCP_LIVE_PREVIEW_START = "mcp__hypeproof__live_preview_start";

/** All hypeproof MCP browser tools, granted as one capability unit. */
export const MCP_BROWSER_TOOLS = [
  MCP_BROWSER_OPEN,
  MCP_BROWSER_SCREENSHOT,
  MCP_LIVE_PREVIEW_START,
] as const;

/** MCP CallToolResult content we produce (structural subset of the MCP SDK type). */
export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

/** A captured page for the vision path. imageBase64 has no `data:` prefix. */
export interface BrowserScreenshot {
  imageBase64: string;
  mimeType: string;
  url?: string;
  title?: string;
}

/** 지금 통합 브라우저에 떠 있는 페이지 (#415) — 이미지 없이 URL/제목만. */
export interface BrowserPage {
  url: string;
  title?: string;
}

/**
 * Host capabilities the extension side (chatPanelProvider/extension.ts, which
 * has the `vscode` API) implements. All best-effort: return null / resolve on
 * failure rather than throwing user-facing errors — the handler converts
 * failures into isError tool results the model can react to in Korean.
 */
export interface BrowserMcpHost {
  /** Open (or reveal) the integrated browser at an already-policy-checked URL. */
  openBrowser(url: string): Promise<void>;
  /** Capture the active integrated-browser tab; null when no tab / capture failed. */
  screenshot(): Promise<BrowserScreenshot | null>;
  /** Ensure the #309 live server + open the browser; returns the URL or null. */
  startLivePreview(): Promise<string | null>;
  /**
   * #415 — 지금 열려 있는 페이지를 **가볍게** 읽는다 (스크린샷 금지: URL 하나
   * 알자고 이미지를 뜨는 건 과하다). 탭이 없으면 null.
   *
   * optional 인 이유: 이 능력이 없는 호스트(구버전·테스트 fake)에서도 도구는
   * 그대로 동작해야 한다 — 없으면 예전처럼 무조건 여는 동작으로 폴백한다.
   */
  currentPage?(): Promise<BrowserPage | null>;
}

/**
 * 호스트의 현재 페이지 조회. 세 상태를 구분한다:
 *   `undefined` = 호스트가 이 능력을 지원하지 않음(또는 조회 실패) → 상태를
 *                 모르니 짐작하지 않는다(중복 방지 생략, 상태 줄도 생략);
 *   `null`      = 지원하지만 열린 탭이 없음;
 *   `BrowserPage` = 지금 떠 있는 페이지.
 */
async function readCurrentPage(host: BrowserMcpHost): Promise<BrowserPage | null | undefined> {
  if (typeof host.currentPage !== "function") return undefined;
  try {
    const page = await host.currentPage();
    return page && typeof page.url === "string" && page.url ? page : null;
  } catch {
    // 호스트 조회 실패는 학생에게 보일 에러가 아니다 — 모른다고 취급.
    return undefined;
  }
}

/** `resolveAlreadyOpen` 의 결과 — 판정 + 상태 줄에 필요한 재료를 한 번에. */
export interface AlreadyOpenVerdict {
  /** 정책 통과 후 정규화된 URL (정책 위반이면 null). */
  url: string | null;
  /** 지금 열려 있는 페이지 (undefined = 모름 — 호스트 미지원/조회 실패). */
  current: BrowserPage | null | undefined;
  /** 요청한 URL 이 이미 떠 있는가. 모르면 false (= 평소대로 연다). */
  alreadyOpen: boolean;
}

/**
 * "이 URL, 지금 이미 열려 있나?" (#415) — `browser_open` 핸들러와 canUseTool
 * (승인 모달)이 **같은 함수**를 쓴다.
 *
 * 왜 단일 소스인가: 모달은 핸들러보다 **먼저** 뜬다. 그래서 모달을 건너뛰려면
 * canUseTool 도 같은 판정을 해야 하는데, 두 판정이 갈라지면 "모달 없이 실제로
 * 열리는" 구멍이 생긴다(승인 게이트 우회). 판정을 한 곳에 두어 그 구멍 자체를
 * 없앤다.
 */
export async function resolveAlreadyOpen(
  host: BrowserMcpHost,
  rawUrl: unknown,
): Promise<AlreadyOpenVerdict> {
  const url = safeNavigateUrl(typeof rawUrl === "string" ? rawUrl : "");
  if (!url) return { url: null, current: undefined, alreadyOpen: false };
  const current = await readCurrentPage(host);
  return { url, current, alreadyOpen: !!current && isSameBrowserUrl(current.url, url) };
}

/**
 * 도구 결과 맨 끝에 붙는 브라우저 상태 한 줄 (#415). 도구 **설명**이 아니라
 * **결과**가 모델 컨텍스트에 남기 때문에, 결과에 현재 화면을 적어두는 것이
 * "지금 뭐가 열려 있지?"를 추측으로 메우지 않게 하는 유일한 수단이다.
 */
function pageStateLine(page: BrowserPage | null): string {
  if (!page) return "현재 열린 페이지: 없음";
  return page.title ? `현재 열린 페이지: ${page.url} — ${page.title}` : `현재 열린 페이지: ${page.url}`;
}

/** 상태를 아는 경우에만(=undefined 가 아닐 때만) 상태 줄을 덧붙인다. */
function withPageState(result: McpToolResult, page: BrowserPage | null | undefined): McpToolResult {
  if (page === undefined) return result;
  return { ...result, content: [...result.content, { type: "text", text: pageStateLine(page) }] };
}

/**
 * The two SDK factory functions this builder needs, injected by the caller
 * (sdkCoach.ts passes the real dynamically-imported SDK; tests pass fakes).
 * Signatures are structural — the SDK's own generics live on its side.
 */
export interface SdkMcpFactory {
  tool(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<McpToolResult>,
  ): unknown;
  createSdkMcpServer(options: { name: string; version?: string; tools?: unknown[] }): unknown;
}

/** Minimal zod surface we use (injected — zod is the SDK's peer dep). */
export interface ZodLike {
  string(): unknown;
}

/**
 * Build the in-process "hypeproof" MCP server instance for one coach turn.
 * Register the RESULT under `mcpServers[HYPEPROOF_MCP_SERVER_NAME]` only when
 * the profile grants the browser capability (permittedMcpToolsFor decides —
 * never call this for an ungranted cohort).
 */
export function buildHypeproofMcpServer(
  factory: SdkMcpFactory,
  z: ZodLike,
  host: BrowserMcpHost,
): unknown {
  const browserOpen = factory.tool(
    "browser_open",
    "통합 브라우저에서 URL을 연다. 학생의 라이브 프리뷰나 참고 사이트를 보여줄 때 사용. " +
      "http(s)/localhost/file 주소만 허용되며, 실행 전 학생의 승인을 받는다. " +
      "이미 같은 주소가 열려 있으면 다시 열지 않는다(탭 중복·승인 모달 반복 방지).",
    { url: z.string() },
    async (args) => {
      const raw = typeof args["url"] === "string" ? (args["url"] as string) : "";
      // Belt over suspenders: canUseTool already ran the URL policy, but the
      // handler re-validates so a policy bug can't turn into a hostile scheme.
      const { url, current, alreadyOpen } = await resolveAlreadyOpen(host, raw);
      if (!url) {
        return {
          content: [{ type: "text", text: `이 주소는 열 수 없어요: ${raw}` }],
          isError: true,
        };
      }
      // #415 — 이미 그 페이지가 떠 있으면 열지 않는다. 다시 열면 탭이 중복으로
      // 생기고, 보고 있던 페이지가 리로드돼 스크롤·상태가 날아가고, 턴 예산이
      // 깎인다. (승인 모달은 canUseTool 이 같은 판정으로 이미 건너뛴다.)
      if (alreadyOpen) {
        return withPageState(
          { content: [{ type: "text", text: `이미 브라우저에 열려 있어요 — 다시 열지 않았어요: ${url}` }] },
          current ?? null,
        );
      }
      await host.openBrowser(url);
      // 방금 연 주소가 곧 현재 상태다 (재조회는 탭이 아직 갱신 전일 수 있어
      // 오히려 틀린 상태를 적을 위험이 있다).
      return withPageState(
        { content: [{ type: "text", text: `브라우저에서 열었어요: ${url}` }] },
        { url },
      );
    },
  );

  const browserScreenshot = factory.tool(
    "browser_screenshot",
    "지금 열려 있는 통합 브라우저 탭의 스크린샷을 찍어 이미지로 돌려준다. " +
      "학생이 만든 페이지가 실제로 어떻게 보이는지 확인할 때 사용.",
    {},
    async () => {
      const shot = await host.screenshot();
      if (!shot || !shot.imageBase64) {
        return withPageState(
          {
            content: [
              { type: "text", text: "열려 있는 브라우저 탭이 없어서 스크린샷을 찍지 못했어요." },
            ],
            isError: true,
          },
          await readCurrentPage(host),
        );
      }
      const label = [shot.title, shot.url].filter(Boolean).join(" — ");
      return withPageState(
        {
          content: [
            { type: "image", data: shot.imageBase64, mimeType: shot.mimeType || "image/jpeg" },
            ...(label ? [{ type: "text", text: label } as const] : []),
          ],
        },
        // 캡처한 탭이 곧 현재 페이지. 호스트 재조회 없이 그대로 상태로 쓴다.
        shot.url ? { url: shot.url, title: shot.title } : await readCurrentPage(host),
      );
    },
  );

  const livePreviewStart = factory.tool(
    "live_preview_start",
    "학생 워크스페이스를 로컬 라이브 서버(127.0.0.1)로 서빙하고 통합 브라우저에서 연다. " +
      "파일이 바뀌면 자동 새로고침된다. 브라우저까지 열리므로 뒤이어 browser_open 을 부를 필요가 없다.",
    {},
    async () => {
      const url = await host.startLivePreview();
      if (!url) {
        return withPageState(
          {
            content: [
              { type: "text", text: "라이브 프리뷰를 시작하지 못했어요 (작업 폴더가 없나요?)." },
            ],
            isError: true,
          },
          await readCurrentPage(host),
        );
      }
      // #415 — "라이브 프리뷰 시작: <url>" 만 돌려주면 모델은 이걸 "서버 주소를
      // 받았다"로 읽고 곧바로 browser_open 을 부른다(2026-07-24 실사용에서 탭이
      // 두 개 열리고 승인 모달로 턴이 2분 멈췄다). 결과 문장이 브라우저까지
      // 열렸다는 사실을 직접 말해야 후속 open 이 필요 없어진다.
      return withPageState(
        { content: [{ type: "text", text: `라이브 프리뷰를 시작하고 브라우저에 열었어요: ${url}` }] },
        { url },
      );
    },
  );

  return factory.createSdkMcpServer({
    name: HYPEPROOF_MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [browserOpen, browserScreenshot, livePreviewStart],
  });
}
