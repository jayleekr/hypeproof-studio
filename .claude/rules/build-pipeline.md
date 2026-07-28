# Build pipeline rules

Loaded explicitly when build/CI work is in scope. Top-level [/CLAUDE.md](../../CLAUDE.md) has the hard rules.

## Approval policy

A full `build.sh` run is 1–2 hours and writes 10–20 GB. **Always confirm with the user before kicking it off.** Acceptable shortcuts:

- Re-running only `prepare_vscode.sh` after a patch/env tweak (fast, idempotent IF run via `scripts/run-build.sh` — see below).
- Re-running only `icons/build_icons.sh` after an SVG swap.

Both are safe to run without re-confirming each time inside the same task.

## Canonical entry point

Always launch builds via `scripts/run-build.sh <logfile>`. It:
1. Sources nvm (Node 22), cargo, `hypeproof-studio.env`
2. Runs `scripts/check-env.sh` before the long build, so missing fresh-machine dependencies fail fast
3. Restores `patches/00-update-disable.patch.yet` from git (the rename in `prepare_vscode.sh:148-150` is one-shot)
4. `git reset --hard && git clean -fdx` inside `vscodium-base/vscode/` to wipe any previously-applied patches + injected extension
5. Execs `bash build.sh` with logging

Skipping these resets makes the second build fail on `git apply` (patches already applied) or `mv .yet .patch` (.yet already renamed).

## Fresh macOS build prerequisites

Run `bash scripts/check-env.sh` before a first build. A clean machine needs:

```bash
brew install nvm jq gnu-sed libicns icoutils imagemagick librsvg python@3.11
nvm install 22.22.1
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
xcode-select --install
```

Required tools checked by `scripts/check-env.sh`: Node `22.22.1`, `python3.11`,
`cargo`/`rustc`, Xcode CLI tools, Homebrew, `jq`, `gsed`, `icns2png`,
`icotool`, ImageMagick `composite`, and `rsvg-convert`.

## How HypeProof Studio overrides reach the build

`build.sh` line 11 sources `prepare_vscode.sh`. We added a HypeProof hook **at the end** of `prepare_vscode.sh` (look for `--- HypeProof Studio overrides ---`) that does, in this order:

