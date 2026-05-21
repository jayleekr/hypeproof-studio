---
name: hype-deploy
description: Deploy the HypeProof Studio Worker to Cloudflare production (api.hypeproof-ai.xyz) after PRs have merged to main. Wraps `npx wrangler deploy` with preflight (clean tree · on main · in sync with origin) and post-deploy health verification. Use when worker code, profiles, or system prompts have landed on main and need to reach prod — the deploy-side counterpart of /hype-open-pr.
user_invocable: true
triggers:
  - "hype-deploy"
  - "deploy worker"
  - "deploy prod"
  - "deploy to prod"
  - "push to prod"
  - "prod 배포"
  - "워커 배포"
  - "배포해"
argument_hint: "[issue # to close after deploy, optional]"
---

# hype-deploy

Promote the Worker on `main` to Cloudflare production. The mechanical part —
preflight, deploy, version capture, health smoke — runs through
`scripts/deploy-worker.sh`. This skill adds the judgment a bare script can't:
*should* we deploy right now, and which deploy-tracking issue gets closed.

Repo: `jayleekr/hypeproof-studio`. Prod URL: `https://api.hypeproof-ai.xyz`.

## Preconditions

- On `main`, working tree clean, in sync with `origin/main`. The script
  enforces this — fix locally before retrying. Submodule modified content is
  OK (`vscodium-base` rename residue from `prepare_vscode.sh` is benign).
- The change you want live is **already on `main`** (PR merged). This skill
  does not deploy from feature branches.
- Cloudflare `wrangler login` is active. If not: `cd worker && npx wrangler login`.
- **Workshop awareness**: if a live cohort is currently running (check the
  admin UI at `https://api.hypeproof-ai.xyz/` → active classes), don't deploy
  mid-session unless the change is itself a hotfix for that session.

## Flow

### 1. Confirm there is something to deploy
`git log origin/main...` is meaningless on a clean main — instead, look at
the last few commits and compare to the currently-active version:

```bash
git log --oneline -5
cd worker && npx wrangler deployments status | head -10
```

If the latest active version corresponds to commits older than your intended
deploy target, deploy is needed. Otherwise tell the user: "already at HEAD,
nothing to deploy."

### 2. Run the harness
```
bash scripts/deploy-worker.sh
```
The script will:
1. Enforce preflight (branch + sync + clean tree).
2. Print the last 5 commits and ask for `y/N` confirmation. To skip the
   prompt (e.g. autonomous deploy after a recent merge), pass `FORCE=1`.
3. Run `npx wrangler deploy --env=""` (top-level env — silences wrangler's
   multi-env warning).
4. Tolerate a known side-effect: if `Uploaded hypeproof-studio-api` appears
   but a tail step (cron schedules / workers.dev subdomain) fails, the
   worker code IS live — only schedule registration is skipped. Surface
   this as a warning, not a failure.
5. Hit `/v1/health` on `https://api.hypeproof-ai.xyz` and require
   `"ok":true`.
6. Print a summary block (timestamp · commit · version id · URL · health).

If preflight fails (exit 1), help the user fix the cause (`git pull` /
`git stash` / branch switch) — never bypass with `--force`.

### 3. Close the deploy-tracking issue, if there is one
The repo uses `ops:` issues to track required redeploys (e.g. `#76 ops: prod
worker redeploy needed for PR #74`). After a successful deploy that covers
such an issue:

```bash
gh issue comment <N> --body-file <tmp-comment>
gh issue close <N>
```

Comment body should include: deploy timestamp · version id · which PRs/issues
this deploy now puts live. Use the argument-passed issue number, or ask the
user which open `ops:`/`fix:` issue this resolves.

### 4. Smoke beyond /v1/health (optional, recommended near a workshop)
Public `/v1/health` only confirms the worker boots. To verify the deployed
*content* (e.g. new system prompt is live), have the user open Studio with a
cohort token and start a chat — the first turn reflects the new profile.
Document this as a manual step; don't try to issue a prod token from CLI
unless `HPS_SIGNING_SECRET` is at hand.

## Guardrails

- Never deploy from a feature branch. Always main + in sync with origin.
- Never bypass the preflight (no `--force-deploy`). If the tree is dirty,
  commit or stash; if behind origin, `git pull --ff-only`.
- Never deploy mid-workshop without explicit user confirmation — even a
  "trivial" deploy can disconnect active SSE streams.
- Don't touch secrets from this skill. Secret rotation is its own thing
  (`npx wrangler secret put <KEY>` interactively, never piped from a file).
- The workers.dev-subdomain / cron-schedules error is *non-blocking* for the
  current deploy. Treat it as warning + flag, not a retry trigger. The
  proper fix is dashboard-side (create workers.dev subdomain) and is its own
  ticket.
- One deploy per invocation. If the user asks for "deploy + rollback if X",
  split — deploy first, then check, then decide.
- Communicate in any language; the deploy summary printed by the script is
  English (terse, log-friendly).
