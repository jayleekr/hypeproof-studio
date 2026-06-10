---
title: Studio Release Process
product: studio
doc_type: release
status: canonical
owner: core
version: 0.1.5
last_reviewed: 2026-06-04
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

Tagged releases are versioned from the git tag. CI sets `HPS_VERSION` from a
`v*` tag, and `scripts/resolve-version.sh` stamps that value into
`product.json`, `Info.plist`, and the bundled `hypeproof-chat` extension. This
tag-driven value is canonical for shipped binaries, release notes, installers,
and operator announcements.

For untagged local/dev builds, `scripts/resolve-version.sh` falls back to
`extensions/hypeproof-chat/package.json`. The docs harness also uses that
package version as its local fallback, so `docs/dev/*` frontmatter should track
the package version until a tagged release supplies `HPS_VERSION`.

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
