// Smoke for updateCheckerHelpers.ts (#72).
// Run: node --experimental-strip-types test/update-checker.smoke.mjs
//
// All helpers here are pure — no vscode, no fs, no child_process. The
// orchestration in updateChecker.ts is covered by the e2e build test below.

import assert from "node:assert/strict";

const {
  compareVersions,
  parseLatestRelease,
  detectAppBundle,
  renderInstallerScript,
  shouldShowBanner,
  pickDarwinAsset,
  pickWindowsInstaller,
  renderWindowsUpdateWrapper,
} = await import("../src/updateCheckerHelpers.ts");

const results = [];
function check(label, fn) {
  try { fn(); results.push({ label, ok: true }); console.log(`✅ ${label}`); }
  catch (err) { results.push({ label, ok: false, err: String(err) }); console.log(`❌ ${label}\n   ${err}`); }
}

// --- compareVersions -----------------------------------------------------

check("compareVersions: equal versions", () => {
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
});
check("compareVersions: a > b minor", () => {
  assert.ok(compareVersions("0.2.0", "0.1.0") > 0);
});
check("compareVersions: a < b patch", () => {
  assert.ok(compareVersions("0.1.0", "0.1.1") < 0);
});
check("compareVersions: a > b patch", () => {
  assert.ok(compareVersions("0.1.2", "0.1.1") > 0);
});
check("compareVersions: a > b major", () => {
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
});
check("compareVersions: handles v prefix", () => {
  assert.equal(compareVersions("v0.1.1", "0.1.1"), 0);
});
check("compareVersions: strips pre-release tag for comparison", () => {
  assert.equal(compareVersions("0.1.1-beta.1", "0.1.1"), 0);
});
check("compareVersions: garbage returns 0 (no spurious update)", () => {
  assert.equal(compareVersions("garbage", "0.1.0"), 0);
  assert.equal(compareVersions("0.1.0", "also garbage"), 0);
});

// --- parseLatestRelease --------------------------------------------------

const REAL_RELEASE = {
  tag_name: "v0.1.2",
  name: "v0.1.2",
  body: "release notes here",
  html_url: "https://github.com/jayleekr/hypeproof-studio-releases/releases/tag/v0.1.2",
  prerelease: false,
  draft: false,
  assets: [
    {
      name: "HypeProof-Studio-darwin-arm64.zip",
      browser_download_url: "https://github.com/jayleekr/hypeproof-studio-releases/releases/download/v0.1.2/HypeProof-Studio-darwin-arm64.zip",
      size: 228 * 1024 * 1024,
    },
  ],
};

check("parseLatestRelease: newer release → available", () => {
  const info = parseLatestRelease(REAL_RELEASE, "0.1.1");
  assert.equal(info.available, true);
  assert.equal(info.version, "0.1.2");
  assert.match(info.downloadUrl, /darwin-arm64\.zip$/);
  assert.equal(info.sizeBytes, 228 * 1024 * 1024);
});
check("parseLatestRelease: same version → not available", () => {
  const info = parseLatestRelease(REAL_RELEASE, "0.1.2");
  assert.equal(info.available, false);
});
// #249 regression: a build whose stamped version equals the latest release must
// NOT offer an update. The bug fed currentBundleVersion()'s esbuild-inlined
// source value (0.1.5) instead of the stamped on-disk version (0.1.15); since
// 0.1.5 < 0.1.15 (two-digit patch), the updater looped forever offering the
// installed version. The fix makes currentBundleVersion() resolve the running
// .app so the check sees the real 0.1.15.
check("parseLatestRelease: #249 — stamped version == latest tag → not available", () => {
  const rel = { ...REAL_RELEASE, tag_name: "v0.1.15", name: "v0.1.15" };
  assert.equal(parseLatestRelease(rel, "0.1.15").available, false, "0.1.15 vs 0.1.15 must not loop");
  assert.equal(parseLatestRelease(rel, "0.1.5").available, true, "stale 0.1.5 (the bug) WOULD loop — shows why the fix matters");
});
check("parseLatestRelease: older release → not available (e.g., rollback scenario)", () => {
  const info = parseLatestRelease(REAL_RELEASE, "0.1.3");
  assert.equal(info.available, false);
});
check("parseLatestRelease: draft → not available", () => {
  const info = parseLatestRelease({ ...REAL_RELEASE, draft: true }, "0.1.1");
  assert.equal(info.available, false);
});
check("parseLatestRelease: prerelease → not available", () => {
  const info = parseLatestRelease({ ...REAL_RELEASE, prerelease: true }, "0.1.1");
  assert.equal(info.available, false);
});
check("parseLatestRelease: missing asset → not available", () => {
  const info = parseLatestRelease({ ...REAL_RELEASE, assets: [] }, "0.1.1");
  assert.equal(info.available, false);
});
check("parseLatestRelease: null input → not available", () => {
  assert.equal(parseLatestRelease(null, "0.1.1").available, false);
  assert.equal(parseLatestRelease(undefined, "0.1.1").available, false);
});

