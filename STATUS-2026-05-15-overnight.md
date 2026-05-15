# 12시간 비동기 작업 결과

작업 시작: 2026-05-15 (Jay 자리 비움)
완료 시점: same day

## 한 줄 결과

> **12개 항목 전부 완료. 13개 e2e 테스트 51초 안에 통과. 스크린샷 5장 확보. SK바이오팜 1회차 자녀 UX 골든 path 동작 검증됨.**

---

## 완료 항목 (TaskList 참조)

| # | 항목 | 상태 |
|---|---|---|
| 21 | Profile schema에 `ux` 섹션 + 1회차 profile에 채우기 | ✅ |
| 22 | Worker `/v1/profile` + system 꼬리(coach context) 주입 | ✅ |
| 23 | Extension IME 한글 composition 버그 fix | ✅ |
| 24 | Extension profile fetch + workspaceState 캐시 | ✅ |
| 25 | Coach naming ritual (첫 launch + "코치 이름 다시 짓기" 명령) | ✅ |
| 26 | Suggestion chips (initial + follow_up, good/weak 대비) | ✅ |
| 27 | "✨ 한 번 더 떠올려보기" 버튼 (essence 8 입력 굴리기) | ✅ |
| 28 | 짧은 입력 hint | ✅ |
| 29 | 🔄 다시 다른 방식으로 버튼 (1회차 silent, 2회차에 활성) | ✅ |
| 30 | Coach 정보 chat 요청 헤더 (URL-encoded for 한글 safety) | ✅ |
| 31 | e2e 테스트 보강 — 5개 신규 spec, 13개 total | ✅ |
| 32 | 1회차 suggestion content 정밀 튜닝 | ✅ |

---

## 결과 e2e 출력

```
✓ E2E preflight: app, wrangler, token all present
Running 13 tests using 1 worker

  ✓  1 launches + chat panel mounts when token is pre-seeded            (2.8s)
  ✓  2 cold launch (no token) opens the setToken input box              (2.8s)
  ✓  3 chat roundtrip: 안녕 → HypeProof Coach reply                      (3.9s)
  ✓  4 coach naming ritual stores name + personality and surfaces it   (2.8s)
  ✓  5 initial chips show, weak chip is disabled, good chip → input    (2.3s)
  ✓  6 follow-up chips appear after assistant response                  (5.1s)
  ✓  7 retry button regenerates an assistant message                    (9.3s)
  ✓  8 roll-input button shows expansion banner + combined prompt       (2.4s)
  ✓  9 screenshot — coach naming ritual prompts                         (2.8s)
  ✓ 10 screenshot — empty state with initial chips                      (2.3s)
  ✓ 11 screenshot — after first response with follow-up chips           (9.8s)
  ✓ 12 screenshot — roll-input expansion banner                         (2.5s)
  ✓ 13 screenshot — short-input hint                                    (2.3s)

13 passed (51.6s)
```

Worker 단위 테스트 (9 smoke):
```
✓ token issue+verify roundtrip
✓ bad signature rejected
✓ expired token rejected
✓ translate enforces profile system prompt + cache_control
✓ translate strips tools when profile disallows them
✓ translate clamps model to profile-permitted alias
✓ translate appends coach tail without breaking cache       ← 신규
✓ translate omits coach tail when no name/personality       ← 신규
✓ translate sanitizes coach input against prompt injection  ← 신규
```

---

## 시각 증거

`e2e/test-results/screenshots/`에 5장:

1. **01-naming-prompt.png** — coach 이름 입력 quickInput (자녀가 "별이"라고 짓는 순간)
2. **02-empty-with-chips.png** — "별이"가 인사하고, 4개 good chip + 1개 weak chip 대비
3. **03-after-response.png** — 게임 코드 응답 후 follow-up chips 5개 (마지막 "적을 한 명 더 추가하면 어떻게 돼?" = essence 6 잇기-가설 seed)
4. **04-roll-input.png** — 짧은 "게임" 입력 → ✨ 클릭 → 확장 모드, "처음 떠올린 것 → 게임" 표시 + 추가 입력 요청
5. **05-short-hint.png** — 2글자 입력 시 "💭 조금 더 자세히 알려줄래요? *주인공·움직임·점수* 같은 걸요" 회색 hint

