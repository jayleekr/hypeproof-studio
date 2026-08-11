// Smoke tests for the SDK native-binary resolution + integrity gate
// (#282 W4a, docs/sdk-bundling.md §5, REQ-M24). Pure — no vscode, no fs
// probes (all injected). Locks:
//   1. seededSdkBinaryPath — the ONE definition of the seeded location per
//      platform (the seed script must write exactly here);
//   2. resolveSdkBinary — resolution order: setting > HPS_SDK_BINARY env >
//      seeded (integrity-gated) > node_modules > unavailable;
//   3. isSeededBinaryTrusted — marker/size gate (seed-time sha512 is trusted
//      via the marker; runtime checks existence + executability + exact size
//      + coarse floor);
//   4. buildSdkQueryOptions — pathToClaudeCodeExecutable passed when resolved,
//      OMITTED otherwise (dev keeps node_modules resolution);
//   5. minor-safety unaffected — binary presence never widens tool policy;
//   6. pinned-manifest consistency — sdkBinaryManifest.ts ===
//      package-lock.json === scripts/seed-sdk-binary.sh (version + sha512).
// Run: node --experimental-strip-types test/sdk-binary.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const {
  buildSdkQueryOptions,
  isSeededBinaryTrusted,
  parseSdkBinaryMarker,
  profileToAgentOptions,
  resolveSdkBinary,
  sdkBinaryMarkerPath,
  seededSdkBinaryPath,
} = await import("../src/sdkCoachHelpers.ts");
const { SDK_BINARY_MANIFEST, SDK_BINARY_MIN_BYTES, SDK_BINARY_VERSION } = await import(
  "../src/sdkBinaryManifest.ts"
);

const profile = (tier, extra = {}) => ({ game: tier ? { template_tier: tier } : undefined, ...extra });

// ─── seededSdkBinaryPath — one path definition per platform ─────────────────
{
  assert.equal(
    seededSdkBinaryPath({ platform: "darwin", homeDir: "/Users/kid" }),
    `/Users/kid/Library/Application Support/HypeProof-Studio/sdk/${SDK_BINARY_VERSION}/claude`,
    "darwin path is app-support/HypeProof-Studio, versioned",
  );
  assert.equal(
    seededSdkBinaryPath({ platform: "win32", homeDir: "C:\\Users\\kid", env: {} }),
    `C:\\Users\\kid\\AppData\\Roaming\\HypeProof-Studio\\sdk\\${SDK_BINARY_VERSION}\\claude.exe`,
    "win32 defaults to AppData/Roaming + claude.exe",
  );
  assert.equal(
    seededSdkBinaryPath({
      platform: "win32",
      homeDir: "C:\\Users\\kid",
      env: { APPDATA: "D:\\Roaming" },
    }),
    `D:\\Roaming\\HypeProof-Studio\\sdk\\${SDK_BINARY_VERSION}\\claude.exe`,
    "win32 honors APPDATA",
  );
  assert.equal(
    seededSdkBinaryPath({ platform: "linux", homeDir: "/home/kid", env: {} }),
    `/home/kid/.config/HypeProof-Studio/sdk/${SDK_BINARY_VERSION}/claude`,
    "linux defaults to ~/.config",
  );
  assert.equal(
    seededSdkBinaryPath({ platform: "linux", homeDir: "/home/kid", env: { XDG_CONFIG_HOME: "/xdg" } }),
    `/xdg/HypeProof-Studio/sdk/${SDK_BINARY_VERSION}/claude`,
    "linux honors XDG_CONFIG_HOME",
  );
  assert.equal(
    seededSdkBinaryPath({ platform: "darwin", homeDir: "/Users/kid", version: "9.9.9" }),
    "/Users/kid/Library/Application Support/HypeProof-Studio/sdk/9.9.9/claude",
    "version segment isolates SDK releases (stale binary never resolves after a bump)",
  );
  assert.equal(
    sdkBinaryMarkerPath("/x/claude"),
    "/x/claude.verified.json",
    "marker sits next to the binary",
  );
}

