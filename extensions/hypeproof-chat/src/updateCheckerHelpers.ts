// Pure helpers for the auto-update flow (#72). No `vscode` import — testable
// from plain Node. The orchestration that touches the VS Code API + file
// system + child processes lives in updateChecker.ts.

/**
 * Compare two HypeProof Studio versions. Returns:
 *   > 0  if a > b
 *   < 0  if a < b
 *   = 0  if equal or unparseable
 *
 * Accepts shapes: "0.1.2", "v0.1.2", "0.1.2-beta.1", "0.1.2+1". Anything we
 * can't parse → 0 (treat as equal so we don't bounce-update on garbage).
 */
export function compareVersions(a: string, b: string): number {
  const parsed = (s: string) => {
    const trimmed = s.replace(/^v/, "").split(/[+-]/)[0]!;
    const parts = trimmed.split(".").map((x) => parseInt(x, 10));
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
    return parts as [number, number, number];
  };
  const pa = parsed(a);
  const pb = parsed(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  }
  return 0;
}

export interface GhRelease {
  tag_name: string;
  name?: string;
  body?: string;
  html_url: string;
  prerelease?: boolean;
  draft?: boolean;
  assets: Array<{ name: string; browser_download_url: string; size: number }>;
}

export interface UpdateInfo {
  available: boolean;
  version: string;            // "0.1.2" (no v prefix)
  downloadUrl: string;
  releaseUrl: string;
  notes: string;              // raw markdown
  sizeBytes: number;
}

export type ReleaseAsset = GhRelease["assets"][number];

/** Picks the update asset for the running platform out of a release's assets. */
export type AssetPicker = (assets: ReleaseAsset[]) => ReleaseAsset | undefined;

/**
 * macOS: the single darwin-arm64 zip. Its name is a fixed suffix (the build
 * stamps a stable asset name), so an `endsWith` match is enough.
 */
export function pickDarwinAsset(assets: ReleaseAsset[]): ReleaseAsset | undefined {
  return assets.find((a) => a.name.endsWith("darwin-arm64.zip"));
}

/**
 * Windows: the Inno Setup installer .exe. Prefer the per-user installer
 * (`install-win.ps1`'s first choice — no admin needed), fall back to the
 * system installer. Unlike the darwin asset, the Windows asset name carries a
 * VS Code *engine* version suffix (e.g. `…Setup-x64-1.116.04919.exe`), not the
 * HPS release version, so we match by SHAPE with a regex rather than a fixed
 * suffix. Mirrors the asset selection in `install-win.ps1`.
 */
export function pickWindowsInstaller(assets: ReleaseAsset[]): ReleaseAsset | undefined {
  return (
    assets.find((a) => /UserSetup.*x64.*\.exe$/i.test(a.name)) ??
    assets.find((a) => /Setup.*x64.*\.exe$/i.test(a.name))
  );
}

/**
 * Parse a GitHub Releases API response into update info relative to the
 * currently-bundled version. Returns `available: false` when:
 *   - response is malformed
 *   - latest tag <= current
 *   - latest is draft / prerelease
 *   - no asset for this platform (per `pickAsset`) is found
 *
 * Callers must do the `compareVersions` check via this function; raw tag
 * comparisons elsewhere are a hazard. `pickAsset` selects the platform's
 * download (defaults to macOS); `checkForUpdates` passes the win32 picker off
 * macOS.
 */
export function parseLatestRelease(
  release: GhRelease | null | undefined,
  currentVersion: string,
  pickAsset: AssetPicker = pickDarwinAsset,
): UpdateInfo {
  const empty: UpdateInfo = {
    available: false,
    version: "",
    downloadUrl: "",
    releaseUrl: "",
    notes: "",
    sizeBytes: 0,
  };
  if (!release || typeof release !== "object") return empty;
  if (release.draft || release.prerelease) return empty;
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  const version = tag.replace(/^v/, "");
  if (!version) return empty;
  if (compareVersions(version, currentVersion) <= 0) return empty;
  const asset = pickAsset(release.assets ?? []);
  if (!asset) return empty;
  return {
    available: true,
    version,
    downloadUrl: asset.browser_download_url,
    releaseUrl: release.html_url,
    notes: typeof release.body === "string" ? release.body : "",
    sizeBytes: typeof asset.size === "number" ? asset.size : 0,
  };
}

/**
 * Given the Electron exec path, return the **top-level** .app bundle root, or
 * null if the running process is not inside an .app bundle (e.g., dev build,
 * F5 in Extension Development Host). The updater bails in the null case — we
 * don't want to silently overwrite the wrong target.
 *
 * IMPORTANT (#206): in the VS Code extension host, `process.execPath` is NOT
 * the top-level Electron binary — it's the utility/plugin **helper** executable
 * nested inside the app's Contents/Frameworks:
 *
 *   /Applications/HypeProof Studio.app/Contents/Frameworks/
 *     HypeProof Studio Helper (Plugin).app/Contents/MacOS/HypeProof Studio Helper (Plugin)
 *
 * Slicing at the *first* /Contents/MacOS/ returns the **helper** sub-bundle,
 * which the installer then `mv`'d the new app into — burying it one level
 * deeper each update (matryoshka). So we resolve the **outermost** .app
 * segment instead, which is always /Applications/<App>.app.
 *
 * Examples:
 *   /Applications/HypeProof Studio.app/Contents/MacOS/Electron
 *     → /Applications/HypeProof Studio.app
 *   /Applications/HypeProof Studio.app/Contents/Frameworks/…Helper (Plugin).app/Contents/MacOS/…
 *     → /Applications/HypeProof Studio.app   (NOT the nested helper)
 *   /Users/jay/.../vscode/Contents/MacOS/Electron     (dev path, no .app)
 *     → null
 *   /usr/local/bin/code                               (CLI, no .app)
 *     → null
 */
