# Contributing to HypeProof Studio

This project is built by a small team during live workshops. Most contributions
start the same way: **you are using the Studio, and you notice something** — a
feature that's missing, an interaction that feels wrong, or a bug.

Capture it while it's fresh. Don't save it for later — file it from where you are.

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

## Code contributions

If you're changing code, not just reporting:

- Read [CLAUDE.md](./CLAUDE.md) and the rules under
  [.claude/rules/](.claude/rules/) first — especially the build pipeline and the
  `vscodium-base` submodule bump policy (pinned; don't auto-follow).
- Day-to-day work is in `worker/`, `extensions/hypeproof-chat/`, `scripts/`. It
  never bumps the submodule.
- Chat-panel features must cite the Essence(s) they serve in the PR.
- English for code, comments, commits, and docs. Converse in any language.
