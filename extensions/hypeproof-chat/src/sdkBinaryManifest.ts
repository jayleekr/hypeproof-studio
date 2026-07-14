// #282 W4a — pinned manifest for the Claude Agent SDK native `claude` binary
// (docs/sdk-bundling.md §5 sketch step 3). PURE constants: no `vscode`, no
// imports — a leaf module loadable standalone by the smoke tests.
//
// All values are PUBLIC (npm registry URLs + SRI integrity hashes) — no
// secrets, no SecretStorage. They are pinned to the exact SDK version in
// extensions/hypeproof-chat/package-lock.json; a smoke test
// (test/sdk-binary.smoke.mjs) fails the build if this table drifts from the
// lockfile, and scripts/seed-sdk-binary.sh embeds the same values (also
// locked by the smoke test). Bump this file ONLY together with the
// @anthropic-ai/claude-agent-sdk dependency — never float (doc §6 "Upstream
// layout drift").
//
// TRUST MODEL (doc §5 step 4 + W4a integrity gate):
// - The tarball's sha512 is verified ONCE, at seed time, against `sha512`
//   below (the same SRI value npm itself enforces via package-lock.json).
// - The seeder then writes a `<binary>.verified.json` marker recording the
//   verified size. At runtime we trust marker + exact size match + the
//   coarse SDK_BINARY_MIN_BYTES floor — re-hashing ~229 MiB on every coach
//   turn is too slow, and the threat model here is corruption/truncation,
//   not an attacker with write access to the user's own app-support dir
//   (who could equally rewrite the marker).

/**
 * The exact @anthropic-ai/claude-agent-sdk version whose platform binaries
 * this manifest describes. Must equal the version resolved in
 * package-lock.json (smoke-tested).
 */
export const SDK_BINARY_VERSION = "0.3.207";

export interface SdkBinaryManifestEntry {
  /** npm platform package that carries the binary. */
  packageName: string;
  /** Direct, unauthenticated registry tarball URL (doc §2.3). */
  url: string;
  /** SRI sha512 of the tarball — identical to package-lock integrity. */
  sha512: string;
  /**
   * Registry `dist.unpackedSize` for the platform package (4 files; the
   * `claude` binary dominates). Used only for operator-facing disk-size
   * messaging — the runtime size gate uses the seed-time marker, not this.
   */
  unpackedSize: number;
}

/** `<platform>-<arch>` keys matching Node's process.platform/process.arch. */
export const SDK_BINARY_MANIFEST: Readonly<Record<string, SdkBinaryManifestEntry>> = {
  "darwin-arm64": {
    packageName: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    url: `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-${SDK_BINARY_VERSION}.tgz`,
    sha512:
      "sha512-08xSo1FDx8h0aLhL5tvcRxa2SMmcUV3aDWeZiEJVTclyiDAs61BgTjAxCg+SZcu1CndjJO8cfO0yM5dhamxz3g==",
    unpackedSize: 241237720,
  },
  "darwin-x64": {
    packageName: "@anthropic-ai/claude-agent-sdk-darwin-x64",
    url: `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-x64/-/claude-agent-sdk-darwin-x64-${SDK_BINARY_VERSION}.tgz`,
    sha512:
      "sha512-1o7K4EYqyCixZ/oeOZSh7AzSy6TM86xoOuf4VuORjPSS31hBnoqY0NGZd27+2VDs9LGtsdksmsTqcNGx9xd1hA==",
    unpackedSize: 249274256,
  },
  "win32-x64": {
    packageName: "@anthropic-ai/claude-agent-sdk-win32-x64",
    url: `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-win32-x64/-/claude-agent-sdk-win32-x64-${SDK_BINARY_VERSION}.tgz`,
    sha512:
      "sha512-YPjVT0q6aXEM2MgN4CI6/9fqiTXwETji+4NoPOzCYuqAkhXZqp30Jsk7/NHqYGNNSfURKrsuAoliKB0rsbpbjg==",
    unpackedSize: 249486048,
  },
  "win32-arm64": {
    packageName: "@anthropic-ai/claude-agent-sdk-win32-arm64",
    url: `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-win32-arm64/-/claude-agent-sdk-win32-arm64-${SDK_BINARY_VERSION}.tgz`,
    sha512:
      "sha512-9fWpUzfkXlPAg2tf8JpQe7w9avFaomAUbfAwyAmykQgSIf66LwaJjvI5hNqhNqczRKyfsXPn3ei2S5HKlmFP+Q==",
    unpackedSize: 243953384,
  },
  "linux-x64": {
    packageName: "@anthropic-ai/claude-agent-sdk-linux-x64",
    url: `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64/-/claude-agent-sdk-linux-x64-${SDK_BINARY_VERSION}.tgz`,
    sha512:
      "sha512-Kg6BPH8Ee0ny/oEUWJmvT1jCRBne4jVpRSOMsJcYp1Fav1rMEgpU219oJJs+LWwx4ifuuLtNWedqJNnVw7mnKg==",
    unpackedSize: 259403141,
  },
  "linux-arm64": {
    packageName: "@anthropic-ai/claude-agent-sdk-linux-arm64",
    url: `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-arm64/-/claude-agent-sdk-linux-arm64-${SDK_BINARY_VERSION}.tgz`,
    sha512:
      "sha512-X4uezYOifDiNTTmmugfRCdg3nNamrr1LFRY9hg30vWYTShL+bbN+nfC3KaFfSYCl4GTtsEEUbYdOTC2F3bBpcA==",
    unpackedSize: 256228677,
  },
};

/**
 * Coarse floor for a plausible `claude` binary (every platform's real binary
 * is ~230–250 MB). Guards against a truncated download / corrupt marker even
 * if the marker's own size field was damaged the same way. Deliberately loose
 * — the EXACT check is `size === marker.size` (isSeededBinaryTrusted).
 */
export const SDK_BINARY_MIN_BYTES = 150 * 1024 * 1024;
