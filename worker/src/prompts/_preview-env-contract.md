# Preview 환경 contract (모든 HTML 출력에 적용)

Studio 우측 패널은 게임 코드를 **sandboxed iframe**에 srcdoc으로 렌더링합니다. sandbox 토큰: `allow-scripts allow-pointer-lock allow-modals` (opaque origin, no `allow-same-origin`). 부모 webview의 CSP가 inherit되며, inline `<script>`/`<style>`은 허용되지만 외부 네트워크는 차단됩니다.

이 환경에서 작동하려면 모든 HTML 출력은 다음을 따라야 합니다:

## 반드시 (MUST)

- **단일 HTML 문서**로 출력 — `<!doctype html>` 로 시작하여 `</html>` 로 끝. 한 파일에 모든 것.
- **inline 코드만** — JS는 `<script>...</script>`, CSS는 `<style>...</style>` 안에. `src`/`href`로 외부 파일 참조 금지.
- 게임 상태는 **메모리 (JS 변수)** 에만 보관.

## 금지 (MUST NOT)

- **네트워크 호출** — `fetch()`, `XMLHttpRequest`, `WebSocket`, `EventSource`, dynamic `import()`, `navigator.sendBeacon` 모두 차단됩니다 (CSP `connect-src` + opaque origin).
- **외부 URL/CDN** — `<script src="https://...">`, `<link href="https://...">`, `<img src="https://...">`, `@import url(https://...)`, `@font-face { src: url(https://...) }` 전부 차단. 폰트·이미지·라이브러리가 필요하면 **base64 `data:` URL** 로 inline.
- **저장소 API** — `localStorage`, `sessionStorage`, `document.cookie`, `IndexedDB`, `caches` 모두 SecurityError 또는 작동 불가 (opaque origin).
- **창/탭/폼 이동** — `window.open()`, `<a target="_blank">`, `<form>` submit, `location.href = ...`, `<meta http-equiv="refresh">` 모두 차단됨.
- **중첩 iframe** — `<iframe>`, `<frame>`, `<object>`, `<embed>` 사용 금지 (CSP `frame-src 'none'`).

## OK인 것

- `requestAnimationFrame`, `setTimeout`/`setInterval`, `performance.now`
- `addEventListener('keydown'/'keyup'/'click'/'pointerdown'/'pointermove'/'pointerup'/'touchstart'/'touchmove'/'touchend')`
- Canvas 2D, WebGL/WebGL2, Web Audio API, `<audio>`/`<video>` 태그 (단, src는 `data:` URL만)
- `alert()`, `confirm()`, `prompt()` (sandbox `allow-modals`)
- `document.fullscreenElement`, `element.requestPointerLock()` (sandbox `allow-pointer-lock`)
- DOM 조작 일체 (`document.createElement`, `innerHTML`, classList 등)

## 위반 시 증상

contract를 어기면 게임이 **"화면은 보이는데 작동 안 함"** 상태가 됩니다 — inline script가 CSP에 막혀 이벤트 핸들러가 바인딩되지 않거나, 외부 리소스가 로드 실패해 빈 캔버스만 남습니다. 모든 HTML 코드 출력 전에 위 contract를 다시 한 번 점검하세요.
