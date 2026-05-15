# HypeProof Studio

A VSCodium fork rebranded as **HypeProof Studio** — an IDE built to teach the
**16 Essences**: the human capabilities needed when working with AI models.

> **Target:** SK바이오팜 첫 회차 (1회차) — June 2026
> **Mode:** solo build, Mac arm64 primary, Windows via CI only
> **Status source of truth:** [METAPLAN.md](./METAPLAN.md) §10

Every UX decision in the chat panel, welcome flow, manual-approve modals, and
onboarding serves one or more of the 16 Essences. Product philosophy lives in
[docs/essence-v0.1.md](./docs/essence-v0.1.md) — do not fork or paraphrase it.

## Current phase

**Phase 4–5 — chat panel + integrated build, UX iteration in progress.**

Per-cohort profile system live; Worker + Studio extension wired through
`/v1/profile`. 1회차 (`sk-biopharm-kids-s1`) profile fully populated. 13 e2e
tests + 9 Worker smoke tests passing locally against `wrangler dev`.

Latest detailed snapshot: [STATUS-2026-05-15-overnight.md](./STATUS-2026-05-15-overnight.md).

Next milestones: Cloudflare production deploy · GitHub Pages publish wizard ·
live-preview extension · 2회차–4회차 profile content.

## Repo layout

| Path | What |
|---|---|
| `vscodium-base/` | **Submodule** → [`jayleekr/vscodium`](https://github.com/jayleekr/vscodium) `@hps/main` (VSCodium fork w/ HPS brand assets + product hook). Do not edit upstream files directly — add a patch under `vscodium-base/patches/`. |
| `extensions/hypeproof-chat/` | Own VS Code extension (React webview). Bundled as a built-in extension at Phase 5. |
| `worker/` | Cloudflare Worker — OpenAI-compatible HypeProof Proxy, per-cohort profiles, token auth. Production target. |
| `proxy-poc/` | Python proxy used for early dev iteration (superseded by `worker/`). |
| `scripts/` | Build wrappers — `run-build.sh`, `inject-builtin-extensions.sh`, `generate-platform-icons.sh`, `verify-branding.sh`, `dev-stack.sh`. |
| `e2e/` | Playwright end-to-end tests (drive the built `.app`). |
| `docs/` | INSTALL, RELEASE-CHECKLIST, COHORT-AUTHORING, essence-v0.1, build/release guides. |
| `.github/workflows/` | `build-windows.yml` (Phase 6); `upstream-sync.yml` + `release.yml` (placeholders). |
| `METAPLAN.md` | Phased build plan — the source of truth. Cross-reference by section (§N). |

## Clone

```bash
git clone --recursive git@github.com:jayleekr/hypeproof-studio.git
# already cloned without --recursive:
git submodule update --init
```

## Local dev stack

```bash
cp hypeproof-studio.env.example hypeproof-studio.env   # then fill in secrets
bash scripts/dev-stack.sh                              # wrangler dev + roster + token
cd e2e && npm test                                     # 13 e2e tests
```

Worker dev runs at `http://localhost:8787` (admin UI at `/`). See
[STATUS-2026-05-15-overnight.md](./STATUS-2026-05-15-overnight.md) for the live
pickup point.

## Build (Mac arm64)

A full build is **1–2 hours** and writes **10–20 GB**. Do not run it casually.

```bash
cd vscodium-base
source ../hypeproof-studio.env        # APP_NAME, BINARY_NAME, … (overrides utils.sh)
bash get_repo.sh
bash prepare_src.sh                   # downloads VS Code source (~500 MB)
bash prepare_vscode.sh                # patches + product.json overrides
# canonical entry point (idempotent restart):
bash ../scripts/run-build.sh ../logs/build-$(date +%Y%m%d-%H%M%S).log
```

Output: `vscodium-base/VSCode-darwin-arm64/HypeProof Studio.app`.

Detailed rules:
[.claude/rules/build-pipeline.md](.claude/rules/build-pipeline.md) ·
[.claude/rules/branding-swap.md](.claude/rules/branding-swap.md) ·
[.claude/rules/extension-dev.md](.claude/rules/extension-dev.md).

## Upstream sync model

VSCodium updates flow: `VSCodium/vscodium` → `jayleekr/vscodium` (fork,
`hps/main` branch carries our brand patches) → submodule pointer bump in this
repo → tagged HypeProof Studio release. Automation lands in Phase 6
(`.github/workflows/upstream-sync.yml`, `release.yml`).

## License

VSCodium and VS Code are MIT-licensed. Attribution to VS Code and VSCodium
**must remain** in the About dialog — do not strip it.
