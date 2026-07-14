# Studio behavioral requirements

> **Spec version:** v0.2.0
> **Last reviewed:** 2026-05-25
> **Live tracker:** [epic #200](https://github.com/jayleekr/hypeproof-studio/issues/200)
> **Philosophy anchor:** [docs/seven-assets.md](./seven-assets.md) — 7 AI Native Assets; chat-panel features follow [METAPLAN §4.5](../METAPLAN.md).

This file is the **contract** for what HypeProof Studio (the IDE-side bundle: `extensions/hypeproof-chat/` + the built `.app`) must do. The companion epic carries live status (🟢/🟡/🔴), this doc carries stable behavior.

Two artifacts, two audiences:

- **Epic (#200)** — current workshop gate and status-changing tracker
- **This doc** — contract, stable, PR-reviewable

When a PR touches Studio behavior, update this doc and link the relevant tracking issue in the same commit.

---

## Test layer policy

| Layer | Where | Tool | When to use |
|---|---|---|---|
| **U** — Pure unit | `extensions/hypeproof-chat/test/*.smoke.mjs` | `node --experimental-strip-types` + `node:assert` | Pure functions; regex/validation/hash/CSP strings; anything that can be extracted to `xxxHelpers.ts` (no `vscode` import) |
| **E** — Electron e2e | `e2e/tests/*.spec.ts` | Playwright Electron driver | Actual `.app` + webview round-trip; UI shape; user-driven flows; cross-process interactions |
| **R** — Rehearsal smoke | `tests/rehearsal/*.test.mjs` | Node 22 `node --test` | Live worker contract (prod or wrangler dev); HTTP shape; token lifecycle |
| **M** — Manual | `scripts/install-mac.sh` + click checklist | Human | Branding integrity (until fully scripted), data folder, signed install, things that need eyeballs |

Default to the leftmost (cheapest) layer that can pin the requirement.

When in doubt:
- Function with no `vscode` dependency → **U**
- DOM / focus / cross-frame postMessage → **E**
- Worker HTTP contract → **R**
- Build artifact properties → **M** (until `verify-branding.sh` style scripts cover it)

---

## A. Lifecycle & autoOnboard

| ID | 요구사항 | 수용 기준 | Layer |
|---|---|---|---|
| REQ-A1 | 첫 실행 시 작업 폴더 자동 생성 | `~/HypeProofGames/index.html` 가 없으면 mkdir + starter HTML 작성, 단일-루트로 open | E |
| REQ-A2 | Workspace trust 모달 영구 억제 | `security.workspace.trust.enabled=false` 가 첫 실행에 global settings 에 기록 | E |
| REQ-A3 | autoOnboard 시퀀스 | 첫 실행 시 welcome editor 닫힘 → hypeproof-chat container 노출 → panel focus | E |
| REQ-A4 | 토큰 없을 때 자동 prompt | 시크릿에 토큰 없으면 `setToken` quickInput 자동 호출 | E |
| REQ-A5 | 저장된 토큰이 무효일 때 재-prompt | `/v1/profile` 호출 실패 시 시크릿은 유지 + `setToken` 재호출 | E |
| REQ-A6 | 코치 네이밍 카드 표시 조건 | `profile.ux.coach.naming_mode != "fixed"` + `coach.configured == false` 일 때만 webview 카드 렌더 | E |
| REQ-A7 | 테스트 백도어 | `HPS_TEST_TOKEN` env / `hps-test-state.json` 파일 / 로컬-only `/tmp/hps-token.txt` 셋 다 동작 (prod proxyUrl 일 땐 dev backdoor 무시) | U |

## B. Token & profile

| ID | 요구사항 | 수용 기준 | Layer |
|---|---|---|---|
| REQ-B1 | `setToken` happy path | input 받은 토큰 trim → `secrets.store(TOKEN_KEY)` → profile 재취득 → 성공 토스트 | E |
| REQ-B2 | 빈 토큰 입력 → 시크릿 삭제 | 빈 문자열로 setToken 시 `secrets.delete` + "cleared" 토스트 + profile invalidate | E |
| REQ-B3 | 토큰 검증을 `/v1/profile` 로 수행 | 200 + valid shape → 통과. 401/403/timeout → 경고 + 재-prompt 트리거 | E |
| REQ-B4 | `hasToken` UI 상태 동기화 | secrets 변화 → `postConfig` → webview 헤더 pill 갱신 | E |
| REQ-B5 | Auth error 분류 (4 sub) | 401/expired·missing → 재-prompt. 403/session_inactive·session_window·not_in_roster·mismatch → 친절한 토스트 (raw JSON 노출 금지) | U + R |

## C. Chat round-trip

| ID | 요구사항 | 수용 기준 | Layer |
|---|---|---|---|
| REQ-C1 | SSE 스트리밍 round-trip | `안녕` → 30s 내 한글 응답 + streamEnd | E |
| REQ-C2 | 코치 헤더 URL-인코딩 | 한글 코치 이름·인격 → `x-hps-coach-name` 가 `encodeURIComponent` 적용된 byte-safe 값 | U |
| REQ-C3 | History 영속화 (workspaceState) | 최대 200 turn 유지, 패널 reload 후 복원, 별도 workspace 에선 보이지 않음 | E + U (clampHistory) |
| REQ-C4 | Clear conversation 명령 | workspaceState 비움 + 빈 history push | E |
| REQ-C5 | Retry message | 직전 user prompt 그대로 다시 전송, history 에 새 assistant turn append | E |
| REQ-C6 | Cancel in-flight stream | AbortController.abort → streamEnd 도착하지 않음, 다음 send 가능 | E |
| REQ-C7 | Webview crash 복구 (S-04 #48) | React render-time error → ErrorBoundary fallback + `webviewError` 호스트 로그 | E |
| REQ-C8 | request_id 가 error banner 에 표시 (S-07 #49) | 스트림 실패 시 `x-request-id` 8글자가 webview ErrorBanner 에 노출 | E |
| REQ-C9 | Show-intent 단축 | "게임 보여줘"/"실행해" 같은 짧은 비-create 입력 → LLM 호출 없이 마지막 게임 preview 재오픈 | U + E |
| REQ-C10 | 이미지 붙여넣기 첨부 (website-copyclone) | **profile `input.image_paste=true` 일 때만**: 입력창에 이미지 클립보드 paste(⌘V) → data URL 썸네일이 입력 영역에 표시 + × 로 제거 가능. image-only(텍스트 없이)도 전송 가능. 텍스트 paste 는 항상 기존 동작 유지(preventDefault 안 함) | E |
| REQ-C11 | 이미지 단발 주입 | 첨부 이미지는 **그 user 턴에만** 모델로 전송됨. `history` 는 text-only 로 매핑(`proxyClient` 가 `m.content` 만 사용) → 후속 턴 재전송·workspaceState 영속 저장 모두 안 함. show-intent 단축은 이미지 첨부 시 건너뜀 | U + E |
| REQ-C12 | 이미지 입력 sanitize + 캡 (worker) | `translate()` 가 OpenAI `image_url` → Anthropic image 블록(data URL→base64 source, http(s)→url source) 변환. `data:image/{png,jpe?g,gif,webp}` + http(s) 만 허용, `file:`/`javascript:` 등은 drop. 턴당 최대 4장·data URL 6.5M자 상한. 이미지 없는 array 는 string 으로 collapse(legacy shape 유지) | U |
| REQ-C13 | 이미지 입력 profile 게이트 (default OFF) | `Profile.input.image_paste` 미설정/false 면 (1) 웹뷰 paste 핸들러가 텍스트 전용으로 동작 + (2) **워커가 `filterMessages` 에서 image 블록 server-side strip** (클라가 보내도 차단). 현 3개 cohort 전부 OFF — 미성년 cohort 가 이미지 흐름에 노출되지 않음. `/v1/profile` 이 resolved boolean 으로 노출 | U |
| REQ-C14 | AI 상호작용 고지 (세션 시작) (#320) | Anthropic Usage Policy — consumer-facing chat 은 최소 세션 시작 시 "AI 와 대화 중" 고지. `AiDisclosureGate`(호스트측): 세션 첫 webview mount 에서 1회 + history clear 직후 재고지; 같은 세션 내 hide/show remount 에는 미재노출. 문구는 오답 가능성·확인 권고 문장 포함(ToS §D.3, verification_reflex). webview 는 메시지 리스트 상단에 `role=note` + `aria-live=polite` 배너로 렌더 | U (`test/ai-disclosure`) |

## D. Preview / Run

| ID | 요구사항 | 수용 기준 | Layer |
|---|---|---|---|
| REQ-D1 | ▶ Run last code 명령 | 마지막 assistant turn 에서 ` ```html ` / `<!doctype>` / ` ```js ` 추출 → preview 패널 오픈 | U + E |
| REQ-D2 | HTML 자동-reveal | assistant 스트림에 HTML 포함 → 별도 클릭 없이 preview 자동 오픈 (Taste 감탄) | E |
| REQ-D3 | Preview iframe 샌드박싱 | `sandbox="allow-scripts allow-pointer-lock allow-modals"` 만. `allow-same-origin`/`allow-top-navigation` 금지. CSP `connect-src none` | U (cspBuilder) + E |
| REQ-D4 | Preview 패널 재사용 | 두 번째 render → 새 WebviewPanel 아니라 기존 panel.reveal | E |
| REQ-D5 | 게임 저장 (workspace `index.html`) | preview 오픈 시 자동으로 workspaceFolder/index.html 에 write (GitHub Pages 준비) | E |
| REQ-D6 | previewReady handshake | host → webview 사이 `previewReady` 메시지 전에 보낸 HTML 은 pending 큐 → ready 시점에 flush | U + E |

## E. Manual-approve modal

| ID | 요구사항 | 수용 기준 | Layer |
|---|---|---|---|
| REQ-E1 | `requireApprovalFor` 기본값 적용 | webview 가 `requestAction(writeFile)` 또는 `executeShell` 시 modal 노출 | E |
| REQ-E2 | Approve/Deny → actionResult | "Approve" 클릭 → `actionResult.approved=true` 가 webview 로 회신 | E |
| REQ-E3 | 설정으로 bypass 가능 | `requireApprovalFor: []` 일 때 modal 없이 즉시 approved 회신 | M |

## F. Coach naming

| ID | 요구사항 | 수용 기준 | Layer |
|---|---|---|---|
| REQ-F1 | `user_names_it` 모드 → 카드 노출 | profile 의 naming_mode = user_names_it + 미설정 → in-panel 카드 | E |
| REQ-F2 | `fixed` 모드 → 카드 미노출 | 카드 안 뜸, 헤더에 `fallback_name` 표시 | E |
| REQ-F3 | 이름·인격 길이 클램프 | 40/200 자 초과 입력 → 잘라서 저장 | U |
| REQ-F4 | 빈 입력 → fallback | 빈 이름 입력 → `profile.fallback_name` 사용 | E |
| REQ-F5 | Rename 명령 prefill | `renameCoach` 실행 시 현재 값 prefilled | E |

## G. Mint student token (#66)

| ID | 요구사항 | 수용 기준 | Layer |
|---|---|---|---|
| REQ-G1 | Issuer 토큰 1회 입력 → SecretStorage 영속 | 첫 mint 시만 prompt, 이후 자동 사용 | U + M |
| REQ-G2 | Cohort 디폴트 = issuer 토큰의 단일-cohort scope | `issuerDefaultCohort()` 가 payload `c` 필드 추출 | U |
| REQ-G3 | 5단계 cascade 검증 | issuer/cohort/profile/user/hours 입력 + `validateInputs` (user charset, hours 1..1440) | U |
| REQ-G4 | 401/403 → 저장된 issuer 삭제 | 인증 실패 시 다음 호출 때 다시 prompt | U + R |
| REQ-G5 | 토큰 → 클립보드 + 만료 토스트 | `vscode.env.clipboard.writeText` + `expISO` 표시 | M |
| REQ-G6 | `forgetIssuerToken` 명령 | secrets 삭제 + 확인 토스트 | M |
| REQ-G7 | Issuer roster append (#290) | `POST /admin/cohorts/:id/roster/append` — cohort-scoped issuer(can_start_session 불요)로 서버측 merge·dedupe, 기존 멤버 보존, 상한 500 | U |
| REQ-G8 | Composite session open (#290) | `POST /admin/cohorts/:id/session/open` — 가드(라이브 세션 시 409, `force:true`로만 교체)→학생토큰 발급→roster append→세션 시작 원자 수행. 토큰은 응답 body로만 전달. issuer는 `max_hours`/`max_session_hours` 상한, 전 경로 24h 하드캡 | U |
| REQ-G9 | Composite session close (#290) | `POST /admin/cohorts/:id/session/close` — 세션 종료 + `{jti, exp}` revoke. TTL은 exp까지 (고정 24h TTL이 장수 토큰보다 먼저 만료되는 구멍 금지) | U |
| REQ-G10 | Server-side issuer mint (#294) | `POST /admin/issuers` (admin Basic/CF) — 서명키 없이 서버가 issuer 발급/재스코프. days≤90·max_hours≤168·session≤24 하드캡, `revoke_jti`로 원자 교체(mint 성공 후 revoke), `issuer_audit:<jti>` 메타데이터 기록(토큰 미포함) | U |
| REQ-G11 | Admin-tier mint delegation (#295) | `can_issue_issuers` 토큰을 든 운영 멤버는 본인 Bearer로 `/admin/issuers` 호출해 강사 issuer 발급 가능(비번 공유 X). 감사에 `minted_by` 기록. **신뢰 모델: Bearer minter ≠ full admin — 본인 scope 안에서만 위임(subset 강제)**: ① 자식 scope는 minter 자신의 scope의 부분집합(cohort 일치, profiles ⊆, max_hours ≤ minter 캡(minter 캡 부재=무제한), can_start_session은 minter가 보유한 scope에서만, max_session_hours ≤ minter 유효캡(기본 4h)) — 위반 시 403; ② `revoke_jti`는 `issuer_audit.minted_by === minter`인(본인이 발급한) 토큰만 대상 — 그 외 403; ③ `can_issue_issuers` 재부여 불가(403) — 권한 자가증식 차단. 새 admin-minter는 full admin(Basic/CF)만 생성하며, full admin은 ①②③ 제한 없음. minter revoke 시 발급권 즉시 소멸 | U |

## H. Report problem (#64)

| ID | 요구사항 | 수용 기준 | Layer |
|---|---|---|---|
| REQ-H1 | 3-step QuickInput cascade | description (≥10자) → recent_turns yes/no → contact (옵션) | M |
| REQ-H2 | JTI 로컬 해싱 (SubtleCrypto) | 원본 JTI 는 절대 네트워크 미전송, 16-hex 만 | U |
| REQ-H3 | 자동 메타데이터 | studio_version, OS, locale, vscode_version, profile_id, jti_hash, last_request_id, ts_client | U |
| REQ-H4 | 마지막 request_id 자동 첨부 | 직전 스트림 에러의 request_id 가 body 에 포함 | U + R |
| REQ-H5 | 429 rate-limit graceful | "잠시 후 다시 시도" 토스트, throw 금지 | R |
| REQ-H6 | 채팅 경로 실패 시에도 동작 | proxyUrl 가 다운된 상태에서도 `/v1/report` 만 살아있으면 신고 성공 (anonymous POST 허용) | R + M |
| REQ-H7 | Abuse 상한 (#260) | 비인증 endpoint 방어: IP당 3건/60s rate limit (429), 전체 body ≤32KB (413), description ≤5000자, attachments ≤20 keys·key명 ≤64자·직렬화 ≤8KB (400), recent_turns opt-in 시 3건×2000자 캡 | U |
| REQ-H8 | PII 최소화 (#260) | 직접 PII 는 `contact` 단일 필드 (옵션, ≤200자) — **D1 에만 저장, Discord embed 미전달**. jti 는 원본 미저장 (16-hex sha256 해시만), Discord embed 는 description 앞 1000자만 노출 | U |
| REQ-H9 | Retention/redaction 정책 (#260) | D1 `reports` 는 진단 목적 한정. 운영 체크리스트: `resolved` 도달 후 90일 내 `contact` 삭제/NULL 처리. GET `/v1/report/:id` 응답은 status/resolution 필드만 (description·contact·attachments 미노출) | 운영 |

## I. Auto-update (#72)

| ID | 요구사항 | 수용 기준 | Layer |
|---|---|---|---|
| REQ-I1 | 24h cadence + 30s initial | 활성화 30s 후 첫 체크, 이후 24h 마다 | U |
| REQ-I2 | Banner gating | newer version + dismissals 에 없음 → 배너; 동일/구버전 → null | U |
| REQ-I3 | Dismiss = 7일 silence | `dismissVersion` 후 동일 버전 배너 7일간 미노출 | U |
| REQ-I4 | 설치 pipeline | download → unzip → `xattr -dr quarantine` → installer.sh write → detached spawn → workbench.action.quit | M |
| REQ-I5 | Free-disk 사전 체크 (≥1GB) | 1GB 미만 → 경고 토스트, 다운로드 skip | U |
| REQ-I6 | Dev 환경에선 no-op | `detectAppBundle` 가 null 이면 "개발 환경" 토스트 후 종료 | U |
| REQ-I7 | 더블-클릭 idempotency | 같은 version 의 inflight Promise 재사용 | U |
| REQ-I8 | Bundle id 일치 확인 | installer.sh 가 `ai.hypeproof.studio` 일 때만 swap | U |

## J. Build / branding integrity (Phase 2-3 게이트)

| ID | 요구사항 | 수용 기준 | Layer |
|---|---|---|---|
| REQ-J1 | App display name = "HypeProof Studio" | `Info.plist` `CFBundleDisplayName` 검증 | M (`scripts/verify-branding.sh`) |
| REQ-J2 | Bundle id = `ai.hypeproof.studio` | `defaults read .../Info.plist CFBundleIdentifier` | M (`scripts/verify-branding.sh`) |
| REQ-J3 | Data folder = `~/Library/Application Support/HypeProof Studio/` | 첫 실행 후 디렉토리 존재 | M (`scripts/verify-branding.sh`) |
| REQ-J4 | "VSCodium" 잔존 문자열 없음 (About attribution 외) | `grep -ri "VSCodium\|codium" Resources \| grep -v -i "license\|notice\|attribution\|third-party"` 결과 0 | M (`scripts/verify-branding.sh`) |
| REQ-J5 | 빌트인 확장 자동 활성 | `onStartupFinished` 시 activity bar 에 hypeproof-chat container 노출 | E |

## K. Settings & config

| ID | 요구사항 | 수용 기준 | Layer |
|---|---|---|---|
| REQ-K1 | 3개 설정 노출 | `hypeproofChat.proxyUrl` / `model` / `requireApprovalFor` 가 settings UI 에 검색됨 | M |
| REQ-K2 | webview → openSettings 브릿지 | 패널 내부 ⚙ 클릭 → `workbench.action.openSettings` 호출 | E |
| REQ-K3 | `coachRuntime` 설정 노출 | `hypeproofChat.coachRuntime` (proxy/agent-sdk) 가 settings UI 에 검색됨 | M |

## L. Safety / observability

| ID | 요구사항 | 수용 기준 | Layer |
|---|---|---|---|
| REQ-L1 | Chat webview CSP | `default-src 'none'` + nonce'd script-src + connect-src webview only | U (cspBuilder) |
| REQ-L2 | Preview iframe 격리 | iframe sandbox 위 D3 + parent CSP `frame-src 'self' data: blob:` | U (cspBuilder) |
| REQ-L3 | Stream abort on dispose | view dispose 시 모든 activeStreams.abort + map clear | U |

## M. Agent SDK coach runtime (#282)

> `hypeproofChat.coachRuntime = "agent-sdk"` 로 전환 시 코치를 Claude Agent SDK 위에서 구동. Phase 1: `@anthropic-ai/claude-agent-sdk` 가 실제 의존성으로 설치되어 있고(dev/extension-host 경로), worker 게이트웨이(`POST /v1/messages`, #316)로 라우팅된다. 아래 안전 계약은 pure helper 단위로 검증된다. Phase 2 부터 도구 정책의 canonical owner 는 **worker 프로필의 `sdk_tools`** 다 ([ADR 0003](adr/0003-agent-sdk-coach-runtime.md) / #283) — 클라이언트는 tier 로 파일 도구를 추론하지 않는다. 주의: SDK 는 플랫폼별 native `claude` 바이너리(~240 MB)를 optionalDependency 로 동반한다 — 패키징(.vsix/built-in)은 node_modules 를 포함하지 않으므로 그 경로에서는 REQ-M7 폴백이 동작하며, built-in 번들링 전략은 Phase-2+ 결정 사항이다.

| ID | 요구사항 | 수용 기준 | Layer |
|---|---|---|---|
| REQ-M1 | 프로필 → 도구 정책 매핑 (fail-closed) | `permittedToolsFor`: worker 프로필 `sdk_tools` 가 유일한 소스 — `read: true` → Read/Grep/Glob, `write: true` → Write/Edit. `sdk_tools` 부재/false → chat-only(`[]`), 워크숍 tier 라도 예외 없음 (tier 기반 추론 제거, #282 Phase 2) | U (`test/sdk-coach-helpers`) |
| REQ-M2 | WebSearch 는 프로필 opt-in 에만 | `tools.web_search === true` 인 cohort 만 WebSearch 부여 (assets_focus 추론 금지) | U (`test/sdk-coach-helpers`) |
| REQ-M3 | Minor 루프 bound | `maxTurnsFor`: 워크숍 20, 그 외(미지정 포함) 6 | U (`test/sdk-coach-helpers`) |
| REQ-M4 | SDK 도구 → 정확한 ActionRequest kind | `sdkToolToActionRequest`: Bash → `executeShell`(Tier-1 hard-deny), Write/Edit → `writeFile`+실경로, Read → `readFile`, WebSearch → `webSearch`, 미지 도구 → fail-closed(`executeShell`) | U (`test/sdk-coach-helpers`) |
| REQ-M5 | 매 tool use 는 canUseTool 게이트 | SDK `allowedTools` 는 빈 값 + `settingSources: []` — 모든 도구가 canUseTool 로 fall-through, cohort 미허용 도구는 deny | U + E |
| REQ-M6 | 게이트웨이 라우팅 + env 보존 | `buildSdkGatewayEnv`: process.env 스프레드(PATH/HOME 보존) 위에 SDK 인식 변수만 설정 — `ANTHROPIC_BASE_URL` 은 `proxyUrl` 설정에서 **파생**(`/v1` 접미사 제거 — SDK 가 `/v1/messages` 를 스스로 붙임), `ANTHROPIC_AUTH_TOKEN` = workshop 토큰 (커스텀 이름 금지) | U (`test/sdk-gateway`) |
| REQ-M7 | SDK 미가용 시 proxy fallback | 패키지 로드 실패(패키징 빌드 등 node_modules 부재) → `SdkUnavailableError` → 콘솔 경고 + 해당 턴 proxy 로 폴백 (학생에게 raw 에러 미노출) | U + E |
| REQ-M8 | Abort parity | agent-sdk 경로도 stop 시 AbortError throw → streamEnd·appendHistory 건너뜀 (잘린 턴 미커밋); abort listener 는 `loadSdk()` 이전 등록 | U + E |
| REQ-M9 | `/v1/messages` 게이트 parity | worker `POST /v1/messages` (Anthropic-native 게이트웨이) 는 `/v1/chat/completions` 와 동일 게이트 공유 (`lib/chat-gate.ts`): 토큰 verify · issuer 거부 · revocation · session window · roster · cohort pause · signingSecretGuard | R (`worker/test/messages-integration.test.mjs`, `route-order.test.mjs`) |
| REQ-M10 | 서버측 system prompt 강제 | `/v1/messages` 는 클라이언트 `system` 을 병합 없이 폐기하고 cohort 프로필 블록으로 교체 (`buildAnthropicSystemBlocks` — `/v1/chat` 과 byte-identical, prompt-cache 마커 유지). classroom key 는 worker 밖으로 안 나감 (upstream 은 `x-api-key`, 학생 토큰 미전달) | R (`worker/test/messages-integration.test.mjs`) |
| REQ-M11 | 모델 정책 clamp | `/v1/messages` 요청 모델은 프로필 catalog (default/fallback/fast alias 또는 그 id) 로 clamp; `claude-*haiku*` 는 fast 핀으로 (SDK aux 호출 비용 상향 방지); 그 외는 프로필 default 강제 | R (`worker/test/messages-integration.test.mjs`) |
| REQ-M12 | Anthropic-native passthrough + 계량 | 응답은 원형 그대로 (non-stream JSON verbatim; stream 은 Anthropic SSE verbatim — OpenAI chunk/[DONE]/asset_score 미주입) + usage tap 으로 `usage_log`/`turns` 를 chat 과 동일 스키마로 기록; upstream 에러·stream 중단은 #257 규율 (request_id 만 노출) | R (`worker/test/messages-integration.test.mjs`) |
| REQ-M13 | 로컬 API key 불요·불허 | agent-sdk 경로의 유일한 자격증명은 workshop 토큰. `buildSdkGatewayEnv` 가 ambient `ANTHROPIC_API_KEY`(AUTH_TOKEN 보다 우선순위 높음)·`CLAUDE_CODE_USE_BEDROCK`·`CLAUDE_CODE_USE_VERTEX` 를 스크럽 — 개발 머신의 키/프로바이더 스위치가 게이트웨이를 우회할 수 없다. classroom Anthropic key 는 worker 밖으로 안 나감 | U (`test/sdk-gateway`) |
| REQ-M14 | 런타임 플래그 기본값 고정 | `hypeproofChat.coachRuntime` default 는 `"proxy"` — Phase-3 전환은 Jay-gated 별도 결정 (스모크가 package.json 기본값을 잠금) | U (`test/sdk-gateway`) |
| REQ-M15 | 게이트웨이 4xx fast-fail (#320) | SDK CLI 는 401/400 도 최대 10회 backoff 재시도 → 만료 토큰이 아이에게 수 분간 무응답으로 보임. `consumeSdkStream`: `api_retry` 이벤트의 `error_status` 401/400 이면 **첫 이벤트에서** 쿼리 abort + proxy 경로와 동일한 토큰 복구 경로 throw (`ProxyAuthError("expired", TOKEN_EXPIRED_FRIENDLY)` — 죽은 토큰 삭제 + 재입력 prompt, 문구는 `proxyClientHelpers` 단일 소스). 429/5xx/529/연결오류(null status)는 SDK backoff 유지 | U (`test/sdk-fastfail`) |
| REQ-M16 | `sdk_tools` 는 프로필 소유 + 가용성/승인 분리 (#282 P2) | worker `Profile.sdk_tools { read, write }` 가 `/v1/profile` 로 노출(부재 → 명시적 false 정규화). 스키마에 shell/exec 플래그 자체가 **존재하지 않음**. 클라이언트 매핑: `buildSdkQueryOptions` 가 permitted set 을 SDK `Options.tools`(base tool set — 가용성)로 전달, chat-only cohort 는 `tools: []` 로 빌트인 전체 비활성. `allowedTools` 는 항상 `[]` 유지 — allowedTools 항목은 **auto-approve 로 canUseTool 을 우회**하므로 승인 모달을 무력화한다(가용성≠승인). 프로필 밖으로 절대 확장 금지 | U (`test/sdk-coach-helpers`, `test/sdk-gateway`) + R (`worker/test/chat-integration`) |
| REQ-M17 | canUseTool 정책 매트릭스 (#282 P2) | `evaluateSdkToolUse` (매 tool call): ① 프로필 미허용 도구(Bash·미 opt-in WebFetch·미지/MCP 도구) → **deny** + 호스트 로그(사유), 학생에겐 한국어 안내; ② read 도구(Read/Grep/Glob)는 **워크스페이스 내부 경로만 자동 허용** — `../` 탈출·cwd 밖 절대경로·절대/`..` Glob 패턴은 deny (`isPathContained`); ③ write 도구(Write/Edit)는 경로 격리 통과 후에도 **항상** `resolveActionApproval` 승인 모달 경유 (승인 게이트가 곧 pedagogy — delegation_judgment·verification_reflex); shell 은 permitted set 이 오염돼도 deny (belt-over-suspenders) | U (`test/sdk-coach-helpers`) |
| REQ-M18 | 미성년 write 불가 invariant (#282 P2, #320) | 미성년 cohort 는 어떤 경로로도 write/exec 능력을 얻지 않는다: ① worker cohort-harness `child_sdk_write` **FAIL** (child cohort 의 `sdk_tools.write: true` 차단, `validate-profiles` + CI); ② worker smoke — parent_coaching cohort 전수 `sdk_tools.write ≠ true`; ③ 클라이언트 `permittedToolsFor` 가 minor tier 에서 write 도구를 **무조건 strip** (프로필이 오염돼도 방어). 의심스러우면 deny | U (`test/sdk-coach-helpers`) + R (`worker/test/smoke`, cohort-harness fixtures) |
| REQ-M19 | 브라우저 MCP 도구는 프로필 소유 (#282 P2 slice 2, #309) | `Profile.sdk_tools.browser` 가 `/v1/profile` 로 노출(부재 → false). grant 시 in-process SDK MCP 서버 `"hypeproof"` (`createSdkMcpServer`) 가 `mcpServers` 로 등록 — 도구: `browser_open(url)`·`browser_screenshot()`(vision image 반환)·`live_preview_start()` (#309 native browser + live server 재사용). 등록 조건: `permittedMcpToolsFor` 비어있지 않음(성인 + browser=true) AND SDK/zod factory 가용 — 아니면 browser-less 로 우아하게 강등. MCP 이름은 `Options.tools`(빌트인 가용성)에 **절대 안 들어감**; `strictMcpConfig: true` 로 ambient MCP 설정(.mcp.json/유저 설정/플러그인) 차단; `allowedTools` 는 여전히 `[]` (모든 호출이 canUseTool 경유) | U (`test/sdk-coach-helpers`, `test/sdk-gateway`, `test/browser-mcp`) + R (`worker/test/chat-integration`) |
| REQ-M20 | 브라우저 MCP canUseTool 정책 (#282 P2 slice 2) | `evaluateSdkToolUse`: ① `browser_open` 은 **outward action** — URL 정책(`safeNavigateUrl` 재사용: http(s)/localhost/file 만, `javascript:`·`vscode:`·`data:`·bare path 거부)을 모달 **이전에** 통과해야 하고, 통과해도 **항상** 승인 모달 (`ActionRequest kind "openBrowser"`, `requireApprovalFor` 기본값 포함 — delegation_judgment); ② `browser_screenshot`/`live_preview_start` 는 browser grant 존재 시 자동 허용 (학생 자신의 탭/워크스페이스를 코치가 "보는" 행위 — verification_reflex); ③ 미허용 cohort 의 hypeproof MCP 도구·모든 외부 `mcp__*` 도구 → deny; 핸들러도 URL 정책을 재검증 (belt-over-suspenders, 거부 시 isError 결과) | U (`test/sdk-coach-helpers`, `test/browser-mcp`) |
| REQ-M21 | 미성년 브라우저 도구 불가 invariant (#282 P2 slice 2, #306/#318) | safe-session 출시 전까지 미성년 cohort 는 브라우저 MCP 능력을 얻지 않는다: ① worker cohort-harness `child_sdk_browser` **FAIL** (child cohort 의 `sdk_tools.browser: true` 차단); ② worker smoke — parent_coaching cohort 전수 `sdk_tools.browser ≠ true` + browser grant 는 성인 copyclone cohort 단독; ③ 클라이언트 `permittedMcpToolsFor` 가 minor/미지 tier 에서 **무조건 strip** (프로필이 오염돼도 방어). 의심스러우면 minor 는 deny | U (`test/sdk-coach-helpers`, `test/sdk-gateway`) + R (`worker/test/smoke`, cohort-harness fixtures) |
| REQ-M22 | SDK subagents 는 프로필 소유 + 읽기 전용 교집합 (#282 P2 slice 3) | `Profile.sdk_tools.subagents` 가 `/v1/profile` 로 노출(부재 → false). grant 시: ① 읽기 전용 subagent 카탈로그(`코드리뷰어`/`리서처` — 한국어 prompt, 이 slice 에선 web 도구 없음)가 SDK `Options.agents` 로 정의되고 Agent/Task invoker 가 `Options.tools` 에 합류 — 미grant 시 `agents` 키 자체가 부재해 모델이 subagent 를 볼 수 없음; ② 각 definition 의 `tools` 는 wishlist(Read/Grep/Glob) ∩ cohort permitted set — definition 이 drift 해 Write 를 열어도 교집합이 strip (read-only cohort 의 코드리뷰어는 절대 Write 불가), `tools` 는 **항상 명시** (생략 시 부모 전체 도구 상속 — sdk.d.ts `AgentDefinition.tools`), `disallowedTools` 로 Bash/Write/Edit/Web 이중 차단; ③ 위임(Agent/Task 호출)은 카탈로그 내 `subagent_type` 만 허용(미지/부재 → deny) + **항상** 승인 모달 (`ActionRequest kind "delegateAgent"`, `requireApprovalFor` 기본값 포함) — 학생의 승인/거부가 곧 delegation_judgment pedagogy (seven-assets §5); ④ **subagent 의 도구 호출도 부모 `canUseTool` 을 경유** (sdk.d.ts@0.3.207 `CanUseTool` options 의 `agentID` — "If running within the context of a sub-agent, the sub-agent's ID") → 동일 `evaluateSdkToolUse` 매트릭스 적용, definition allowlist 는 defense-in-depth | U (`test/sdk-subagents`) + R (`worker/test/chat-integration`) |
| REQ-M23 | 미성년 subagent 불가 invariant (#282 P2 slice 3) | pedagogy 결정 전까지 미성년 cohort 는 SDK subagent 능력을 얻지 않는다: ① worker cohort-harness `child_sdk_subagents` **FAIL** (child cohort 의 `sdk_tools.subagents: true` 차단, `validate-profiles` + fixtures); ② worker smoke — parent_coaching cohort 전수 `sdk_tools.subagents ≠ true` + grant 는 성인 copyclone cohort 단독; ③ 클라이언트 `permittedAgentToolsFor` 가 minor/미지 tier 에서 **무조건 strip** (프로필이 오염돼도 방어). 의심스러우면 minor 는 deny | U (`test/sdk-subagents`) + R (`worker/test/smoke`, cohort-harness fixtures) |
| REQ-M24 | native `claude` 바이너리 해석 순서 + 무결성 게이트 (#282 W4a, [docs/sdk-bundling.md](sdk-bundling.md)) | `resolveSdkBinary` (pure, 프로브 주입): ① `hypeproofChat.sdkBinaryPath` 설정 → ② `HPS_SDK_BINARY` env (e2e/CI) → ③ seeded 위치 (`seededSdkBinaryPath` 가 유일 정의 — darwin `~/Library/Application Support/HypeProof-Studio/sdk/<ver>/claude`; `scripts/seed-sdk-binary.sh` 가 설치) — seed 시 tarball sha512 를 핀 manifest(`sdkBinaryManifest.ts` = package-lock, smoke 로 drift 차단)에 대해 1회 검증 후 `.verified.json` 마커 기록, 런타임은 마커 + 정확 크기 일치 + min-floor 만 검사 (229 MB 를 매 턴 재해시하지 않음) → ④ node_modules (dev — `pathToClaudeCodeExecutable` 미전달, SDK 자체 lookup) → ⑤ 전부 실패 → `SdkUnavailableError` → proxy 폴백 (REQ-M7 그대로). 상위 후보의 부재/불신은 **fall-through** (stale 설정이 dev 경로를 막지 않음). 바이너리 존재는 도구 정책을 절대 확장하지 않음 — minor cohort 는 바이너리가 있어도 `tools: []` | U (`test/sdk-binary`) |

---

## How to update this doc

1. PR that **adds** a behavior:
   - Add a row to the appropriate domain table (A–L). New domain → new ## section.
   - Specify Layer column with cheapest-first principle (U over E over R over M).
   - In the same PR, add a sub-issue to epic #89 if 🔴 (not yet implemented).

2. PR that **changes** a behavior:
   - Update the row's acceptance criteria.
   - Reference the REQ-### in the commit message body.
   - If the test layer changes (e.g. promoted U → E because logic moved into VS Code API surface), update the column too.

3. PR that **removes** a behavior:
   - Delete the row.
   - Document the removal in METAPLAN if it's user-visible.
   - Sub-issue cleanup in epic #89.

## Spec version policy

Bump `Spec version` on:
- A new domain section (e.g. M, N, …) → bump minor (v0.2.0).
- A breaking contract change in a stable REQ (e.g. token now requires a new claim) → bump minor.
- Editorial (typos, layer-column refinements, wording) → no bump.

Major version bump is reserved for a deliberate restructuring of the doc itself — not for product changes.

## Related

- [METAPLAN.md](../METAPLAN.md) §4.5 — AI Native Asset → Chat Panel UX map
- [docs/seven-assets.md](./seven-assets.md) — 7 AI Native Assets (canonical product philosophy)
- [.claude/rules/extension-dev.md](../.claude/rules/extension-dev.md) — hypeproof-chat extension architecture
- [.claude/rules/build-pipeline.md](../.claude/rules/build-pipeline.md) — build + post-build branding verification
- [tests/rehearsal/README.md](../tests/rehearsal/README.md) — R1–R6 rehearsal categories
- [e2e/README.md](../e2e/README.md) — Playwright Electron e2e

## N. Native browser + agentic control (#278)

Phase 0–3 (통합 브랜치 `feat/boah-homepage-browser`). "실기계"는 디스플레이 있는 풀빌드/
dev-host 검증(자동화 셸 불가). REQ-D3(iframe 샌드박싱)은 live_server 코호트엔 REQ-N1이 대체.
**대상 코호트: 원장 website-copyclone(`boah-dental-director-copyclone-2026-s1`, cohort
`boah-dental-2026-a`, tier `website`)** — PR #309 리뷰로 별도 homepage 코호트 대신 이 트랙에 통합.

| ID | 요구 | 설명 | 테스트 |
|---|---|---|---|
| REQ-N1 | live_server 프리뷰 | `preview.type:"live_server"` 코호트는 iframe 대신 워크스페이스를 127.0.0.1로 서빙해 네이티브 브라우저로 열고, 저장 시 SSE로 자동 새로고침. path-traversal 거부 | U(liveServerHelpers) + 실기계 |
| REQ-N2 | live_server 계약 완화 | live_server 코호트는 멀티파일·상대경로·same-origin fetch·스토리지 허용 계약을 받음(iframe 단일파일 계약 아님) | U(translate 분기) |
| REQ-N3 | 페이지→코치(vision) | page_context+image_paste 코호트에서 "페이지를 코치에게"가 현재 탭 스크린샷+DOM을 코치에 전달. 미성년 코호트는 반드시 off | U(worker gate) + 실기계 |
| REQ-N4 | 브라우저 tool 게이팅 | `browser_control` 켜진 코호트만 worker가 8개 브라우저 도구 + 사용 규약을 주입. 꺼지면 tool_use/tool_result 블록도 drop | U(translate) |
| REQ-N5 | CDP 실행기 핸드셰이크 | 실행기는 `Target.attachToTarget({flatten})` 후 sessionId로 모든 페이지 명령 라우팅(스파이크 확정). navigate URL은 스킴 화이트리스트(http/https/localhost/file) | U(cdpSession, browserControlHelpers) + 실기계 |
| REQ-N6 | 자동실행 + 액션로그 | 코치의 브라우저 액션은 모달 없이 자동 실행되고, 채팅에 액션 로그(running→done/error)로 표시. tool 루프 scratch 턴은 영속 히스토리 미오염 | U + 실기계 |
| REQ-N7 | 루프 안전 | agentic 루프는 per-cohort `max_iterations` 캡 + abort 준수. asset_score는 최종(비-tool) 턴만 기록 | U |

## O. 미성년 안전·컴플라이언스 (#320)

Anthropic 미성년자 가이드(#282 의 2026-07-13 라이선싱 코멘트) 구현 계층. 게이트웨이 모더레이션은
`worker/src/lib/moderation.ts` — deterministic 토큰/패턴 스크린이며 모델 호출이 아니다. **성인
코호트는 이 계층을 완전히 건너뛴다 (동작 변화 0).** 프로젝트 불변식: 미성년 코호트는 의심스러우면
차단(deny) 방향으로만 실패한다.

| ID | 요구사항 | 수용 기준 | Layer |
|---|---|---|---|
| REQ-O1 | Minor cohort 판별 fail-safe | `minor_cohort: true` 플래그 **또는** `audience.age_range` 상한 < 18 → minor (`isMinorCohort`). 플래그 누락이 모더레이션을 silent-disable 할 수 없음. `/v1/profile` 응답에 `minor_cohort` 노출 (클라이언트 AI 디스클로저 등 minor UX 근거) | R (`worker/test/moderation.test.mjs`) |
| REQ-O2 | 인바운드 게이트웨이 모더레이션 | minor cohort 의 최신 user 텍스트를 **upstream 호출 전** 스크린 (`/v1/chat` + `/v1/messages` 동일, stream/non-stream 공통). 카테고리: 노골적 성적 콘텐츠 · 자해 지시 · 잔혹 폭력 · PII 요구 (전화번호/집주소/주민번호). 한국어 토큰은 multi-char only (bare 색 → 검색 매칭 함정). 차단 시 400 + `type: "moderation_block"` + kid-friendly 한국어 문구 + `request_id`, upstream 호출 0회 | R (`worker/test/moderation.test.mjs`) |
| REQ-O3 | 아웃바운드 non-stream 모더레이션 | non-stream 응답의 assistant 텍스트 스크린 — 차단 시에도 usage 계량은 유지 (토큰은 실소비). **스트리밍 아웃바운드는 문서화된 후속** (스트림 버퍼링 금지 — 인바운드 스크린 + 코호트 child-safety 프롬프트가 스트림 경로 방어) | R (`worker/test/moderation.test.mjs`) |
| REQ-O4 | 성인 코호트 무영향 | adult profile 은 스크린을 아예 호출하지 않음 — 동일 텍스트가 성인 경로에선 그대로 통과 | R (`worker/test/moderation.test.mjs`) |
| REQ-O5 | 로그 위생 | 차단 로그(console.error + Analytics `moderation_block` datapoint)는 category + rule id + FNV hash 만 — 매칭된 텍스트 verbatim 절대 금지 | R (`worker/test/moderation.test.mjs`) |
| REQ-O6 | Age-verification 설계 노트 | [docs/age-verification.md](./age-verification.md) 유지 — 수강등록+roster+토큰 게이트가 minors-guide 의 "only intended users" 요건을 충족한다는 논거 + 잔여 갭 추적 | M (문서 리뷰) |
| REQ-O7 | False-positive 회귀 목록 | 검색/색상/이야기한(야한)/유니섹스(섹스)/게임 속 몬스터 처치/사이트 주소/전화번호 입력 화면 등 benign 한국어가 절대 차단되지 않음 — 룰 추가 PR 은 이 목록을 통과해야 머지 | R (`worker/test/moderation.test.mjs`) |
