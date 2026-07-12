# 교육용 네이티브 브라우저 — 설계 스펙

상태: **구현 완료 (Phase 0–3, 2026-07) — 실기계 e2e 검증 대기** · 추적: [#278](https://github.com/jayleekr/hypeproof-studio/issues/278) · 결정: [adr/0002-native-browser-via-webcontentsview.md](adr/0002-native-browser-via-webcontentsview.md) · 현재 진실: §0.5

## 0. 구현 방향 갱신 (2026-06-24) — 중요

소스를 받아 확인한 결과 **VS Code 1.116.0(Electron 39.8.7)에 이미 완성된 통합 브라우저가
존재**한다(MS #300319): `WebContentsView` 기반 에디터-탭 브라우저, 세션 격리,
Playwright/CDP 자동화, 확장용 **`browser` proposed API**. VSCodium 패치가 제거하지도
않는다. → 아래 §3–§4의 "WebContentsView를 코어 패치로 처음부터 빌드" 설계는 **불필요**
해졌고, **upstream 기능을 enable + 배선**하는 방식으로 대체한다(훨씬 작고 안전).

**구현된 것(이번 작업):**
- `scripts/apply-product-overrides.sh` — product.json `extensionEnabledApiProposals`에
  `{"hypeproof.hypeproof-chat":["browser"]}` 추가 → built-in 확장에 proposed API 허용
  (코어 소스 패치 없음). jq 검증 완료.
- `extensions/hypeproof-chat/` — `enabledApiProposals:["browser"]` + 벤더 dts
  (`src/vscode.proposed.browser.d.ts`) + `src/nativeBrowser.ts`:
  - `hypeproof-chat.openBrowser` (Q1) — `window.openBrowserTab(url, {Beside})`로 외부/
    localhost/file 페이지 열기.
  - `capturePageContext()`/`captureActivePage()` — `BrowserTab.startCDPSession()`로
    screenshot+innerText+AX 추출.
  - **Q2 채팅 주입(텍스트 경로)** — `hypeproof-chat.sendPageToCoach`가 활성 탭의 DOM
    텍스트+URL/제목을 다음 턴 프롬프트에 prepend(`chatPanelProvider.attachPageContext`/
    `handleSend`). 히스토리엔 사용자 원문만 남김.
  - **per-cohort 게이트** `input.page_context`(default off) — worker `profiles/types.ts`
    + `/v1/profile`(chat.ts) → 확장 `ResolvedProfile`. host가 강제(미성년 보호).
    확장·worker typecheck + worker 테스트 27건 통과.
  - **진입점** — 채팅 패널 view/title에 🌐 브라우저 열기 버튼(항상) + 💬 페이지를 코치에게
    버튼(`page_context` 켜진 코호트만, context key `hypeproof-chat.pageContextEnabled`
    게이트). 그전엔 Command Palette 전용이라 아이가 못 찾았음.

**발견(중요):** 기존 image-paste 기능은 **webview UI까지만 구현**돼 있고 host→worker→LLM
이미지 전달(멀티모달)이 없다 — `proxyClient`는 텍스트만 보내고 worker엔 image 처리가
없으며 worker Profile에 `input` 필드 자체가 없었다. 그래서 Q2 주입은 **텍스트 경로로 먼저**
구현했고, **스크린샷(vision) 주입은 멀티모달 proxy 파이프라인 구축이 선행**되어야 한다(후속).

**후속(별도 커밋):** ① 멀티모달 proxy 파이프라인(이미지 content part → Anthropic image
block) 구축 후 screenshot(vision) 주입 ② 미성년 안전 세션/URL 정책 ③ 게임을 네이티브로
통합할지 결정.

**검증 한계:** 디스플레이 없는 자동화 셸이라 IDE에서 브라우저가 실제로 그려지는 시각
확인은 불가 — typecheck + jq 검증까지가 여기서 가능한 범위, 최종 확인은 풀빌드 후 실제
머신 몫.

## 0.5 구현 완료 (2026-07) — Phase 0–3 · 현재 진실의 출처

보아치과 홈페이지 커리큘럼(성인)을 위해 세 조건을 모두 구현했다. 통합 브랜치
`feat/boah-homepage-browser`(→ #278). 각 커밋 tsc·단위테스트 green. (참고: #278 본체 —
upstream 통합 브라우저 enable + 확장 배선 — 은 이미 #279로 main에 머지됨. 아래는 그 위 후속.)

- **Phase 0** — `boah-homepage-2026-s1` 코호트 + `homepage` tier(skeleton 미주입, 기존
  copyclone용 `website` tier와 구분: 대화로 새 홈페이지 제작).
- **Phase 1 (조건 ③)** — 인프로세스 live server(`liveServer.ts`, 127.0.0.1, SSE 자동
  새로고침) + `preview.type:"live_server"` 최초 소비(iframe 대신 네이티브 브라우저) +
  `_preview-env-contract-live-server.md`(멀티파일·상대경로·same-origin fetch 허용).
- **Phase 2 (조건 ② 읽기)** — image-paste 멀티모달 파이프라인이 이미 머지돼 있어,
  "페이지를 코치에게"가 캡쳐 스크린샷을 이미지로 전달하도록 배선 + 프로필
  page_context/image_paste ON. `capturePageContext`가 핸드셰이크 없이 직접 CDP를 불러
  실패하던 버그를 Phase 3에서 수정.
- **Phase 3 (조건 ② 제어)** — client-driven agentic 루프:
  - worker: content block에 tool_use/tool_result, `browser-tools.ts`(8개 도구),
    `browser_control` 게이팅, `_browser-control-contract.md`, tool_use SSE(`hps_tool_use`).
  - 확장: `CdpSession`(Target.attachToTarget 핸드셰이크 → sessionId 재사용),
    `browserControl.ts` 실행기(navigate/read/click/type/screenshot/back/forward/dialog),
    `runBrowserLoop`(자동실행 + 액션로그, 히스토리 미오염), 웹뷰 액션 로그.

### CDP 스파이크 결과 (2026-07-11, 실기계 Studio 창)

`startCDPSession` raw CDP를 실기계에서 실증(throwaway `__cdpSpike` 커맨드, dev-host):
- `needsHandshake: true` — 페이지 레벨 명령은 root 세션에서 "Method not found" →
  `Target.attachToTarget({flatten:true})`로 sessionId 확보 후 모든 명령에 실어야 함.
- `crossOriginSurvived: true` — sessionId가 cross-origin 이동에서 생존(재-attach 불필요).
- `inputWorks: true` — `Input.dispatchMouseEvent`로 실제 클릭 동작(JS-eval 폴백 불필요).
→ 실행기를 "핸드셰이크 1회 → sessionId 고정" 형태로 확정.

### 성인 세션 정책 (Phase 4, 경량)

성인 코호트라 미성년 하드닝 불필요. URL 스킴 화이트리스트(http/https/localhost/file만,
js/data/vscode 거부)는 `browserControlHelpers.safeNavigateUrl`에 포함. 다운로드-off·per-cohort
파티션 하드닝은 **코어 패치 영역**(`browserSession.ts`가 확장 API로 파티션 선택 미노출) →
미성년 트랙 후속으로 분리(§5).

### 남은 검증

end-to-end 실동작(코치가 실제로 브라우저를 모는 것)은 실기계에서만 확인 — 풀빌드 또는
dev-host(로컬 worker + homepage 토큰). 단위 로직(핸드셰이크·실행기 헬퍼·tool_use SSE·
로그라인·live server)은 테스트됨.

> 아래 §1–§12는 원래 설계(처음부터 빌드 가정)의 기록이다. upstream 재사용으로 상당수가
> "이미 제공됨"으로 대체됨 — §0가 현재 진실의 출처다.

---

상태(원본): Draft (설계) · 추적: [#278](https://github.com/jayleekr/hypeproof-studio/issues/278) · 결정: [adr/0002-native-browser-via-webcontentsview.md](adr/0002-native-browser-via-webcontentsview.md)

> 이 문서는 "왜/무엇"(ADR 0002, 이슈 #278)을 받아 "어떻게"를 정의하는 엔지니어링 설계
> 스펙이다. 구현 PR은 이 문서를 갱신해야 한다. 코어 내부 동작에 대한 단언 중 vscode 소스를
> 직접 검증하지 못한 항목은 **[PoC검증]** 으로 표시했다.

## 1. 목표 / 비목표

**목표 (이슈 #278의 교육 시나리오)**
- Q1 — 수강자가 만든 페이지(`file://`·`localhost`)와 따라하려는 외부 사이트(`https://`)를
  하나의 네이티브 브라우저에서 연다.
- Q2 — 그 페이지를 Studio LLM(코치)이 분석에 쓸 수 있다(스크린샷 + DOM/텍스트).
- Q3 — SK바이오팜 아이들이 만든 게임을 이 브라우저에서 안전하게 실행한다.

**비목표 (이번 범위 밖)**
- 풀 브라우저 UX(북마크/확장/싱크). 최소 chrome(주소·뒤로/앞으로·새로고침)만.
- 멀티 윈도우·탭 타일링(cmux Bonsplit 류). 단일 surface + 탭 리스트로 시작.
- 임의 사이트 자동화 에이전트. CDP는 "페이지 컨텍스트 추출"에 한정.

## 2. 현재 상태 & 격차

`extensions/hypeproof-chat/src/previewProvider.ts` — WebviewPanel 안 sandboxed
iframe(srcdoc), `cspBuilder.ts`가 외부망 차단. 게임 계약은
`worker/src/prompts/_preview-env-contract.md`(외부 URL 금지, 에셋 base64 inline).
프로필 스키마에 `preview: { type: "iframe" | "live_server" }`가 이미 존재
(`worker/src/profiles/types.ts`) — 네이티브 브라우저는 사실상 `live_server`의 실체화.

격차: ① 외부 사이트 못 띄움(iframe 거부 + CSP), ② 내비게이션 부재, ③ localhost/배포물
라이브 확인 불가.

## 3. 엔진 선택 — WebContentsView vs `<webview>`

| 기준 | `WebContentsView` (선택) | `<webview>` 태그 |
|---|---|---|
| 외부 사이트 로드 | O (top-level webContents) | O (guest webContents) |
| CDP / 페이지 분석 | **네이티브**(`webContents.debugger`) | 제한적(메인 경유 필요) |
| 지원 상태 | 현행 권장 API | semi-deprecated |
| 세션 격리 | `session` 파티션 | partition 속성 |
| 코어 변경 | 메인 프로세스 surface + IPC 필요 | 확장 webview엔 `webviewTag` 비활성 → 어차피 코어 변경 |
| Positioning | 네이티브 레이어(직접 관리) | DOM 흐름(쉬움) |

→ **`WebContentsView`**. 둘 다 코어 변경이 필요하다면, CDP·세션·지원성에서 우월한 쪽을
택한다. `<webview>`는 1차 feasibility 스파이크용으로만(선택).
**[PoC검증]** vscodium-base의 Electron 버전이 `WebContentsView`(Electron 30+)를
지원하는지 확인(`patches/00-build-update-electron.patch.no` 참조).

## 4. 아키텍처

### 4.1 컴포넌트 / 프로세스

```
┌─ main process (Electron) ──────────────────────────────┐
│  NativeBrowserService            ← 코어 패치로 신설      │
│   • create/destroy WebContentsView                       │
│   • attach to active BrowserWindow, setBounds()          │
│   • navigate / reload / goBack/Forward                   │
│   • session partition 선택 (hp-safe | hp-browse)         │
│   • capturePage() → NativeImage                          │
│   • debugger.attach() → CDP (AX tree / DOM / text)       │
│   └── IPC channel  ◄────────────────────────────────┐    │
└──────────────────────────────────────────────────────┼──┘
                                                        │ IPC (patch)
┌─ extension host (Node) ───────────────────────────────┼──┐
│  hypeproof-chat / (또는 hypeproof-preview)             │  │
│   • 명령: 열기·주소·리로드·탭·"코치에게 보내기"          │  │
│   • bounds 보고(에디터 슬롯) → main이 뷰 위치 동기화     │  │
│   • 페이지 컨텍스트 수집 → 채팅 턴에 주입                │  │
└──────────────────────────────────────────────────────────┘
        │ postMessage                         │ /v1/chat/completions
┌─ webview-ui (iframe) ─┐            ┌─ worker (Cloudflare) ─┐
│  주소창·탭 UI(chrome) │            │  image-paste 재사용    │
│  ※ 실제 페이지 픽셀은 │            │  translate.ts forward  │
│    네이티브 뷰가 그림 │            │  page_context 게이트   │
└───────────────────────┘            └────────────────────────┘
```

핵심: **브라우저 chrome(주소창·탭)은 webview-ui로 그리고, 실제 페이지 픽셀은 그 위에 겹친
네이티브 `WebContentsView`가 그린다.** webview는 네이티브 뷰가 차지할 사각형의 화면 좌표를
main에 보고하고, main이 `setBounds()`로 맞춘다(cmux의 portal/reparenting과 같은 개념).

### 4.2 코어 패치 지점

- 새 패치 `patches/50-native-browser-surface.patch` (현 prefix 최대 40-, 선례:
  `00-security-add-command-filter.patch`, `00-ui-report-issue.patch`).
- 추가 내용(유력 가설): 메인 프로세스에 `NativeBrowserService` 등록 + 확장/렌더러가
  호출할 수 있는 **IPC 메서드 채널** 노출. VS Code 확장은 메인 프로세스에 직접 접근할 수
  없으므로 이 노출이 패치의 본질이다.
- **[PoC검증]** 정확한 hook(메인 프로세스 서비스 등록 위치, 확장이 invoke하는 경로 —
  내부 IPC 서비스 vs 주입 글로벌 vs proposed API)은 PoC에서 vscode 소스를 받아 확정한다.
- `.claude/rules/build-pipeline.md` "Adding a new patch" 절차(`git diff > ../patches/`,
  `git apply --check`, 헤더 주석)를 따른다.

### 4.3 Positioning / 라이프사이클

- 에디터 영역에 브라우저 "슬롯"(커스텀 에디터 또는 webview placeholder)을 두고, 그 DOM
  사각형의 화면 좌표를 ResizeObserver로 추적해 main에 보고 → `view.setBounds()`.
- 상태 머신: `hidden → loading → live → hidden(탭 전환) → disposed`. 다른 탭/패널이
  활성화되면 뷰를 `removeChildView`/숨김(z-order 위로 새는 것 방지). cmux의
  lifecycle(`liveVisible/liveHidden/discarded`)을 참고.
- 포커스·키보드·풀스크린·드래그가 네이티브 레이어와 워크벤치 사이에서 새지 않도록 처리.
  **이 부분이 최대 난점**(전형적 BrowserView positioning 문제).

## 5. 세션 / 보안 모델

### 5.1 두 세션 파티션

| 파티션 | 용도 | 정책 |
|---|---|---|
| `persist:hp-safe` | 미성년 코호트 · AI생성 게임 | 네트워크 차단/allowlist, 권한 핸들러 전부 deny, 다운로드·팝업 차단, devtools off |
| `persist:hp-browse` | 일반 브라우징(레퍼런스·dev server) | 표준, 단 권한은 명시 승인 |

공통 `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, `webSecurity: true`.

### 5.2 권한 / URL 정책

- `session.setPermissionRequestHandler` — 안전 세션은 geolocation/camera/mic/notification
  전부 거부.
- URL allow/deny — `session.webRequest.onBeforeRequest` 또는 `will-navigate` 게이트.
  미성년 코호트의 allowlist 여부는 **열린 결정**(§11).
- 다운로드 — 안전 세션은 `will-download` 취소. 일반 세션은 워크스페이스 하위로 한정.

### 5.3 요구사항 매핑

`docs/studio-requirements.md` REQ-D(프리뷰 샌드박싱) 행을 갱신하고, 네이티브 브라우저용
신규 REQ를 추가한다(세션 격리, 권한 deny, URL 정책, page_context 게이트). REQ-### 부여는
구현 PR에서.

## 6. LLM 페이지 컨텍스트 주입

### 6.1 스크린샷 경로 (기존 파이프라인 재사용)

`webContents.capturePage()` → `NativeImage` → `toJPEG(quality)`로 ~3.5MB cap 이하로
인코딩/다운스케일 → data URL → **기존 image-paste 경로**로 전송
(`extensions/hypeproof-chat/webview-ui/src/ChatPanel.js`의 첨부 흐름,
`worker/src/lib/translate.ts`가 Claude vision으로 forward). 신규 vision 배선 불필요.
주의: 풀페이지 PNG는 cap 초과 가능 → JPEG/리사이즈 필수.

### 6.2 DOM / 텍스트 / AX 경로 (CDP)

`webContents.debugger.attach("1.3")` 후 `Accessibility.getFullAXTree`,
`DOM.getDocument`, `Runtime.evaluate`(또는 단순히 `webContents.executeJavaScript`로
title·visible text·outerHTML). 결과를 `page-context` payload로 만들어 채팅 턴에 텍스트
컨텍스트로 주입. cmux의 `get text/html`·`snapshot`과 동등하나 진짜 CDP라 견고.

### 6.3 데이터 게이트 (블로킹)

신규 프로필 플래그 `input.page_context`(default `false`). `image_paste`와 동일하게
**worker가 강제**(게이트 off면 페이지 컨텍스트 첨부 거부). 미성년 코호트 기본 off.

### 6.4 UX

커맨드 `hypeproof-chat.sendPageToCoach`("현재 페이지를 코치에게") — 스크린샷(+옵션 DOM)을
다음 턴 컨텍스트로 첨부. 7 Assets의 Context design / Verification reflex에 매핑
(`docs/seven-assets.md`).

## 7. 게임 프리뷰 통합 전략

| 옵션 | 내용 | 트레이드오프 |
|---|---|---|
| A. 병행(권장 시작점) | AI생성 게임은 현 iframe 유지, 네이티브 브라우저는 외부/본인 페이지·localhost 전용 | 안전 정책 변경 최소, 점진적 |
| B. 통합 이전 | 게임도 `persist:hp-safe` 네이티브 세션으로 이전 | 능력↑(풀 브라우저 API) but 안전 포지션 재검증 필요 |

시작은 A, 안정화 후 B 검토. 게임 생성 프롬프트의 "외부 URL 금지" 제약 완화 여부는 별도
product 결정(§11).

## 8. 프로필 스키마 변경

- `worker/src/profiles/types.ts`: `preview.type`에 네이티브 경로 배선(`"live_server"`
  재사용 또는 `"native"` 추가) + `session: "safe" | "browse"` 힌트.
- `input.page_context: boolean` 추가(default off), worker에서 강제.
- 영향 프로필: `sk-biopharm-kids-*`(안전 세션·page_context off), 일반 코호트는 선택.

## 9. 작업 분해 / 단계

각 단계는 독립 PR. 빌드 수반 단계는 `.claude/rules/build-pipeline.md` 준수.

1. **PoC** — `WebContentsView`를 vscodium-base에 띄워 `https://` 외부 사이트 로드 +
   `setBounds()` positioning + Electron 버전 확인. 산출물: 패치 초안 + 검증 노트.
2. **코어 패치** — `NativeBrowserService` + IPC (`patches/50-native-browser-surface.patch`).
3. **Positioning/라이프사이클** — 에디터 슬롯 ↔ bounds 동기화, z-order, focus.
4. **확장 UI** — 주소창·뒤로/앞으로·리로드·탭(webview-ui chrome) + 열기 커맨드.
5. **컨텍스트 주입** — capturePage→image-paste 재사용 + CDP DOM/AX + `page_context` 게이트.
6. **안전 세션** — `hp-safe`/`hp-browse` 파티션, 권한 deny, URL/다운로드 정책.
7. **게임 통합** — 옵션 A 배선(병행), 프로필 `preview.type`.
8. **문서/테스트** — REQ-D 갱신, e2e, 이 스펙·ADR 상태 갱신.

## 9.1 PoC 검증 결과 (standalone Electron 32.3.3, 2026-06-23)

VS Code 소스/풀빌드 없이 standalone Electron PoC로 핵심 API를 실증했다(electron@32.3.3
= `WebContentsView` 지원 확인). 세 교육 시나리오 + 안전 모델이 모두 API 수준에서 통과.

| 시나리오 | 결과 | 확인된 API |
|---|---|---|
| Q1 외부 `https` 로드 | ✅ `example.com` title="Example Domain" | `new WebContentsView({webPreferences:{partition}})` + `webContents.loadURL` |
| Q1 positioning | ✅ | `win.contentView.addChildView(view)` + `view.setBounds({x,y,width,height})` |
| Q2a 스크린샷 | ✅ (offscreen 400×300 PNG) | `webContents.capturePage()` / offscreen `paint` → `image.toPNG()`·`toJPEG(80)` |
| Q2b DOM/AX 추출 | ✅ AX 15노드 + 본문 텍스트 | `webContents.debugger.attach("1.3")` → `Accessibility.getFullAXTree`, `Runtime.evaluate` |
| Q3 게임 실행 | ✅ rAF score=40 | `loadFile()` + canvas/requestAnimationFrame, `executeJavaScript` 상태 read-back |
| 안전 세션 | ✅ | `session.fromPartition("persist:…")` + `setPermissionRequestHandler(deny)` |

주의: 헤드리스(디스플레이 표면 없음) 환경에선 일반 `capturePage`·rAF가 표면 부재로 실패 →
**offscreen 렌더링**으로 동일 결과 실증. 디스플레이가 있는 실제 머신에선 일반 경로로 동작
하므로 이는 API 한계가 아니라 자동화 셸 제약이다. Electron 버전 일치는 vscodium-base
빌드에서 재확인 필요(§3 [PoC검증]). PoC 소스: 세션 스크래치패드 `poc/`(throwaway).

## 10. 테스트 전략

- Unit: bounds 계산, URL 정책, page_context 게이트(off→거부), 스크린샷 인코딩 cap.
- E2E(현 13 e2e 대비): 외부 URL 로드, file://·localhost 로드, 게임 실행, 안전 세션
  네트워크 차단, "코치에게 보내기" 첨부 경로.
- 보안: 안전 세션 권한 deny·다운로드 취소·node 미주입 확인(REQ-D 류).

## 11. 리스크 & 열린 질문

- **[리스크]** Positioning/z-order/focus가 워크벤치와 충돌(최대 난점).
- **[리스크]** 코어 패치가 upstream/VSCodium 동기화 시 깨질 수 있음(patch 유지보수).
- **[리스크]** 빌드 1–2h × 반복 → PoC에서 `<webview>` 스파이크로 일부 위험 선검증 고려.
- **[열린 결정]** 미성년 코호트 URL allowlist 강제 여부.
- **[열린 결정]** 게임을 네이티브로 이전(옵션 B)할지, 게임 생성 "외부 URL 금지" 완화 여부.
- **[열린 결정]** 타깃 마일스톤(Phase 6/7) 및 epic 승격.

## 12. 참고

- ADR: [adr/0002-native-browser-via-webcontentsview.md](adr/0002-native-browser-via-webcontentsview.md)
- 이슈: [#278](https://github.com/jayleekr/hypeproof-studio/issues/278)
- 현 뷰어: `extensions/hypeproof-chat/src/previewProvider.ts`, `cspBuilder.ts`
- 재사용 파이프라인: `extensions/hypeproof-chat/webview-ui/src/ChatPanel.js`, `worker/src/lib/translate.ts`
- 스키마: `worker/src/profiles/types.ts` (`preview.type`)
- 게임 계약: `worker/src/prompts/_preview-env-contract.md`
- 규약: `.claude/rules/build-pipeline.md`(패치), `docs/studio-requirements.md`(REQ-D), `docs/seven-assets.md`, `docs/AUTONOMY-MANDATE.md`
