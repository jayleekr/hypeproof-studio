# HypeProof Agent Skills

This directory is the public source of truth for Agent Skills maintained with HypeProof Studio.

## Current measurement

Use the [member measurement workbench](https://hypeproof-ai.xyz/members/studio/measurement) for current Codex and Claude Code work: review evidence, calculate six-capability research task indices, and record next actions. Its [versioned methodology](https://hypeproof-ai.xyz/members/studio/measurement/methodology) defines current rules. The `packages/measurement/` package supplies host capture and synchronization; it does not turn AI suggestions into human-reviewed scores.

## Historical HAIN7 reports — retired 2026-09-15

[`hain7-report`](./hain7-report/) is retained only to replay or export an explicitly selected historical seven-axis record under its original rubric. It is not a recommended workflow for new measurements.

The CLI requires `--legacy-replay` and an exact session path, rejects `--latest`, and keeps existing overwrite safeguards. The flag declares archival intent; it does not authenticate the age of input. Preserve original records and label replayed output as historical. Never convert seven-axis scores into six-axis scores.

Read the [historical instructions](./hain7-report/SKILL.md) and [runtime compatibility](./hain7-report/references/runtime-compatibility.md) for archival use. Public examples remain synthetic; never upload private learner logs in issues or PRs.
