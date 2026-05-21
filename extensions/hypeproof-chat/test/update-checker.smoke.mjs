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

// --- detectAppBundle ----------------------------------------------------

check("detectAppBundle: standard /Applications path", () => {
  const result = detectAppBundle("/Applications/HypeProof Studio.app/Contents/MacOS/Electron");
  assert.equal(result, "/Applications/HypeProof Studio.app");
});
check("detectAppBundle: dev path with .app", () => {
  const result = detectAppBundle("/Users/jay/dev/build/HypeProof Studio.app/Contents/MacOS/Electron");
  assert.equal(result, "/Users/jay/dev/build/HypeProof Studio.app");
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
