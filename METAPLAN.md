# HypeProof Studio — Solo Build Metaplan

> **Owner:** Jay (solo) · **Target:** SK바이오팜 1회차 (June 2026)
> **Philosophy (drives UX):** [docs/seven-assets.md](./docs/seven-assets.md) — 7 AI Native Assets; chat-panel features follow the §4.5 map.
> **Strategic plan:** [hypeproof-studio-plan.md](../hypeproof/.claude/worktrees/curriculum/products/ai-architect-academy/internal/hypeproof-studio-plan.md)

This is the phase map and decision gates. Mechanics live elsewhere — build in
[.claude/rules/build-pipeline.md](.claude/rules/build-pipeline.md), contributor
flow in [CONTRIBUTING.md](./CONTRIBUTING.md). Cross-reference sections by §N.

---

## 0. Working Mode

- Jay solo. **Mac arm64 is the only local target.**
- **Windows is scaffolding only** — CI builds it (Phase 6); never built locally.
- Apple Developer / signing admin = deferred to Phase 7.
- All asset changes resolved inside this repo.

---

## Phase 0. Environment

**Goal:** a Mac that can build VSCodium. **Gate:** Node 22.22.1, Python 3.11,
≥60 GB free → Phase 1. (Setup details: CONTRIBUTING.md "Environment setup".)

## Phase 1. First build — vanilla VSCodium

**Goal:** an untouched VSCodium.app builds and runs on Mac; trust the pipeline.
**Gate:** `VSCodium.app` launches normally → Phase 2. Build fails after ~3 h
debugging → **Plan B (§9)**.

## Phase 2. Brand asset swap

**Goal:** zero visible "VSCodium" outside the legal About attribution.

- Env overrides via `hypeproof-studio.env` (APP_NAME, BINARY_NAME, repo paths…).
- One logo SVG → `icons/stable/codium_{cnl,cnl_w80_b8,clt}.svg`, then
  `bash icons/build_icons.sh` regenerates every platform asset.
- Other assets per the §8 checklist.
- `product.json` keys overridden via jq inside `prepare_vscode.sh`
  (nameShort/Long, applicationName, dataFolderName, darwinBundleIdentifier
  `ai.hypeproof.studio`, urlProtocol, win32 series).
- Welcome/About: `announcements-extra.json` + About keeps VSCodium/VS Code (MIT).

**Gate:** builds as **HypeProof Studio.app**; title/dock/menu all branded;
About shows attribution → Phase 3.

## Phase 3. Second build — brand verification

**Goal:** every changed asset reaches the build.
**Gate:** no "VSCodium" anywhere (except About attribution); data folder
`~/Library/Application Support/HypeProof-Studio/` → Phase 4.

## Phase 4. Chat panel scaffold

**Goal:** a React-webview VS Code extension at `extensions/hypeproof-chat/`
(own extension, later bundled built-in). Chat UI + streaming + Proxy fetch +
workshop-token input + history.

**Gate:** open panel → message → Proxy round-trip streams back; **all 7 AI
Native Assets have at least one MVP panel affordance from §4.5** → Phase 5.

## 4.5. AI Native Asset → Chat Panel UX map

> Source: [docs/seven-assets.md](./docs/seven-assets.md). Chat-panel features
> are added/removed against this table. **MVP ✅** = required for the Phase 4
> debut; the rest are Phase 5+ / v0.2.

| Asset | Panel UX | MVP |
|---|---|---|
| Taste | welcome copy, preview auto-reveal, generated artifact save path | ✅ |
| Intent clarity | empty-prompt block, good-vs-weak chips, short-input roll prompt | ✅ |
| Context design | role/profile-driven system prompt, cohort examples, token-bound profile fetch | ✅ |
| Verification reflex | verdict prompts, source/citation chips, report-problem path with request id | ✅ |
| Delegation judgment | manual-approve modal, hard-deny shell execution, scoped file-write approval | ✅ |
| Iteration reflex | retry / think-again affordance, retry counter hooks, quick V1-first-shot flow | ✅ |
| Ownership | named coach, workspace `index.html` save, update/install continuity | ✅ |

**MVP coverage (Phase 4 debut):** all 7 assets have at least one panel affordance.
Per-cohort profiles choose emphasis with `assets_focus`; the deprecated
`essences_focus` array remains only as a v0.1 compatibility bridge.

## Phase 5. Chat panel + build integration

**Goal:** the panel ships pre-installed in HypeProof Studio.app — inject
`extensions/hypeproof-chat/` into VS Code source during `prepare_vscode.sh`,
register as built-in, add the manual-approve modal + game-preview panel.
**Gate:** built .app launches with the panel active + Proxy OK → Phase 6.

## Phase 6. Windows scaffolding

**Goal:** Win is *buildable in CI only*. `.github/workflows/build-windows.yml`
(matrix), `docs/HOW-TO-BUILD-WIN.md`, stub signing.
**Gate:** GitHub Actions produces a downloadable .exe artifact → Phase 7.

## Phase 7. Release v0.1.0

**Goal:** distributable to SK바이오팜 families. GitHub Release (.app/.exe),
one-line installers, 1-page install guide, 6-person staff dogfood, child
dry-run. **Gate:** 6 staff installs + 4 h dogfood pass → 1회차 GO.

---

## 8. Asset-change checklist (Phase 2 aid)

| File | → change |
|---|---|
| `utils.sh` | APP_NAME via env override |
| `icons/stable/codium_cnl.svg` | HypeProof logo |
| `icons/stable/codium_cnl_w80_b8.svg` | HypeProof logo (80w/8b) |
| `icons/stable/codium_clt.svg` | HypeProof CLI icon |
| `icons/corner_512.png` | HypeProof corner watermark |
| `icons/template_macos.png` | HypeProof Mac dock template |
| `src/stable/resources/server/code-{192,512}.png`, `favicon.ico` | HypeProof |
| `src/stable/resources/linux/code.png` | HypeProof |
| `announcements-extra.json` | HypeProof first welcome |
| `product.json` (build-time jq override) | HypeProof keys |

One HypeProof logo SVG is enough — `build_icons.sh` generates the rest.

---

## 9. Plan B (if Phase 3 not green by 2026-05-28)

- 1회차 (June): Cline + Proxy + one-line installer.
- HypeProof Studio v0.1: formal debut in July (2회차).
- Detail: [strategic plan](../hypeproof/.claude/worktrees/curriculum/products/ai-architect-academy/internal/hypeproof-studio-plan.md) §6.

---

## 10. Progress tracking

Phases 0–3 done; **Phase 4–5 in progress** (chat panel + integrated build, UX
iteration). Latest detail: see git history / `STATUS-*` if present.
Phases 6–7 not started.

---

## 11. Open decisions

- [ ] Repo public vs private (affects free Win-signing path).
- [ ] Apple Developer enrolment timing (Phase 7-1 is fine).
- [ ] Chat-panel name ("HypeProof Chat" vs separate brand).
- [ ] Workshop-token issuance (1회차 manual; automate next).
- [ ] Use Cline source as Phase 4 design inspiration.
