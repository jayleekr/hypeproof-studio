// Pure CSP / sandbox string builders. Kept vscode-free so the security
// posture is unit-testable under plain Node — sandbox laxness is silent
// (the .app still launches), so a failing unit test on CI is the only thing
// that catches a stray `allow-same-origin` slipping in via PR review.

interface ChatPanelCspArgs {
  cspSource: string;          // value of `webview.cspSource`
  nonce: string;
}

/**
 * CSP for the main chat panel webview (host: extension's webview).
 *
 * default-src 'none' forces every directive to be enumerated. We allow:
 *  - img/style/script/font/connect from the webview's own cspSource
 *  - inline styles (Vite emits some) and the per-render nonce'd script tags
 *
 * Do NOT loosen `connect-src` to https: — the chat panel never talks directly
 * to a model API; the host bridges over postMessage to the worker via fetch.
 */
export function buildChatPanelCsp(args: ChatPanelCspArgs): string {
  const { cspSource, nonce } = args;
  return [
    `default-src 'none'`,
    `img-src ${cspSource} data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${cspSource}`,
    `font-src ${cspSource}`,
    `connect-src ${cspSource}`,
  ].join("; ");
}

interface PreviewShellCspArgs {
  cspSource: string;
  // No nonce: see comment on buildPreviewShellCsp.
}

/**
 * CSP for the preview shell webview.
 *
 * **Important correction (#NNN)**: `about:srcdoc` IS a local scheme per CSP3
 * §4.2.3, so the inner iframe inherits this CSP regardless of sandbox flags.
 * Earlier comments here claimed the opposite; DevTools console proved them
 * wrong (`Refused to execute inline script ... 'nonce-XXX'` reported inside
 * srcdoc, with the parent's nonce). Lesson: don't trust untested CSP
 * inheritance claims.
 *
 * Consequence: any inline script the inner page wants to run must be allowed
 * by THIS policy. AI-generated games are inline-script-heavy, so we accept
 * `'unsafe-inline' 'unsafe-eval'` here. The shell document itself has only
 * one hand-written bridge script (acquireVsCodeApi + message routing); the
 * inline-permissive policy isn't ideal but `cspSource` restricts where
 * external scripts could load from. The previously-used nonce approach
 * doesn't work because nonce/'unsafe-inline' interaction (CSP3 §6.6.3.2:
 * nonce makes 'unsafe-inline' inactive) propagates to inherited contexts.
 *
 * Other directives match the inner CSP so intersection-of-inherited+meta
 * stays usable: workspace asset fetch via `cspSource`, exfil blocked by
 * omitting `https:` from connect/frame/img.
 */
export function buildPreviewShellCsp(args: PreviewShellCspArgs): string {
  const { cspSource } = args;
  return [
    `default-src 'none'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src ${cspSource} 'unsafe-inline' 'unsafe-eval'`,
    `img-src ${cspSource} data: blob:`,
    `font-src ${cspSource} data:`,
    `connect-src ${cspSource}`,
    `media-src ${cspSource} data: blob:`,
    `frame-src 'self' data: blob:`,
    `base-uri ${cspSource}`,
    `object-src 'none'`,
  ].join("; ");
}

/**
 * Sandbox attribute for the preview iframe that hosts AI-generated game HTML
 * or a user-opened .html file.
 *
 * Allowed: scripts, pointer-lock (canvas games), modals (alert/confirm).
 *
 * `allow-same-origin` is intentionally omitted — not for CSP-inherit reasons
 * (CSP3 §4.2.3 inherits regardless; see buildPreviewShellCsp comment), but
 * to keep the iframe at opaque origin so it can't reach parent storage
 * (cookies/localStorage/IndexedDB) of the vscode-webview origin. Cost: CORS
 * fetch to workspace assets fails. Static loads via `<img>/<script src>/
 * <link>/<base href>` still work.
 *
 * Forbidden by omission:
 *  - allow-top-navigation*: no navigating Studio away
 *  - allow-popups*: no surprise tabs
 *  - allow-forms: reduces phishing surface
 *  - allow-downloads / allow-storage-access* / allow-presentation
 *  - allow-same-origin: see above
 *
 * The exfil gate is CSP-level (shell + inner meta both exclude `https:`
 * from connect/frame/img), enforced as intersection of inherited + meta.
 */
export const PREVIEW_IFRAME_SANDBOX =
  "allow-scripts allow-pointer-lock allow-modals";

/**
 * Permissions Policy for the same untrusted preview iframe (#992 H-22).
 *
 * 마이크 패치 v3 는 바깥 webview 위임을 **소유 확장 id** 로 좁혔다. 그런데 preview 패널도
 * `hypeproof-chat` 이 만든다(`extension.ts` → `PreviewProvider` → `createWebviewPanel`,
 * `enableScripts: true`) — 즉 preview **셸 문서**는 그 게이트 안에 있다. 셸 안의 이 iframe 이
 * AI 가 만든 HTML 이나 학생이 연 .html 을 돌린다.
 *
 * `allow` 속성이 없으면 opaque-origin 샌드박스 iframe 의 microphone 은 기본 allowlist('self')
 * 에 걸리지 않아 막힐 **것으로 보인다**. 그러나 그건 사양 기본값에서 한 추론이고, 이 경로에서
 * 실측한 적은 없다. 아이 화면에서 생성된 페이지가 마이크를 열 수 있는지를 기본값에 맡기지 않고
 * **명시적으로 끈다** — 임베더 쪽 위임이 나중에 더 넓어져도 이 줄은 그대로 거절한다.
 *
 * 범위는 센서 둘뿐이다(microphone · camera). 오늘 preview 콘텐츠(kids-quest 세상, 생성 게임)에
 * 둘을 쓰는 코드는 0건이다(검색으로 확인). 다른 기능까지 넓히지 않는다.
 */
export const PREVIEW_IFRAME_ALLOW = "microphone 'none'; camera 'none'";
