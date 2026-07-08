# Studio behavioral requirements

> **Spec version:** v0.1.0
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

## H. Report problem (#64)

| ID | 요구사항 | 수용 기준 | Layer |
|---|---|---|---|
| REQ-H1 | 3-step QuickInput cascade | description (≥10자) → recent_turns yes/no → contact (옵션) | M |
| REQ-H2 | JTI 로컬 해싱 (SubtleCrypto) | 원본 JTI 는 절대 네트워크 미전송, 16-hex 만 | U |
| REQ-H3 | 자동 메타데이터 | studio_version, OS, locale, vscode_version, profile_id, jti_hash, last_request_id, ts_client | U |
| REQ-H4 | 마지막 request_id 자동 첨부 | 직전 스트림 에러의 request_id 가 body 에 포함 | U + R |
| REQ-H5 | 429 rate-limit graceful | "잠시 후 다시 시도" 토스트, throw 금지 | R |
| REQ-H6 | 채팅 경로 실패 시에도 동작 | proxyUrl 가 다운된 상태에서도 `/v1/report` 만 살아있으면 신고 성공 (anonymous POST 허용) | R + M |

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

> `hypeproofChat.coachRuntime = "agent-sdk"` 로 전환 시 코치를 Claude Agent SDK 위에서 구동. Phase-0/1 스캐폴드 — 아래 안전 계약은 SDK 미설치 상태에서도 pure helper 단위로 검증된다. 도구 정책의 canonical owner 는 궁극적으로 worker 프로필이어야 한다 ([ADR 0003](adr/0003-agent-sdk-coach-runtime.md) / #283).

| ID | 요구사항 | 수용 기준 | Layer |
|---|---|---|---|
| REQ-M1 | 프로필 → 도구 정책 매핑 (fail-closed) | `permittedToolsFor`: `search-webapp`(워크숍) → Read/Write/Edit; 게임/kids/teen/미지정 tier → chat-only(`[]`) | U (`test/sdk-coach-helpers`) |
| REQ-M2 | WebSearch 는 프로필 opt-in 에만 | `tools.web_search === true` 인 cohort 만 WebSearch 부여 (assets_focus 추론 금지) | U (`test/sdk-coach-helpers`) |
| REQ-M3 | Minor 루프 bound | `maxTurnsFor`: 워크숍 20, 그 외(미지정 포함) 6 | U (`test/sdk-coach-helpers`) |
| REQ-M4 | SDK 도구 → 정확한 ActionRequest kind | `sdkToolToActionRequest`: Bash → `executeShell`(Tier-1 hard-deny), Write/Edit → `writeFile`+실경로, Read → `readFile`, WebSearch → `webSearch`, 미지 도구 → fail-closed(`executeShell`) | U (`test/sdk-coach-helpers`) |
| REQ-M5 | 매 tool use 는 canUseTool 게이트 | SDK `allowedTools` 는 빈 값 + `settingSources: []` — 모든 도구가 canUseTool 로 fall-through, cohort 미허용 도구는 deny | U + E |
| REQ-M6 | 게이트웨이 라우팅 + env 보존 | `env: { ...process.env, ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN }` (커스텀 이름 금지, PATH 보존) | U |
| REQ-M7 | SDK 미가용 시 proxy fallback | 패키지 부재 → `SdkUnavailableError` → 콘솔 경고 + 해당 턴 proxy 로 폴백 (학생에게 raw 에러 미노출) | U + E |
| REQ-M8 | Abort parity | agent-sdk 경로도 stop 시 AbortError throw → streamEnd·appendHistory 건너뜀 (잘린 턴 미커밋); abort listener 는 `loadSdk()` 이전 등록 | U + E |

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