// ─── marker parsing + the seeded integrity gate ──────────────────────────────
{
  const BOM = "\uFEFF"; // PS 5.1 Out-File -Encoding utf8 prefix
  const SIZE = 240_245_936; // plausible real binary size (doc §2.2)
  const marker = JSON.stringify({
    sdkVersion: SDK_BINARY_VERSION,
    size: SIZE,
    tarballSha512: "sha512-abc",
    verifiedAt: "2026-07-14T00:00:00Z",
  });
  const stat = { exists: true, executable: true, size: SIZE };

  assert.deepEqual(parseSdkBinaryMarker(marker), {
    sdkVersion: SDK_BINARY_VERSION,
    size: SIZE,
    tarballSha512: "sha512-abc",
    verifiedAt: "2026-07-14T00:00:00Z",
  });
  // Windows PowerShell 5.1 `Out-File -Encoding utf8` prefixes EF BB BF. The
  // marker written by an older seed-sdk-binary.ps1 must still parse, or the
  // seeded claude.exe is rejected and Studio silently drops to proxy-only.
  assert.deepEqual(
    parseSdkBinaryMarker(BOM + marker),
    {
      sdkVersion: SDK_BINARY_VERSION,
      size: SIZE,
      tarballSha512: "sha512-abc",
      verifiedAt: "2026-07-14T00:00:00Z",
    },
    "UTF-8 BOM (PS 5.1 Out-File) must not break the marker",
  );
  assert.deepEqual(
    isSeededBinaryTrusted({ stat, markerRaw: BOM + marker }),
    { ok: true },
    "a BOM-prefixed marker must still trust the seeded binary",
  );

  assert.equal(parseSdkBinaryMarker(null), null);
  assert.equal(parseSdkBinaryMarker("not json"), null);
  assert.equal(parseSdkBinaryMarker(JSON.stringify({ sdkVersion: "x" })), null, "missing fields");
  assert.equal(
    parseSdkBinaryMarker(JSON.stringify({ sdkVersion: "x", size: -1, tarballSha512: "sha512-a" })),
    null,
    "non-positive size rejected",
  );
  assert.equal(
    parseSdkBinaryMarker(JSON.stringify({ sdkVersion: "x", size: 1, tarballSha512: "md5-oops" })),
    null,
    "non-sha512 SRI rejected",
  );

  assert.deepEqual(isSeededBinaryTrusted({ stat, markerRaw: marker }), { ok: true });
  assert.equal(
    isSeededBinaryTrusted({ stat: { ...stat, exists: false }, markerRaw: marker }).ok,
    false,
    "absent binary",
  );
  assert.equal(
    isSeededBinaryTrusted({ stat: { ...stat, executable: false }, markerRaw: marker }).ok,
    false,
    "non-executable binary",
  );
  assert.equal(isSeededBinaryTrusted({ stat, markerRaw: null }).ok, false, "no marker → untrusted");
  assert.equal(
    isSeededBinaryTrusted({ stat: { ...stat, size: SIZE - 1 }, markerRaw: marker }).ok,
    false,
    "size drift vs seed-time marker → untrusted",
  );
  assert.equal(
    isSeededBinaryTrusted({
      stat: { exists: true, executable: true, size: 1024 },
      markerRaw: JSON.stringify({ sdkVersion: SDK_BINARY_VERSION, size: 1024, tarballSha512: "sha512-a" }),
    }).ok,
    false,
    "coarse floor: a tiny 'binary' is untrusted even with a matching marker",
  );
  assert.equal(
    isSeededBinaryTrusted({
      stat,
      markerRaw: JSON.stringify({ sdkVersion: "0.0.1", size: SIZE, tarballSha512: "sha512-a" }),
    }).ok,
    false,
    "marker for a different SDK version → untrusted",
  );
  assert.ok(SDK_BINARY_MIN_BYTES < SIZE, "floor stays below real binary sizes");
}