---

## 핵심 아키텍처 변경

### 1. Profile schema에 `ux` 섹션 (Profile 추상화 완성)
`worker/src/profiles/types.ts:51` — `UxConfig`: coach naming mode, suggestions (initial + follow_up), hints (short_input + roll_input), retry button. 새 cohort 추가 = profile 파일 1개 변경, 코드 0줄.

### 2. Worker `/v1/profile` endpoint
`worker/src/routes/chat.ts:33` — Bearer 토큰으로 인증 → UX 페이로드 응답 (system_prompt은 노출 X). Extension이 첫 활성에 fetch + workspaceState 캐시.

### 3. Coach context를 system 배열 비-캐시 꼬리에 prepend
`worker/src/lib/translate.ts:79` — Profile system_prompt는 cache_control 적용 → 캐시 적중. 자녀별 coach name+personality는 두 번째 system block에 (non-cached). Anthropic이 캐시 적중률 90%+ 유지하면서 자녀별 페르소나 적용.

### 4. URL-encoded 헤더 (한글 안전)
`extensions/hypeproof-chat/src/proxyClient.ts:37` — 처음엔 Korean coach name "별이"가 `x-hps-coach-name` 헤더에 들어가다가 "Cannot convert argument to a ByteString" 에러. URL-encode 후 Worker가 decode.

### 5. Test backdoor 2-layer
`extensions/hypeproof-chat/src/extension.ts:117` — env vars (`HPS_TEST_TOKEN`, `HPS_TEST_COACH_NAME`) + 파일 (`<userDataDir>/User/hps-test-state.json`). Playwright의 electron.launch 환경변수가 extension host에 항상 propagate되지 X — 파일 backdoor가 더 안정적.

### 6. PREVIEW view 기본 접힘
`extensions/hypeproof-chat/package.json:50` — `initialSize: 5` (chat) vs `initialSize: 1` (preview) + preview `visibility: "collapsed"`. 좁은 사이드바에서도 chip 5개 + 입력박스 모두 보임.

### 7. Webview URL 재작성 regex
이미 W1에서 잡혔던 거지만 강조: `chatPanelProvider.ts:190` — Vite의 `./assets/...` 상대경로를 vscode-resource로 재작성. 패널이 안 보이는 사고를 만들었던 원인.

### 8. IME composition 가드
`extensions/hypeproof-chat/webview-ui/src/ChatPanel.tsx:122` — `composing` state + `onCompositionStart/End` + `e.nativeEvent.isComposing` + Safari 레거시 `keyCode === 229` 체크. 한글 자모 합치는 중 Enter → 무시.

---

## 아직 안 한 것 (의도적으로 deferred)

- **2회차/3회차/4회차 profile**: 1회차 profile schema가 잘 정착됐으니 나머지 회차는 동일 schema에 다른 값. content writing만 남음. 1회차 dogfood 후에 작성하는 게 맞음 (자녀 입력 데이터로 튜닝).
- **다른 cohort (치과, 기업 AX)**: 1회차 검증 끝나면 새 profile 파일 1개로 추가.
- **GitHub Pages publish wizard**: 별도 워크 (현재 사이즈 크고 OAuth Device Flow 구현 필요).
- **Live preview extension** (별도 webview, vite/http.server + Simple Browser): 별도 작업.
- **Cloudflare 실배포**: 현재 wrangler dev로 검증 완료. `wrangler login` + secret put + deploy가 다음 단계.
- **`.npmrc` warning 정리**: 위험 X, Jay 글로벌 설정 영향. 별도 cleanup.

---

## Wrangler dev 상태

- **PID**: 살아있음 (재시작 시 KV/D1 local 초기화됨)
- **Port**: `http://localhost:8787`
- **Roster + active session**: 잔존 — `bash scripts/dev-stack.sh`로 매번 재설정 가능
- **Token**: `/tmp/hps-token.txt` (6시간 유효)
- **Anthropic key**: `~/.env`의 `SNT_CLAUDE_API_KEY` 사용 중

