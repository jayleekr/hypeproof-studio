# G1 REPORT — install-session-trace

**게이트** G1 「설치 후 Studio 첫 응답까지 간다」
**코호트** `sk-biopharm-2026-a` (SK 바이오팜 워크숍 · 2026-08-22)
**due** 2026-08-09 (경과)
**실측일** 2026-08-10
**실측자** Ryan (지웅) · Mac (Apple Silicon, macOS 15, 16GB)
**리뷰** AI 1차 — 사람 최종 대기

---

## 판정 요약

| # | 항목 | 판정 | 근거 |
|---|---|---|---|
| 1 | 설치 화면이 단일 준비 페이지에 있고 학생도 접근 가능 | **PASS** | §1 |
| 2 | 토큰 발급과 세션 열기 화면이 단일 준비 페이지에 있음 | **PASS** | §1 |
| 3 | 토큰 발급과 세션 열기가 3분 안에 완료 | **PASS** (3.1초) | §2 |
| 4 | 토큰 끊김·만료·권한 오류의 복구 행동이 보임 | **PASS** (단서 1건) | §3 |
| 5 | Mac/Windows 공개계 설치가 각각 10분 안에 완료 | **Mac PASS** (171초, 순정 VM) · Windows 미검증 | §4 · §9 |
| 6 | 강의 필수 라이브러리가 양쪽 OS에 설치됨 | **Mac PASS** — 단 **결함 1건 발견·수정** (설치기 버전 게이트) | §5 · §9 |
| 7 | Mac/Windows가 fallback 없이 같은 SDK 로직으로 작동 | **PARTIAL** — CI 증거 있음 | §6 |
| 8 | 자기 workspace path와 실행 컨텍스트를 정확히 읽음 | **재정의 필요** — 아동 트랙엔 항목 문언이 안 맞음 | §7 · §8 |

**G1 종합: Red 유지.** 4개 PASS, 3개 PARTIAL, 1개 재정의 필요.

Green 전환 차단 요인은 둘이다.
1. **Windows 실기기 검증 (⑤⑥⑦)** — 검증 한 번으로 셋이 함께 닫힌다. 단 PR CI 가 windows-2022 에서 doctor + shell smoke 를 이미 매번 돌리고 있어 일부는 덮여 있다(§6). 별도 담당자 진행.
2. **항목 ⑧ 의 문언** — agent-sdk 트랙(보아) 기준으로 쓰여 있어 chat-only 아동 트랙에 그대로 적용되지 않는다(§8). 기준을 코호트 계층별로 나눠야 한다.

**부수 쟁점:** `/download` 는 네이티브 PowerShell 설치를 지시하지만 `dependencies.yaml`(`windows_policy: wsl2-recommended`)과 `MEMBER-GUIDE.ko.md:18`("네이티브 PowerShell/cmd 미지원")은 반대를 선언한다. SK 는 초3~6 가족 워크숍이라 대부분 네이티브 Windows 다. Windows 담당자에게 이관.

---

## §1. 준비 페이지 단일화·접근성 (항목 1·2)

세 페이지 모두 인증 없이 HTTP 200.

```
https://hypeproof-ai.xyz/download          200  0.42s
https://hypeproof-ai.xyz/install           200  0.30s
https://hypeproof-ai.xyz/live/sk-biofarm   200  0.32s
```

`/live/sk-biofarm` 단일 페이지에 설치·토큰·세션이 모두 존재한다 (본문 언급: 설치 16회 / 토큰 11회 / 세션 4회).
로그인·비밀번호·Sign in 요소 없음 → 학생 직접 접근 가능.

Mac·Windows 원라인 설치가 같은 페이지에 병기되어 있고, OS 경고창 대처법과 오프라인 대체 경로(.dmg/.exe 직접 다운로드)까지 한 화면에 있다.

## §2. 토큰·세션 3분 기준 (항목 3)

강사 실사용 경로(웹 프록시 `/api/workshop/boa-room/session`)로 측정.

```
status  0.79s  → session: null
open    1.76s  → session_id : sk-biopharm-2026-a-2026-08-10
                 profile_id : sk-biopharm-kids-2026-grade-3-4-s1
                 window     : 2026-08-10T04:16:10Z ~ 05:16:10Z
close   0.50s  → session: null
─────────────────────────────────────────
전체    3.1초    (기준 180초 대비 1.7%)
```