export function detectAppBundle(execPath: string): string | null {
  if (typeof execPath !== "string" || !execPath) return null;
  // Must be an executable living inside a bundle (…/Contents/MacOS/<bin>).
  // A bare .app path or a CLI binary is not an update target.
  if (!execPath.includes("/Contents/MacOS/")) return null;
  // Take the OUTERMOST .app segment, not the nearest enclosing one. `.*?` is
  // non-greedy so it stops at the first ".app" boundary from the left.
  const outer = execPath.match(/^(.*?\.app)(?:\/|$)/);
  return outer ? outer[1]! : null;
}

export interface InstallerScriptInput {
  // Where the unpacked NEW .app lives right now (inside a tmp dir).
  newAppPath: string;
  // Where the OLD .app currently lives (currently running).
  oldAppPath: string;
  // The bundle id we expect to see — used as a sanity guard in the installer
  // so a malformed download can't wipe an unrelated /Applications/<x>.app.
  expectedBundleId: string;
  // Version string for log + backup naming.
  newVersion: string;
  oldVersion: string;
  // Where to write the per-run log (full path).
  logPath: string;
}

/**
 * Render the installer.sh contents. Pure string assembly so unit tests can
 * snapshot it. The script is intentionally bash-only + relies on macOS-native
 * tools (osascript, pgrep, xattr, mv, open, /usr/libexec/PlistBuddy).
 *
 * Safety properties:
 *   - Refuses to run if the new bundle's CFBundleIdentifier doesn't match
 *     `expectedBundleId` (defense against zip swaps / man-in-the-middle).
 *   - Refuses to run if NEW or OLD path doesn't end in ".app".
 *   - Backs up OLD app to ~/.Trash/<basename>.<oldVersion>.<timestamp>.app
 *     (recoverable for 30 days, never destroys).
 *   - Atomic swap via `mv` (both src + dst on same volume, /Applications).
 *   - Strips quarantine AFTER swap (a fresh xattr -dr).
 *   - Always re-opens the new app at the end, even on partial failure.
 *   - Logs everything to `logPath`; exit code is non-zero on any abort.
 */
