# JY dev review: one-command PR check

Runs a screen-bearing PR branch in the Dev app before merge (PRD UX-05).

## Usage

```bash
bash scripts/review-pr.sh <PR-number-or-branch> [--provider claude|codex|service]
```

- `<PR-number-or-branch>`: GitHub PR number (e.g. `1302`) or branch name
- `--provider`: how the Dev app connects to its AI backend
  - `service` (default): routes through the local wrangler server on port 8787
  - `claude`: uses your local Claude Code subscription
  - `codex`: uses your local Codex subscription

## What it does

| Step | Action | Typical time |
|---|---|---|
| 1 | Fetch and check out the PR branch in a temp worktree | ~3s |
| 2 | `npm ci` for extension + webview-ui | ~3–60s (cold/warm) |
| 3 | Generate a random local `.dev.vars`, init D1, start `wrangler dev --port 8787` | ~25s cold |
| 4 | Issue a local test instructor token; copy to clipboard | <1s |
| 5 | `studio-dev.py run` — build extension, patch base app, launch Dev app | ~15–30s |
| 6 | Print in-app instructions | — |

Press **Ctrl+C** to stop the app, server, and remove the worktree.

## Prerequisites

- `/Applications/HypeProof Studio.app` installed (base app)
- `node`, `npm`, `npx wrangler`, `python3` in PATH
- `gh` logged in (for PR-number mode)

## Security notes

- Uses a freshly generated random signing secret every run — never copies or symlinks the production `.dev.vars`.
- Refuses to start if port 8787 is already occupied (prints the holder PID).
- Refuses to start if a production URL (`hypeproof-ai.xyz`) is detected in environment.

## Troubleshooting

| Problem | Fix |
|---|---|
| `port 8787 already in use` | Kill the listed PID or close the other session |
| `profile not permitted` in app | Auto-detected profile may not match the PR's cohort; check `worker/src/profiles/` manually |
| `Dependencies missing` from studio-dev.py | `npm ci` failed silently; re-run script |
| Token not in clipboard | Token is printed to stdout; copy it manually |
