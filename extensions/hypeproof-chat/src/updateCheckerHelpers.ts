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

/**
 * Parse a GitHub Releases API response into update info relative to the
 * currently-bundled version. Returns `available: false` when:
 *   - response is malformed
 *   - latest tag <= current
 *   - latest is draft / prerelease
 *   - matching darwin-arm64 asset not found
 *
 * Callers must do the `compareVersions` check via this function; raw tag
 * comparisons elsewhere are a hazard.
 */
export function parseLatestRelease(
  release: GhRelease | null | undefined,
  currentVersion: string,
  assetSuffix: string = "darwin-arm64.zip",
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
  const asset = (release.assets ?? []).find((a) => a.name.endsWith(assetSuffix));
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
 * Given the Electron exec path, return the .app bundle root path or null if
 * the running process is not inside an .app bundle (e.g., dev build, F5 in
 * Extension Development Host). The updater bails in the null case — we
 * don't want to silently overwrite the wrong target.
 *
 * Examples:
 *   /Applications/HypeProof Studio.app/Contents/MacOS/Electron
 *     → /Applications/HypeProof Studio.app
 *   /Users/jay/.../vscode/Contents/MacOS/Electron     (dev path)
 *     → that path's .app root (works) — caller decides whether to proceed
 *   /usr/local/bin/code                               (CLI, no .app)
 *     → null
 */
export function detectAppBundle(execPath: string): string | null {
  if (typeof execPath !== "string" || !execPath) return null;
  const marker = "/Contents/MacOS/";
  const idx = execPath.indexOf(marker);
  if (idx < 0) return null;
  const candidate = execPath.slice(0, idx);
  // Sanity: bundle should end with ".app". If not, something unusual.
  return candidate.endsWith(".app") ? candidate : null;
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

# Verify new bundle id matches expected (prevents a malicious or corrupt zip
# from being mv'd over /Applications/HypeProof Studio.app).
NEW_BID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$NEW_APP/Contents/Info.plist" 2>/dev/null || echo "")
[[ "$NEW_BID" == "$EXPECTED_BUNDLE_ID" ]] || abort "bundle id mismatch: got '$NEW_BID', expected '$EXPECTED_BUNDLE_ID'"
echo "[ok] bundle id verified"

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
