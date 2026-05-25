# HypeProof Autonomy Mandate

Status: Active
Owner: Jay
Date: 2026-05-25
Parent: GitHub issue #203 / epic #200

This mandate defines when an engineering agent should proceed autonomously, when
it should notify, and when it must stop for explicit human confirmation.

## Default

Proceed autonomously unless the action changes irreversible production state,
requires private account/billing settings, or affects participant privacy.

Use the smallest reversible step that proves the outcome. Prefer local tests,
dry-runs, and prod smoke checks before changing live state.

## Decision Matrix

| Change type | Workshop direct impact | Workshop indirect impact | Workshop unrelated |
|---|---|---|---|
| Narrow code/doc change | Proceed | Proceed | Proceed |
| Broad code/doc change | Confirm if D-day <= 24h; otherwise proceed with tests | Proceed and notify | Proceed |
| Production state change | Confirm if irreversible; otherwise proceed with smoke + rollback note | Proceed and notify | Proceed |
| Account, billing, or access policy | Human confirmation required | Human confirmation required | Human confirmation required |
| Participant data retention/privacy | Human confirmation required | Human confirmation required | Human confirmation required |
| Irreversible recovery risk | Human confirmation required | Human confirmation required | Human confirmation required |

## D-Day Escalation

When a workshop starts within 24 hours, raise the risk level by one step for
changes that directly affect participant entry, chat availability, session
windows, roster, release install, or instructor operation.

Examples:
- Worker deploy that changes chat behavior: proceed only with targeted tests and
  immediate prod smoke.
- Session/roster/token changes: confirm unless the issue explicitly asks for the
  exact operation.
- Cosmetic docs or templates: proceed.

## Always Autonomous

- Closing stale issues/PRs when acceptance criteria are already met and evidence
  is linked.
- Creating child issues that clarify an accepted epic.
- Non-production docs, tests, or scripts that do not alter participant data.
- Local-only validation and read-only production health checks.
- Reversible code changes with passing targeted tests.

## Notify After Proceeding

Proceed, then leave a GitHub issue comment when the action changes how the team
operates:
- deploy scripts, release scripts, or smoke checks
- admin/operator runbooks
- cohort profile behavior
- measurement or ingestion schema

The comment must include the commit, tests run, and any remaining manual gate.

## Stop For Human Confirmation

Do not proceed without an explicit user instruction for:
- GitHub billing/spending limit changes
- Cloudflare Access policy changes
- adding/removing production admin identities
- enabling student chat body logging in production
- changing retention periods or deletion policy
- destructive database/R2/KV operations
- rotating secrets when the old secret cannot be recovered by the agent

## Quality Bar

Every autonomous change must end with:
- a commit pushed to `main` or a clear reason it was not pushed
- targeted tests or a clear reason tests were not applicable
- an issue/PR update when the work maps to a GitHub tracker
- no unrelated dirty-tree changes included

## Related

- `docs/seven-assets.md`
- `docs/studio-requirements.md`
- `scripts/verify-prod.sh`
- `worker/DEPLOY.md`
