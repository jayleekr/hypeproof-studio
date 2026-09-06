# HypeProof Studio

VSCodium fork rebranded as **HypeProof Studio**. Target: SK바이오팜 첫 회차 (June 2026).
Strategic + phase plan: see [METAPLAN.md](./METAPLAN.md). Do not duplicate it here.

## Product philosophy (READ BEFORE DESIGNING UX)

This IDE exists to teach the **7 AI Native Assets** — the human capabilities needed when working with AI models. Every UX decision in the chat panel, welcome flow, manual-approve modals, and onboarding must serve one or more of these assets.

- Source of truth: [docs/seven-assets.md](./docs/seven-assets.md) — do **not** fork or paraphrase elsewhere
- UX mapping: METAPLAN §4.5 (asset → concrete chat-panel feature)
- Behavioral contract: [docs/studio-requirements.md](./docs/studio-requirements.md) — REQ-### rows across Studio behavior domains, with test-layer assignments. PR touching Studio behavior must update this doc.
- Autonomy policy: [docs/AUTONOMY-MANDATE.md](./docs/AUTONOMY-MANDATE.md) — proceed/notify/confirm rules for workshop-risk work
- When adding a new chat-panel feature: cite which asset(s) it embodies in the PR/commit. If you cannot, the feature is probably noise

## Current phase

**Phase 4–5 (chat panel + integrated build) — UX iteration in progress.** Per-cohort profile system live, Worker (`worker/`) + Studio extension (`extensions/hypeproof-chat/`) wired through `/v1/profile`. 1회차 (sk-biopharm-kids-s1) profile fully populated; 13 e2e tests passing locally against `wrangler dev`.

Next milestones:
- Cloudflare production deploy (`worker/DEPLOY.md`)
- GitHub Pages publish wizard (Device Flow OAuth) — separate sprint
- Live preview extension (`hypeproof-preview`) — separate sprint
- 2회차–4회차 profile content

Progress tracking: METAPLAN §10. Latest detail: git history.

## Repo layout

- `vscodium-base/` — **submodule** → `jayleekr/vscodium@hps/main`. **Do not edit upstream files directly**; add a patch under `vscodium-base/patches/`. Pointer is pinned — bump deliberately only, never auto-follow. Policy: [.claude/rules/build-pipeline.md](.claude/rules/build-pipeline.md) "Submodule bump policy".
- `extensions/hypeproof-chat/` — own VS Code extension (React webview). Will be bundled as a built-in extension at Phase 5.
- `proxy-poc/` — HypeProof Proxy (OpenAI-compatible). Extension talks to this.
- `METAPLAN.md` — phased build plan. Always cross-reference by section (§N) rather than copying.

## Hard rules

- **YOU MUST NOT** run `bash build.sh` without explicit user approval. A full build is 1–2 hours and consumes 10–20 GB. Confirm disk + intent first.
- **YOU MUST NOT** run Windows-specific commands locally. Win builds happen in GitHub Actions only (Phase 6). Mac arm64 is the only local target.
- **YOU MUST NOT** edit files under `vscodium-base/vscode/` or `vscodium-base/VSCode-*/` directly — these are upstream/build artifacts. All changes go through `vscodium-base/patches/*.patch` or the `prepare_vscode.sh` jq edits.
- **YOU MUST NOT** put secrets (Workshop tokens, Apple Developer ID, signing certs) in any tracked file. `.env` only, gitignored.

## Build & branding (Mac)

```bash
cd vscodium-base
source ../hypeproof-studio.env   # APP_NAME, BINARY_NAME, etc. — overrides utils.sh defaults
bash get_repo.sh                 # fetch upstream commit hash
bash prepare_src.sh              # download VS Code source (~500 MB)
bash prepare_vscode.sh           # apply patches + product.json overrides
bash build.sh                    # 1–2 h build → VSCode-darwin-arm64/HypeProof Studio.app
```

Required env vars (defaults in `utils.sh` are VSCodium — must override):
`APP_NAME`, `APP_NAME_LC`, `BINARY_NAME`, `ASSETS_REPOSITORY`, `GH_REPO_PATH`, `ORG_NAME`.

Memory: `export NODE_OPTIONS="--max-old-space-size=12288"` before build.

## Branding swap

Single SVG → all platforms. Edit `vscodium-base/icons/stable/codium_cnl.svg` (+ `codium_cnl_w80_b8.svg`, `codium_clt.svg`) then run `bash icons/build_icons.sh`. Full file list in METAPLAN §8.

## Decision gates

Each phase has a gate in METAPLAN. Do not proceed past a gate without confirming the listed criteria. Plan B (Cline + Proxy fallback) remains available as a fallback decision — see METAPLAN §9 for its criteria. It is not tied to a fixed date; evaluate it against the current phase gate.

## Cross-tool development entry point

[AGENTS.md](./AGENTS.md) indexes the shared conventions and scoped instructions.
For Chalk authoring, follow its linked requirement and test documents; keep
existing philosophy, autonomy, and verification rules in their canonical files.

## Detailed rules

- [.claude/rules/build-pipeline.md](.claude/rules/build-pipeline.md) — build failure modes, env vars, jq patterns
- [.claude/rules/branding-swap.md](.claude/rules/branding-swap.md) — asset replacement checklist
- [.claude/rules/extension-dev.md](.claude/rules/extension-dev.md) — hypeproof-chat React webview
- [.claude/rules/verification.md](.claude/rules/verification.md) — 관측 규율. **판정 기준을 세우기 전에 대상을 열어본다** · 대조군 먼저 · CI 초록은 아무것도 보장하지 않는다
- [e2e/observe/README.md](e2e/observe/README.md) — 실사용 관측 도구. 큐시트는 강사가 채팅으로 몰고, 이건 그동안 무슨 일이 일어났는지 보는 용도
- [docs/seven-assets.md](docs/seven-assets.md) — 7 AI Native Assets (canonical product philosophy, drives chat-panel UX)