// --- Windows asset selection (#447) -------------------------------------
// Real win32 releases carry FOUR assets; the name suffix is the VS Code engine
// version (1.116.04919), not the HPS release version — so selection is by shape.
const WIN_DL = "https://github.com/jayleekr/hypeproof-studio-releases/releases/download/v0.1.2";
const WIN_ASSETS = [
  { name: "HypeProof-Studio-darwin-arm64.zip", browser_download_url: `${WIN_DL}/HypeProof-Studio-darwin-arm64.zip`, size: 170 * 1024 * 1024 },
  { name: "HypeProof.Studio-win32-x64-1.116.04919.zip", browser_download_url: `${WIN_DL}/HypeProof.Studio-win32-x64-1.116.04919.zip`, size: 178 * 1024 * 1024 },
  { name: "HypeProof.StudioSetup-x64-1.116.04919.exe", browser_download_url: `${WIN_DL}/HypeProof.StudioSetup-x64-1.116.04919.exe`, size: 126 * 1024 * 1024 },
  { name: "HypeProof.StudioUserSetup-x64-1.116.04919.exe", browser_download_url: `${WIN_DL}/HypeProof.StudioUserSetup-x64-1.116.04919.exe`, size: 126 * 1024 * 1024 },
];
const WIN_RELEASE = { ...REAL_RELEASE, assets: WIN_ASSETS };

check("pickWindowsInstaller: prefers the per-user Setup .exe", () => {
  const a = pickWindowsInstaller(WIN_ASSETS);
  assert.equal(a?.name, "HypeProof.StudioUserSetup-x64-1.116.04919.exe");
});
check("pickWindowsInstaller: falls back to system Setup when no UserSetup", () => {
  const a = pickWindowsInstaller(WIN_ASSETS.filter((x) => !/UserSetup/.test(x.name)));
  assert.equal(a?.name, "HypeProof.StudioSetup-x64-1.116.04919.exe");
});
check("pickWindowsInstaller: ignores the portable zip (never the installer)", () => {
  const a = pickWindowsInstaller(WIN_ASSETS.filter((x) => /\.zip$/.test(x.name)));
  assert.equal(a, undefined);
});
check("pickDarwinAsset: never returns a Windows .exe", () => {
  const a = pickDarwinAsset(WIN_ASSETS);
  assert.equal(a?.name, "HypeProof-Studio-darwin-arm64.zip");
});
check("parseLatestRelease: win32 picker → resolves the UserSetup .exe download", () => {
  const info = parseLatestRelease(WIN_RELEASE, "0.1.1", pickWindowsInstaller);
  assert.equal(info.available, true);
  assert.equal(info.version, "0.1.2");
  assert.match(info.downloadUrl, /UserSetup-x64-.*\.exe$/);
  assert.equal(info.sizeBytes, 126 * 1024 * 1024);
});
check("parseLatestRelease: win32 picker + no installer asset → not available", () => {
  const rel = { ...WIN_RELEASE, assets: WIN_ASSETS.filter((x) => /\.zip$/.test(x.name)) };
  assert.equal(parseLatestRelease(rel, "0.1.1", pickWindowsInstaller).available, false);
});
check("parseLatestRelease: win32 picker still honors version gate (same version)", () => {
  assert.equal(parseLatestRelease(WIN_RELEASE, "0.1.2", pickWindowsInstaller).available, false);
});

