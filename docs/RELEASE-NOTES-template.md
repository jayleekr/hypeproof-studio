# HypeProof Studio RELEASE-NOTES template

Copy this body into each GitHub Release before publishing or mirroring. Keep it
operator-readable: the release page is the first place people check when an
installer or production deploy needs to be trusted.

```md
## Summary

One or two sentences describing what this release changes for participants,
operators, or production reliability.

## Highlights

- Participant-facing:
- Operator-facing:
- Build/release:
- Production/API:

## Install / Update

- macOS: use `HypeProof-Studio-darwin-arm64.zip`.
- Windows: use `HypeProof.StudioUserSetup-x64-*.exe` for a per-user install, or
  `HypeProof.StudioSetup-x64-*.exe` for a machine install.
- One-line installers resolve from the mirror repo:
  `jayleekr/hypeproof-studio-releases`.
- If this release changes endpoint defaults, clear any temporary
  `hypeproofChat.proxyUrl` override after updating.

macOS one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/jayleekr/hypeproof-studio-releases/main/install-mac.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/jayleekr/hypeproof-studio/main/scripts/install-win.ps1 | iex
```

## Included Assets

- `HypeProof-Studio-darwin-arm64.zip` — macOS arm64 app zip
- `HypeProof.Studio-win32-x64-*.zip` — Windows portable zip
- `HypeProof.StudioUserSetup-x64-*.exe` — Windows user installer
- `HypeProof.StudioSetup-x64-*.exe` — Windows system installer
- `HypeProof.Studio.exe` — Windows app executable
- `hypeproof-studio-tunnel.exe` — tunnel helper
- `inno_updater.exe` — Windows updater helper

## Verification

- macOS release build:
- Windows release build:
- Mirror publish:
- Production Worker deploy:
- Production health:

## Known Notes

- Unsigned binaries may require the usual macOS/Windows trust prompt handling.
- Staff dogfood/install count:

## Changes

- PR / issue links:
- Full changelog:
```
