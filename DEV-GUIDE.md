# HypeProof Studio — 개발자 가이드 / Dev Guide

이 문서는 **Claude Code로 그대로 실행**하도록 만든 가이드입니다. 컨트리뷰터는
Claude Code에게 *"DEV-GUIDE.md 따라서 진행해줘"* 라고 하면, 아래 단계가 미리
만들어 둔 하네스(스크립트·스킬·템플릿)로 실행됩니다. 각 단계는 "직접 알아내기"가
아니라 "이 명령 실행"입니다.

<details><summary>English</summary>

This guide is written to be **run by Claude Code**. Tell Claude Code *"follow
DEV-GUIDE.md"* and each step below executes through pre-built harness (scripts,
skills, templates). Every step is "run this", not "figure this out".
</details>

---

## 0. 전제 / Prerequisites

- **Claude Code를 쓴다고 가정**합니다. 모든 단계가 Claude Code 실행 기준.
- 로컬 빌드·개발은 **macOS arm64 전용**. Windows/Linux는 빌드 불가 — 이슈는
  웹 폼으로(§5). 워크숍 참가자(Win)는 설치본만 받으므로 이 가이드 대상 아님.
- `jayleekr/hypeproof-studio` 접근 권한 + GitHub 계정.

<details><summary>English</summary>

- **Assumes Claude Code.** Every step is phrased for Claude Code to execute.
- Local build/dev is **macOS arm64 only**. Windows/Linux can't build — file
  issues via the web forms (§5). Windows workshop participants only get the
  installer and are not the audience here.
- Access to `jayleekr/hypeproof-studio` + a GitHub account.
</details>

---

## 1. 한 번에 셋업 / One-command setup

```bash
git clone --recursive git@github.com:jayleekr/hypeproof-studio.git
cd hypeproof-studio
bash scripts/setup.sh
```

`setup.sh`는 멱등(idempotent)·안전합니다: 툴체인 점검, 서브모듈 init,
`worker/.dev.vars` 생성 + Gemini 키 주입(`dev-secrets.sh`), worker/e2e 의존성
설치, main 직푸시 방지 가드 활성화. 빠진 건 **자동 설치하지 않고 정확한 명령을
출력**합니다 (예: `brew install nvm`).

<details><summary>English</summary>

`setup.sh` is idempotent and safe: checks toolchain, inits the submodule,
creates `worker/.dev.vars` + pulls the Gemini key via `dev-secrets.sh`,
installs worker/e2e deps, enables the pre-push guard. Anything missing is
**printed as an exact command, never auto-installed**.
</details>

---

## 2. 키 & provider / Keys & providers

- provider는 **스위칭 가능**: 워커가 `LLM_PROVIDER`(`gemini`|`anthropic`)를 읽어
  맞는 키 사용. **Gemini**는 워크숍 비용상 기본 모델. **Anthropic은 fallback이
  아니라 동급** — 컨트리뷰터 전원 Claude Code를 쓰니 개발 중엔 Claude가 자연스러운
  provider. `worker/.dev.vars`에 `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`
  한 줄, 코드 변경 0.
- **키는 서버(Worker)에만** 존재. 빌드된 앱은 raw API 키를 임포트하지 않고
  *workshop token*만 보관 → 앱이 새도 키는 안 샘.
- **테스트 목적 키 사용은 자유** — 빌드 앱 마음껏, 에이전트 방치, e2e 루프 다
  정상 dev 트래픽. 비용 걱정 불필요.
- 단 하나의 규칙: **키 자체를 커밋/공개 위치에 붙여넣지 말 것.**
  `worker/.dev.vars`는 gitignore + `chmod 600`, `.example`만 커밋.
  `/report-ui`·`collect-studio-env.sh`는 설계상 시크릿 미포함. 새면 Jay에게
  알려 로테이션 — 드라마 없음.
- 로컬-dev 빌드는 `proxyUrl`이 localhost면 `dev-stack.sh`가 쓴
  `/tmp/hps-token.txt`를 자동 임포트(매번 붙여넣기 불필요). 워크숍 빌드
  (`proxyUrl=https://api.hypeproof.ai/v1`)는 그 경로를 절대 안 읽음.

<details><summary>English</summary>

- Provider is **switchable** via `LLM_PROVIDER` (`gemini`|`anthropic`). Gemini
  is the cost-chosen workshop default; **Anthropic is a peer, not a fallback**
  (everyone uses Claude Code, so Claude is natural while developing) — one env
  line, no code change.
- The **key lives server-side (Worker) only**. The built app holds a workshop
  token, never a raw API key — a leaked app can't expose the key.
- **Testing usage is free** — hammer the app, leave agents running, loop e2e.
  Expected dev traffic, not a concern.
- One rule: **don't commit or publicly paste the key.** `worker/.dev.vars` is
  gitignored + `chmod 600`; only `.example` is committed. `/report-ui` and
  `collect-studio-env.sh` are secret-free by design. If a key leaks, tell Jay
  to rotate — no drama.