1. Run `scripts/apply-product-overrides.sh` → patches `vscode/product.json` with HPS values (nameShort, applicationName, bundle id, urlProtocol, dataFolderName, win32 keys) **and the release version** (`.version`/`.commit`/`.date`, plus `vscode/package.json` `.version` which drives Info.plist `CFBundleShortVersionString`). Version comes from `scripts/resolve-version.sh` — single source of truth: `$HPS_VERSION` (CI sets it from the git tag) → extension `package.json` fallback. An empty version made the in-app updater loop forever (#206), so `verify-branding.sh` now fails the build if `product.json.version` is empty/placeholder or disagrees with the bundled extension.
2. Copy pre-built `extensions/hypeproof-chat/` (dist + webview-ui/dist + media + package.json) into `vscode/extensions/hypeproof-chat/`
3. Leave `product.json.builtInExtensions` untouched. Listing the extension there triggers marketplace/GitHub download during build; a folder under `extensions/` is bundled automatically.

**Prerequisite**: `extensions/hypeproof-chat/dist/extension.js` and `extensions/hypeproof-chat/webview-ui/dist/index.html` must exist before the build starts. Run `npm run build` inside `extensions/hypeproof-chat/` (or `scripts/inject-builtin-extensions.sh` which does both build + inject) before any `scripts/run-build.sh` invocation that wants the extension included.

## Required env vars (must be in `hypeproof-studio.env`)

Discovered during Phase 1: missing any of these causes silent or confusing failures.

| Var | Why |
|---|---|
| `VSCODE_QUALITY=stable` | `get_repo.sh` and `prepare_vscode.sh` both branch on this. Empty → wrong API URL |
| `CI_BUILD=no` | Skip the git safe.directory tweak that's only valid in GH Actions |
| `OS_NAME=osx` | Picks the Mac code path in `prepare_vscode.sh` Linux/Win-specific sed blocks |
| `VSCODE_ARCH=arm64` | Mac dev target |
| `SHOULD_BUILD=yes` | Otherwise the build is a no-op |
| `SHOULD_BUILD_REH=no` | Skip remote-extension-host build (saves ~15 min) |
| `DISABLE_UPDATE=yes` | Disables in-app updater (we don't ship an update server for v0.1) |

## Icon generation flow

`vscodium-base/icons/build_icons.sh` does two things:
1. For Mac: rasterizes our `icons/stable/codium_*.svg` files into `src/stable/resources/darwin/code.icns`
2. For Linux/Win/server: **downloads VSCodium-flavored icons** from `raw.githubusercontent.com/VSCodium/icons` via wget unless the target files already exist

**Current state:** the fork (`jayleekr/vscodium@hps/main`) ships **pre-generated HypeProof-branded platform icons committed under `src/stable/resources/{darwin,win32,linux,server}/`** (`code.icns`, `code.ico`, `code.png`, `favicon.ico` — the "HP" logo, committed in the brand-assets commit). So `build_icons.sh`'s existence checks short-circuit both the darwin rasterize and the Linux/Win/server download paths, and **neither `build-mac.yml` nor `build-windows.yml` runs `generate-platform-icons.sh`** — branding is already correct from the committed icons. This is why CI needs no `rsvg-convert`/ImageMagick for icons.

`scripts/generate-platform-icons.sh` is now a **refresh tool**: run it (after `install-brand-assets.sh`, before `build_icons.sh`) only when the brand SVG changes and you need to regenerate + re-commit the platform rasters. It requires `rsvg-convert` (librsvg) + ImageMagick locally. It is no longer a required build step.

## Common failure modes (from real Phase 1 run)

| Symptom | Root cause | Fix |
|---|---|---|
| `prepare_src.sh: line 11: checksum: command not found` | `~/.npmrc` has `prefix=` that breaks nvm globals | Cosmetic. Source archives still build. Ignore for local builds |
| `mv: ../patches/00-update-disable.patch.yet: No such file or directory` | Second build with stale rename | `run-build.sh` restores from git |
| `error: patch failed: build/gulpfile.vscode.ts` | Patches already applied to `vscode/` | `run-build.sh` resets via `git clean -fdx` |
| `nvm: command not found` or `N/A: version "v22.22.1"` | Missing nvm or exact Node pin | `brew install nvm && nvm install 22.22.1` |
| `cargo: command not found` / `rustc: command not found` | Missing Rust toolchain | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| `icns2png could not be found` | Missing libicns | `brew install libicns` |
| `icotool could not be found` | Missing icoutils | `brew install icoutils` |
| `composite could not be found` | Missing ImageMagick | `brew install imagemagick` |
| `rsvg-convert could not be found` | Missing librsvg | `brew install librsvg` |
| Build silently uses VSCodium icons | `build_icons.sh` skipped regeneration because files exist | Delete `src/stable/resources/*/code.{icns,png,ico}` before re-running |
| `Request https://api.github.com/repos/.../releases/tags/v0.1.0 failed with status code: 404` during `bundle-marketplace-extensions-build` | Extension listed in `product.json.builtInExtensions` triggers a marketplace/GH download. The download target doesn't exist (no release yet) | Don't list bundled extensions in `builtInExtensions`. Place them in `vscode/extensions/` only — VSCodium picks them up automatically as built-ins (same as `git`, `npm`, etc.) |
| `npm error ELSPROBLEMS / missing: <pkg>, required by hypeproof-chat` during `vscode-min-prepack` (#349, killed the v0.1.17 tag builds) | The injected extension ships pre-built with NO `node_modules`, but its `package.json` declared a runtime `dependencies` entry — `npm list --production` then fails on the copy | Runtime deps of hypeproof-chat must live in `devDependencies`; the packaged build loads them from `dist/vendor` (#343). Never add a `dependencies` entry to the extension |

## Restarting a stuck/failed build

```bash
pkill -f "bash build.sh"
sleep 2
pkill -9 -f "bash build.sh" || true
bash scripts/run-build.sh logs/build-$(date +%Y%m%d-%H%M%S).log
```

`run-build.sh`'s reset step makes restart idempotent.

## Post-build verification (mandatory)

After every successful `run-build.sh`, run `bash scripts/verify-branding.sh`.
Non-zero exit blocks release. Covers epic #89 REQ-J1·J2·J3·J4: display name,
bundle id, data folder, and "VSCodium/codium" leakage outside legal
attribution. The script is also the canonical answer to "is this build
ready to publish?" — never `gh release create` from a build that didn't
pass it.

In CI this runs as the "Verify branding + vendored SDK" step in
`build-mac.yml` with `REQUIRE_SDK_VENDOR=1` (added with #349; there is no
`SKIP_DATA_FOLDER` knob — the data-folder check is warn-only and safe
without a launch).

### Vendored Agent SDK JS assertion (SDK-coach builds)

`verify-branding.sh` also asserts that the vendored Agent SDK JS actually
shipped inside the built app (#282 W4b, added after the #343 review). A packaged
build loads `sdk.mjs` through a variable-specifier dynamic import that esbuild
never bundles, so `sdkCoach.loadSdk()` falls back to
`dist/vendor/node_modules` (see `sdkCoachHelpers.ts`
`VENDORED_SDK_ENTRY_SUBPATH`, written by `scripts/inject-builtin-extensions.sh`).
If that vendor tree is missing, the SDK import throws and the coach **silently**
degrades to the proxy-only runtime — a non-canonical, proxy-only ship even on an
SDK release. The check makes that a hard failure. It asserts:

1. `Contents/Resources/app/extensions/hypeproof-chat/dist/vendor/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` exists, and
2. no `claude-agent-sdk-<platform>` (229 MB native binary) package leaked into the shipped vendor tree — those reach students via the W4a seed (`scripts/seed-sdk-binary.sh`), never the app bundle.

**Trigger** (so pre-SDK / pure-vanilla builds never false-fail):

- `REQUIRE_SDK_VENDOR=1` → always assert (explicit CI/release gate for the SDK build).
- Otherwise auto-detect: assert only when the **bundled** extension's
  `package.json` declares the `@anthropic-ai/claude-agent-sdk` dependency —
  in `dependencies` OR `devDependencies` (i.e. this build is an SDK-coach
  build). A vanilla build (no `hypeproof-chat`) or a pre-SDK extension (no
  such dep) is skipped with an informational note.

`build-mac.yml` sets `REQUIRE_SDK_VENDOR=1` on its verify step (#349) so a
build that forgot to vendor the SDK fails the gate rather than shipping
proxy-only.

**Dep placement rule (#349)**: the SDK must stay in the extension's
`devDependencies`, never `dependencies` — the injected copy has no
`node_modules`, and a declared prod dep makes `vscode-min-prepack`'s
`npm list --production` hard-fail the whole build (see failure-mode table).

## Phase-aware behavior

- **Phase 0–1**: vanilla build first. Do not introduce branding overrides yet.
- **Phase 2+**: `hypeproof-studio.env` must be sourced before any `prepare_*` or `build.sh` call.
- **Phase 5**: bundling `hypeproof-chat` as built-in needs the extension folder injected into VS Code source during `prepare_vscode.sh`. Do not add a `product.json.builtInExtensions` entry.

## Adding a new patch

1. Make the change against the unpacked `vscode/` tree.
2. `cd vscode && git diff > ../patches/NN-<topic>.patch` (NN = next free prefix).
3. Verify it applies cleanly: `cd vscode && git apply --check ../patches/NN-<topic>.patch`.
4. Document the patch's purpose in a one-line header comment inside the file.

## Submodule (`vscodium-base`) bump policy

`vscodium-base` is a submodule → `jayleekr/vscodium` `@hps/main`. **Policy: pin + deliberate bump.** The main repo does NOT auto-follow fork HEAD.

Bump the pointer (its own reviewed commit in the main repo) **only when**:
1. An upstream VSCodium sync has been merged into fork `hps/main` **and a build passed**, or
2. A brand/icon/patch/`prepare_vscode.sh`-hook change in the fork is required by a main-repo change.

Rules:
- Day-to-day work (`worker/`, `extensions/`, profiles, scripts) lives in the **main repo** and never bumps the submodule. Most commits leave the pointer untouched — that is expected, not a mistake.
- A bump is a standalone commit: `chore: bump vscodium-base → <short-sha> (<why>)`. Never fold a bump into an unrelated feature commit.
- Never `git add vscodium-base` reflexively. Stage it only when intentionally bumping.
- Reproducibility is the point: builds are 1–2 h; a silent pointer move would change everyone's build.
- Phase 6: `.github/workflows/upstream-sync.yml` automates step 1 — cron merges upstream into the fork, opens a **PR** in this repo bumping the pointer; a human + a green build gate before merge.

## CI (Phase 6)

Windows build runs in GitHub Actions only. Local Windows reproduction is out of scope. The workflow file lives at `.github/workflows/build-windows.yml` (Phase 6 — not yet created).
