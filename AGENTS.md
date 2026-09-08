# Repository instructions

Read [CLAUDE.md](CLAUDE.md) for existing project rules, then the documents below.
This entry point does not replace the autonomy mandate, product philosophy, or
release gates. Keep those rules in their existing canonical documents.

- Development flow: [DEV-GUIDE.md](DEV-GUIDE.md).
- Layer placement and admission: [vessel-and-modules](docs/plan/vessel-and-modules.md).
- Directory and naming conventions: [directory structure](docs/dev/02-directory-structure.md).
- Requirement index: [requirements](docs/dev/04-requirements.md).
- Verification and evidence: [testing](docs/dev/05-testing-requirements.md) and
  [verification rules](.claude/rules/verification.md).
- Workshop/production decisions: [autonomy mandate](docs/AUTONOMY-MANDATE.md).
- Chalk authoring proposal: [product requirements](docs/requirements/chalk-authoring.md)
  and [test requirements](docs/testing/chalk-authoring.md).

Read the scoped AGENTS.md before changing chalk/, worker/, or the Studio extension.
Inspect existing implementations before creating another store, validator, or
authentication path. Declare planned behavior as planned; a documented test is
not an executed test. Keep changes in a focused branch and PR following the dev
guide. Do not change production state merely to validate documentation.

<!-- hype-pr-skill:start -->
## Agent PR preparation

For development through PR creation in this repository, read and use
`.claude/skills/hype-pr/SKILL.md` (also discoverable at `.agents/skills/hype-pr/`).
Inspect criteria links at task start; before creating a PR, record the agent's
impact assessment and validation with `scripts/hype-pr/pr.py inspect` / `prepare`.
Create through `scripts/hype-pr/pr.py create --preparation <receipt> --apply`.
Fix stale/missing preparation instead of bypassing it with direct `gh pr create`.
The common contract is `docs/AGENT-GUIDE.ko.md`; commands are in `docs/HYPE-PR.ko.md`.
This adds no GitHub required check and does not grant human approval or merge authority.
<!-- hype-pr-skill:end -->
