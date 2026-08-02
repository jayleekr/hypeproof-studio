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
// #457 — 검사(inspect) 3종. 스크린샷만으로는 "버튼이 실제로 눌리는가"를 알 수
// 없다. 큐시트 Loop Engineering(20:05–20:35)은 "검사 → 수정 → 재검사" 반복이고,
// 클릭이 없으면 그 검사가 반쪽이다. 2026-07-26 실사용에서 코치가 "제가 직접
// 클릭 도구가 없어서 … 직접 눌러봐 달라고 부탁드릴게요"라며 참가자에게
// 떠넘겼고 루브릭 "직접 눌러보며 확인"이 끝내 못 채워졌다.
// CDP 구현은 이미 browserControl.ts 에 있다(프록시 경로 #278). 여기서는 SDK
// 경로에 노출만 한다 — 새 능력이 아니라 안 이어져 있던 배선이다.
export const MCP_BROWSER_READ = "mcp__hypeproof__browser_read";
export const MCP_BROWSER_CLICK = "mcp__hypeproof__browser_click";
export const MCP_BROWSER_TYPE = "mcp__hypeproof__browser_type";

/** All hypeproof MCP browser tools, granted as one capability unit. */
export const MCP_BROWSER_TOOLS = [
  MCP_BROWSER_OPEN,
  MCP_BROWSER_SCREENSHOT,
  MCP_LIVE_PREVIEW_START,
  MCP_BROWSER_READ,
  MCP_BROWSER_CLICK,
  MCP_BROWSER_TYPE,
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
 * `openBrowser` 가 실제로 무슨 일을 했는지 (#526).
 *
 * 슬롯당 탭 하나라는 규칙(#519) 때문에 "연다"는 요청이 실제로는 **기존 탭의
 * 이동**이 될 수 있다. 그때 밀려난 페이지를 여기 담아 도구 결과에 적는다 —
 * 안 그러면 코치는 참고 사이트 두 개가 나란히 떠 있다고 **믿는다**.
 */
export interface BrowserOpenOutcome {
  /** 같은 슬롯의 이 페이지가 요청 주소로 이동했다(= 화면에서 사라졌다). */
  replaced?: BrowserPage;
}

/**
 * Host capabilities the extension side (chatPanelProvider/extension.ts, which
 * has the `vscode` API) implements. All best-effort: return null / resolve on
 * failure rather than throwing user-facing errors — the handler converts
 * failures into isError tool results the model can react to in Korean.
 */
export interface BrowserMcpHost {
  /**
   * Open (or reveal) the integrated browser at an already-policy-checked URL.
   *
   * #526 — 슬롯이 차 있으면 기존 탭이 그 주소로 **이동**한다. 무엇이 밀려났는지
   * 돌려주면 결과에 적는다. 안 돌려줘도(구버전 호스트·fake) 동작은 그대로다.
   */
  openBrowser(url: string): Promise<BrowserOpenOutcome | void>;
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
  /**
   * #519 — 지금 **열려 있는 모든** 페이지. 중복 판정(resolveAlreadyOpen)이 쓴다.
   *
   * `currentPage` 하나로는 부족하다: 코치 브라우징은 슬롯이 둘이다(참가자 결과물 /
   * 참고 사이트). 참고 사이트를 보는 중에 결과물 주소를 요청받으면 "지금 페이지"와
   * 다르다는 이유로 이미 떠 있는 페이지에 승인 모달이 또 뜬다 — #415 가 없애려던
   * 바로 그 잡음이다.
   *
   * optional 인 이유는 currentPage 와 같다: 없으면 currentPage 로 폴백한다.
   */
  openPages?(): Promise<BrowserPage[] | null>;
  /**
   * #523 — 이미 열려 있는 그 탭을 **코치의 운전 대상으로 고정**한다. 매칭된
   * 페이지를 돌려주고, 못 찾으면 null.
   *
   * 왜 필요한가: `browser_open` 이 "이미 열려 있다"고 판정하면 탭을 열지 않으므로
   * `setTargetTab` 을 태우는 경로(host.openBrowser)를 통째로 건너뛴다. 그러면
   * 뒤이은 browser_read/click/type 이 **직전 타깃**(다른 슬롯)에 붙어, 코치가
   * A 를 본다고 믿으면서 B 를 읽는다. #522 가 판정 범위를 열린 탭 전체로 넓히면서
   * 실제로 가능해진 상태다(그 전에는 매칭 = 타깃이라 무해했다).
   *
   * 왜 탭 핸들이 아니라 URL 인가: 이 모듈은 의도적으로 vscode-free 다(노드에서
   * 단위 테스트한다). `vscode.BrowserTab` 을 여기로 들이면 그 경계가 깨진다.
   * 탭을 찾아 고정하는 일은 vscode API 를 가진 호스트가 한다.
   *
   * optional 인 이유는 currentPage 와 같다 — 없으면 예전 동작(타깃 그대로)이다.
   */
  focusOpenPage?(url: string): Promise<BrowserPage | null>;
  /**
   * #457 — CDP 검사 도구 위임. `browserControl.ts` 의 execute() 를 그대로 태운다
   * (browser_read / browser_click / browser_type). optional 인 이유는
   * currentPage 와 같다: 이 능력이 없는 호스트에서도 나머지 도구는 동작해야 한다.
   */
  inspect?(name: string, input: Record<string, unknown>): Promise<McpToolResult | null>;
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
  // #519 — 열린 탭 **전부**와 비교한다(호스트가 알려줄 때만). 슬롯이 둘이라
  // "지금 보고 있는 페이지"만으로는 이미 떠 있는 다른 슬롯을 놓친다.
  const open = await readOpenPages(host);
  const alreadyOpen = open
    ? open.some((p) => isSameBrowserUrl(p.url, url))
    : !!current && isSameBrowserUrl(current.url, url);
  return { url, current, alreadyOpen };
}

/**
 * 이번 open 으로 **밀려난** 페이지의 표기(제목 — 주소) (#526). 없으면 null.
 *
 * 요청 주소와 같은 페이지가 밀려난 것으로 보고되면 무시한다 — 같은 주소로의
 * 이동은 참가자 눈에 아무것도 사라지지 않은 것이라, 그걸 "사라졌다"고 적으면
 * 없는 상실을 코치에게 가르친다.
 */
function replacedPageOf(outcome: BrowserOpenOutcome | void, url: string): string | null {
  const page = outcome && typeof outcome === "object" ? outcome.replaced : undefined;
  if (!page || typeof page.url !== "string" || !page.url) return null;
  if (isSameBrowserUrl(page.url, url)) return null;
  return page.title ? `${page.title}(${page.url})` : page.url;
}

/**
 * 매칭된 탭을 코치의 운전 대상으로 고정하고 그 페이지를 돌려준다 (#523).
 * 지원 안 함 / 못 찾음 / 실패 → null (호출부가 예전 동작으로 폴백한다).
 */
async function focusOpenPage(host: BrowserMcpHost, url: string): Promise<BrowserPage | null> {
  if (typeof host.focusOpenPage !== "function") return null;
  try {
    const page = await host.focusOpenPage(url);
    return page && typeof page.url === "string" && page.url ? page : null;
  } catch {
    // 고정에 실패해도 "이미 열려 있다"는 판정 자체는 유효하다. 여기서 던지면
    // 멀쩡한 결과가 오류로 바뀐다.
    return null;
  }
}

/** 열린 페이지 목록 조회. 지원 안 함/실패 → undefined (짐작하지 않는다). */
async function readOpenPages(host: BrowserMcpHost): Promise<BrowserPage[] | undefined> {
  if (typeof host.openPages !== "function") return undefined;
  try {
    const pages = await host.openPages();
    if (!Array.isArray(pages)) return undefined;
    return pages.filter((p) => p && typeof p.url === "string" && p.url);
  } catch {
    return undefined;
  }
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
  /** #457 — browser_type 의 submit 플래그용. */
  boolean?(): unknown;
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
        // #523 — 열지 않는다고 해서 **아무것도 안 해도 되는 게 아니다.** 그 탭을
        // 코치의 운전 대상으로 고정하지 않으면 뒤이은 read/click/type 이 직전
        // 타깃(다른 슬롯)에 붙어, 코치가 A 를 본다고 믿으며 B 를 읽는다.
        const focused = await focusOpenPage(host, url);
        // 상태 줄도 **매칭된 탭**으로 적는다. `current` 는 운전 중인 탭이라,
        // 그대로 쓰면 한 결과 안에서 "A 가 열려 있다 / 현재 페이지는 B" 로
        // 갈라진다 — 모델이 읽는 두 줄이 서로 다른 페이지를 말하게 된다.
        return withPageState(
          { content: [{ type: "text", text: `이미 브라우저에 열려 있어요 — 다시 열지 않았어요: ${url}` }] },
          focused ?? current ?? null,
        );
      }
      const outcome = await host.openBrowser(url);
      // #526 — "열었어요"가 사실이 아닐 때가 있다. 슬롯당 탭 하나(#519)라서, 같은
      // 슬롯에 탭이 있으면 그 탭이 **이 주소로 이동**한다 — 즉 보고 있던 페이지가
      // 화면에서 사라진다. 결과가 그걸 말하지 않으면 코치는 참고 사이트 두 개가
      // 나란히 떠 있다고 믿고 "왼쪽이 A, 오른쪽이 B" 같은 없는 화면을 설명한다
      // (지어낸 성공 — R0 와 같은 실패 계열).
      const replaced = replacedPageOf(outcome, url);
      const text = replaced
        ? `브라우저에서 열었어요: ${url}\n` +
          `(참고: 같은 자리에 있던 ${replaced} 는 이 주소로 이동했어요 — ` +
          `결과물 1개 · 참고 사이트 1개까지만 동시에 띄울 수 있어요. ` +
          `둘을 비교하려면 번갈아 열어야 합니다.)`
        : `브라우저에서 열었어요: ${url}`;
      // 방금 연 주소가 곧 현재 상태다 (재조회는 탭이 아직 갱신 전일 수 있어
      // 오히려 틀린 상태를 적을 위험이 있다).
      return withPageState({ content: [{ type: "text", text }] }, { url });
    },
  );

  const browserScreenshot = factory.tool(
    "browser_screenshot",
    "지금 열려 있는 통합 브라우저 탭의 스크린샷을 찍어 이미지로 돌려준다. " +
      "학생이 만든 페이지가 실제로 어떻게 보이는지 확인할 때 사용.",
    {},
    async () => {
      // #457 후속 — 스크린샷 경로가 둘로 갈려 있었다. 이 도구는
      // host.screenshot()(capturePageContext: 매 호출 새 CDP 세션 attach+close)
      // 을 쓰고, browser_read 는 BrowserControl(세션 재사용)을 쓴다. 실측에서
      // **screenshot 만** 반복 실패했다(2026-07-26 T1: 2/2 실패, 실사용 로그에서도
      // 동일). 같은 Page.captureScreenshot 인데 세션 관리만 다르다.
      //
      // 그래서 inspect 가 있으면 그쪽(BrowserControl)을 먼저 쓴다 — 구현이 하나면
      // 한쪽만 고쳐지는 일이 없다. 없을 때만 기존 경로로 폴백한다.
      if (host.inspect) {
        const viaCdp = await host.inspect("browser_screenshot", {});
        if (viaCdp && !viaCdp.isError) return withPageState(viaCdp, await readCurrentPage(host));
      }
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

  // ── #457 검사 3종 ─────────────────────────────────────────────────────────
  // 전부 host.inspect 로 위임한다 — CDP 구현은 browserControl.ts 에 이미 있고
  // 여기서 다시 구현하면 프록시 경로와 갈라진다(같은 동작이 두 벌이 되는 순간
  // 한쪽만 고쳐지는 버그가 생긴다).
  const inspectOrFail = async (
    name: string,
    input: Record<string, unknown>,
    absent: string,
  ): Promise<McpToolResult> => {
    if (!host.inspect) {
      return withPageState(
        { content: [{ type: "text", text: absent }], isError: true },
        await readCurrentPage(host),
      );
    }
    const r = await host.inspect(name, input);
    return withPageState(
      r ?? { content: [{ type: "text", text: absent }], isError: true },
      await readCurrentPage(host),
    );
  };

  const browserRead = factory.tool(
    "browser_read",
    "지금 열려 있는 페이지의 접근성/DOM 스냅샷을 **텍스트로** 읽는다. 상호작용 요소마다 " +
      "[ref=eN] 라벨이 붙는다. browser_click / browser_type 전에 **반드시 먼저** 호출해 " +
      "최신 ref 를 얻어라 — 페이지가 이동하거나 클릭이 일어나면 이전 ref 는 무효가 된다. " +
      "스크린샷은 '어떻게 보이는가'를, 이 도구는 '무엇을 누를 수 있는가'를 알려준다.",
    {},
    async () => inspectOrFail("browser_read", {}, "열려 있는 브라우저 탭이 없어서 페이지를 읽지 못했어요."),
  );

  const browserClick = factory.tool(
    "browser_click",
    "페이지의 요소를 **실제로 클릭한다**(CDP 입력 이벤트 — 진짜 마우스 클릭과 같다). " +
      "ref 는 browser_read 가 붙여준 [ref=eN] 값이다. 버튼·링크가 정말 동작하는지 " +
      "확인하려면 눈으로 보는 것이 아니라 이 도구로 눌러봐야 한다.",
    { ref: z.string() },
    async (args: Record<string, unknown>) =>
      inspectOrFail(
        "browser_click",
        { ref: String(args["ref"] ?? "") },
        "클릭하지 못했어요. browser_read 로 ref 를 다시 받아보세요.",
      ),
  );

  const browserType = factory.tool(
    "browser_type",
    "입력 요소에 텍스트를 **실제로 타이핑한다**. submit=true 면 입력 후 Enter 까지 누른다. " +
      "폼이 동작하는지 확인할 때 쓴다. ref 는 browser_read 가 준 값이다.",
    {
      ref: z.string(),
      text: z.string(),
      // boolean 을 제공하지 않는 주입(테스트 fake)에서도 서버가 만들어져야 하므로
      // 없으면 이 필드를 생략한다 — submit 은 핸들러가 기본 false 로 처리한다.
      ...(typeof z.boolean === "function" ? { submit: z.boolean() } : {}),
    },
    async (args: Record<string, unknown>) =>
      inspectOrFail(
        "browser_type",
        {
          ref: String(args["ref"] ?? ""),
          text: String(args["text"] ?? ""),
          submit: args["submit"] === true,
        },
        "입력하지 못했어요. browser_read 로 ref 를 다시 받아보세요.",
      ),
  );

  return factory.createSdkMcpServer({
    name: HYPEPROOF_MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [browserOpen, browserScreenshot, livePreviewStart, browserRead, browserClick, browserType],
  });
}