export function renderInstallerScript(input: InstallerScriptInput): string {
  const {
    newAppPath,
    oldAppPath,
    expectedBundleId,
    newVersion,
    oldVersion,
    logPath,
  } = input;

  // bash escape via $'...' — pass shell strings as positional args via env vars
  // instead of inline so paths containing spaces or quotes can't break the
  // script. Each variable is wrapped in "${VAR}" inside the script body.
  return `#!/usr/bin/env bash
# Auto-generated by HypeProof Studio (issue #72). Do not hand-edit.
# Performs an in-place .app swap from <old> → <new>, preserving Gatekeeper trust.

set -uo pipefail

NEW_APP=${shJsonString(newAppPath)}
OLD_APP=${shJsonString(oldAppPath)}
EXPECTED_BUNDLE_ID=${shJsonString(expectedBundleId)}
NEW_VERSION=${shJsonString(newVersion)}
OLD_VERSION=${shJsonString(oldVersion)}
LOG=${shJsonString(logPath)}

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo
echo "===================================================================="
echo "[$(date '+%Y-%m-%d %H:%M:%S')] HypeProof Studio update \${OLD_VERSION} → \${NEW_VERSION}"
echo "  new:  $NEW_APP"
echo "  old:  $OLD_APP"
echo "  bid:  $EXPECTED_BUNDLE_ID"

abort() { echo "[ABORT] $*"; exit 1; }

[[ "$NEW_APP" == *.app ]] || abort "new app path doesn't end in .app: $NEW_APP"
[[ "$OLD_APP" == *.app ]] || abort "old app path doesn't end in .app: $OLD_APP"
[[ -d "$NEW_APP" ]]       || abort "new .app not found: $NEW_APP"
[[ -d "$OLD_APP" ]]       || abort "old .app not found: $OLD_APP"

# Guard (#206): OLD_APP must be the TOP-LEVEL app, never a helper sub-bundle
# nested inside Contents/Frameworks. A regression in app-root detection
# installed the new bundle *inside* the running one, burying it a level deeper
# every update (matryoshka). Refuse rather than nest.
case "$OLD_APP" in
  */Contents/Frameworks/*) abort "refusing to install into a nested sub-bundle: $OLD_APP" ;;
esac

# Verify new bundle id matches expected (prevents a malicious or corrupt zip
# from being mv'd over /Applications/HypeProof Studio.app).
NEW_BID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$NEW_APP/Contents/Info.plist" 2>/dev/null || echo "")
[[ "$NEW_BID" == "$EXPECTED_BUNDLE_ID" ]] || abort "new bundle id mismatch: got '$NEW_BID', expected '$EXPECTED_BUNDLE_ID'"
echo "[ok] new bundle id verified"

# Guard (#206): OLD_APP's own bundle id must also match — a second signal that
# the resolved target is the real app and not some unrelated .app the path
# happened to land on.
OLD_BID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$OLD_APP/Contents/Info.plist" 2>/dev/null || echo "")
[[ "$OLD_BID" == "$EXPECTED_BUNDLE_ID" ]] || abort "old bundle id mismatch: got '$OLD_BID', expected '$EXPECTED_BUNDLE_ID'"
echo "[ok] old app is top-level + bundle id verified"

# Wait for the old app to fully quit. Extension already asked the app to
# quit before spawning us; this is a safety belt.
osascript -e "tell application id \\"$EXPECTED_BUNDLE_ID\\" to quit" 2>/dev/null || true
for i in 1 2 3 4 5 6 7 8 9 10; do
  if ! pgrep -f "$OLD_APP/Contents/MacOS" >/dev/null 2>&1; then
    echo "[ok] old app no longer running"
    break
  fi
  sleep 1
done
# Even if pgrep still sees it, proceed — a stuck process shouldn't block the
# update indefinitely (mv may still succeed if the binary fd was already
# closed by the OS).

# Backup OLD to ~/.Trash. mv is atomic when source + dest are on the same
# volume; ~/.Trash typically is. Falls back to rm -rf only if backup fails.
TRASH_DIR="$HOME/.Trash"
TS=$(date '+%Y%m%d-%H%M%S')
BACKUP_PATH="$TRASH_DIR/$(basename "$OLD_APP" .app).\${OLD_VERSION}.\${TS}.app"
if mv "$OLD_APP" "$BACKUP_PATH"; then
  echo "[ok] backed up old → $BACKUP_PATH"
else
  echo "[warn] backup mv failed; removing OLD directly"
  rm -rf "$OLD_APP" || abort "could not remove old app"
fi

# Install new
mv "$NEW_APP" "$OLD_APP" || abort "could not install new app"
echo "[ok] installed new app"

# Strip quarantine on the freshly-moved bundle. Required: install-mac.sh
# does this on first install; an auto-update without this step would trigger
# Gatekeeper on the new launch (even though path+bid trust persists, the
# downloaded bundle has its OWN quarantine attr from curl).
xattr -dr com.apple.quarantine "$OLD_APP" 2>/dev/null || true
echo "[ok] stripped quarantine"

# Reopen
open "$OLD_APP"
echo "[ok] launched updated app"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] update complete"
exit 0
`;
}

/**
 * JSON-style quoting that's safe in bash assignments: wraps in double quotes
 * and escapes `"`, `\`, and `$` inside. For paths/version strings only —
 * not a general bash-escape utility.
 */
function shJsonString(s: string): string {
  if (typeof s !== "string") return '""';
  const esc = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
  return `"${esc}"`;
}

/**
 * Dismissal state for "Later" clicks — store per-version with a TTL so we
 * don't badger the user every activation but eventually re-prompt if they
 * forget. globalState shape: { [version]: dismissedAt(unix sec) }.
 */
export function shouldShowBanner(
  available: UpdateInfo,
  dismissals: Record<string, number>,
  nowSeconds: number,
  rePromptAfterSeconds: number = 7 * 24 * 3600,
): boolean {
  if (!available.available) return false;
  const dismissedAt = dismissals[available.version];
  if (!dismissedAt) return true;
  return nowSeconds - dismissedAt > rePromptAfterSeconds;
}

/**
 * Minimum free disk required before kicking off an update download. The full
 * .app + extracted contents takes several hundred MB; 1 GB gives headroom.
 */
export const MIN_FREE_DISK_BYTES = 1024 * 1024 * 1024;

/**
 * Pure predicate: do we have at least `threshold` bytes free?
 *
 * Defensive against NaN/negative/non-finite inputs — those collapse to
 * "no free disk" so we never proceed on a bad reading.
 */
export function hasFreeDisk(freeBytes: number, threshold: number = MIN_FREE_DISK_BYTES): boolean {
  if (typeof freeBytes !== "number" || !Number.isFinite(freeBytes) || freeBytes < 0) return false;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0) return false;
  return freeBytes >= threshold;
}

/**
 * Idempotency guard for runUpdate: same-version concurrent calls share one
 * factory invocation. Pulled out so the orchestration can use it AND a unit
 * test can verify it without spinning up child processes.
 *
 * The factory runs synchronously on the first call; subsequent calls with
 * the same key return the same Promise until it settles.
 */
export function pickInflight<T>(
  map: Map<string, Promise<T>>,
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  const existing = map.get(key);
  if (existing) return existing;
  const p = factory().finally(() => map.delete(key));
  map.set(key, p);
  return p;
}
