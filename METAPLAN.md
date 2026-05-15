# HypeProof Studio — Solo Build Metaplan

> **Owner:** Jay (single-developer mode)
> **Started:** 2026-05-14
> **Target:** 6월 1회차 SK바이오팜 데뷔
> **Repo:** `/Users/jaylee/CodeWorkspace/hypeproof-studio/`
> **Strategic plan:** [curriculum/products/ai-architect-academy/internal/hypeproof-studio-plan.md](../hypeproof/.claude/worktrees/curriculum/products/ai-architect-academy/internal/hypeproof-studio-plan.md)
> **Product philosophy (drives UX):** [docs/essence-v0.1.md](./docs/essence-v0.1.md) — 16 Essences. Phase 4 챗 패널 기능은 §4.5 매핑표 기준.

---

## 0. Working Mode

- Jay 솔로 (JY 위임 X, freelancer 보류)
- **Mac이 1차 책임** (Jay 본인 dev 환경)
- **Win은 스캐폴딩까지만** (빌드 스크립트 + CI yml 준비, 실제 빌드는 CI에서)
- Apple Developer 신청 같은 행정 = 나중에 (개발 후)
- 모든 자산 식별/변경을 이 repo 안에서 해결

---

## Phase 0. 환경 준비 (오늘~내일, 2-3시간)

**Goal**: VSCodium 빌드 가능한 Mac 로컬 환경 구축.

### Tasks
- [ ] **디스크 정리** — 현재 48GB 남음 (89% 사용). 빌드 10-20GB 필요 → 20GB 이상 확보
- [ ] **Node.js 22.22.1** — `brew install nvm && nvm install 22.22.1`
- [ ] **Python 3.11** — `brew install python@3.11` (3.12 이상은 빌드 깨질 수 있음)
- [ ] **rustup** — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- [ ] **Mac 빌드 deps** — `brew install jq imagemagick librsvg` (icons 변환용)
- [ ] **Xcode CLI** — `xcode-select --install` (이미 있을 가능성)

### Decision gate
- `node --version` = v22.22.1
- `python3.11 --version` = Python 3.11.x
- `df -h /` → 사용가능 60GB 이상
→ 통과 시 Phase 1

### Open question
- Node 24 (현재) 동시 보유: nvm으로 22/24 switch 사용. node-default-version은 22로 설정.

---

## Phase 1. 첫 빌드 — Vanilla VSCodium (반나절)

**Goal**: 손대지 않은 VSCodium.app가 Mac에서 빌드되고 실행되는 것 확인. 빌드 파이프라인 신뢰 확보.

### Tasks
- [ ] `cd vscodium-base`
- [ ] `bash get_repo.sh` — VS Code 소스 commit hash 확인
- [ ] `bash prepare_src.sh` — VS Code 소스 다운로드 (~500MB)
- [ ] `bash prepare_vscode.sh` — VSCodium 패치 적용
- [ ] `bash build.sh` — 실제 빌드 (1-2시간 예상)
- [ ] 결과 확인: `VSCode-darwin-arm64/VSCodium.app` 존재 + 실행 가능

### Likely 문제 + 대응
| 문제 | 대응 |
|---|---|
| `prepare_src.sh` 401/404 (GitHub rate limit) | GITHUB_TOKEN 환경변수 추가 |
| `npm install` fail (node-gyp 등) | Xcode CLI 재설치, python3 path 확인 |
| Out of memory (NODE_OPTIONS) | `export NODE_OPTIONS="--max-old-space-size=12288"` |
| Sourcemap upload 시도 (실패해도 OK) | `export VSCODE_PUBLISH_COUNTER=0` |

### Decision gate
- `VSCodium.app` 실행 → 정상 VS Code-like 화면 표시 → **Phase 2 진입**
- 빌드 실패 + 3시간 디버그 → **Plan B**: Cline + Proxy 방향으로 회귀 검토

---

## Phase 2. 브랜드 자산 변경 (1-2일)

**Goal**: VSCodium의 모든 흔적을 HypeProof Studio로 치환.

### 2-1. 환경변수 (utils.sh 또는 별도 hps.env)

```bash
# hypeproof-studio.env
export APP_NAME="HypeProof Studio"
export APP_NAME_LC="hypeproof-studio"
export BINARY_NAME="hypeproof-studio"
export ASSETS_REPOSITORY="jayleekr/hypeproof-studio"
export GH_REPO_PATH="jayleekr/hypeproof-studio"
export ORG_NAME="HypeProof Lab"
```

→ `build.sh` 실행 전 `source hypeproof-studio.env`

### 2-2. 아이콘 swap (SVG 원본 → 모든 plat 자동 생성)

