# HypeProof Studio — Solo Build Metaplan

> **Owner:** Jay (solo) · **Target:** SK바이오팜 1회차 (June 2026)
> **Philosophy (drives UX):** [docs/essence-v0.1.md](./docs/essence-v0.1.md) — 16 Essences; chat-panel features follow the §4.5 map.
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

**Gate:** open panel → message → Proxy round-trip streams back; **≥8 MVP
essences from §4.5 reflected** → Phase 5.

## 4.5. Essence → Chat Panel UX map

> Source: [docs/essence-v0.1.md](./docs/essence-v0.1.md). Chat-panel features
> are added/removed against this table. **MVP ✅** = required for the Phase 4
> debut; the rest are Phase 5+ / v0.2.

| # | Essence | Panel UX | MVP |
|---|---------|----------|-----|
| 1 | 천 번째도 첫 번째처럼 감탄 | welcome copy + "왜 신기한가" slot | — |
| 2 | 전심전력으로 임하기 | empty-prompt block + resolution hint | ✅ |
| 3 | 부하 걸기 | "더 무겁게 물어보기" preset | ✅ |
| 4 | 만족 유예, 추궁 | "한 번 더 (n)" + meaning-loss warning | ✅ |
| 5 | 역할 몰입과 관점 부여 | role presets + system-prompt library | ✅ |
| 6 | 잇기 — 가설 세우기 | hypothesis-tree review (Phase 5) | — |
| 7 | 질문으로 공터 만들기 | "되물어주세요" — model asks first | ✅ |
| 8 | 입력 먼저 굴리기 | quick-iterate seed mode (Phase 5) | — |
| 9 | 백 번 뽑아보기 | variation runner + compare grid | — |
| 10 | 다중 모델 조율 | model selector + cross-critique | ✅ toggle / P5 critique |
| 11 | 역목표 설계 | "실패시키는 길" red-team preset | — |
| 12 | 수행과 위임의 역전 | scaffold mode (Phase 5+) | — |
| 13 | 추상의 사다리 | metaprompt builder (v0.2) | — |
| 14 | 언러닝 | "검증된 전략 다시 의심" on model switch | — |
| 15 | 상상하기 | deliberate response delay toggle | — |
| 16 | 소격하기 | manual-approve modal *is* the kick + CoT always-on | ✅ |

**MVP coverage (Phase 4 debut, 8):** 2, 3, 4, 5, 7, 10 (toggle), 16
(manual-approve + CoT), and 1 (welcome copy).

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