// ─── resolveSdkBinary — the REQ-M24 order matrix ─────────────────────────────
{
  const SIZE = 240_000_000;
  const goodMarker = JSON.stringify({
    sdkVersion: SDK_BINARY_VERSION,
    size: SIZE,
    tarballSha512: "sha512-abc",
  });
  const trustedSeed = {
    path: "/seed/claude",
    stat: { exists: true, executable: true, size: SIZE },
    markerRaw: goodMarker,
  };
  const base = {
    seeded: trustedSeed,
    nodeModulesAvailable: true,
    fileExists: () => true,
  };

  // 1. setting beats everything.
  assert.deepEqual(
    resolveSdkBinary({ ...base, settingPath: "/setting/claude", envPath: "/env/claude" }),
    { available: true, source: "setting", path: "/setting/claude" },
  );
  // 2. env beats seeded + node_modules.
  assert.deepEqual(resolveSdkBinary({ ...base, envPath: "/env/claude" }), {
    available: true,
    source: "env",
    path: "/env/claude",
  });
  // 3. trusted seeded beats node_modules.
  assert.deepEqual(resolveSdkBinary(base), {
    available: true,
    source: "seeded",
    path: "/seed/claude",
  });
  // 4. node_modules → NO explicit path (SDK's own lookup runs in dev).
  {
    const r = resolveSdkBinary({ ...base, seeded: undefined });
    assert.equal(r.available, true);
    assert.equal(r.source, "node-modules");
    assert.equal(r.path, undefined, "no pathToClaudeCodeExecutable for dev/node_modules");
  }
  // 5. nothing → unavailable with a reason trail (→ SdkUnavailableError → proxy fallback).
  {
    const r = resolveSdkBinary({
      settingPath: "/missing",
      envPath: "/also-missing",
      seeded: { ...trustedSeed, markerRaw: null },
      nodeModulesAvailable: false,
      fileExists: () => false,
    });
    assert.equal(r.available, false);
    assert.equal(r.reasons.length, 4, "every skipped tier leaves a diagnosable reason");
    assert.ok(r.reasons[0].includes("sdkBinaryPath"));
    assert.ok(r.reasons[1].includes("HPS_SDK_BINARY"));
    assert.ok(r.reasons[2].includes("marker"));
  }
  // A stale/missing setting FALLS THROUGH (never disables dev node_modules).
  {
    const r = resolveSdkBinary({
      settingPath: "/stale/claude",
      nodeModulesAvailable: true,
      fileExists: (p) => p !== "/stale/claude",
    });
    assert.equal(r.available, true);
    assert.equal(r.source, "node-modules");
  }
  // An untrusted seed (size drift) falls through too.
  {
    const r = resolveSdkBinary({
      ...base,
      seeded: { ...trustedSeed, stat: { exists: true, executable: true, size: SIZE - 7 } },
    });
    assert.equal(r.available, true);
    assert.equal(r.source, "node-modules");
  }
  // Whitespace/empty settings are "unset", not candidates.
  assert.equal(
    resolveSdkBinary({ ...base, settingPath: "  ", envPath: "" }).source,
    "seeded",
  );
}

// ─── buildSdkQueryOptions — pathToClaudeCodeExecutable threading ─────────────
{
  const workshop = profile("website", { sdk_tools: { read: true, write: true } });
  const agent = profileToAgentOptions(workshop, { model: "m", systemPrompt: "s" });
  const argsBase = { proxyUrl: "http://localhost:8787/v1", token: "t", baseEnv: {} };

  const withPath = buildSdkQueryOptions(agent, {
    ...argsBase,
    pathToClaudeCodeExecutable: "/seed/claude",
  });
  assert.equal(withPath.pathToClaudeCodeExecutable, "/seed/claude", "resolved path is passed to the SDK");

  const withoutPath = buildSdkQueryOptions(agent, argsBase);
  assert.ok(
    !("pathToClaudeCodeExecutable" in withoutPath),
    "no resolution → option OMITTED so the SDK's node_modules lookup runs (dev)",
  );
}