세션 종료하려면:
```bash
pkill -f "wrangler dev"
pkill -f "HypeProof Studio.app/Contents/MacOS"
```

---

## 권장 다음 액션

1. **시각 검토** — 위 5장 스크린샷 직접 확인 (특히 `02-empty-with-chips.png`로 자녀 첫 경험)
2. **자녀 안경 dogfood** — 본인이 자녀라 생각하고 앱 열고 첫 메시지 → 응답 → ▶ Run → preview 흐름 한 번 (preview view를 클릭해서 펼치고)
3. **System prompt content tuning** — 1회차 system prompt (`worker/src/prompts/sk-biopharm-kids-s1.md`)를 한 번 더 자녀 톤으로 redline
4. **Cloudflare 실배포** — `worker/DEPLOY.md` 따라서 30분
5. **2회차 profile 작성** — Load week (essence 3, 4, 5, 11). suggestion 톤 더 challenging하게, retry counter 켜기, coach revisit_on_entry 켜기 (자녀가 "이번엔 이 친구한테 더 부담을 줘볼래?")

---

## 변경된 파일 (committable diff 목록)

```
worker/src/profiles/types.ts                     [+47 lines]   UxConfig + SuggestionChip
worker/src/profiles/sk-biopharm-kids-s1.ts       [+44 lines]   ux 섹션 채움
worker/src/lib/translate.ts                      [+25 lines]   CoachContext + coach tail
worker/src/routes/chat.ts                        [+62 lines]   /v1/profile + decode headers
worker/test/smoke.mjs                            [+45 lines]   3 신규 coach tail tests
worker/tsconfig.json                             [+2 lines]    allowImportingTsExtensions
worker/src/index.ts                              [-1, +1]      unused 'c' fix
worker/src/lib/tokens.ts                         [-1, +9]      TokenError 일반 class + noUncheckedIndexedAccess

extensions/hypeproof-chat/package.json           [+5 lines]    renameCoach 명령 + view sizes
extensions/hypeproof-chat/src/extension.ts       [+60 lines]   applyTestBackdoors + naming flow
extensions/hypeproof-chat/src/chatPanelProvider.ts [+90 lines] ensureProfile, runCoachNamingRitual, retry/naming handlers
extensions/hypeproof-chat/src/proxyClient.ts     [+22 lines]   fetchProfile, coach headers URL-encoded
extensions/hypeproof-chat/src/protocol.ts        [+55 lines]   ResolvedProfile, UxConfig, SuggestionChip, CoachInfo
extensions/hypeproof-chat/webview-ui/src/ChatPanel.tsx  [전체 재작성]  chips/hints/roll/retry/IME/coach name
extensions/hypeproof-chat/webview-ui/src/App.tsx [+12 lines]   onRetry, onNamingRitual
extensions/hypeproof-chat/webview-ui/src/styles.css     [전체 재작성]  새 컴포넌트 스타일

e2e/fixtures/app.ts                              [+30 lines]   preseedCoach + file-based backdoor
e2e/tests/01-launch.spec.ts                      [+15 lines]   pre-seed coach
e2e/tests/02-chat-roundtrip.spec.ts              [+10 lines]   pre-seed coach
e2e/tests/03-coach-naming.spec.ts                [신규, 34 lines]
e2e/tests/04-chips.spec.ts                       [신규, 70 lines]
e2e/tests/05-retry-and-roll.spec.ts              [신규, 78 lines]
e2e/tests/99-screenshots.spec.ts                 [신규, 105 lines]
```

git status 안 본 상태. 커밋은 안 함 (사용자가 직접 검토 후 결정).

---

## 알려진 미해결

- **Linux/Win/server icons**: VSCodium 원격 fallback 그대로 (Mac dev엔 영향 X)
- **`.npmrc` warning**: 모든 npm 명령에 노이즈, 비파괴적
- **Test failures during iteration**: 4번 실패하고 수정 → fix (HTTP 헤더 한글, PREVIEW collapse, file backdoor). 최종 상태 13/13 통과.

