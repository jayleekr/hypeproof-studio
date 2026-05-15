# Contributing to HypeProof Studio

This project is built by a small team during live workshops. Most contributions
start the same way: **you are using the Studio, and you notice something** — a
feature that's missing, an interaction that feels wrong, or a bug.

Capture it while it's fresh. Don't save it for later — file it from where you are.

## Your first contribution, end to end

The whole arc, in order. Each step links to its detailed section.

| # | Phase | Command (macOS) | Section |
|---|---|---|---|
| 1 | Clone (with submodule) | `git clone --recursive …` | [Environment setup](#environment-setup-contributors-who-build--dev) |
| 2 | Install environment | `brew … && nvm … && gh auth login` | [Environment setup](#environment-setup-contributors-who-build--dev) |
| 3 | Build the app (once, 1–2 h) | `bash scripts/run-build.sh …` | [Build the app](#build-the-app) |
| 4 | Run + test | `scripts/dev-stack.sh`, `npm test` | [Run & test](#run--test) |
| 5 | Use the Studio, notice something | — | [The fast path](#the-fast-path-report-ui) |
| 6 | File the issue | `/report-ui` | [The fast path](#the-fast-path-report-ui) |
| 7 | Fix the code → PR | `git switch -c fix/issue-N-…` | [Contributing code](#contributing-code-issue--pr) |

Steps 1–4 are one-time setup. Day to day you live in steps 5–7. You do **not**
need to rebuild the app for worker/extension changes — only for a fresh clone or
a `vscodium-base` change (see [Build the app](#build-the-app)).

## The fast path: `/report-ui`

From a terminal in the repo, run the Claude Code skill:

```
/report-ui
```

It walks you through it:

1. **Type** — feature proposal, UX suggestion, or bug.
2. **Narrative** — a few questions in your language. Be concrete.
3. **Screenshot** — either your *actual* Studio window (you click it) or a clean
   Playwright reproduction. You can skip it.
4. It files a GitHub issue with your narrative, a **full environment snapshot**,
   the screenshot, and the labels a downstream fixer needs.

You get back an issue URL. That's it.

> Why a skill and not just the web form? The skill stamps the exact app build,
> submodule commit, worker state, and OS into the issue automatically. That
> snapshot is what lets a later solver skill fix it without guessing.

### Platform support

| You are on | `/report-ui` skill | How to report |
|---|---|---|
| **macOS** | ✅ Full (live-window or Playwright screenshot) | Run `/report-ui` |
| **Windows / Linux** | ❌ Skill is macOS-only | Use the [web issue forms](#manual-fallback) and attach a screenshot manually |

This is intentional: local build & dev is **macOS arm64 only** (see
[METAPLAN.md](./METAPLAN.md) §0 — Windows ships from CI, not local). Windows
workshop participants don't have the repo; they report via the web form. The
env collector still emits valid (degraded) JSON on any OS, and the web forms
work everywhere.

## Issue types

| Type | When | Label |
|---|---|---|
| Feature proposal | A capability the Studio doesn't have | `type:feature` |
| UX suggestion | An existing interaction should work differently | `type:ux` |
| Bug | Something broke or behaved wrong | `type:bug` |

Every feature/UX idea must serve at least one of the **16 Essences**
([docs/essence-v0.1.md](./docs/essence-v0.1.md)). If it serves none, it is
probably noise — say so honestly in the issue and it can still be discussed.

## Manual fallback

No terminal handy? Open an issue on GitHub and pick a form
([feature](.github/ISSUE_TEMPLATE/feature_request.yml) ·
[ux](.github/ISSUE_TEMPLATE/ux_suggestion.yml) ·
[bug](.github/ISSUE_TEMPLATE/bug_report.yml)). For the Environment field, run:

```bash
bash scripts/collect-studio-env.sh
```

and paste the JSON. Drag your screenshot into the issue.

## What happens next

Issues labelled `solver:ready` are structured for a downstream solving skill
(see [.claude/skills/report-ui/references/solver-contract.md](.claude/skills/report-ui/references/solver-contract.md)).
A solver — human or skill — picks it up, opens `fix/issue-<N>-<slug>`, and the
merged PR closes the issue. Screenshots live on the orphan `contrib-evidence`
branch, never on `main`.

## Environment setup (contributors who build / dev)

Local build and dev are **macOS arm64 only**. One-time setup:

```bash
# 1. Toolchain
brew install nvm jq imagemagick librsvg
nvm install 22.22.1 && nvm use 22.22.1        # build + worker pin Node 22
xcode-select --install                         # if not already present

# 2. Repo (submodule is required)
git clone --recursive git@github.com:jayleekr/hypeproof-studio.git
cd hypeproof-studio
# cloned without --recursive? → git submodule update --init

# 3. GitHub CLI (the /report-ui skill needs it)
brew install gh && gh auth login               # needs 'repo' scope

# 4. Secrets — never commit these
cp hypeproof-studio.env.example hypeproof-studio.env   # fill in if building
cat > worker/.dev.vars <<'EOF'
ANTHROPIC_API_KEY=...        # ask Jay; or reuse SNT_CLAUDE_API_KEY from ~/.env
HPS_SIGNING_SECRET=...       # any strong random string (shared per cohort)
HPS_ADMIN_PASSWORD=dev       # local admin UI password
EOF

```

That covers steps 1–2 of the journey. Next: build, then test.

### Build the app

You need a built `.app` for the Playwright screenshot path of `/report-ui`,
for the full e2e suite, and to see UI changes in the real shell. You do **not**
need it for worker or extension-logic iteration (those hot-reload / rebuild on
their own — see [Contributing code](#contributing-code-issue--pr)).

A full build is **1–2 h** and writes **10–20 GB**. Run it once after cloning:

```bash
cd vscodium-base
source ../hypeproof-studio.env
bash get_repo.sh && bash prepare_src.sh && bash prepare_vscode.sh
bash ../scripts/run-build.sh ../logs/build-$(date +%Y%m%d-%H%M%S).log
```

Verify it built:

```bash
ls "vscodium-base/VSCode-darwin-arm64/HypeProof Studio.app"
open "vscodium-base/VSCode-darwin-arm64/HypeProof Studio.app"   # smoke
```

Same procedure with failure modes and the **submodule bump policy** (pinned —
do not auto-follow): [.claude/rules/build-pipeline.md](.claude/rules/build-pipeline.md).
Also summarised in the README's
[Build from source](./README.md#build-from-source-macos-arm64) section.

### Run & test

Three test layers — run the one(s) your change touches before opening a PR:

```bash
# 1. Local stack (wrangler dev + roster + token at /tmp/hps-token.txt)
bash scripts/dev-stack.sh

# 2. Worker unit/smoke (9 tests) + typecheck — needs the stack NOT required
cd worker && npm test && npm run typecheck

# 3. End-to-end (13 tests) — needs the built .app AND dev-stack running
cd e2e && npm install && npx playwright install chromium && npm test
```

If e2e fails at preflight it tells you which of `.app` / wrangler / token is
missing — fix that and re-run.

## Contributing code (issue → PR)

Code lands through pull requests. **Policy: PR-first, review optional** — open a
PR for every change to `main`; a second pair of eyes is encouraged but not
required to merge. Direct pushes to `main` are reserved for the maintainer
(Jay).

> Enforcement note: GitHub branch protection / rulesets require a paid plan on
> private repos, so this is not a server-side block. It's enforced by two soft
> layers: a local `pre-push` guard (below) and a **CI guard**
> (`.github/workflows/main-guard.yml`) that turns any non-PR push to `main`
> into a red ❌ build. Maintainer pushes (`jayleekr`) and commits marked
> `[skip-main-guard]` pass.

Flow:

1. **Have an issue.** File one with `/report-ui` first if it doesn't exist —
   the env snapshot helps whoever (you or a solver skill) fixes it.
2. **Branch** off `main`: `fix/issue-<N>-<slug>` (bug) or
   `feat/issue-<N>-<slug>` (feature). The slug matches the issue's
   `HPS-SOLVER` marker when filed via the skill.
3. **Change + verify locally** (no app rebuild needed; never bumps the
   `vscodium-base` submodule):
   - **Worker** (`worker/`): `wrangler dev` hot-reloads. Verify with
     `cd worker && npm test && npm run typecheck`.
   - **Extension** (`extensions/hypeproof-chat/`): `npm run build` (or
     `npm run watch:extension` / `watch:webview`), then reload the Extension
     Development Host. Re-run the relevant `e2e/` spec for UI changes.
   - Run the matching [Run & test](#run--test) layer before pushing.
4. **Open the PR.** Put `Closes #<N>` in the body so the merge auto-closes the
   issue. Chat-panel features must cite the Essence(s) they serve.
5. **Merge** once green (squash or merge; keep history sane). Delete the branch.

Enable the shipped guard so you can't push to `main` by accident:

```bash
git config core.hooksPath .githooks
```

(The maintainer overrides it with `HPS_ALLOW_MAIN_PUSH=1 git push` when needed.)

- Read [CLAUDE.md](./CLAUDE.md) and [.claude/rules/](.claude/rules/) before your
  first change.
- English for code, comments, commits, and docs. Converse in any language.

The team is listed in [CONTRIBUTORS.md](./CONTRIBUTORS.md) — add a row when a
new collaborator is invited.
