# Remote classroom operations — browser and Mac host checks (#751)

| Command | What it exercises | What it is not |
|---|---|---|
| `npm --prefix e2e run test:classroom` | Chalk sharing pages ↔ real Service routes (SQLite) | — |
| `npm --prefix e2e run test:classroom-ops` | Chalk operations panel, commands through the real device client | a real Studio app |
| `npm --prefix e2e run test:classroom-ops-roster` | built webview click → real `ClassroomOpsHost` (VS Code stubbed at the bundle edge) → real Service → real Chalk; 30 seats, reviewed input, finish → evaluation → review, real-send confirmation, reader's viewer check | a real Studio app, SDK, model, mailbox |
| `npm --prefix e2e run test:classroom-ops-help` | Chalk /manage: roster on connect, help requests vs technical problems (open/answered/resolved/withdrawn/expired/other class), the Service's first action as the one primary, help entry under "2 수업 진행" keeping page state | a real Studio app or learner |
| `npm --prefix e2e run test:classroom-report` | the report page and its PDF in Chromium | a recipient's mail client or printer |

All four run in PR CI (`.github/workflows/classroom-ops.yml`). The evaluator and mail provider are replaced at their
transport seams; accounts are synthetic.

## Isolated Mac host for the current build

The Mac may have an installed Studio that is **older than this branch** (2026-09-19: `/Applications/HypeProof Studio.app`
is v0.1.16). Running that app says nothing about this code. Do not record it as a check of these features.

```sh
npm --prefix extensions/hypeproof-chat run build:extension && npm --prefix extensions/hypeproof-chat/webview-ui run build
node e2e/classroom/mac-devhost.mjs prepare   # copies the shell, injects the current build, ad-hoc signs the COPY, verifies hashes
node e2e/classroom/mac-devhost.mjs launch    # local synthetic Service + the copy, isolated user data; prints the steps
```

- `/Applications` is only read. The copy lives under `e2e/test-results/classroom-devhost/` (git-ignored), with its own
  `--user-data-dir` and `--extensions-dir`. Its only Service is the local in-process one; no production URL or token.
- `manifest.json` records the shell version, the extension source SHA and the bundle hashes. When the shell is older
  than the release this branch would ship in, **only extension-level behaviour** may be read from it — not the updater,
  signing, shell patches or the vendored Agent SDK (absent in this copy: SDK turns fall back to the proxy runtime).
- Use `HPS_DEVHOST_SOURCE=/path/to/official.app` for a current official shell. This script downloads nothing.
- Record results as “isolated dev host (shell vX copy + current extension)” with the manifest. Real release builds,
  Windows, the school network and production D1/R2 stay **NOT RUN** until they are actually run.

### Long checkout paths on macOS

`prepare` keeps the copied app and manifest under `HPS_DEVHOST_DIR`, but gives
Electron a short, per-host user-data directory under the OS temporary directory.
The former `<checkout>/e2e/test-results/.../user-data` path exceeded the 103-byte
Unix socket limit on this Mac and the process exited with `ENOTSOCK`. Re-run
`prepare` for an old manifest; `launch` now rejects that path before opening an app.
The temporary profile is a development artifact and may be removed by OS cleanup.

Regression: `node --test e2e/classroom/mac-devhost.test.mjs` binds a real local
Unix socket for a deeply nested checkout and verifies separate host profiles.

### Re-running the whole classroom path on this Mac

One prepared host serves both runs. Re-run `prepare` whenever extension, webview, Service or Chalk sources change — both
runs refuse a copy whose bundle hashes or extension sources differ from the checkout.

```sh
export HPS_DEVHOST_DIR=e2e/test-results/classroom-devhost         # any git-ignored directory; reuse it between runs
export HPS_DEVHOST_SOURCE="/path/to/official/HypeProof Studio.app" # an unpacked official arm64 release, never /Applications
npm --prefix extensions/hypeproof-chat run build:extension && (cd extensions/hypeproof-chat/webview-ui && npx vite build)
node e2e/classroom/mac-devhost.mjs prepare
(cd e2e && node --experimental-strip-types --experimental-sqlite classroom/mac-gui.mjs)   # machine-checked, ~3 min → $HPS_DEVHOST_DIR/gui/result.json
node --experimental-strip-types --experimental-sqlite e2e/classroom/mac-demo.mjs          # stays open for a person: /demo and /manage on :18762
```

- `mac-gui.mjs` drives the real window: issue → verify → connect → step → instructor confirm → provider error → recovery →
  token evidence after `runtime_ready` → instructor stop → preserving reset (file hashes) → learner consent → collection of
  the app's **real SessionSpool** (Service re-hash, `coverage`) → draft opened and approved for content → reconnect → leave.
  Every step is `PASS` or `NOT_RUN` in `result.json`, next to the source SHA, shell version and SDK version.
- Neither run sets the e2e gate (`HPS_TEST_E2E` / `hps-test-state.json`): with it the extension creates no spool at all.
  The app gets its own `HOME`, so the spool is real but never lands in the user's
  `~/Library/Application Support/HypeProof-Studio`.
- Scripted in both: model answers, the report evaluator transport, mail. `mac-demo.mjs` also scripts seats A2/A3.
  Neither is evidence about a real model, real mail, Windows, a school network, staging/production D1·R2 or a release install.
- `mac-demo.mjs` creates a new synthetic class on every start; its token and class expire after about an hour.
- Selected collection (#751 U1) on this Mac: start `mac-demo.mjs` with `HPS_DEMO_PREPARE_A1=1` (the real window connects, takes one
  real turn and records consent by itself), then `node e2e/classroom/mac-demo-board.mjs` — a visible browser signs in to the real
  Chalk board, selects A1, previews, collects, and checks from the Service's rows that the scripted seats A2/A3 (connected and
  consenting) were left untouched. `HPS_BOARD_HEADLESS=1` runs the same without keeping a window open.

## Instructor UI review preview (synthetic, for looking at the screens)

```sh
node --experimental-strip-types --experimental-sqlite e2e/classroom/ui-review-preview.mjs      # 127.0.0.1:18951, until Control-C
HPS_UI_REVIEW_OUT=<dir> node e2e/classroom/ui-review-capture.mjs                                # on a FRESH preview: it sends and collects
HPS_UI_REVIEW_OUT=<dir> node e2e/classroom/ui-review-capture-pass2.mjs                          # pass 2 screens only; reads, sends nothing
```

- 24 synthetic seats in mixed states; connected seats run the real device client code in-process. The instructor token is
  synthetic (test secret, this process only) and is written to `e2e/test-results/ui-review-preview/instructor-token.txt`.
- The capture script asserts no horizontal overflow and no token on the page, and records the primary CTAs, viewport and
  device scale factor of every screenshot. Its "합성 데이터" badge is added by the script, not by the product.
- Shares cover every help-request state the board must tell apart: open (B2, C2 with a fault, quiet C6), answered (A5), resolved (A6),
  withdrawn (B1), expired (B3, set in SQLite), an earlier class (B4, session id set in SQLite), and a submission (B6).
- Not evidence about a real class, a real Studio window, Windows, a school network, staging or production.
