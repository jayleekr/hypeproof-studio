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
   - CI can route eligible issues to the existing Claude Solver by applying
     `solver:ready`.
   - Interactive execution should use the `/goal` prompt below.

4. **Verify and close the loop**
   - Every task ends with targeted tests, a PR or explicit blocked comment, and
     an issue update.
   - Worker deploys run `scripts/verify-prod.sh` after deploy.
   - Release/mirror work verifies installer resolution against the mirror repo.

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

### Operating prompt

```text
/goal Run one autonomous HypeProof Studio milestone cycle. Audit METAPLAN phases and open GitHub epics, create or update missing task issues with stable hps:auto-task markers, classify risk using AUTONOMY-MANDATE, execute eligible low-risk tasks through issue→branch→tests→PR→merge, run relevant smoke checks, and leave issue comments for every completed, blocked, or human-gated item. Do not change secrets, billing/access policy, participant data retention, or irreversible production state.
```

## CI Entry Points

- `milestone-audit.yml`: scheduled/dispatch audit and optional task creation.
- `autonomous-task-runner.yml`: dispatch-only task routing to solver or `/goal`
  comment.
- `mirror-release.yml`: dispatch-only release mirror sync to
  `jayleekr/hypeproof-studio-releases`.
- `deploy-worker.yml`: dispatch-only Worker deploy with test and prod smoke.

Keep deploy and mirror workflows dispatch-only until at least one successful
operator dry-run is recorded in the relevant issue.
