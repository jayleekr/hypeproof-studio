# Windows venue package (remote classroom operations, #751)

For checking **this branch's** classroom features on real Windows PCs before a release contains them. It is the Windows
counterpart of `../mac-devhost.mjs`: a COPY of an official Studio shell + the current extension build, isolated user data,
a NON-production Service. Nothing here may be run on a developer Mac (repo rule); the scripts are executed on
`windows-latest` in CI (`classroom-ops.yml` → *classroom / windows field scripts*) against a fake shell, which proves they
parse and refuse what they must — **not** that a Studio window works. That is what the venue run is for.

| Piece | Where it comes from |
|---|---|
| `classroom-field-bundle` (extension build + `manifest.json` with source SHA and sha256 per file) | CI artifact of the PR (*classroom / field bundle*), or `node e2e/classroom/field-bundle.mjs` |
| official Studio shell | the installed `%LOCALAPPDATA%\Programs\HypeProof Studio` (read only) or an unpacked official zip |
| Agent SDK native `claude.exe` | `scripts\seed-sdk-binary.ps1` per PC (never part of the bundle) |
| Service + Chalk | the staging pair (`worker/wrangler.staging.toml`, `chalk/wrangler.staging.toml`); production hosts are refused |

```powershell
powershell -ExecutionPolicy Bypass -File prepare-devhost.ps1 -ShellDir "$env:LOCALAPPDATA\Programs\HypeProof Studio" `
  -Bundle C:\hps\classroom-field-bundle -WorkDir C:\hps\devhost -ServiceUrl https://<staging-worker>.workers.dev/v1
powershell -ExecutionPolicy Bypass -File preflight.ps1 -WorkDir C:\hps\devhost      # on the venue network, 30+ min before class
powershell -ExecutionPolicy Bypass -File prepare-devhost.ps1 ... -Launch             # same arguments; opens the copy
```

The venue cue sheet (who does what, in which order, what to write down, when to stop) is in
[`docs/testing/classroom-admin.md`](../../../docs/testing/classroom-admin.md#windows-field-cuesheet-20260921).
Record a run as "isolated dev host (official shell vX copy + extension `<sha>`)" with `manifest.json` and `preflight.json`.
Installer, updater, signing and the release's own extension stay NOT RUN until a release that contains this feature is installed.
