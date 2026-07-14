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

// Explicit .ts specifier: this pure-module graph must load under
// `node --experimental-strip-types` (smoke tests), which resolves ESM
// specifiers literally. esbuild + tsc (allowImportingTsExtensions) accept it.
import { safeNavigateUrl } from "./browserControlHelpers.ts";

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
      "http(s)/localhost/file 주소만 허용되며, 실행 전 학생의 승인을 받는다.",
    { url: z.string() },
    async (args) => {
      const raw = typeof args["url"] === "string" ? (args["url"] as string) : "";
      // Belt over suspenders: canUseTool already ran the URL policy, but the
      // handler re-validates so a policy bug can't turn into a hostile scheme.
      const url = safeNavigateUrl(raw);
      if (!url) {
        return {
          content: [{ type: "text", text: `이 주소는 열 수 없어요: ${raw}` }],
          isError: true,
        };
      }
      await host.openBrowser(url);
      return { content: [{ type: "text", text: `브라우저에서 열었어요: ${url}` }] };
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
        return {
          content: [
            { type: "text", text: "열려 있는 브라우저 탭이 없어서 스크린샷을 찍지 못했어요." },
          ],
          isError: true,
        };
      }
      const label = [shot.title, shot.url].filter(Boolean).join(" — ");
      return {
        content: [
          { type: "image", data: shot.imageBase64, mimeType: shot.mimeType || "image/jpeg" },
          ...(label ? [{ type: "text", text: label } as const] : []),
        ],
      };
    },
  );

  const livePreviewStart = factory.tool(
    "live_preview_start",
    "학생 워크스페이스를 로컬 라이브 서버(127.0.0.1)로 서빙하고 통합 브라우저에서 연다. " +
      "파일이 바뀌면 자동 새로고침된다. 서버 URL을 돌려준다.",
    {},
    async () => {
      const url = await host.startLivePreview();
      if (!url) {
        return {
          content: [
            { type: "text", text: "라이브 프리뷰를 시작하지 못했어요 (작업 폴더가 없나요?)." },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: `라이브 프리뷰 시작: ${url}` }] };
    },
  );

  return factory.createSdkMcpServer({
    name: HYPEPROOF_MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [browserOpen, browserScreenshot, livePreviewStart],
  });
}
