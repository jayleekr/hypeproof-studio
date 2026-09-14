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
python3 scripts/studio-dev.py run
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

## Local vs live

Default `local` points to `http://127.0.0.1:8787/v1`. It does **not** start a server,
create a lesson, issue a token, or promise an AI response. Use the existing local
Service setup separately. For an isolated local token, deliberately place it in
`<state>/local-participant-token.txt` with mode 600; the launcher overrides the
legacy shared `/tmp/hps-token.txt` import path. No production credentials are copied.

`--service live` explicitly points to production API. Enter your own valid
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
early launch failure. Actual native evidence is recorded separately in the PR.
Neither a unit-test pass nor a three-second running process proves AI/tool use.