- Local-dev builds (localhost `proxyUrl`) auto-import the token
  `dev-stack.sh` wrote to `/tmp/hps-token.txt`; workshop builds never read it.
</details>

---

## 3. 앱 빌드 / Build the app — 최초 1회, ~1–2 h

```bash
cd vscodium-base
source ../hypeproof-studio.env
bash get_repo.sh && bash prepare_src.sh && bash prepare_vscode.sh
bash ../scripts/run-build.sh ../logs/build-$(date +%Y%m%d-%H%M%S).log
# 검증:
open "vscodium-base/VSCode-darwin-arm64/HypeProof Studio.app"
```

빌드는 1–2시간, 10–20 GB. **worker/extension만 고칠 땐 재빌드 불필요**(핫리로드).
앱 빌드가 필요한 경우: 최초 클론, `vscodium-base` 변경, UI를 실제 셸에서 확인.
실패 모드·서브모듈 핀 정책: [.claude/rules/build-pipeline.md](.claude/rules/build-pipeline.md).

<details><summary>English</summary>

Build is 1–2 h, 10–20 GB. **No rebuild for worker/extension changes**
(hot-reload). You need a built app for: first clone, a `vscodium-base` change,
or seeing UI in the real shell. Failure modes + submodule pin policy:
[.claude/rules/build-pipeline.md](.claude/rules/build-pipeline.md).
</details>

---

## 4. 실행 & 테스트 / Run & test

```bash
bash scripts/dev-stack.sh                       # wrangler dev + roster + token
cd worker && npm test && npm run typecheck      # 9 smoke + types (no stack needed)
cd e2e && npm test                              # 13 e2e (needs built app + dev-stack)
```

고친 영역에 해당하는 레이어만 돌리면 됩니다. e2e가 preflight에서 실패하면
`.app`/wrangler/token 중 무엇이 없는지 알려줍니다.

<details><summary>English</summary>

Run the layer(s) your change touched. If e2e fails at preflight it names which
of `.app` / wrangler / token is missing.
</details>

---

## 5. 쓰다가 발견 → 이슈 / Notice something → file an issue

```
/report-ui
```

타입(feature/ux/bug) 선택 → 모국어로 서술 → 스크린샷(실제 창 클릭 or Playwright
재현, 생략 가능) → 환경 스냅샷·라벨 자동 부착 이슈 생성 → URL 반환. macOS 전용;
Windows/Linux는 GitHub 웹 폼([feature](.github/ISSUE_TEMPLATE/feature_request.yml)
· [ux](.github/ISSUE_TEMPLATE/ux_suggestion.yml)
· [bug](.github/ISSUE_TEMPLATE/bug_report.yml)) + 스크린샷 수동 첨부.

<details><summary>English</summary>

`/report-ui`: pick type → describe in your language → screenshot (live window
or Playwright repro, optional) → issue created with env snapshot + labels →
URL. macOS only; Windows/Linux use the GitHub web forms + manual screenshot.
</details>

---

## 6. 코드 고치기 → PR / Fix code → PR

**정책: PR 필수, 리뷰 선택.** main 직푸시는 메인테이너(Jay) 전용.

```bash
git switch -c fix/issue-<N>-<slug>      # 또는 feat/issue-<N>-<slug>
# … 수정 + §4의 해당 테스트 통과 + 커밋 …
```
그다음 Claude Code에서:
```
/hype-open-pr
```

`/hype-open-pr` 스킬(`/report-ui`의 PR쪽 짝)이 브랜치를 확인하고 내부적으로
`scripts/open-pr.sh`(main 거부 → push → `.github/pull_request_template.md`로
PR 생성)를 실행한 뒤, **본문의 `Closes #<N>` · Essence(챗 패널 변경 시 §4.5
번호) · Tested를 대화형으로 같이 채워**줍니다. (스킬 없이 직접 하려면
`bash scripts/open-pr.sh`만 실행하고 본문은 수동.) CI `main-guard`가 비-PR
main 푸시를 빨간 빌드로 표시(메인테이너·`[skip-main-guard]` 제외). merge 후
브랜치 삭제.

<details><summary>English</summary>

**Policy: PR-first, review optional.** Direct main push is maintainer-only.
In Claude Code run **`/hype-open-pr`** (the PR-side counterpart of
`/report-ui`): it checks the branch, runs `scripts/open-pr.sh` internally
(refuses on main → pushes → opens a PR from the template), then fills
`Closes #<N>` / Essence (§4.5 number for chat-panel) / Tested *with you*.
Script-only path: `bash scripts/open-pr.sh` (fill the body manually). The
`main-guard` CI flags non-PR main pushes red. Delete the branch after merge.
</details>

---

## 7. 병행 작업 / Parallel work (worktrees)

여러 이슈를 동시에 굴릴 땐 **Claude Code 네이티브 worktree**를 씁니다 — 별도
스크립트 불필요:

