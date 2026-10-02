# Windows subscription development execution — 2026-10-02

Scope: issue #1457, `REQ-STUDIO-DEV-SUBSCRIPTION`, `ST-REQ-COACH-RUNTIME`
and `ST-TEST-GPT-PRACTICE`. This is developer-runtime evidence, not a classroom
learning outcome or release acceptance.

## Executed environment

- Windows x64; Node 22.22.3; Python 3.14.
- Installed HypeProof Studio shell 0.1.56, copied into owned LocalAppData state.
- Source base `3d76d9de`, branch `feat/windows-subscription-dev`.
- Codex CLI 0.159.2 with its matching code-mode host, existing ChatGPT login;
  model `gpt-6.1-sol`. No provider credential files were inspected or copied.
- Local Worker at `127.0.0.1:8787`, health reporting `env: dev`, using local D1.
  Existing admin APIs issued a signed adult developer-practice participant code.

## Observed native behavior

The launcher bundled the current extension/webview into a separately identified
Windows app, preserving the installed shell's file manifest. Its receipt reports
`official_app_unchanged: true`; applied extension SHA-256:
`772ba9234f74ceddcc0a560a5f36d2b57a5cb668a1efc01221bac3b71d1675f9`.
The purple title displayed DEV, local Service and branch. UI inspection used the
actual Electron window's loopback debugging port, with mouse/keyboard input.

An unrelated global home-directory test seed initially overrode the local code
and returned 401. The isolated Dev app now ignores that global seed and the
launcher strips inherited test environment variables. After rebuilding, its own
signed code connected through the existing activity/SecretStorage path, and the
start screen offered the activity bound to the isolated workspace.

The initial model turn returned a Code Mode host-disabled error. Enabling the
required transport fixed dynamic Studio tools while leaving built-in tools
disabled. In the rebuilt native chat, Codex Read first reported the missing test
file, then Write, Edit and Read succeeded through the shared Studio host tools.
The existing action-approval resolver was called for both changes; this profile
allowed them by policy, so this native run does **not** claim a manually clicked
approval modal.

The UI returned `WINDOWS_SUBSCRIPTION_VERIFIED`. A separate filesystem read
confirmed that exact UTF-8 content in `windows-subscription-check.txt` under the
owned development workspace. File SHA-256:
`c51e9120ef9232c6908dcc837d72b9f0a32e58494b81d64eb602ab36546fcc21`.
Screenshots, code, app copies, generated file and personal logs remain in private
development state, outside the repository.

## Automated checks and limits

Executed locally:

- `python3 scripts/test-studio-dev.py`: launcher/platform fixtures pass.
- `node extensions/hypeproof-chat/test/local-runtime.smoke.mjs`: actual helper
  Write/Edit/Read, approval denial, traversal/junction denial, credential scrubbing,
  official-app opt-in isolation, test-seed isolation, authenticated MCP and
  Windows child/grandchild termination on cancellation pass.
- `node --test worker/test/codex-rehearsal.test.mjs`: 12 protocol fixtures pass,
  including built-in/external tool refusal and wrong-thread refusal.
- Extension `npm run typecheck` and PowerShell entrypoint parser: pass.
- `python3 scripts/docs-harness/check.py --min-score 95`: 100/100.

Claude Code 2.1.266 was installed but not logged in. Its real subscription turn
is **BLOCKED by login**, not PASS. The Windows launcher resolves its native exe
and fails before build when login is missing. No login/account state was changed.
New macOS native execution, Windows arm64 native execution, full shell builds,
installers, production Service calls and release gates are **NOT RUN**. The new
macOS/Windows CI matrix is authored; a local pass is not a CI pass.