// --- renderWindowsUpdateWrapper (relaunch-race fix) ---------------------
check("renderWindowsUpdateWrapper: waits for app exit BEFORE launching installer", () => {
  const s = renderWindowsUpdateWrapper({
    appProcessName: "HypeProof Studio",
    installerPath: "C:\\Temp\\hps\\Setup.exe",
    installerArgs: ["/silent", "/mergetasks=runcode", "/LOG=C:\\Temp\\hps\\u.log"],
  });
  // The wait loop precedes the Start-Process — that ordering IS the fix.
  const waitAt = s.indexOf("Get-Process -Name $name");
  const runAt = s.indexOf("Start-Process");
  assert.ok(waitAt > 0 && runAt > 0, "must contain both a wait loop and a launch");
  assert.ok(waitAt < runAt, "the app-exit wait must come before launching the installer");
  assert.ok(s.includes("$name = 'HypeProof Studio'"));
  // Installer args are passed through, single-quoted for PowerShell.
  assert.ok(
    s.includes("-ArgumentList '/silent', '/mergetasks=runcode', '/LOG=C:\\Temp\\hps\\u.log'"),
    "installer args must be passed through single-quoted",
  );
});
check("renderWindowsUpdateWrapper: escapes single quotes in paths", () => {
  const s = renderWindowsUpdateWrapper({
    appProcessName: "App",
    installerPath: "C:\\it's here\\Setup.exe",
    installerArgs: ["/silent"],
  });
  // A literal single quote must be doubled so PowerShell keeps it inside the string.
  assert.ok(s.includes("-FilePath 'C:\\it''s here\\Setup.exe'"));
});
// The BOM is load-bearing, not cosmetic: Windows PowerShell 5.1 decodes a
// BOM-less `-File` script as the ANSI codepage (CP949 in Korea). The installer
// path we bake in lives under %TEMP% = C:\Users\<계정명>\AppData\Local\Temp, so
// on a Korean-username machine it became mojibake, Start-Process found nothing,
// and Studio quit without ever updating. Measured on PS 5.1.26100:
//   BOM-less  → Test-Path 'C:\Users\신제형\…\Setup.exe' = False
//   UTF-8 BOM → Test-Path 'C:\Users\신제형\…\Setup.exe' = True
check("renderWindowsUpdateWrapper: starts with a UTF-8 BOM (non-ASCII paths under PS 5.1)", () => {
  const s = renderWindowsUpdateWrapper({
    appProcessName: "HypeProof Studio",
    installerPath: "C:\\Users\\신제형\\AppData\\Local\\Temp\\hps-update\\Setup.exe",
    installerArgs: ["/silent"],
  });
  assert.equal(s.charCodeAt(0), 0xfeff, "the wrapper must lead with U+FEFF");
  // …and the BOM must be the ONLY thing before the header comment.
  assert.ok(s.startsWith("\uFEFF# Auto-generated"), "BOM immediately precedes the script body");
  // The non-ASCII path survives rendering verbatim; the BOM is what makes
  // PowerShell read those bytes as UTF-8 rather than CP949.
  assert.ok(s.includes("-FilePath 'C:\\Users\\신제형\\AppData\\Local\\Temp\\hps-update\\Setup.exe'"));
  // Written with fs.writeFileSync(path, s) (default utf8) this is EF BB BF.
  const bytes = Buffer.from(s, "utf8");
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "on-disk bytes are EF BB BF");
});
check("renderWindowsUpdateWrapper: has a bounded wait (deadline), not an infinite loop", () => {
  const s = renderWindowsUpdateWrapper({ appProcessName: "App", installerPath: "x.exe", installerArgs: [], maxWaitMs: 5000 });
  assert.match(s, /AddMilliseconds\(5000\)/);
  assert.match(s, /\(Get-Date\) -lt \$deadline/);
});

// --- detectAppBundle ----------------------------------------------------

check("detectAppBundle: standard /Applications path", () => {
  const result = detectAppBundle("/Applications/HypeProof Studio.app/Contents/MacOS/Electron");
  assert.equal(result, "/Applications/HypeProof Studio.app");
});
check("detectAppBundle: dev path with .app", () => {
  const result = detectAppBundle("/Users/jay/dev/build/HypeProof Studio.app/Contents/MacOS/Electron");
  assert.equal(result, "/Users/jay/dev/build/HypeProof Studio.app");
});
// #206: the extension host's execPath is the nested helper, NOT the top app.
check("detectAppBundle: nested Helper (Plugin) execPath → outermost app", () => {
  const result = detectAppBundle(
    "/Applications/HypeProof Studio.app/Contents/Frameworks/HypeProof Studio Helper (Plugin).app/Contents/MacOS/HypeProof Studio Helper (Plugin)",
  );
  assert.equal(result, "/Applications/HypeProof Studio.app");
});
check("detectAppBundle: doubly-nested helper (already-bloated install) → outermost app", () => {
  const result = detectAppBundle(
    "/Applications/HypeProof Studio.app/Contents/Frameworks/HypeProof Studio Helper (Plugin).app/Contents/Frameworks/HypeProof Studio Helper (Plugin).app/Contents/MacOS/HypeProof Studio Helper (Plugin)",
  );
  assert.equal(result, "/Applications/HypeProof Studio.app");
});
check("detectAppBundle: non-.app path → null", () => {
  assert.equal(detectAppBundle("/usr/local/bin/code"), null);
});
check("detectAppBundle: path missing MacOS marker → null", () => {
  assert.equal(detectAppBundle("/Applications/HypeProof Studio.app"), null);
});
check("detectAppBundle: empty input → null", () => {
  assert.equal(detectAppBundle(""), null);
});