```bash
claude -w issue-12        # 이슈 #12용 새 worktree + 세션
claude -w issue-15 --tmux # 또 다른 이슈를 별도 worktree(+tmux 패널)에서
```

흐름은 §5–6과 동일: **이슈 발행(`/report-ui`) → 이슈별 worktree에서
`fix/issue-N-slug` 브랜치 작업 → `/hype-open-pr` → merge 후 worktree 정리.**
worktree는 worker/extension/docs **병행 작업용**(핫리로드, 앱 재빌드 0).

이 프로젝트의 함정 3개 — worktree를 어떻게 만들든 동일하게 적용:

1. **포트 8787 충돌.** `dev-stack.sh`는 8787 하드코딩. **동시에 라이브 스택은
   1개만.** 다른 worktree는 코드 + `cd worker && npm test`(스택 불필요)로 검증.
2. **새 worktree엔 빌드된 `.app`이 없음.** e2e는 worktree 자기 디렉토리에서
   앱을 찾음. **빌드·e2e는 primary clone에서만** — worktree마다 빌드(1–2h·6GB)
   금지.
3. **`worker/.dev.vars`는 디렉토리별**(gitignored, 복사 안 됨). 새 worktree에서
   워커를 돌리려면 복사: `cp <primary>/worker/.dev.vars worker/.dev.vars`.
   서브모듈 `vscodium-base`도 미체크아웃 — worker/extension/docs 작업엔 불필요.

`pre-push` 가드와 `core.hooksPath`는 공유 `.git`이라 모든 worktree에 자동 적용.
worktree 디렉토리는 `.claude/worktrees/`(gitignored)에 두면 깔끔합니다.

<details><summary>English</summary>

For several issues in parallel, use **Claude Code's native worktree** — no
custom script:

```bash
claude -w issue-12          # new worktree + session for issue #12
claude -w issue-15 --tmux   # another issue in its own worktree (+tmux)
```

Same flow as §5–6: file the issue (`/report-ui`) → work a
`fix/issue-N-slug` branch in the per-issue worktree → `/hype-open-pr` →
tidy up after merge. Worktrees are for **parallel worker/extension/docs**
work (hot-reload, no app rebuild).

Three project gotchas — true no matter how the worktree is made:

1. **Port 8787 collides.** `dev-stack.sh` hardcodes 8787 — only **one live
   stack at a time**. Other worktrees: code + `cd worker && npm test` (no
   stack needed).
2. **A fresh worktree has no built `.app`.** e2e looks for the app in its
   own dir. **Build & e2e only in the primary clone** — never rebuild per
   worktree (1–2 h, 6 GB).
3. **`worker/.dev.vars` is per-directory** (gitignored, not copied). To run
   the worker in a new worktree:
   `cp <primary>/worker/.dev.vars worker/.dev.vars`. The `vscodium-base`
   submodule is also unchecked out — fine for worker/extension/docs.

The `pre-push` guard and `core.hooksPath` live in the shared `.git`, so they
apply in every worktree. Keep worktree dirs under `.claude/worktrees/`
(gitignored).
</details>

---

## 부록 / Appendix

- **플랫폼**: 빌드/`/report-ui` = macOS arm64만. Win은 CI 빌드만(METAPLAN §0/§6).
- **가드 2겹**: `.githooks/pre-push`(로컬, `setup.sh`가 활성) +
  `.github/workflows/main-guard.yml`(CI). 둘 다 소프트 — 서버측 차단은 유료
  플랜 필요(미적용).
- **건드리지 말 것**: `vscodium-base` 서브모듈 핀(의도적 bump만 —
  [.claude/rules/build-pipeline.md](.claude/rules/build-pipeline.md)),
  `worker/.dev.vars`(시크릿).
- 스킬은 `/skill-creator`로만 만들고 고침(`.claude/skills/skill-creator`).
- 팀: [CONTRIBUTORS.md](./CONTRIBUTORS.md) · 페이즈/게이트: [METAPLAN.md](./METAPLAN.md)
  · 제품 철학: [docs/essence-v0.1.md](./docs/essence-v0.1.md)

<details><summary>English</summary>

- **Platform**: build/`/report-ui` = macOS arm64 only; Win is CI-only
  (METAPLAN §0/§6).
- **Two soft guards**: `.githooks/pre-push` (local, enabled by `setup.sh`) +
  `main-guard` CI. Server-side blocking needs a paid plan (not applied).
- **Don't touch**: the `vscodium-base` submodule pin (deliberate bumps only),
  `worker/.dev.vars` (secrets).
- Skills are created/edited only via `/skill-creator`.
- Team: [CONTRIBUTORS.md](./CONTRIBUTORS.md) · phases/gates:
  [METAPLAN.md](./METAPLAN.md) · philosophy:
  [docs/essence-v0.1.md](./docs/essence-v0.1.md)
</details>