// ─── 바이너리 존재가 도구 정책을 바꾸지 않는다 (REQ-M18/M21/M23) ──────────────
// 시드된 바이너리는 CLI 가 **어디서** 도는지를 바꿀 뿐 코호트가 **무엇을** 할 수
// 있는지는 건드리지 않는다.
//
// 2026-08-11 — 이전에는 "아동은 무엇을 주든 tools: []" 였다. 지금은 도구 정책의
// owner 가 프로필이므로(ADR 0003) write 는 프로필이 열면 열린다. 대신 **아동에게
// 여전히 닫힌 것**(browser·subagents)으로 이 불변식을 검사한다 — 바이너리가
// 있어도 그 둘은 새어나오지 않아야 한다.
{
  const pollutedMinor = profile("kids-rich", {
    sdk_tools: { read: false, write: false, browser: true, subagents: true },
  });
  const agent = profileToAgentOptions(pollutedMinor, { model: "m", systemPrompt: "s" });
  const opts = buildSdkQueryOptions(agent, {
    proxyUrl: "http://localhost:8787/v1",
    token: "t",
    baseEnv: {},
    pathToClaudeCodeExecutable: "/seed/claude",
  });
  assert.deepEqual(
    opts.tools,
    [],
    "바이너리가 있어도 아동에게 browser/subagents 는 새지 않는다",
  );
  assert.equal(opts.agents, undefined, "no subagents for minors regardless of binary");
  assert.deepEqual(opts.allowedTools, [], "allowedTools stays [] (no auto-approve)");
  assert.equal(opts.pathToClaudeCodeExecutable, "/seed/claude");
  assert.deepEqual(agent.permittedMcpTools, [], "no browser MCP for minors regardless of binary");
}

// ─── pinned-manifest consistency: manifest === package-lock === seed script ──
{
  const lock = JSON.parse(readFileSync(join(here, "..", "package-lock.json"), "utf8"));
  const sdkLock = lock.packages["node_modules/@anthropic-ai/claude-agent-sdk"];
  assert.equal(
    SDK_BINARY_VERSION,
    sdkLock.version,
    "sdkBinaryManifest SDK_BINARY_VERSION must equal the locked @anthropic-ai/claude-agent-sdk version — bump them together",
  );

  for (const [key, entry] of Object.entries(SDK_BINARY_MANIFEST)) {
    const locked = lock.packages[`node_modules/${entry.packageName}`];
    assert.ok(locked, `${entry.packageName} present in package-lock.json (optionalDependency)`);
    assert.equal(locked.version, SDK_BINARY_VERSION, `${key}: lockfile version matches`);
    assert.equal(entry.sha512, locked.integrity, `${key}: manifest sha512 === lockfile integrity`);
    assert.equal(entry.url, locked.resolved, `${key}: manifest URL === lockfile resolved tarball URL`);
    assert.ok(entry.unpackedSize > SDK_BINARY_MIN_BYTES, `${key}: unpackedSize sane`);
  }

  // Seed script embeds the same pin (self-contained on venue machines).
  const script = readFileSync(join(here, "..", "..", "..", "scripts", "seed-sdk-binary.sh"), "utf8");
  const pinned = script.match(/^PINNED_VERSION="([^"]+)"/m);
  assert.ok(pinned, "seed script declares PINNED_VERSION");
  assert.equal(pinned[1], SDK_BINARY_VERSION, "seed script PINNED_VERSION matches the manifest");
  for (const [key, entry] of Object.entries(SDK_BINARY_MANIFEST)) {
    if (key.startsWith("linux") || key.startsWith("darwin") || key.startsWith("win32")) {
      assert.ok(
        script.includes(entry.sha512),
        `seed script embeds the pinned sha512 for ${key}`,
      );
    }
  }
  // The seeded destination in the script matches seededSdkBinaryPath (darwin).
  assert.ok(
    script.includes('$HOME/Library/Application Support/HypeProof-Studio/sdk/$VERSION'),
    "seed script darwin destination matches seededSdkBinaryPath",
  );
  assert.ok(
    script.includes('${XDG_CONFIG_HOME:-$HOME/.config}/HypeProof-Studio/sdk/$VERSION'),
    "seed script linux destination matches seededSdkBinaryPath",
  );
  assert.ok(script.includes('.verified.json'), "seed script writes the runtime-trusted marker");
}

console.log("sdk-binary.smoke: all assertions passed");