기존 (VSCodium):
- `icons/stable/codium_clt.svg` (CLI 아이콘)
- `icons/stable/codium_cnl_w80_b8.svg` (앱 아이콘, 80 width, 8 border)
- `icons/stable/codium_cnl.svg` (앱 아이콘 표준)

작업:
- [ ] **HypeProof 로고 SVG** 디자인 또는 기존 web/public/ 에서 가져오기
- [ ] 3개 파일로 만들어 `icons/stable/` 에 덮어쓰기 (이름은 그대로 유지하거나 새 이름 + script 수정)
- [ ] `bash icons/build_icons.sh` 실행 → .icns / .ico / .png 자동 생성

### 2-3. 추가 자산
- [ ] `icons/corner_512.png` — splash/corner watermark
- [ ] `icons/template_macos.png` — Mac dock template
- [ ] `src/stable/resources/darwin/*.icns` (existing dir 확인)
- [ ] `src/stable/resources/linux/code.png` (Linux는 후순위지만 파일 존재)
- [ ] `src/stable/resources/server/code-192.png`, `code-512.png`, `favicon.ico`

### 2-4. 문자열 치환 (patches 추가)

VSCodium은 이미 "Visual Studio Code" → "VSCodium" 패치를 적용함 (`patches/00-brand-remove-branding.patch`).
우리는 그 위에 추가 패치 또는 직접 강제 치환:

- [ ] `product.json` 키 추가/덮어쓰기:
  - `nameShort`: "HypeProof Studio"
  - `nameLong`: "HypeProof Studio"
  - `applicationName`: "hypeproof-studio"
  - `dataFolderName`: ".hypeproof-studio"
  - `win32DirName`, `win32NameVersion`, `win32MutexName` 등 win32 시리즈
  - `darwinBundleIdentifier`: "ai.hypeproof.studio"
  - `urlProtocol`: "hypeproof-studio"

→ 변경은 `prepare_vscode.sh` 안에서 product.json을 jq로 수정하는 방식. (VSCodium도 이미 같은 패턴)

### 2-5. Welcome 페이지 / About

VSCodium의 announcements 시스템 활용:
- [ ] `announcements-extra.json` 갱신 (HypeProof Studio 첫 메시지)
- [ ] About 다이얼로그 텍스트 (VS Code source 패치 또는 product.json `licenseUrl` 등)

### Decision gate
- VSCodium.app가 아니라 **HypeProof Studio.app**로 빌드
- 실행 시 윈도우 타이틀, dock, 메뉴바 모두 HypeProof Studio
- About에 HypeProof + Based on VSCodium / VS Code (MIT) 명시
→ Phase 3 진입

---

## Phase 3. 두 번째 빌드 — 브랜드 적용 확인 (반나절)

**Goal**: 변경된 자산이 모두 빌드에 반영되는지 검증.

### Tasks
- [ ] `source hypeproof-studio.env`
- [ ] `bash build.sh` (재빌드)
- [ ] 결과: `HypeProof-Studio-darwin-arm64/HypeProof Studio.app` 확인
- [ ] 실행 → 모든 표면에서 "HypeProof Studio" 확인
- [ ] 데이터 폴더 검증: `~/Library/Application Support/HypeProof-Studio/` 생성

### Decision gate
- 어디에도 "VSCodium" 안 보임 (단, About의 attribution 제외)
→ Phase 4 진입

---

## Phase 4. Chat Panel Scaffold (2-3일)

**Goal**: VS Code 확장으로 동작하는 React Webview panel 골격.

이 panel은 **HypeProof Studio에 사전 번들될 자체 확장**.

### 위치
- `extensions/hypeproof-chat/` (VS Code 확장 디렉토리)

### Tasks
- [ ] `yo code` 또는 수동 scaffold: TypeScript webview extension
- [ ] React + Vite 셋업 (webview-ui/)
- [ ] activity bar 아이콘 → HypeProof Chat panel 열기
- [ ] 기본 chat UI (입력 + 메시지 list + 스트리밍)
- [ ] HypeProof Proxy fetch 구현 (현재 `proxy-poc/proxy.py` 활용)
- [ ] Workshop token 입력 UI
- [ ] Conversation history (workspace state API)

### Architecture
```
hypeproof-chat/
├── src/
│   └── extension.ts           # activate, webview registration
├── webview-ui/
│   ├── src/
│   │   ├── App.tsx            # main React component
│   │   ├── ChatPanel.tsx      # 메시지 list + 입력
│   │   ├── proxy.ts           # OpenAI-compatible fetch client
│   │   └── types.ts
│   ├── vite.config.ts
│   └── package.json
└── package.json
```

### Decision gate
- 패널 열기 → "안녕" 입력 → HypeProof Proxy 거쳐 응답 받기 → 화면에 스트리밍
- §4.5 매핑표에서 **MVP 표시된 essence 8개 이상** 패널에 반영
→ Phase 5 진입

---

