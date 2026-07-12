# 0002 — Native browser via Electron WebContentsView

Status: Accepted — 구현 완료 (Phase 0–3, 2026-07). 실기계 e2e 검증 대기.
CDP 스파이크(2026-07-11)로 `startCDPSession` 경로 확정: Target.attachToTarget({flatten})
핸드셰이크 필요, sessionId는 cross-origin 이동에서 생존, Input.dispatch* 실동작. 상세:
[../native-browser-spec.md](../native-browser-spec.md) §0.5.

Tracking: [#278](https://github.com/jayleekr/hypeproof-studio/issues/278) · Design spec: [../native-browser-spec.md](../native-browser-spec.md)

## Context

Studio의 "웹/HTML 보기"는 현재 `hypeproof-chat` 확장의 `PreviewProvider`가 VS Code
WebviewPanel 안의 **sandboxed iframe(srcdoc)** 으로 렌더링한다. 외부망을 의도적으로
차단하므로(opaque origin + CSP가 `https:` 차단) 로컬/AI생성 HTML 전용이고, 임의의
외부 사이트·localhost dev server를 띄울 수 없으며 주소창·탭·히스토리 같은 내비게이션
개념이 없다. 교육에서 수강자가 **본인이 만든 페이지**와 **따라하려는 레퍼런스 사이트**를
같은 도구로 열고, 그 페이지를 코치(LLM)가 분석하게 하려면 "단순 HTML 뷰어"로는 부족하다.

레퍼런스로 `manaflow-ai/cmux`의 네이티브 브라우저를 조사했다. 풀 기능(탭/옴니바/세션/
다중 프로필 격리/에이전트 자동화)을 갖췄으나 **Swift + `WKWebView`(Apple WebKit) 네이티브
macOS 앱**이고 **GPL-3.0**이다.

## Decision

Studio는 이미 Electron(Chromium) 위에 있으므로, 교육용 네이티브 브라우저를 **Electron
`WebContentsView`**로 구현한다.

- BrowserWindow 위에 풀 Chromium webContents를 네이티브 뷰로 레이어링 → 실제
  내비게이션·외부 사이트 로드(iframe의 `X-Frame-Options` 문제 없음)·devtools.
- 자동화/페이지 분석은 Chromium **CDP**(`webContents.debugger`)와 `capturePage()`로 얻는다.
- LLM에 페이지를 보내는 경로는 **기존 image-paste 파이프라인을 재사용**한다(신규 vision
  배선 불필요). 텍스트/DOM 컨텍스트는 CDP로 추출한다.
- 쿠키/저장소 격리는 Electron `session` 파티션으로 하고, 미성년/게임용 **하드닝된 안전
  세션**과 일반 브라우징 세션을 분리한다.

## Update (2026-06-24): 상위 호환 발견 — upstream Integrated Browser 재사용

소스를 받아보니(VS Code 1.116.0, Electron 39.8.7) **upstream에 이미 완성된 통합
브라우저가 존재한다** (MS #300319): `WebContentsView` 기반 에디터-탭 브라우저
(`vscode-browser:` URI → `BrowserEditor`), 세션/파티션 격리, Playwright/CDP 자동화,
그리고 확장용 **`browser` proposed API**(`window.openBrowserTab`,
`BrowserTab.startCDPSession`). VSCodium 패치도 이 기능을 제거하지 않아 빌드에 그대로
남는다.

따라서 **위험한 커스텀 코어 소스 패치(`patches/`)를 새로 만들지 않는다.** 대신:
- `scripts/apply-product-overrides.sh`가 product.json `extensionEnabledApiProposals`에
  `{"hypeproof.hypeproof-chat": ["browser"]}`를 추가해 **built-in 확장에 proposed API를
  허용**한다(코어 소스 변경 없음, product.json 오버라이드만).
- `hypeproof-chat` 확장이 `vscode.window.openBrowserTab`로 페이지를 열고(Q1),
  `BrowserTab.startCDPSession()`로 screenshot·DOM·AX를 추출(Q2)한다.
- LLM 주입은 기존 image-paste 파이프라인을 재사용, 미성년 게이트는 `image_paste`와 동일
  패턴(프로필별 opt-in + worker 강제).

엔진 선택 본문(아래)은 "왜 Electron/Chromium 경로인가"의 근거로 유효하다 — upstream이
바로 그 경로(WebContentsView)로 구현돼 있다.

## Alternatives considered

- **cmux 코드 이식(WKWebView/Swift)** — 거부. Swift/WKWebView ≠ Electron/Chromium 런타임,
  AppKit/NSWindow 결합, **Windows에 WKWebView 없음**(Phase 6 타깃), **GPL-3.0 전염**이
  MIT 기반 VSCodium 파생물에 하드 블로커. 기능 명세 레퍼런스로만 사용.
- **Electron `<webview>` 태그** — 주 경로로는 거부. 외부 사이트는 로드되지만
  semi-deprecated이고 CDP 접근이 제한적이며, VS Code 확장 webview는 `webviewTag`가
  비활성이라 어차피 코어 변경이 필요하다. 빠른 feasibility 스파이크용으로만 고려.
- **현 iframe 프리뷰 유지** — 거부. 외부 사이트를 못 띄워 교육 시나리오를 만족 못 함.

## Consequences

- **커스텀 코어 소스 패치가 불필요**해졌다(Update 참조). 구현은 product.json 오버라이드
  + 확장 TS로, pr-ci typecheck로 검증 가능하다. positioning/z-order는 upstream
  `BrowserEditor`가 이미 처리하므로 우리 부담이 아니다. (최종 시각 확인은 풀빌드 후
  실제 머신에서.)
- **프리뷰 안전 정책이 바뀐다**("기본 격리" iframe → "기본 풀 브라우저"). 미성년 코호트용
  하드닝 세션 + URL 정책이 블로킹 요구사항이며 `docs/studio-requirements.md` REQ-D 행을
  갱신해야 한다. (upstream 세션은 `persist:vscode-browser`/per-workspace/ephemeral —
  미성년용 정책 적용 방식은 후속.)
- 임의 페이지의 스크린샷/DOM을 LLM(외부 서비스)에 보내므로, `image_paste`와 동일하게
  **프로필별 opt-in + worker 강제(default-off)** 데이터 게이트가 필요하다.
- 프로필 스키마의 `preview.type`(현 `"iframe" | "live_server"`)에 네이티브 경로를
  배선한다.
- proposed API는 finalize되면 시그니처가 바뀔 수 있다(upstream sync 시 벤더 dts +
  `enabledApiProposals` 재확인 필요).
