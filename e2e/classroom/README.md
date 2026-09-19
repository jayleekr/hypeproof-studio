# Remote classroom operations — browser and Mac host checks (#751)

| Command | What it exercises | What it is not |
|---|---|---|
| `npm --prefix e2e run test:classroom` | Chalk sharing pages ↔ real Service routes (SQLite) | — |
| `npm --prefix e2e run test:classroom-ops` | Chalk operations panel, commands through the real device client | a real Studio app |
| `npm --prefix e2e run test:classroom-ops-roster` | built webview click → real `ClassroomOpsHost` (VS Code stubbed at the bundle edge) → real Service → real Chalk; 30 seats, reviewed input, finish → evaluation → review, real-send confirmation, reader's viewer check | a real Studio app, SDK, model, mailbox |
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