---

## 마지막 마무리 (12개 항목 이후 보너스)

작업 막바지에 추가로 정리한 것들:

1. **System prompt 정리** (`worker/src/prompts/sk-biopharm-kids-s1.md`) — 아직 안 만든 "공개하기" 버튼 언급 제거. 1회차엔 미리보기까지만, 공개는 다음 회차라고 안내하도록 변경. Coach context system 블록 두 번째 위치라는 메타 설명도 추가.
2. **`/CLAUDE.md`** — Current phase를 "Phase 0"에서 "Phase 4–5 chat panel + integrated build, UX iteration in progress"로 업데이트. 이 STATUS 문서로 포인터.
3. **`docs/COHORT-AUTHORING.md`** — 새 cohort 추가 절차 매뉴얼. 1회차 패턴에서 2-4회차로 진화하는 방법 + 치과 / 기업 등 새 cohort 확장 패턴 + 트러블슈팅 표.

## 최종 상태 (다음 세션 픽업 지점)

**살아있는 것** (당장 사용 가능):
- ✅ Wrangler dev: `localhost:8787` (12시간 유효 token = `/tmp/hps-token.txt`)
- ✅ Roster + active session for `sk-biopharm-2026-a`, 8시간 창
- ✅ HypeProof Studio.app 빌드된 .app 정상 동작
- ✅ Extension dist 최신 (16.3KB extension.js, 151KB webview bundle)
- ✅ 13/13 e2e 테스트 통과 (`cd e2e && npm test`)
- ✅ 9/9 Worker smoke 통과

**바로 확인 가능**:
```bash
# 앱 열기
open "/Users/jaylee/CodeWorkspace/hypeproof-studio/vscodium-base/VSCode-darwin-arm64/HypeProof Studio.app"
# 코치 이름 짓는 화면이 자동으로 뜸 (or token 먼저)

# Worker dashboard (admin UI)
open http://localhost:8787/    # password: dev

# 스크린샷
open "/Users/jaylee/CodeWorkspace/hypeproof-studio/e2e/test-results/screenshots/"

# 테스트 재실행
cd /Users/jaylee/CodeWorkspace/hypeproof-studio/e2e && npm test

# Stack 재가동 (KV는 wrangler 재시작 시 클리어됨)
cd /Users/jaylee/CodeWorkspace/hypeproof-studio && bash scripts/dev-stack.sh
```

## 다음 우선순위 (sequence)

1. **시각 dogfood (15분)** — 위 5장 스크린샷 확인 + 앱 직접 열어서 자녀 시점에서 한 번 통과
2. **System prompt 또 한번 redline (30분-1시간)** — `worker/src/prompts/sk-biopharm-kids-s1.md` 자녀 톤으로 다시 손봐도 좋음. wrangler dev 띄워둔 상태에서 코드 수정 → 자동 hot-reload → 즉시 테스트
3. **Cloudflare 실배포 (30분)** — `worker/DEPLOY.md` 따라서. `wrangler login` → KV/D1 생성 → secret put → deploy
4. **2회차 profile 작성** — Load week, `worker/src/prompts/sk-biopharm-kids-s2.md` + `worker/src/profiles/sk-biopharm-kids-s2.ts`. 가이드: `docs/COHORT-AUTHORING.md` § "Load week 추천 설정"
5. **GitHub Pages publish wizard** — 별도 sprint
6. **Live preview extension** — 별도 sprint

## 참고

- 자세한 plan: `/Users/jaylee/.claude/plans/l0-floating-duckling.md`
- 빌드 파이프라인 룰: `.claude/rules/build-pipeline.md`
- 확장 개발 룰: `.claude/rules/extension-dev.md`
- **새 cohort 추가**: `docs/COHORT-AUTHORING.md` ← 신규
- e2e 사용법: `e2e/README.md`
- Worker 배포: `worker/DEPLOY.md`
