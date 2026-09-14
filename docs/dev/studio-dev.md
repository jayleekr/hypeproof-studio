# Isolated Studio development (macOS arm64)

This opt-in tool builds the current checkout's chat extension and webview into a
separate copy of the installed app. It does not change install/update/release CI,
production Service, lessons, or `/Applications/HypeProof Studio.app`.

## First run

Prerequisites: official Studio installed, Python 3.10+, Node/npm compatible with
the checked-in lockfiles, `codesign`, and macOS arm64. No full VSCodium rebuild.

```sh
npm --prefix extensions/hypeproof-chat ci
npm --prefix extensions/hypeproof-chat/webview-ui ci
python3 scripts/studio-dev.py --provider claude run
```

After dependencies are installed, double-click `scripts/Studio Dev.command`.
The default state directory is outside the repo under
`~/Library/Application Support/HypeProof Studio Development/<checkout hash>`.
Its `user-data`, `extensions`, `workspace`, logs and app backups are separate.
Use the launcher; opening the `.app` directly in Finder uses a different default
profile and does not receive the launcher's settings or isolated token path.

`--base-app '/path/to/HypeProof Studio.app'` selects a compatible installed base.
`--state-dir '/absolute/empty-directory'` overrides the owned development state.
Non-owned, overlapping and symlink state directories are rejected. Previous app
copies are retained; no automatic deletion or forced termination is performed.
The installed base is hashed before/after preparation. A development copy is
signed locally, not a signed/notarized release distributable.

## Edit, build, apply

```sh
python3 scripts/studio-dev.py watch
```

Watch builds source changes but does not interrupt a running app. Save your
work, quit **only the development app**, and run the launcher again to apply.
This is rebuild/relaunch, not full hot reload. Build failure leaves the current
app untouched. Signing and installed-app checks happen before replacement.
Configuration has a purple DEV title with branch and Service mode.

The shell/helper names must be preserved. Renaming `package.json.name` or
`CFBundleName` without rebuilding Helpers causes Electron's
`Unable to find helper app` fatal error. Only development identity/display
metadata is changed. New runtime dependencies are not silently packaged: a
manifest dependency mismatch against the base app is refused.

## Local subscriptions

This is an explicit developer-only exception to the production runtime credential
contract (REQ-M13), not a change to classroom authentication. It extends
ST-REQ-COACH-RUNTIME and ST-TEST-GPT-PRACTICE.

The development launcher defaults to the installed, logged-in **Claude Code** CLI.
Use `--provider codex` for the local Codex ChatGPT login, or `--provider service`
for the existing Service-funded runtime. Missing CLI/login fails before a build;
there is no silent fallback to another provider or API billing.

```sh
python3 scripts/studio-dev.py --provider claude run
python3 scripts/studio-dev.py --provider codex run
python3 scripts/studio-dev.py --provider service --service live run
```

This replaces the model connection, not the classroom Service. Local mode still
uses a valid local lesson/token from the existing Service setup. A participation
code authenticates the local class; it is never sent to Claude Code or Codex.
The chosen CLI owns its credentials and subscription limits. No OAuth files are
read/copied and no provider API key is needed for this model path.

The existing chat shows the development provider/model. File tools (Read, Write,
Edit) use one Studio host implementation with the resolved lesson profile's
capability gates and the existing approval UI. Both providers can create and
modify actual workspace files. Shell, search, browser tools, attachments, model
switching during a turn, and production funding parity are outside this first
local adapter. No claim of full release-runtime equivalence is made.

The override requires BOTH the Dev app identity and launcher environment, and
refuses a remote Service URL. Official app behavior and production model pins
remain unchanged. Claude uses its documented CLI/MCP connection, with built-in
tools and unrelated hooks/MCP disabled. Codex uses App Server dynamic tools;
built-in tools are disabled and its own working directory is disposable.

Implementation: `src/localRuntime/` owns the shared lifecycle/tool policy and
small provider adapters. The old `scripts/lib/codex-local-client.mjs` entry point
re-exports the shared client so rehearsal scripts do not fork its logic.

## Local vs live

Default `local` points to `http://127.0.0.1:8787/v1`. It does **not** start a server,
create a lesson, issue a token, or promise an AI response. Use the existing local
Service setup separately. For an isolated local token, deliberately place it in
`<state>/local-participant-token.txt` with mode 600; the launcher overrides the
legacy shared `/tmp/hps-token.txt` import path. No production credentials are copied.

`--provider service --service live` explicitly points to production API. Enter your own valid
participation code in the development app. This preserves the installed app and
its data, but real API requests consume real allowance and are recorded by the
Service. It is not an offline simulation. Existing permissions remain unchanged.

## Scope and validation

