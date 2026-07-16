# e2e/ — Playwright for Electron

Drives the actual `HypeProof Studio.app` binary, exercises the chat extension end-to-end against a live Anthropic backend (via the local wrangler dev Worker).

## Prereqs

- Built `.app` exists at `vscodium-base/VSCode-darwin-arm64/HypeProof Studio.app` (run `scripts/run-build.sh` once)
- Dev stack running: `bash scripts/dev-stack.sh` (starts wrangler, sets roster, issues a token to `/tmp/hps-token.txt`)
- npm install once: `npm install && npx playwright install chromium` (chromium isn't used but playwright wants it)

### Driving a different `.app` — `HPS_APP_PATH`

By default the suite drives the in-tree build artifact. To verify a
not-yet-shipped extension against the current shell without rebuilding (or
touching `vscodium-base/`), copy the `.app` somewhere writable, inject a fresh
`extensions/hypeproof-chat/{dist,webview-ui/dist,media,package.json}` build into
its `Contents/Resources/app/extensions/hypeproof-chat/`, then point the suite at
the copy:

```bash
HPS_APP_PATH="/path/to/copy/HypeProof Studio.app" npm test
```

`HPS_APP_PATH` accepts either the `.app` bundle root or the inner
`Contents/MacOS/HypeProof Studio` binary. Unset → the default in-tree artifact.

### SDK coach binary — `HPS_SDK_BINARY`

Tests that exercise the agent-sdk coach runtime need the native `claude` CLI
(#282 W4a, REQ-M24). Packaged builds don't carry it; the extension resolves it
as `hypeproofChat.sdkBinaryPath` setting → **`HPS_SDK_BINARY` env** → seeded
location → node_modules. For e2e, either:

```bash
# one-time seed to the standard per-user location (integrity-verified):
bash scripts/seed-sdk-binary.sh
# or point at any binary explicitly (e.g. the dev node_modules copy):
HPS_SDK_BINARY="$PWD/extensions/hypeproof-chat/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude" npm test
```

Neither set → the coach falls back to the proxy runtime (REQ-M7), which is
also a valid state to test.

### Quiet mode — `HPS_QUIET` (invisible local runs)

GUI e2e runs LOCALLY (private-repo macOS CI minutes bill at 10x). To keep a run
from taking over the machine, `launchApp()` runs in **quiet mode by default**
(`HPS_QUIET=1`; set `HPS_QUIET=0` for headed debugging). In the Electron main
process it:

1. `app.dock.hide()` — no dock icon.
2. moves every window to `(-4000,-4000)` + `showInactive()`, re-applied on
   `ready-to-show`/`show` (VS Code re-centers its window after creation).
3. `app.hide()` once the workbench is ready, so focus returns to you
   (escape hatch: `HPS_QUIET_NO_HIDE=1` leaves it shown-but-off-screen).

Playwright drives everything over CDP, which captures the off-screen/hidden
surface directly, so DOM interaction and `page.screenshot` keep working. A
hidden/occluded renderer normally throttles timers ~5x, so quiet launches also
pass `--disable-background-timer-throttling`,
`--disable-renderer-backgrounding`, and
`--disable-backgrounding-occluded-windows` to stay fast.

Diagnostic: `HPS_QUIET_DEBUG=1` logs `[HPS_QUIET] {dockVisible,appHidden,windows[bounds,visible]}`
so a run can assert invisibility.

### Full local suite while away — `scripts/e2e-quiet.sh`

**Rule: full suite = run while away; quiet mode keeps even that invisible.**
Beyond quiet mode, never let a suite launch windows while you're using the Mac.
`scripts/e2e-quiet.sh` gates on the screen lock (`CGSSessionScreenIsLocked` via
pyobjc `Quartz`): it waits until the screen is **locked** to start, and
**aborts + kills the app** the instant it unlocks.

```bash
pip3 install pyobjc-framework-Quartz   # once — lock detection dep
bash scripts/e2e-quiet.sh              # waits for lock, then runs the suite invisibly
```

If Quartz isn't installed the script refuses to run (fails safe — never runs
while it can't confirm you're away).

## Run

```bash
cd e2e
npm install
npx playwright install --with-deps chromium    # only first time
npm test                # headless
npm run test:headed     # show the actual Electron window — useful for debugging
npm run test:ui         # Playwright UI mode
```

After a run:
```bash
npm run report          # opens HTML report in browser
ls test-results/        # screenshots + traces on failure
```

## What's covered

- **01-launch.spec.ts** — app boots, workbench DOM ready, our activity bar container present.
- **02-chat-roundtrip.spec.ts** — autoOnboard's token prompt fills → "안녕" sent → Korean assistant reply received within 30s.
- **27-ai-disclosure.spec.ts** — the AI-disclosure banner (#320, REQ-C14) shows once at the top of a fresh session, persists across the first turn, and re-appears (never duplicated) after Clear Conversation.

## What's not (yet)

- ▶ Run → Preview render
- Manual-approve modal for `requireApprovalFor` actions
- Multi-turn conversation persistence after reload
- Session-window expiry (force end-class mid-test → next message gets 403)

## Layout

```
e2e/
├── playwright.config.ts          # single worker, no parallel, 90s timeout
├── fixtures/
│   ├── global-setup.ts           # preflight: .app exists, wrangler up, token file present
│   └── app.ts                    # launchApp() / closeApp() / frame locators
└── tests/
    ├── 01-launch.spec.ts
    └── 02-chat-roundtrip.spec.ts
```

## How it works under the hood

1. `launchApp()` mkdtemp's a fresh user-data-dir, writes a `settings.json` that points
   `hypeproofChat.proxyUrl` at `http://localhost:8787/v1` and disables welcome/telemetry.
2. Spawns the .app via `@playwright/test`'s Electron driver — flags include
   `--password-store=basic` so the secret store is file-based (writable from outside).
3. The chat extension's `autoOnboard` immediately pops a quickInput box for the
   workshop token. The test types the token from `/tmp/hps-token.txt`.
4. The chat panel's webview is a doubly-nested iframe (`iframe.webview.ready` →
   `#active-frame`). `chatFrame()` helper walks that chain.
5. After the assertion, the user-data-dir is torn down so each test is hermetic.