## 4.5. Essence → Chat Panel UX 매핑

> Source: [docs/essence-v0.1.md](./docs/essence-v0.1.md). 챗 패널 기능 추가/제거는 이 표 기준.
> **MVP** 칼럼이 ✅인 항목은 Phase 4 데뷔에 필수. 나머지는 Phase 5+ 또는 v0.2.

| # | Essence | 패널 UX 반영 | 위치 | MVP |
|---|---------|--------------|------|-----|
| 1 | 천 번째도 첫 번째처럼 감탄 | 환영 페이지 카피 + 첫 출력에 "왜 이게 신기한가" 코멘트 슬롯 | `webview-ui/Welcome.tsx`, `announcements-extra.json` | — |
| 2 | 전심전력으로 임하기 | 빈 프롬프트 차단 + 최소 길이 가이드, "지금 입력의 해상도" 힌트 | `ChatPanel.tsx` 입력 검증 | ✅ |
| 3 | 부하 걸기 | "더 무겁게 물어보기" 버튼 (반론 강제·각도 변환 프리셋) | `ChatPanel.tsx` 액션 바 | ✅ |
| 4 | 만족 유예, 추궁 | "한 번 더 (n=3/5/10)" 재요청 + 의미 소실 감지 경고 | 재요청 컨트롤 | ✅ |
| 5 | 역할 몰입과 관점 부여 | 역할 프리셋 (의사/변호사/엔지니어/회의록자 등) — 직업별 트랙용 | 역할 셀렉터 + system prompt 라이브러리 | ✅ |
| 6 | 잇기 — 가설 세우기 | "임시 다리" 모드: 모델이 가설 트리 → 사용자가 검토·승인 | Tree 컴포넌트 (Phase 5) | — |
| 7 | 질문으로 공터 만들기 | "되물어주세요" 버튼 — 명세 부족 시 모델이 먼저 질문 | system prompt에 inject | ✅ |
| 8 | 입력 먼저 굴리기 | 빠른 시험 모드 (작은 시드 → 결함 자동 차수화) | "Iterate" 패널 (Phase 5) | — |
| 9 | 백 번 뽑아보기 | 같은 프롬프트 변주 n회 일괄 실행 + 답변 비교 그리드 | Variation Runner | — |
| 10 | 다중 모델 조율 | 모델 셀렉터 (Sonnet 4.6 / 다른 백엔드) + 교차 비평 모드 | 모델 토글, 비평 액션 | ✅ (토글) / Phase 5 (교차 비평) |
| 11 | 역목표 설계 | "실패시키는 길 찾기" 버튼 (red-team 프리셋) | 액션 바 | — |
| 12 | 수행과 위임의 역전 | 비계 모드: 모델 약점 표시 + 사용자 보충 슬롯 | Phase 5 + |
| 13 | 추상의 사다리 | 메타프롬프트 빌더 + 출력 피드백 루프 (Cline 영감) | 별도 패널 (v0.2) | — |
| 14 | 언러닝 | 모델/버전 변경 시 "검증된 전략 다시 의심" 체크리스트 | 모델 스위치 다이얼로그 | — |
| 15 | 상상하기 | "뜸 들이기" — 일부러 응답 지연 + 산책 알림 옵션 | 설정 토글 | — |
| 16 | 소격하기 | **Manual-approve 모달은 그 자체로 '킥'** + CoT 항상 보기 토글 | `extension.ts` approval handler, "Show reasoning" 기본 ON | ✅ |

### MVP essence 커버리지 (Phase 4 데뷔 기준 8개)
2, 3, 4, 5, 7, 10(토글), 16(manual-approve + CoT 보기), 그리고 1(환영 카피).

