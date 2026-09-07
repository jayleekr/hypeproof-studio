# Studio start page (#723)

The App owns the entry canvas and SecretStorage bridge; Service still owns profile,
cohort, session and authorization. No lesson/persona content is compiled into this page.
The custom HP SVG and charcoal/sage palette belong to HypeProof. Cursor's official
[quickstart](https://prod.cursor.com/docs/get-started/quickstart) informed the sequence
(connect → choose context → start), not copied branding or source code.

## Reproduce

```sh
npm --prefix extensions/hypeproof-chat/webview-ui run build
npm --prefix extensions/hypeproof-chat run build:extension
npm --prefix extensions/hypeproof-chat run typecheck
npm --prefix extensions/hypeproof-chat test
npm --prefix e2e run test:start-page
```

The Chromium harness serves the built UI with controlled host messages. It covers
neutral/connected/error/pending states, failed replacement, explicit disconnect,
390/768/1280px overflow and credential non-persistence. The host smoke covers real
profile-response handling with controlled 401/403/network/malformed responses.
Neither harness claims a live LLM run or real-user learning outcomes.

## Actual Mac observation, 2026-09-07

PASS on arm64 macOS with the existing Electron shell and this branch's rebuilt
extension (extension package 0.1.5). Exact injected artifact hashes are in
`evidence/build-hashes.json`; these are not a whole-app release build.

- App copy: `/tmp/hps-start-20260907/HypeProof Studio.app`
- Isolated user data: `/tmp/hps-start-20260907/user-data-3`
- Practice folder: `/private/tmp/hps-start-20260907/workspace`
- Local Service: `http://127.0.0.1:8797/v1`; CDP: 9348
- Synthetic roster/session opened through the normal admin API for the actual
  `boah-dental-director-copyclone-2026-s1` registry profile.
- No token preseed for this observed flow: entered via the new password form.
- Invalid code → actual 401 inline error → valid code → real dental course/coach
  confirmation → rejected replacement preserves connection → begin → actual
  dental welcome and fixed coach in chat → reopen via “수업 연결” → disconnect.
- No Navi fallback or name ritual in the adult chat. No QuickInput onboarding.
- Fresh entry no longer displays empty auxiliary/sidebar panes or empty asset score.
- Screenshots and sanitized state snapshots are in `evidence/`.

The Electron fixture disables trust only in its own launch flags. The product no
longer writes a global trust-disable setting or requests restart on activation.
Existing user settings/workspaces and `/Applications` were preserved. New sessions
still need a valid course code from the appropriate Service; an old child-course
code intentionally resolves to that child course. This does not migrate a user's
account to another course automatically.

No LLM task, public hosting, full shell build, signed installer, or Dock icon rebuild
was performed for this UI change. The in-app mark is implemented; shipping it as an
OS application icon remains release work. Folder routing keeps its existing safety
checks; when opening a different workspace reloads the window, the course is shown
again and the learner presses Start there.

The existing Electron launch/auth specs were updated for the new entry flow.
The fixture now explicitly opens `--folder-uri`: with a positional directory,
Playwright's Electron launch consumed the argument and Start opened the cohort's
normal directory. The corrected fixture stays in its isolated practice folder.

```sh
HPS_APP_PATH='/path/to/app-copy.app' \
HPS_E2E_PROXY_URL=http://127.0.0.1:8797/v1 \
HPS_E2E_TOKEN_FILE=/path/to/private-synthetic-token \
npm --prefix e2e test -- 01-launch 21-token-trust 24-token-validation
```

Final local result: extension typecheck and complete smoke suite PASS; built UI
browser controls PASS; all five Electron launch/auth specs PASS (15.1s). The first
Electron attempt exposed the positional-folder fixture defect; the full five-spec
selection was rerun after correcting it. No full L1–L5 rerun is claimed here.

## HP shell follow-up (#725)

The forest/lime brand now extends into the workbench. Configuration defaults hide
inherited navigation chrome while preserving user overrides. The HP canvas remains
behind chat, and even closing every editor shows the HP watermark instead of Codium.
File/settings controls remain available in the entry header. The normal settings
surface in the tested shell is a modal editor (confirmed from its live DOM); the
Electron test closes its explicit “Close Modal Editor (Escape)” control.

`hp-shell-evidence/` contains the actual Mac start/empty-editor screenshots and
observed shell state. PASS: complete extension smoke/typecheck, responsive browser
controls, workflow-shell check, real Electron `27-hp-shell` (3.7s). The shell test
uses a local health-only mock and no token preseed; it makes no authentication/LLM
claim. Earlier #724 authentication evidence above remains separate.

For an existing isolated Mac app copy, inject the rebuilt extension and `media/`,
then apply the asset-only overlay before starting it:

```sh
node scripts/install-shell-brand.mjs '/path/to/copy.app/Contents/Resources/app/out/media'
```

The build workflows apply the same assets before Mac signing and before Windows
compilation. Their full build/signing/installer paths were not run locally. This
script is not a whole-app build and must not modify a signed installed app in place.
The root submodule and installed app were preserved; rollback of the preview is
restoring the previous copied extension/media. A source rollback is a normal revert.