**부수 확인:** #542에서 수정된 B반 프로필 id(`sk-biopharm-kids-2026-grade-3-4-s1`)가 실제 세션 개설까지 관통했다. 파일명(`sk-biopharm-kids-s1`)이 아닌 레지스트리 id가 정상 동작함을 확인.

테스트 후 잔여물 없음: `session: null · roster_size: 0 · paused: null`.

## §3. 오류 복구 행동 (항목 4)

워커가 4가지 실패 상태를 구분해 반환한다.

| 입력 | 응답 | HTTP |
|---|---|---|
| 형식 깨진 토큰 (`.` 없음) | `invalid issuer token: malformed token` | 401 |
| 서명 불일치 | `invalid issuer token: invalid signature` | 401 |
| 폐기된 토큰 | `issuer token revoked` | 401 |
| 스코프 밖 코호트 | `issuer not scoped to cohort=sk-biopharm-2026-a` | 403 |

토큰 검증이 코호트 검증보다 선행하는 순서는 정상이다. 프록시 계층(`boaMint.ts:mapError`)이 이를 한국어 안내로 변환하는 것도 확인.

**단서 — 봇 가드가 진단을 가린다.**
`origin`·`referer`·`user-agent` 없이 `/api/workshop/*` 를 호출하면 원인과 무관하게 `{"error":"Forbidden"}` (403) 만 반환된다. 브라우저 헤더를 붙여야 실제 401 + 한국어 안내가 나온다. 당일 운영자가 curl 기반 헬스체크·진단 스크립트를 쓸 경우 원인이 은폐된다.
→ 조치 제안: 진단용 경로를 따로 두거나, 가드 응답에 "브라우저에서 호출하세요" 힌트를 넣는다.

## §4. Mac 설치 경로 (항목 5)

**회귀 TC PASS** — `scripts/test-installer-pipe.sh`, 0.66초.

```
1. 하네스 검증
   ok  음성 대조군: 가드 없는 스크립트는 파이프에서 뒷부분을 잃는다
   ok  양성 대조군: 가드가 있으면 파이프에서도 끝까지 간다
2. install.sh 가드 보유
   ok  _hps_is_piped / HPS_REEXEC / exec bash
   ok  brew 설치기 호출에 stdin 차단(</dev/null) 유지
3. 정상 실행 비방해
   ok  파일 실행 경로 --help 정상
PASS — curl|bash 회귀 가드 정상
```

#544(공기계에서만 재현되던 curl|bash 조용한 중단)의 가드가 살아 있음을 매 실행마다 검증 가능.

**미충족:** 공개계(brew·CLT 없는 클린 계정) 10분 실측은 본 실측기에서 수행하지 못했다. 본 기기는 이미 설치 완료 상태이며, 클린 계정 또는 VM이 필요하다.

## §5. 필수 라이브러리 설치 (항목 6) — **결함 1건**

Mac 기준 매니페스트 7종 중 5종 확인:

```
git      ✓ 2.39.2      /usr/bin/git
gh       ✓ 2.76.2      /opt/homebrew/bin/gh
jq       ✓ 1.8.1       /opt/homebrew/bin/jq
node     ✓ v23.11.0    /opt/homebrew/bin/node
python3  △ 3.10.5      /Library/Frameworks/Python.framework/Versions/3.10/bin/python3
```

**⚠ 이 절은 두 번 뒤집혔다. 최종 결론은 §9 다.** 결론만 먼저: **doctor 가 둘이고, 설치기 쪽 게이트가 비어 있었다.** 아래 §5 본문은 `scripts/hps-doctor.sh`(레포 스크립트)만 검증한 것이며, 참가자가 실제로 타는 `install.sh` 내장 `doctor()` 는 버전을 보지 않았다 — 순정 VM 실측(§9)에서 드러났다.

**레포 스크립트(`scripts/hps-doctor.sh`)의 게이트는 정상 작동한다** — `dependencies.yaml` 이 `min_version: "3.11"` 과 `version_regex` 를 선언하고, 이를 강제하며 **종료코드 1** 로 fail-closed 한다. 실행 결과:

```
FAIL  python: 3.10.5 is below the required minimum 3.11
      fix: brew upgrade python@3.11
warn  shellcheck / pre-commit: not found (tier=dev, optional)
warn  rsync 2.6.9 < 3.1 · bash 3.2.57 < 5.0 (tier=maintainer, optional)
verdict: 1 hard failure(s), 4 warning(s)      exit code 1
```

