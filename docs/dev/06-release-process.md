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
cd webview-ui && npm run build
cd ../../../e2e
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

## Trial and classroom delivery

Personal trial and classroom sessions use **one App artifact and one stable
update channel**. Participation codes select the Service profile and access
limits; they do not select a second App build. Publish each App release once to
`hypeproof-studio-releases`, then verify both entry paths against that artifact.
A successful mirror makes an update available; it does not replace a running
installation or prove that the user has restarted into it.

On macOS, ordinary and personal-trial shortcuts must resolve to
`/Applications/HypeProof Studio.app`. A trial may keep separate user-data,
extensions and workspace directories, but its regular shortcut must not pin an
App under `releases/v*/`. Preserve those directories when updating. Explicitly
label isolated App/Service copies used for development as local rehearsals.
They are not evidence that a public release has reached the user.

For every release report, record these separately for trial and classroom:

- Public App tag, asset digest and source commit.
- Actual executable path, product version/commit and bundled extension version
  after restart. An old process remains old even if a newer file exists on disk.
- Effective Service endpoint and `/v1/health` version; confirm the selected
  profile using the existing authenticated API without logging the token.
- Module version/pin, or compiled Service prompt revision when there is no pin.

A Service deployment reaches both profiles using that Service; a local gateway
continues serving its own code. App, Service and Module deployment remain
separate under the layer plan. Do not rebuild App for a Service-only change or
report a localhost result as public deployment. Reuse the existing App updater
for verified download, backup and safe restart; do not add a trial updater.

The release checklist requires both entry paths. If either is stale or untested,
report delivery as incomplete with the missing path and action, rather than
claiming that both were deployed. See NAT-01/12 and the
[native trial laptop checks](../testing/studio-native-trial-laptop.md).

## Rollback

Rollback means returning workshop members to the previous known-good app build
and previous Worker configuration. Keep the previous release artifact available
until the new release has completed at least one workshop or rehearsal pass. If
the Worker contract changes, rollback must include token/profile compatibility.
If the app build changes preview or storage behavior, rollback must preserve the
member's local `~/HypeProofGames` directory and avoid deleting generated work.
