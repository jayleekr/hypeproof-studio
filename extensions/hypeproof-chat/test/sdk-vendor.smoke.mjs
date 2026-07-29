// Smoke tests for the SDK JS vendoring resolution (#282 W4b,
// docs/sdk-bundling.md §5 step 1, REQ-M25). Pure — no vscode, fileExists
// injected. Locks:
//   1. the vendored-entry subpaths loadSdk/loadZod join against __dirname (they
//      must match exactly what scripts/inject-builtin-extensions.sh writes);
//   2. resolveSdkModule/resolveZodModule — vendored (packaged) vs bare
//      specifier (dev/no-distDir); falls back correctly when absent;
//   3. the inject script actually vendors the JS closure into dist/vendor and
//      guards against shipping the 229 MB platform binary (build-time assertion
//      that the mechanism excludes the binary, mirroring sdk-binary.smoke's
//      seed-script content checks).
// Run: node --experimental-strip-types test/sdk-vendor.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const {
  resolveSdkModule,
  resolveZodModule,
  VENDORED_SDK_ENTRY_SUBPATH,
  VENDORED_ZOD_ENTRY_SUBPATH,
  SDK_JS_SPECIFIER,
} = await import("../src/sdkCoachHelpers.ts");

// ─── vendored-entry subpaths: the layout the inject script must produce ──────
{
  assert.equal(
    VENDORED_SDK_ENTRY_SUBPATH,
    "vendor/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    "SDK entry sits under dist/vendor/node_modules so Node resolves sdk.mjs's own ajv imports from the sibling tree",
  );
  assert.equal(
    VENDORED_ZOD_ENTRY_SUBPATH,
    "vendor/node_modules/zod/index.js",
    "zod ESM entry (v4 exports['.'].import)",
  );
  assert.equal(SDK_JS_SPECIFIER, "@anthropic-ai/claude-agent-sdk");
}

// ─── resolveSdkModule — vendored (packaged) vs node-modules (dev) ────────────
{
  const DIST = "/app/extensions/hypeproof-chat/dist";
  const vendoredEntry = join(DIST, VENDORED_SDK_ENTRY_SUBPATH);

  // (a) vendored copy present → absolute entry path, source "vendored".
  assert.deepEqual(
    resolveSdkModule({ distDir: DIST, fileExists: (p) => p === vendoredEntry }),
    { source: "vendored", entryPath: vendoredEntry },
    "packaged build: resolves the vendored sdk.mjs absolute path",
  );

  // (b) vendored copy absent → bare specifier (Node's node_modules lookup, dev).
  assert.deepEqual(
    resolveSdkModule({ distDir: DIST, fileExists: () => false }),
    { source: "node-modules", specifier: SDK_JS_SPECIFIER },
    "dev/standalone with a dist dir but no vendor: falls back to the bare specifier",
  );

  // (c) no distDir (ESM smoke / __dirname unavailable) → bare specifier even if
  //     fileExists would say yes (nothing to join against).
  assert.deepEqual(
    resolveSdkModule({ fileExists: () => true }),
    { source: "node-modules", specifier: SDK_JS_SPECIFIER },
    "no distDir → bare specifier",
  );

  // (d) custom specifier honored (test-seam parity with loadSdk).
  assert.equal(
    resolveSdkModule({ fileExists: () => false, specifier: "@scope/x" }).specifier,
    "@scope/x",
  );

  // (e) the joined vendored path is absolute + ends with the subpath — exactly
  //     what loadSdk feeds pathToFileURL at runtime.
  const r = resolveSdkModule({ distDir: DIST, fileExists: () => true });
  assert.equal(r.source, "vendored");
  // Portable oracles: resolveVendoredModule joins with path.join, so the
  // separator is the host platform's. `startsWith("/")` / `endsWith("/sdk.mjs")`
  // are POSIX-only spellings of these two facts and false-fail on Windows.
  assert.ok(isAbsolute(r.entryPath), "absolute path for the file:// URL");
  assert.equal(basename(r.entryPath), "sdk.mjs", "points at the SDK ESM entry");
  assert.equal(r.entryPath, join(DIST, VENDORED_SDK_ENTRY_SUBPATH), "under dist/vendor, not a bare name");
}

// ─── resolveZodModule — same contract ────────────────────────────────────────
{
  const DIST = "/app/dist";
  const zEntry = join(DIST, VENDORED_ZOD_ENTRY_SUBPATH);
  assert.deepEqual(
    resolveZodModule({ distDir: DIST, fileExists: (p) => p === zEntry }),
    { source: "vendored", entryPath: zEntry },
    "packaged build: resolves the vendored zod entry",
  );
  assert.deepEqual(
    resolveZodModule({ distDir: DIST, fileExists: () => false }),
    { source: "node-modules", specifier: "zod" },
    "dev: bare 'zod' (loadZod tolerates absence → browser-less)",
  );
  assert.deepEqual(
    resolveZodModule({ fileExists: () => true }),
    { source: "node-modules", specifier: "zod" },
    "no distDir → bare 'zod'",
  );
}

// ─── inject script: vendors the JS closure + guards against the binary ───────
{
  const script = readFileSync(
    join(here, "..", "..", "..", "scripts", "inject-builtin-extensions.sh"),
    "utf8",
  );
  assert.ok(script.includes("dist/vendor"), "inject script vendors into dist/vendor");
  assert.ok(
    script.includes("--omit=optional"),
    "vendor install omits optionalDependencies (the 229 MB platform binaries)",
  );
  assert.ok(
    script.includes("claude-agent-sdk@"),
    "vendor install pins the SDK version (from package-lock)",
  );
  assert.ok(
    /claude-agent-sdk-\*/.test(script),
    "inject script guards against a leaked platform-binary package",
  );
  assert.ok(
    script.includes("sdk.mjs"),
    "inject script asserts the vendored SDK entrypoint exists",
  );
  assert.ok(
    /-size \+50M/.test(script),
    "inject script guards against an oversized (binary) file in the vendor tree",
  );
  assert.ok(
    script.includes("typeof m.query"),
    "inject script imports the vendored SDK to prove the runtime closure is complete",
  );
  // The vendored destination in the script matches the runtime subpath.
  assert.ok(
    script.includes("node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"),
    "inject script's vendored SDK entry matches VENDORED_SDK_ENTRY_SUBPATH",
  );
  assert.ok(
    script.includes("node_modules/zod/index.js"),
    "inject script's vendored zod entry matches VENDORED_ZOD_ENTRY_SUBPATH",
  );
}

console.log("sdk-vendor.smoke: all assertions passed");