**결함 — doctor 가 제시하는 처방이 막다른 길이다.**

```
$ brew upgrade python@3.11
Error: python@3.11 not installed
```

미설치 상태에서 `upgrade` 를 안내한다. 정답은 `install` 이다. 강사·학생이 화면의 지시를 그대로 따르면 여기서 멈춘다.
→ 조치: 설치 여부를 보고 `install` / `upgrade` 를 갈라 출력한다.

**본 기기 상태: 하드 실패.** `python@3.11` 미설치(brew 에는 3.13·3.14), `python3` 는 python.org 프레임워크 3.10.5 로 해석된다. 다만 저장소 내 22개 `*.py` 중 3.11 전용 기능 사용 0건이라 현재 실동작 영향은 없다.

**주의:** `hps` 는 별도 설치 바이너리가 아니라 레포의 `scripts/hps-doctor.sh` 다. 매니페스트 파일명도 `hypeproof-deps.yaml` 이 아니라 `dependencies.yaml` 이며, `install.sh` 주석과 워크플로 주석이 옛 이름을 가리키고 있다(문서 드리프트).

## §6. 크로스 OS 동일 로직 (항목 7) — 미검증

Windows 실기기가 없어 착수 불가. 항목의 명제 자체가 "양쪽이 같은 로직으로 작동한다"이므로 **Mac 단독 실행은 부분 증거가 되지 않는다.**

차단 요인: **#340 — 관리 단말 Studio 설치 검증(EV 코드서명 구매 여부)**. 2026-08-01 이후 진척 없음.
리허설이 8/19·8/21 이므로 **실질 결정 기한은 8/18**.

## §7. workspace path·실행 컨텍스트 (항목 8) — PASS (단, agent-sdk 경로 한정)

앱이 배포하는 로컬 SDK 바이너리를 실제 프록시·실제 참가자 토큰·실제 워크스페이스로 구동해 검증했다.

```
바이너리 : ~/Library/Application Support/HypeProof-Studio/sdk/0.3.207/claude
           Claude Code 2.1.207 · sha512 검증 완료 (claude.verified.json, 2026-08-09T12:41:37Z)
경로     : ANTHROPIC_BASE_URL=https://api.hypeproof-ai.xyz  (proxyUrl 에서 /v1 제거 — sdkCoach.ts:92)
토큰     : session/open 으로 민팅한 참가자 토큰 (g1-rehearsal-ryan)
워크스페이스: <scratch>/ws-g1test  (index.html 1개)

질의: "지금 네 작업 디렉토리(cwd)의 절대경로가 뭐야? 그 안에 어떤 파일이 있어?"
응답: "/private/.../scratchpad/ws-g1test  ·  파일: index.html 하나 있어요! 🗂️"
소요: 15.5초
```

절대경로와 파일 목록이 실제와 정확히 일치 — **SDK 경로의 메커니즘은 정상**이다. 다만 이것이 곧 항목 ⑧ 통과는 아니다: SK 는 미성년이라 이 런타임에 도달하지 않는다(§8 참조).

**한계 — 두 가지가 아직 안 밟혔다.**

1. **GUI 채팅 경로 미검증.** Studio 앱은 실행했으나 채팅창 입력은 하지 못했다 (osascript 키스트로크가 손쉬운 사용 권한에 막힘, error 1002). `setToken` 저장, 확장의 요청 조립, 💬 패널 렌더링, 도구 호출(파일 저장·미리보기)은 미확인.
2. **런타임이 다르다.** 본 검증은 `coachRuntime: agent-sdk` 경로다. 확장의 **기본값은 `proxy`** (`package.json` default). 즉 학생이 실제로 타는 기본 경로는 아직 실기기에서 확인되지 않았다.

또한 본 검증은 확장이 주입하는 `<env>` 워크스페이스 파일 목록(`listWorkspaceFiles`, `sdkCoach.ts:197`) 없이 맨 바이너리를 돌린 것이다. 그럼에도 15.5초에 정답을 냈다 — 2026-07-26 실측(cwd 를 받고도 `find ~` 로 홈 전체를 훑어 한 턴 151초 중 120초 증발)의 재발은 관측되지 않았다. 다만 워크스페이스가 파일 1개로 작아 조건이 약했으므로, 파일이 많은 실제 코호트 워크스페이스에서 재측정할 것.

