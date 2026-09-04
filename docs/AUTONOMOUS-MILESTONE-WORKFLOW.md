# Autonomous Milestone Workflow

Status: active draft  
Owner: Jay  
Parent: GitHub issue #230

This workflow turns the HypeProof Studio timeline into an autonomous operating
loop. It is deliberately built around the existing repo sources of truth:

- `METAPLAN.md` — phase and release gates
- `docs/AUTONOMY-MANDATE.md` — autonomy boundary and human gates
- GitHub issues/PRs — executable backlog and evidence trail

## Loop

1. **Audit**
   - Run `node scripts/milestone-audit.mjs --mode audit --dry-run`.
   - The script writes `milestone-audit.json` with stable task candidates.
   - Each generated task has an idempotency marker:
     `<!-- hps:auto-task:<stable-id> -->`.

2. **Generate or update tasks**
   - Run `node scripts/milestone-audit.mjs --mode issue --max-create 10`.
   - Low/medium risk tasks get `autonomy:ready`.
   - Human-gated tasks get `autonomy:blocked-human` and must not be executed
     until the blocking decision is explicitly approved.

3. **Execute**
   - For small code/docs/test work, use the issue -> branch -> tests -> PR flow.
   - CI **cannot** route issues to the Claude Solver. A human applies
     `solver:ready` or mentions `@claude`; see "Removed: autonomous-task-runner"
     below for why, and do not rebuild the CI path without reading it.
   - Interactive execution should use the `/goal` prompt below.
   - Runtime changes that affect the Worker, API, release artifacts, or shipped
     extension must include the relevant dispatch-only dry-run first and, when
     that passes and no human gate applies, production deploy or release mirror
     execution.

4. **Verify and close the loop**
   - Every task ends with targeted tests, a PR or explicit blocked comment, and
     an issue update.
   - Worker deploys run `deploy-worker.yml` with `dry_run=false` and
     `verify_prod=true`, then run `scripts/verify-prod.sh` after deploy.
   - Release/mirror work verifies installer resolution against the mirror repo.
   - If production deploy is intentionally skipped, the issue/PR must say why:
     docs-only, workflow-only, human-gated, missing secret, or unsafe state.

## Human Gates

Automation must stop and label/comment instead of mutating when the task touches:

- secrets, billing, GitHub/Cloudflare access policy, or admin identities
- participant chat body logging, retention, deletion, consent, or privacy
- destructive D1/R2/KV operations
- irreversible production state changes

These gates come from `docs/AUTONOMY-MANDATE.md` and override all workflow
defaults.

## `/goal` Prompts

### Implementation prompt

```text
/goal Implement the HypeProof Studio autonomous milestone ops workflow. Use METAPLAN.md as the phase/gate source, docs/AUTONOMY-MANDATE.md as the autonomy boundary, and GitHub issues as the backlog source. Add milestone audit/task generation scripts, GitHub Actions workflows for audit/task execution/release mirror/worker deploy, tests, and docs. Preserve human gates for secrets, billing/access policy, privacy/data retention, and irreversible production changes. Work issue→branch→tests→PR→merge.
```

When the implementation changes Worker/API runtime behavior, shipped extension
behavior, installer artifacts, or release distribution, the goal run must also:

1. run the relevant dispatch-only dry-run workflow first;
2. merge only after tests and dry-run evidence pass;
3. run the production deploy or release mirror workflow when no human gate
   applies;
4. run production smoke verification after deploy; and
5. comment the deploy URL/run id, smoke result, and any skipped deploy reason on
   the issue.

### Operating prompt

```text
/goal Run one autonomous HypeProof Studio milestone cycle. Audit METAPLAN phases and open GitHub epics, create or update missing task issues with stable hps:auto-task markers, classify risk using AUTONOMY-MANDATE, execute eligible low-risk tasks through issue→branch→tests→PR→merge, run relevant dry-run workflows, and for runtime/release-distribution changes that pass dry-run and are not human-gated, run the production deploy or release mirror workflow and production smoke verification. Leave issue comments for every completed, deployed, skipped-deploy, blocked, or human-gated item with run ids and evidence. Do not change secrets, billing/access policy, participant data retention, or irreversible production state without explicit approval.
```

## CI Entry Points

- `milestone-audit.yml`: scheduled/dispatch audit and optional task creation.
- `mirror-release.yml`: dispatch-only release mirror sync to
  `jayleekr/hypeproof-studio-releases`.