Developer tooling only; no new learner behavior or asset outcome is claimed.
Requirements: preserve official installation/data, never silently overwrite a
running app, preserve work across relaunch, and distinguish process launch from
actual UI/AI acceptance. This supports existing isolated candidate practice in
[unified release and migration](unified-release-and-migration.md), without changing
its release gates or treating local acceptance as release readiness.

```sh
python3 scripts/test-studio-dev.py
```

Tests cover path/state ownership, Helper identity regression, process inspection,
settings preservation, official-payload change detection, running-app refusal and
early launch failure, and stale JavaScript shadowing TypeScript source. Webview
type checks use `noEmit`; keep generated JavaScript outside `src`. If preparation
reports a shadowed source, move the generated companion out before rebuilding.
Actual native evidence is recorded separately in the PR.
Neither a unit-test pass nor a three-second running process proves AI/tool use.

## 팀원이 쓰는 순서

1. 이 PR의 브랜치를 별도 폴더에 체크아웃한다. 공식 앱은 설치된 상태로 둔다.
2. 위 First run의 두 `npm ci`를 실행한다. 사용할 Claude Code 또는 Codex CLI에 본인 계정으로 로그인한다.
3. 로컬 수업 Service와 유효한 참여 코드를 준비한다. 이미 서버가 있다면 그대로 사용한다. `scripts/dev-stack.sh`는 기존 로컬 수업·참여 코드 준비 스크립트지만 실행 중인 Wrangler를 종료하므로 다른 작업이 있을 때 무작정 실행하지 않는다. 이 실행기는 수업 서버를 자동 구성하지 않는다.
4. `python3 scripts/studio-dev.py --state-dir "$HOME/Studio-Dev-Local" --provider claude run`으로 시작한다. Codex는 `--provider codex`로 바꾼다. 해당 경로는 이 실행기 전용으로 새로 선택한다.
5. 개발 앱에서 **로컬 서버가 발급한** 참여 코드를 입력한다. 자동 연결이 필요하면 그 코드를 지정한 state 폴더의 `local-participant-token.txt`에 본인이 저장하고 파일 권한을 600으로 설정한다. 코드는 공유하거나 커밋하지 않는다.
6. 파일 생성이 허용된 수업에서 작은 텍스트 파일 생성·읽기·수정을 확인한다. 앱 시작 성공과 모델/파일 동작 성공은 별개다.
7. 소스 수정 후 개발 앱만 종료하고 같은 실행 명령으로 다시 빌드한다. 실행 중인 앱을 강제로 바꾸지 않는다.

로컬 구독 모드는 모델 API 키를 요구하지 않는다. 로컬 수업 서버의 서명·관리 설정과 참여 권한은 별도로 필요하다. 공식 서버용 참여 코드를 로컬 서버에 붙여도 자동으로 호환되지 않는다. 현재 제공 범위는 macOS arm64의 소스 기반 개발 실행이며, 설치 파일을 배포하는 정식 출시가 아니다.

## 실험을 공식 Studio에 반영하는 절차

개발 실행 기능과 교육 제품 실험은 별도 변경으로 관리한다. 아래는 이 개발 흐름에서 따를 PR 분리 기준이며 기존 리뷰·릴리스 규칙을 대체하지 않는다.

- 개발 기반 PR: 앱 격리, 로컬 모델 연결, 빌드·실행 및 개발 가이드만 포함한다. 현재 실험한 학생 UI, 강의 내용, 평가 모델, 게임 결과물은 포함하지 않는다.
- 제품 실험: 각 가설별 브랜치/작업 폴더에서 실습한다. 실행기가 현재 체크아웃을 빌드하므로 변경이 섞인 전체 폴더를 공식 브랜치에 복사하지 않는다.
- 승격 후보: 최신 main에서 별도 브랜치를 만들고 필요한 소스 변경만 선택한다. 사용자 문제, 공통 제품 동작, 확인 기준과 실패 사례를 요구사항·테스트로 연결한다. 게임은 시험 사례로 두고 전용 UI나 규칙을 공통 계층에 넣지 않는다.
- 검증: 앱/Service/강의 버전과 모델 연결 경로를 기록한다. 결정적인 상태·권한·저장은 자동 테스트로, 모델 응답과 사용자 흐름은 실제 실행으로 확인한다. 로컬 구독에서 성공한 것을 공식 모델 연결의 성공으로 간주하지 않는다.
- 리뷰: 저장소 hype-pr 절차로 별도 PR을 올린다. 실험용 프롬프트와 UI는 개발 실행기 PR에 편승시키지 않는다. 리뷰를 거쳐 머지한 뒤 기존 공식 릴리스 절차로 배포한다. 개발 실행 자체가 자동 머지나 배포를 유발하지 않는다.
- 제외: 참여 코드, 로그인 자격, .dev.vars, 사용자 데이터, 빌드 앱, 생성 작업물, 개인 실행 로그는 커밋하지 않는다.
