# Branding swap rules (Phase 2)

Goal: zero visible "VSCodium" or "Visual Studio Code" strings outside the legal attribution in About.

## Single source of truth

One SVG drives everything. Edit these three (same logo, three crops) and run `icons/build_icons.sh`:

- `vscodium-base/icons/stable/codium_cnl.svg` — primary app icon
- `vscodium-base/icons/stable/codium_cnl_w80_b8.svg` — 80 width, 8 border variant
- `vscodium-base/icons/stable/codium_clt.svg` — CLI icon

`build_icons.sh` regenerates `.icns`, `.ico`, and PNGs for Mac, Win, Linux, server. Do not hand-edit the generated binaries.

## File checklist

See METAPLAN §8 for the full table. Categories:

- App icons (`icons/stable/*.svg`) — edit SVG only
- Server/web assets (`src/stable/resources/server/*.png`, `favicon.ico`)
- Linux (`src/stable/resources/linux/code.png`)
- Mac corner/template (`icons/corner_512.png`, `icons/template_macos.png`)
- Welcome screen (`announcements-extra.json`)

## product.json strings

Done via jq in `prepare_vscode.sh` (not by editing `product.json` directly — that file is regenerated). Keys: see [../../vscodium-base/CLAUDE.md](../../vscodium-base/CLAUDE.md) "product.json overrides".

## Verification

After build, inspect:

1. App display name — `mdls -name kMDItemDisplayName "VSCode-darwin-arm64/HypeProof Studio.app"`
2. Bundle ID — `defaults read "VSCode-darwin-arm64/HypeProof Studio.app/Contents/Info.plist" CFBundleIdentifier` → `ai.hypeproof.studio`
3. Data folder — launch app, confirm `~/Library/Application Support/HypeProof-Studio/` created (not `Code/` or `VSCodium/`)
4. Search for residual strings — `grep -ri "VSCodium\|codium" "VSCode-darwin-arm64/HypeProof Studio.app/Contents/Resources" | grep -v -i "license\|notice\|attribution"`

Attribution to VS Code (MIT) and VSCodium **must remain** in About — do not strip it.
