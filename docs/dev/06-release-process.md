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

## In-App Updates

Studio checks the public `jayleekr/hypeproof-studio-releases` stable release
30 seconds after activation and every 24 hours afterwards. It does not silently
install: the user starts the download and confirms restart. Dismissing a version
suppresses its banner for seven days. Service/module deployments are separate
from this App update path.

The updater supports macOS arm64 and Windows x64. Release assets must carry the
GitHub SHA-256 digest and expected byte size. Failed checks are not evidence that
the installed version is current. Failed downloads must not reach the installer.
See REQ-I1 through REQ-I13 and issue #730 for the contract and failure controls.

Verification commands:

```bash
cd extensions/hypeproof-chat
npm test
npm run typecheck
npm run build:extension
cd ../../e2e
node update-check/run.mjs
```

The last command copies the installed macOS app into an isolated temporary
directory, injects the built extension, and checks the update command against the
public release API. It never installs an update. Platform CI executes macOS
swap/rollback fixtures and the Windows PowerShell wrapper with a mocked installer.
Neither replaces the release gate for an actual packaged-app upgrade/relaunch on
each supported OS. A source-code merge does not update installed clients: a new
App release and its public mirror are required. Older broken updater builds may
still need a one-time manual reinstall (notably REQ-I10).

## Rollback

Rollback means returning workshop members to the previous known-good app build
and previous Worker configuration. Keep the previous release artifact available
until the new release has completed at least one workshop or rehearsal pass. If
the Worker contract changes, rollback must include token/profile compatibility.
If the app build changes preview or storage behavior, rollback must preserve the
member's local `~/HypeProofGames` directory and avoid deleting generated work.