**남은 절차 (GUI):**
1. 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용 → 터미널 앱 허용
2. Studio → `Cmd+Shift+P` → `HypeProof Chat: Set Workshop Token` → 참가자 토큰
3. 💬 패널에서 동일 질의 후 응답·도구 호출 캡처

---

## 후속 조치

| 우선순위 | 항목 | 담당 | 기한 |
|---|---|---|---|
| **높음** | #340 Windows EV 코드서명 결정 → 항목 5·6·7 해제 | 사람 | 8/18 |
| **높음** | 이 기기 `~/.hypeproof/issuer-token` 을 신규 토큰으로 교체 (현재 폐기된 `88037804…` 잔존) | Ryan | 즉시 |
| 중간 | 항목 8 수동 실행 후 본 문서 갱신 | Ryan | 8/12 |
| 중간 | Python 버전 게이트 보강 (§5) | Studio Ops | 8/16 |
| 낮음 | 봇 가드 진단 은폐 완화 (§3) | Studio Ops | 8/19 |

## 부록 — 토큰 전달 사고 기록

신규 이슈어 토큰(`jti: 92522c66-5136-45e1-b3dd-804cdfb4a9ab`) 수령 과정에서 **서명 세그먼트가 누락된 채 전달**되는 일이 3회 반복됐다.

- 정상 토큰: 736자 = payload 692 + `.` + 서명 43 (HMAC-SHA256 base64url)
- 수령본: 692자, `.` 0개 → 워커 `malformed token`
- 원인: 채팅 경유 복사 시 마침표에서 선택이 끊김 (더블클릭 단어 선택 등)

토큰 자체는 정상이었고 발급 오류가 아니었다. **당일 강사에게 토큰을 채팅으로 전달하면 같은 사고가 재현된다.** 파일 전달 또는 복사 버튼 사용을 배부 절차에 명시할 것.

---

## §8. 실기기 앱 UI 실측 — 아동 트랙의 산출물 경로 (2026-08-10)

앱을 실제로 열고 접근성 API 로 UI 를 조작해 학생과 동일한 경로를 밟았다.
토큰 등록 → 코치 작명 → 채팅 → 파일 생성 요청.

세션: `sk-biopharm-2026-a` / `sk-biopharm-kids-2026-grade-3-4-s1` / user `g1-rehearsal-ryan`

### 결론 — 아동 트랙의 산출물은 정상 저장된다

```
~/HypeProofGames/index.html   2026-08-10 20:40:22   129 bytes
<title>안녕</title>            ← 요청 내용 그대로
```

코치는 Write 도구가 없다(chat-only, L3 결정). 대신 **확장이 코치의 ```html 펜스를 파싱해 저장한다**:

```ts
// chatPanelProvider.ts:637 revealBuilt()
const checked = validateAndRepairHtml(html);
await this.saveGameToWorkspace(checked.html);   // → workspace_root/index.html
if (this.isLiveServerPreview() && (await this.openInLiveServer())) return true;
```

세션 중 라이브 서버 주소도 UI 에 노출됐다(`http://127.0.0.1:54562/`). 즉 G2 의 「파일 저장은 실제 write 와 존재 확인까지 완료」와 「최종 유저가 파일·URL 중 하나를 가져감」은 **아동 트랙에서도 충족 가능**하다.

### 항목 ⑧ 은 아동 트랙에 그대로 적용되지 않는다

「자기 workspace path 와 실행 컨텍스트를 정확히 읽음」은 코치가 파일 도구로 워크스페이스를 다루는 **agent-sdk 트랙(보아)** 기준 문언이다.

- 프록시 코치는 cwd 를 못 읽는다 — 실측에서 "저는 파일 시스템에 직접 접근할 수 없어요" 로 정확히 답했다. 설계대로다
- 아동 트랙에서 코치가 cwd 를 알 **필요가 없다** — 저장을 확장이 하기 때문이다
- 반면 SDK 경로 자체는 정상 (§7): 같은 질문에 절대경로·파일 목록을 정확히 답했다(15.5초)

→ 기준을 코호트 계층별로 나눌 것. 아동 트랙 대체 문언 제안: **"코치의 산출물이 workspace_root 에 저장되고 미리보기로 렌더된다"** — 이건 위에서 실측으로 충족됐다.

