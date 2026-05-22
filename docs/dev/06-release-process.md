---
title: Studio Release Process
product: studio
doc_type: release
status: canonical
owner: core
version: 0.1.4
last_reviewed: 2026-05-22
audience: release owners
source_paths:
  - scripts/build-all.sh
  - scripts/verify-branding.sh
  - docs/RELEASE-CHECKLIST.md
quality_gates:
  - version-documented
  - rollback-documented
  - source-paths-exist
---

# Studio Release Process

## Version Source

The product version comes from `extensions/hypeproof-chat/package.json`. Member
docs may have a separate portal version, but Studio behavior, release notes, and
binary packaging must reference the product version. A version bump must update
release notes, the release checklist, and any member-facing docs that mention
the installable build. The docs harness checks that `docs/dev/*` frontmatter
matches the package version.

## Build And Publish

The release owner runs the build script, applies product overrides, verifies the
display name, bundle id, data folder, built-in extension activation, and absence
of disallowed upstream branding strings. The release checklist in
`docs/RELEASE-CHECKLIST.md` remains the operational source of truth for the
exact sequence. Release notes should summarize member-visible changes, known
risks, validation evidence, and hotfix candidates.

## Rollback

Rollback means returning workshop members to the previous known-good app build
and previous Worker configuration. Keep the previous release artifact available
until the new release has completed at least one workshop or rehearsal pass. If
the Worker contract changes, rollback must include token/profile compatibility.
If the app build changes preview or storage behavior, rollback must preserve the
member's local `~/HypeProofGames` directory and avoid deleting generated work.
