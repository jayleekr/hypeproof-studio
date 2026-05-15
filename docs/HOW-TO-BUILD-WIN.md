# Building HypeProof Studio for Windows

Windows builds run **only in GitHub Actions** (`.github/workflows/build-windows.yml`). Local Windows reproduction is out of scope for Jay's Mac-only dev environment.

## Trigger a build

### Manual (web UI)
1. Go to repo → Actions → "Build Windows"
2. Click "Run workflow"
3. Optional: enter branch/tag (default `main`)
4. Wait ~60–90 min
5. Download the `hypeproof-studio-windows-x64` artifact from the run page

### Manual (CLI)
```bash
gh workflow run build-windows.yml --ref main
gh run watch
gh run download <run-id>
```

### Automatic
Pushing a tag matching `v*` (e.g. `v0.1.0`) auto-triggers a build.

## What you get

`dist/` contains:
- `HypeProof Studio Setup x.y.z.exe` — NSIS installer (unsigned for now)
- `HypeProof Studio-x64.zip` — portable archive

## Signing

**Phase 6 status: unsigned.** Windows SmartScreen will warn users on first launch ("Windows protected your PC" → "More info" → "Run anyway"). The family install guide explains this step.

Self-signed cert path (post-Phase-7 task):
1. Generate cert in repo secrets: `WIN_CERT_PFX` (base64), `WIN_CERT_PASSWORD`
2. Add a `Sign` step to the workflow using `signtool.exe` from Windows SDK
3. Bump to EV cert when public release matters (Apple Developer ID's Win equivalent)

## Build deps inside the runner

The workflow installs everything fresh: Node 22, Python 3.11, jq via choco, all npm deps. No persistent state — every run is reproducible from `main`.

## Failure modes

| Symptom | Fix |
|---|---|
| `prepare_src.sh` 404 | GitHub rate limit — usually transient, re-run job |
| `npm install` ETIMEDOUT | npm registry hiccup — re-run job |
| Out of memory | `NODE_OPTIONS` already at 12 GB; runner has 16 GB — raise to 14 GB if needed |
| Icon build fails | Verify `rsvg-convert` / `imagemagick` install in workflow (currently relies on built-in runner tools) |

## Local Windows dev (not supported)

If absolutely needed for triage:
- Use a Windows VM (Parallels / UTM) with 32 GB RAM allocation
- Mirror the workflow steps manually
- Expect 2–3 h initial setup; not maintained