### 남은 실제 결함 2건

**1. `sandbox.file_write: true` 가 읽히지 않는 채 오독을 만든다**

`sandbox.*` 중 실제로 읽히는 것은 `workspace_root`(chat.ts:169 → 클라이언트 폴더 전환)와 `mcp_tools_enabled`(translate.ts 툴 필터)뿐이다. `file_write` 와 `execute_shell` 은 소비자가 없다.

이 필드 때문에 **두 사람이 같은 오독을 했다** — 프로필 작성자(파일 쓰기를 켰다고 믿음)와 본 검증자(블로커라고 보고). 조치: `types.ts` 에 `@deprecated` + 실제 저장 경로 명시, 프로필에 주석, 하네스에 `child_legacy_file_write` (warn) 추가.

**2. 코치가 존재하지 않을 파일명을 말한다**

"이 내용을 `hello.html` 파일로 저장하면 돼요" 라고 답하지만 실제 저장은 `index.html` 이다. 아이가 그 이름을 찾으면 없고, 할 수 없는 일을 지시받는다. 조치: 두 트랙 프롬프트에 "저장을 시키지 마세요" 규칙 추가.

### 부수 관측

- 토큰 등록 직후 앱이 워크스페이스를 `workspace_root` 로 이동한다("작업 폴더를 수업에 맞는 곳으로 옮겼어요"). 사용자가 연 폴더는 버려진다 — 의도된 동작(`workspaceRouting.ts`)이지만 문서에 없다
- AI 고지 문구 정상 노출: "🤖 AI 코치와 대화하고 있어요. AI의 답은 틀릴 수 있으니…"
- 7자산 게이지가 반응한다 (0/7 → 1/7 Own ◐)
- **작명 의식에서 채팅 패널이 React 훅 오류로 크래시** (#300·#310, 2/2 재현) → PR #567 로 수정, v0.1.38 에 포함

### 본 절의 정정 이력 — 계측기가 두 번 틀렸다

이 절의 초판은 "미성년은 아키텍처상 파일을 쓸 수 없다 → G2 통과 불가 → 설계 결정 필요" 라고 결론했다. **틀렸다.** 두 가지를 어겼다.

| 어긴 규칙 | 무엇을 했나 |
|---|---|
| `verification.md` §1 — 판정 기준을 세우기 전에 대상을 열어본다 | 커리큘럼 프롬프트를 읽기 전에 아키텍처만 보고 "파일이 나와야 한다"고 전제했다. 프롬프트는 chat-only + 미리보기를 명시하고 있었다 |
| `verification.md` §5 — 코치의 말은 증거가 아니다 | 코치가 말한 파일명(`hello.html`)으로 디스크를 확인하고 "미생성" 판정했다. 실제 저장 경로(`index.html`)는 보지 않았다 |

덧붙여, 당시 세운 조치안("미성년 프로필에 `sdk_tools.write: true` 추가")은 **하네스가 하드 실패로 막는 항목**이었다 — `validate.py` 의 `child_sdk_write`: *"minors never gain workspace write capability"*. 제안 자체가 강제된 불변식 위반이었다.

---

## §9. 순정 macOS VM 실측 (2026-08-11) — 참가자 머신 전원에 해당하는 결함 1건

### 환경

`tart` + `ghcr.io/cirruslabs/macos-sequoia-vanilla` (macOS 15.7.7 arm64).
**PATH 가 아니라 파일 경로로** 공기계 조건을 확인했다 — 첫 시도에서 `macos-sequoia-base`(CI 이미지)를 쓰고 PATH 만 보고 "brew 없음" 으로 오판한 뒤 바로잡은 절차다.

```
/opt/homebrew/bin/brew              없음 ✅
/opt/homebrew/bin/gh · node         없음 ✅
/Library/Developer/CommandLineTools  존재 ⚠ (1.8G 실설치 — 이 이미지의 한계)
```

**측정 한계:** CLT 가 이미 있으므로 아래 171초에는 CLT 설치(~2GB)가 빠져 있다. #539 의 3분 26초는 CLT 까지 포함한 값이며 두 수치는 정합적이다.

### 항목 ⑤·⑥ — 설치 171초 (기준 600초의 28%)

```
EXIT=0 · 소요 171초
==> [2] Ensuring package manager (Homebrew)
==> Downloading and installing Homebrew...      ← 실제 설치 (base 이미지에서는 "brew present" 였다)
==> Installing node@22
✓ Studio: installed · ✓ SDK: seeded + verified · ✓ doctor: all manifest checks passed
```

설치 결과를 파일 경로로 확인: `/opt/homebrew/bin/{brew,node,gh}` ✅, `/Applications/HypeProof Studio.app` ✅.

### 결함 — 설치기의 doctor 가 버전을 보지 않는다 (참가자 전원 해당)

같은 런에서 doctor 가 `✓ python: Python 3.9.6` 을 통과시켰다. **매니페스트 요구는 3.11 이다.**

```
python@3.11        ❌ 미설치
PATH python3       /usr/bin/python3 → 3.9.6   (stock macOS 기본)
brew formula       node@22, gh, … python@3.11 없음
doctor             "✓ python: Python 3.9.6" + "all manifest checks passed"
```

원인 — `install.sh` 의 두 곳이 **존재만** 본다:

```sh
install_one_dep()  if have "$_bin"; then ok ...; return 0        # 버전 비교 없음
doctor()           _ver="$(eval "$(dep_check_cmd "$_id")")"      # 찍기만 하고 대조 안 함
                   ok "${_id}: ${_ver:-present}"
```

`scripts/hps-doctor.sh` 는 처음부터 `min_version` 을 강제했다. **doctor 가 둘이었고 설치기 쪽만 비어 있었다.** stock macOS 가 python 3.9.6 을 기본 탑재하므로 **순정 기기로 오는 참가자는 전원 이 상태**가 되고, 화면에는 "전 항목 통과" 가 찍힌다.

현재 실동작 영향은 낮다(레포 `*.py` 22개 중 3.11 전용 문법 0건). 그러나 3.11+ 문법이 하나라도 들어오는 순간 **전 참가자 머신에서 조용히 깨지고 게이트가 못 잡는다.** #544(공기계에서만 터지던 `curl\|bash` 중단)와 같은 계열이다.

### 조치 + 검증

`install.sh` 에 매니페스트 `min_version` 을 임베드하고 두 호출 지점에 게이트를 배선했다. tier 를 존중한다 — required/recommended 만 강제하고 `bash`(maintainer, min 5.0)는 제외한다. 강제하면 `/bin/bash` 3.2 인 모든 macOS 설치가 깨진다.

**같은 VM 에서 수정본으로 재실행:**

```
python: 3.9.6 < 최소 3.11 — 설치를 진행합니다…
→ brew install python@3.11
→ /opt/homebrew/opt/python@3.11              ✅ 설치됨
→ doctor: ✓ python: Python 3.11.15
→ 대화형 셸: /opt/homebrew/opt/python@3.11/libexec/bin/python3 → 3.11.15
EXIT=0 · 27초
```

회귀 TC: `scripts/test-installer-version-gate.sh` — 대조군(3.9.6 미달 / 3.11.5 충족 / 경계 / 자릿수), 버전 추출기(`jq-1.7.1-apple`·`v22.23.2` 등 실제 출력 형태), 매니페스트↔임베드 값 일치, tier 정책, 두 호출 지점 배선까지 검사한다. 기기 없이 1초에 끝난다.

### 본 절이 남기는 교훈 — 대리 신호로 판정하지 말 것

오늘 같은 실수를 세 번 했다. 전부 **대상을 열지 않고 대리 신호를 읽은** 것이다.

| # | 읽은 대리 신호 | 실제 |
|---|---|---|
| 1 | 코치가 말한 파일명(`hello.html`) | 저장은 `index.html` 로 되고 있었다 (§8) |
| 2 | 비대화형 SSH 의 PATH | brew 는 설치돼 있었고 PATH 에만 없었다 |
| 3 | 레포 `hps-doctor.sh` | 참가자가 타는 것은 `install.sh` 내장 doctor 였다 |

세 번째 착시는 이 절 안에서도 한 번 더 났다 — `zsh -lc` 가 `.zshrc` 를 읽지 않아 PATH 반영이 안 된 것처럼 보였다. 대화형 셸로 다시 재서 3.11.15 를 확인했다. `.claude/rules/verification.md` §1 이 정확히 이 실패 방식을 경고하고 있다.