- `deploy-worker.yml`: dispatch-only Worker deploy with test and prod smoke.

Keep deploy and mirror workflows dispatch-only until at least one successful
operator dry-run is recorded in the relevant issue.

## Removed: `autonomous-task-runner.yml` (2026-09-04)

Deleted. This section exists so it is not rebuilt in six months. Read all of
it, including the parts that argue against the deletion.

### The mechanical reason the `solver` mode could never work

GitHub does not raise workflow-triggering events for writes made with
`secrets.GITHUB_TOKEN`. This is a platform anti-recursion rule, not a bug and
not something a permissions change fixes.

The router's `solver` mode did exactly two things: add the `solver:ready`
label and post a comment, both via `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.
`claude-solver.yml` listens on `issues: [labeled]` and
`issue_comment: [created]`. Both of the router's writes were therefore
suppressed at the source. The handoff was impossible from the day it was
written.

Empirically confirmed before deleting: across the last 100 `claude-solver`
runs the triggering actor was a human in every single case (jayleekr 44,
J3llyBe4n 28, ico1036 11, +4 others). Zero runs by `github-actions[bot]`.
The router never started the solver, not once.

### The green run that hid it

`autonomous-task-runner.yml` was invoked **once, ever**: 2026-06-04T10:15Z,
`workflow_dispatch` by jayleekr, conclusion `success`. That success is why
nobody looked. The routing step labelled the issue, posted "Routed to Claude
Solver", and exited 0 — and nothing downstream started. A workflow can only
observe that its own `gh` calls returned 0; it cannot observe that the event
it intended to raise was swallowed. Treat "the routing workflow is green" as
evidence of nothing.

### What the deletion also took away — the honest cost

Two of the three modes were **not** broken, and deleting the file removed
them too:

- `goal-comment` posted a ready-to-paste `/goal` prompt for a human to read.
  It deliberately contained no `@claude`, so it was never meant to trigger
  anything, and it worked as designed.
- `verify-only` was a `jq` summary of the issue's state and labels. No event
  dependency at all. It worked as designed.

Only `solver` — the one mode whose entire purpose was an unattended handoff —
was the broken one. The file was deleted whole rather than reduced to its two
working modes because the whole thing had been dispatched once in three
months; a two-mode convenience wrapper around `gh issue view` and
`gh issue comment` was not worth a workflow file. **If either of those is
wanted back, they are cheap and correct to rebuild.** That is not the part
being warned against.

### What must not be rebuilt without solving this first

The `solver` mode. Naively re-adding it — or "fixing" it by giving
`claude-solver.yml` a `workflow_dispatch` trigger — does not work either:
`claude-solver.yml`'s `authorize` job reads `context.payload.sender.login`
and requires that login to have write permission. That guard is what stops a
mass-labeling accident from burning API budget. A `workflow_dispatch` event
has no `payload.sender` in that shape, so the guard either fails or needs its
own branch. Rebuilding CI-initiated solving therefore requires answering a
design question first — *what does "authorized" mean when the caller is a
workflow and not a person?* — and only then plumbing. Do not skip to the
plumbing.

The alternative that does work today, and is the real path: a human with
write permission applies `solver:ready` or mentions `@claude`. That path is
untouched by this removal.

### The part that generalizes — read this before writing any workflow

**The rule was already documented correctly in this repo**, on 2026-06-04, in
`notify-release-published.yml`'s header:

> "CI-created releases that use the default GITHUB_TOKEN do not trigger
> recursive release workflows, so operators can use workflow_dispatch"

That is the same rule, written down in this repo, three months before both
`#663` and this router contradicted it. The knowledge existed, was correct,
and did not travel. This has now been found three times (release mirror,
`#663`, this router), which makes it a pattern rather than a bad commit.

Before adding any workflow step that writes to GitHub (`gh issue edit`,
`gh issue comment`, `gh pr create`, `gh release create`, `git push`,
`github-script` mutations) with the intent of waking another workflow: check
whether the token is `secrets.GITHUB_TOKEN`. If it is, the event will not be
raised. Use a PAT/App token, a `workflow_dispatch`, or a
`repository_dispatch` — or state plainly in the file that a human is required.

A durable countermeasure is suggested but not yet scoped: a CI check that
flags any workflow whose trigger events can only be raised by
`GITHUB_TOKEN` writes elsewhere in the repo. The rule is mechanical and
greppable.