// --- renderInstallerScript ---------------------------------------------

check("renderInstallerScript: includes expected anchors", () => {
  const script = renderInstallerScript({
    newAppPath: "/tmp/hps-update-0.1.2/HypeProof Studio.app",
    oldAppPath: "/Applications/HypeProof Studio.app",
    expectedBundleId: "ai.hypeproof.studio",
    newVersion: "0.1.2",
    oldVersion: "0.1.1",
    logPath: "/Users/x/Library/Logs/HypeProofStudio/update-0.1.2.log",
  });
  // Has shebang
  assert.ok(script.startsWith("#!/usr/bin/env bash"), "missing shebang");
  // Embeds paths with proper quoting
  assert.match(script, /NEW_APP="\/tmp\/hps-update-0\.1\.2\/HypeProof Studio\.app"/);
  assert.match(script, /OLD_APP="\/Applications\/HypeProof Studio\.app"/);
  // Has bundle id sanity guard
  assert.ok(script.includes("Print :CFBundleIdentifier"), "missing PlistBuddy check");
  // #206: refuses to install into a nested sub-bundle
  assert.ok(script.includes("*/Contents/Frameworks/*)"), "missing nested-bundle guard");
  // #206: validates OLD_APP's own bundle id, not just NEW_APP's
  assert.ok(script.includes("OLD_BID="), "missing old-app bundle id check");
  // Has quarantine strip
  assert.ok(script.includes("xattr -dr com.apple.quarantine"), "missing quarantine strip");
  // Has reopen step
  assert.ok(script.includes('open "$OLD_APP"'), "missing reopen");
  // Has backup-to-trash
  assert.ok(script.includes("$HOME/.Trash"), "missing trash backup");
});

check("renderInstallerScript: path with shell-sensitive chars stays escaped", () => {
  const script = renderInstallerScript({
    newAppPath: '/tmp/he"llo/Studio.app',
    oldAppPath: "/Applications/Has $var/Studio.app",
    expectedBundleId: "ai.hypeproof.studio",
    newVersion: "0.1.2",
    oldVersion: "0.1.1",
    logPath: "/tmp/log.log",
  });
  // Double quote inside path should be backslash-escaped
  assert.match(script, /NEW_APP="\/tmp\/he\\"llo/);
  // Dollar sign in path should be escaped (not interpreted as a var)
  assert.match(script, /OLD_APP="\/Applications\/Has \\\$var/);
});

// --- shouldShowBanner --------------------------------------------------

const AVAIL = {
  available: true,
  version: "0.1.2",
  downloadUrl: "...", releaseUrl: "...", notes: "", sizeBytes: 0,
};
const NOT_AVAIL = { ...AVAIL, available: false };
const NOW = 1779329977;
const WEEK = 7 * 24 * 3600;

check("shouldShowBanner: not available → false", () => {
  assert.equal(shouldShowBanner(NOT_AVAIL, {}, NOW), false);
});
check("shouldShowBanner: available, never dismissed → true", () => {
  assert.equal(shouldShowBanner(AVAIL, {}, NOW), true);
});
check("shouldShowBanner: dismissed yesterday → false", () => {
  assert.equal(shouldShowBanner(AVAIL, { "0.1.2": NOW - 24 * 3600 }, NOW), false);
});
check("shouldShowBanner: dismissed > 7 days ago → true (re-prompt)", () => {
  assert.equal(shouldShowBanner(AVAIL, { "0.1.2": NOW - WEEK - 1 }, NOW), true);
});
check("shouldShowBanner: different version dismissed → still show", () => {
  assert.equal(shouldShowBanner(AVAIL, { "0.1.1": NOW }, NOW), true);
});

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