### 작업 분해 (Phase 4 task 추가)
- [ ] 역할 프리셋 라이브러리 작성 — 직업별 system prompt 5종 (essence #5)
- [ ] 입력 검증 + 해상도 힌트 (essence #2)
- [ ] 액션 바: 무겁게/한번더/되물어주세요 3개 버튼 (#3, #4, #7)
- [ ] 모델 셀렉터 토글 (#10)
- [ ] CoT/reasoning 보기 기본 ON + manual-approve 모달 디자인 (#16)
- [ ] 환영 페이지 카피 — essence #1 톤 (announcements-extra.json)

---

## Phase 5. Chat Panel + 빌드 통합 (1-2일)

**Goal**: HypeProof Studio.app 빌드 시 chat panel이 사전 설치된 상태로 포함.

### Tasks
- [ ] `extensions/hypeproof-chat/` 를 VS Code source의 `extensions/` 하위로 inject (prepare_vscode.sh 단계)
- [ ] `product.json.builtInExtensions` 에 추가 (built-in 확장으로 등록)
- [ ] 빌드 → app 실행 → 기본으로 chat panel 활성
- [ ] Manual-approve 모달 추가 (file write/exec)
- [ ] 게임 미리보기 panel 추가

### Decision gate
- 빌드된 .app 실행 → chat panel 사전 활성 + Proxy 호출 OK
→ Phase 6 진입

---

## Phase 6. Windows 스캐폴딩 (반나절)

**Goal**: Win 빌드 가능한 상태까지만. 실제 빌드는 Jay 머신에서 안 함.

### Tasks
- [ ] `.github/workflows/build-windows.yml` 작성 (matrix build)
- [ ] Win build dependencies 문서화 (`docs/HOW-TO-BUILD-WIN.md`)
- [ ] Win signing은 stub (self-signed 또는 unsigned)
- [ ] CI에서 1회 trigger → .exe artifact 생성 확인

### Decision gate
- GitHub Actions가 Win 빌드 완료 → artifact 다운로드 가능
→ Phase 7 진입

---

## Phase 7. Release v0.1.0 (1일)

**Goal**: SK바이오팜 가족에게 배포 가능한 상태.

### Tasks
- [ ] GitHub Release 작성 (.app, .exe 첨부)
- [ ] One-line installer 스크립트 (curl/iwr 둘 다)
- [ ] 가족용 install 가이드 (PDF 1페이지)
- [ ] 운영진 dogfood (6명)
- [ ] Dry-run (자녀 1-2명 4시간)

### Decision gate
- 운영진 6명 install 성공 + 4시간 dogfood 완료
→ SK바이오팜 1회차 GO

---

## 8. 자산 변경 체크리스트 (Phase 2 보조)

| 파일 | 현재 | → 변경 |
|---|---|---|
| `utils.sh` | APP_NAME="VSCodium" | env file로 override |
| `icons/stable/codium_cnl.svg` | VSCodium 로고 | HypeProof 로고 |
| `icons/stable/codium_cnl_w80_b8.svg` | (same) | HypeProof 로고 (80w/8b) |
| `icons/stable/codium_clt.svg` | CLI 아이콘 | HypeProof CLI |
| `icons/corner_512.png` | 코너 워터마크 | HypeProof |
| `icons/template_macos.png` | Mac dock | HypeProof |
| `src/stable/resources/server/code-{192,512}.png` | favicon | HypeProof |
| `src/stable/resources/server/favicon.ico` | (same) | HypeProof |
| `src/stable/resources/linux/code.png` | Linux | HypeProof |
| `announcements-extra.json` | VSCodium 공지 | HypeProof 첫 환영 |
| `product.json` (build-time override) | VS Code keys | HypeProof keys |

→ 디자인 자산 출처: `web/public/` 또는 `members.md` 의 로고 사용. **HypeProof 로고 SVG 1개**만 있으면 build_icons.sh가 나머지 자동 생성.

---

## 9. Plan B (Phase 3 실패 시)

5/28 시점 빌드 안정화 못 하면:
- 6월 1회차: Cline + Proxy + One-line installer
- HypeProof Studio v0.1: 7월 정식 데뷔 (2회차)

→ 자세한 내용: [strategic plan](../hypeproof/.claude/worktrees/curriculum/products/ai-architect-academy/internal/hypeproof-studio-plan.md) §6

---

## 10. 진행 트래킹

| Phase | Status | 시작일 | 완료일 | 비고 |
|---|---|---|---|---|
| 0. 환경 준비 | 시작 전 | — | — | |
| 1. 첫 빌드 (vanilla) | — | — | — | |
| 2. 브랜드 자산 변경 | — | — | — | |
| 3. 두 번째 빌드 | — | — | — | |
| 4. Chat panel scaffold | — | — | — | |
| 5. 통합 빌드 | — | — | — | |
| 6. Win 스캐폴딩 | — | — | — | |
| 7. Release v0.1.0 | — | — | — | |

---

## 11. 미해결 결정 (Phase 진행 중 답할 것)

- [ ] HypeProof Studio repo **공개 vs 비공개** (Win 사이닝 무료 path에 영향)
- [ ] Apple Developer 신청 시점 (Phase 7 직전이면 충분)
- [ ] Chat panel 이름 ("HypeProof Chat" vs 별도 브랜드)
- [ ] Workshop token 발급 시스템 (이번 회차는 manual, 다음은 자동화)
- [ ] Cline source를 Phase 4 panel 개발에 참고 자료로 사용 (디자인 inspiration)

---

## 12. 작업 시작 (오늘 5/14)

- [x] VSCodium repo cloned
- [x] METAPLAN 작성
- [ ] **Phase 0 시작** → Jay 본인 머신에서 env setup

다음 명령:
```bash
cd /Users/jaylee/CodeWorkspace/hypeproof-studio/vscodium-base
df -h /  # 디스크 여유 확인 먼저
brew install nvm jq imagemagick librsvg
```
