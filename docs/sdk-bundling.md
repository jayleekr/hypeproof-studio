# SDK CLI binary bundling — decision pack (#282 Phase 2)

Status: **Implemented (W4a)** — option (b): binary resolution order + instructor
pre-seed + integrity gate shipped (see §7); in-app consent download flow and
SDK-JS vendoring into the built-in remain (W4b). Decided 2026-07-14.
Epic: [#282](https://github.com/jayleekr/hypeproof-studio/issues/282) · ADR: [adr/0003-agent-sdk-coach-runtime.md](adr/0003-agent-sdk-coach-runtime.md) · Trigger: PR #317

## 1. Problem

`@anthropic-ai/claude-agent-sdk` spawns a vendored native `claude` CLI binary
shipped as a platform `optionalDependency` (e.g.
`@anthropic-ai/claude-agent-sdk-darwin-arm64`, ~240 MB unpacked). Packaged
Studio builds exclude `node_modules` (`.vscodeignore` +
`scripts/inject-builtin-extensions.sh:46-50` copy only `package.json`, `dist/`,
`media/`, `webview-ui/dist/`), so today the SDK coach works only in dev; a
packaged build hits `SdkUnavailableError` and falls back to the proxy coach
(REQ-M7, `docs/studio-requirements.md`). This doc records how the binary
reaches student machines.

## 2. Empirical findings

All findings measured against `@anthropic-ai/claude-agent-sdk@0.3.208`
(`claudeCodeVersion: 2.1.208`), installed with optional deps and read directly
from the published `sdk.mjs` bundle.

### 2.1 How the SDK locates the CLI (read from `sdk.mjs`)

Resolution order, verbatim behavior:

1. **`options.pathToClaudeCodeExecutable`** — if set, used as-is, no further
   lookup (`let lh = d.pathToClaudeCodeExecutable; if (!lh) { … }`). The path
   is arbitrary; the SDK's own error strings document the
   binary-at-external-path case ("Claude Code native binary at ${e} exists but
   failed to launch … specify a matching binary with
   options.pathToClaudeCodeExecutable"). Paths not ending in
   `.js/.mjs/.ts/.tsx/.jsx` are treated as native binaries.
2. **Fallback**: `createRequire(import.meta.url).resolve()` over candidate
   packages `@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude[.exe]`
   plus `existsSync` (on Linux it orders glibc/musl variants via
   `process.report.getReport().header.glibcVersionRuntime`). This only works
   when the platform package sits in `node_modules` next to the SDK.
3. Neither → throws: "Native CLI binary for ${platform}-${arch} not found.
   Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set
   options.pathToClaudeCodeExecutable."

There is **no env-var override for the binary path** (the `CLAUDE_CODE_*` vars
in the bundle are runtime flags, none is a CLI path). Conclusion: **the binary
can live anywhere outside `node_modules`** — e.g. the extension's
`globalStorageUri` under `~/Library/Application Support/HypeProof-Studio/` —
as long as we pass `pathToClaudeCodeExecutable`.

Also load-bearing: **`sdk.mjs` is self-contained.** Grepping every import
specifier in the bundle yields only Node built-ins (`fs`, `child_process`,
`module`, `node:path`, …) — zod and the MCP SDK are inlined. So the 3.8 MB JS
package can be vendored into the built-in extension without carrying a
dependency tree; the listed `peerDependencies` are type-level for consumers.

### 2.2 Real sizes (measured)

| Item | Size |
|---|---|
| `@anthropic-ai/claude-agent-sdk` (JS package, unpacked) | 3.8 MB |
| `claude-agent-sdk-darwin-arm64` binary (`claude`, Mach-O arm64) | 240,245,936 B (~229 MiB) |
| `claude-agent-sdk-darwin-arm64` **tarball (actual download)** | **70,310,935 B (~67 MiB)** |
| `claude-agent-sdk-darwin-x64` unpacked (registry `dist.unpackedSize`) | 249,754,704 B |
| `claude-agent-sdk-win32-x64` unpacked (registry `dist.unpackedSize`) | 251,178,208 B |
| Studio `HypeProof-Studio-darwin-arm64.zip` today (release v0.1.16) | 167,185,011 B (~159 MiB) |

The platform tarball contains exactly 4 files (`claude`, `LICENSE.md`,
`package.json`, `README.md` — registry `fileCount: 4`).

### 2.3 Download-on-demand mechanism (verified end-to-end)

npm hosts per-platform tarballs at stable, direct, unauthenticated URLs:

```
https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-0.3.208.tgz
```

Integrity is pinned twice — in any consumer `package-lock.json` and in the
registry document (`dist.integrity`):

```
sha512-V58HJmQeVAyEa1ccYjDYe/YzLMfh2kABegPIuuF4umpBiveGyjxXSmWGPcMR+IHqDJjASCWCP17P3ka+YSFmcg==
```

Verified empirically: downloaded the tarball (70,310,935 B) and
`openssl dgst -sha512 -binary | base64` reproduced the lockfile hash exactly.

### 2.4 Signing facts (macOS)

The vendored binary is **already Developer-ID signed by Anthropic** with
hardened runtime (`codesign -dv`: `Identifier=com.anthropic.claude-code`,
`flags=0x10000(runtime)`). Extraction via npm/tar sets no
`com.apple.quarantine` xattr (only `com.apple.provenance` observed), and a
Node-side `fetch` + tar extraction does not tag quarantine either (only
LaunchServices/browser downloads do). A binary stored *outside* the `.app` and
spawned via `child_process` neither breaks nor depends on our app seal.

Conversely, our `scripts/sign-mac.sh` re-seals the app with
`codesign --force --deep --sign -` (ad-hoc): embedding the binary *inside* the
`.app` would **replace Anthropic's valid Developer-ID signature with our
ad-hoc one** on that nested Mach-O — strictly worse than leaving it external.

## 3. Options compared

| | (a) Bundle in app | (b) On-demand download + pre-seed + fallback | (c) Cohort-differentiated builds |
|---|---|---|---|
| darwin zip size | 167 MB → **~237 MB** (+70 MB compressed; +240 MB on disk) | unchanged (167 MB) | mixed: two artifact matrices |
| First SDK use | instant | one-time 67 MiB download (or pre-seeded → instant) | depends on cohort artifact |
| Auto-update cost | every Studio release re-ships ~70 MB of unchanged binary (updater downloads whole zip, #206) | zero — binary versioned independently | (a)'s cost for SDK cohorts |
| Signing | `--deep` ad-hoc re-sign clobbers Anthropic's Developer-ID signature | binary keeps Anthropic's signature; app seal untouched | same problem as (a) |
| Offline venue | works | needs instructor pre-seed (script below); else proxy coach | works for SDK cohorts |
| Redistribution posture | we redistribute Anthropic's binary inside our artifact | user machine pulls from npm, same channel as `npm install` | we redistribute (SDK cohorts) |
| Complexity | build + sign + verify-branding churn, ×3 platforms | download/verify module + seed script | **highest**: doubled CI matrix, forked release checklist + verify-branding, per-cohort release ops — and still inherits (a)'s signing issue |
| Failure mode | none (binary always present) | binary absent → existing REQ-M7 proxy fallback (already shipped, tested) | wrong artifact handed to wrong cohort |

## 4. Decision

**Pre-agreed rule** (recorded here as applied): default to **(b)**; switch to
(a) only if research shows (b) infeasible — i.e. no direct tarball URL, binary
not relocatable/pointable, or integrity not verifiable.

**Feasibility check for (b) — all pass, empirically:**

1. Direct tarball URL — **yes** (§2.3, downloaded from registry.npmjs.org).
2. Binary relocatable — **yes** (§2.1, `pathToClaudeCodeExecutable` checked
   first, arbitrary path, no node_modules requirement).
3. Integrity verifiable — **yes** (§2.3, sha512 reproduced against lockfile
   and registry `dist.integrity`).

**Outcome: option (b).** Bonus factors, not needed for the rule but
confirming: (a) would degrade the binary's signature (§2.4) and permanently
tax every auto-update; (c) adds the most operational surface for the least
benefit and still inherits (a)'s signing problem.

## 5. Implementation sketch (W4)

Ship in the W4 work item of #282 Phase 2; this PR is docs-only.

1. **Vendor the SDK JS (3.8 MB) into the built-in extension.**
   `scripts/inject-builtin-extensions.sh` additionally copies
   `node_modules/@anthropic-ai/claude-agent-sdk/` (JS package only, no
   platform optionalDeps) into the injected extension;
   `loadSdk()` (`extensions/hypeproof-chat/src/sdkCoach.ts:89`) tries the bare
   specifier (dev) then the vendored path (packaged). Safe because `sdk.mjs`
   imports only Node built-ins (§2.1).
2. **Binary path override.** New pure helper in
   `extensions/hypeproof-chat/src/sdkCoachHelpers.ts` resolving
   `<globalStorageUri>/sdk/<sdkVersion>/claude[.exe]`;
   `buildSdkQueryOptions()` (currently `sdkCoachHelpers.ts:160`) passes it as
   `pathToClaudeCodeExecutable` when the file exists, otherwise omits it so
   dev keeps node_modules resolution. Unit tests per the existing
   pure/orchestration split.
3. **Pinned manifest, SecretStorage-free.** A checked-in constant table
   `{ sdkVersion, platform → { url, sha512, size } }` — all values public
   (registry URL + integrity hash), no secrets, no SecretStorage. An extension
   build check fails if `sdkVersion` disagrees with the
   `@anthropic-ai/claude-agent-sdk` version in `package.json`.
4. **Download flow (extension host).** Explicit user consent (size + disk
   warning) → fetch tarball to temp under globalStorage → verify sha512
   against the pinned manifest → extract `package/claude` → `chmod 755` →
   atomic rename into the versioned dir → progress UI. Any failure degrades
   to the proxy coach exactly as today (REQ-M7 unchanged).
5. **Instructor pre-seed: `scripts/seed-sdk-binary.sh`.** zsh-compatible.
   Modes: (i) networked venue machine — download + verify + install to the
   same globalStorage path; (ii) air-gapped — consume a USB-carried tarball
   (`--tarball <path>`), verify the same pinned sha512, install. Idempotent;
   prints the resolved path and hash on success. Run during venue setup
   (D-3 rehearsal checklist).
6. **Docs/tests follow-up in W4** (not this PR): REQ row(s) for binary
   provisioning in `docs/studio-requirements.md`; runbook line for the seed
   step; release-E2E check that a packaged build with a seeded binary runs an
   SDK turn.

## 6. Risks

- **Version skew** — the binary must match the SDK JS (`claudeCodeVersion`
  pinned in the SDK's package.json). Mitigation: the manifest/dependency
  consistency check in sketch step 3; seed script takes its version from the
  same manifest.
- **Registry reachability at venues** — mitigated by pre-seed; if a venue
  blocks npmjs.org and no seed happened, students silently get the proxy
  coach (acceptable, REQ-M7).
- **Gatekeeper edge cases** — signature and quarantine facts are favorable
  (§2.4), but must be rehearsed on a real venue macOS before the first
  SDK-backed workshop (release E2E discipline).
- **Disk** — +240 MB per student machine (+251 MB win32); consent prompt in
  sketch step 4.
- **Upstream layout drift** — a future SDK release could rename the platform
  packages or tarball layout; the pinned manifest isolates us (we bump it
  deliberately with the SDK dependency, never float).
- **Licensing** — Anthropic Commercial Terms govern the SDK (ADR 0003); (b)
  keeps distribution on npm's own channel rather than redistributing the
  binary inside our artifact. Re-confirm alongside the shared-classroom-key
  licensing item already tracked in ADR 0003 before the first SDK workshop.

## 7. Implementation status (W4a, 2026-07-14)

Shipped (REQ-M24, `docs/studio-requirements.md`):

- **Resolution order** (`sdkCoachHelpers.resolveSdkBinary`, pure + unit-tested;
  host probes in `sdkCoach.resolveSdkBinaryForHost`):
  1. `hypeproofChat.sdkBinaryPath` setting (explicit override, used if the
     file exists);
  2. `HPS_SDK_BINARY` env var (e2e/CI seam, same contract);
  3. seeded location — `seededSdkBinaryPath` is the ONE definition:
     darwin `~/Library/Application Support/HypeProof-Studio/sdk/<version>/claude`,
     win32 `%APPDATA%\HypeProof-Studio\sdk\<version>\claude.exe`,
     linux `${XDG_CONFIG_HOME:-~/.config}/HypeProof-Studio/sdk/<version>/claude`
     — accepted only when the seed-time `.verified.json` marker checks out
     (exists + executable + exact size + coarse floor; the full sha512 runs
     once at seed time, not per launch — trust model in `sdkBinaryManifest.ts`);
  4. node_modules (dev): no `pathToClaudeCodeExecutable` is passed, the SDK's
     own optionalDependency lookup runs;
  5. nothing → `SdkUnavailableError` → proxy coach (REQ-M7, unchanged).
- **Pinned manifest** — `extensions/hypeproof-chat/src/sdkBinaryManifest.ts`
  (version + per-platform URL/sha512/unpackedSize), smoke-locked to
  `package-lock.json` AND to the seed script's embedded pins
  (`test/sdk-binary.smoke.mjs`). Note: the lockfile pins **0.3.207** — the
  §2 measurements were taken on 0.3.208; the 0.3.207 values in the manifest
  were re-verified against the registry (`dist.integrity`/`unpackedSize`).
- **Instructor pre-seed** — `scripts/seed-sdk-binary.sh` (zsh-compatible):
  direct registry download (no npm/node on the venue machine), sha512 verify
  (openssl/shasum), extract `package/claude`, chmod 755, write marker,
  idempotent re-run, `--tarball` for air-gapped venues, `--force`, `--version`
  (non-pinned versions fetch `dist.integrity` from the registry). Verified
  end-to-end on darwin-arm64 (download → hash match → extracted binary
  answers `--version` → second run no-ops).
- Binary presence never widens tool policy — a minor cohort still gets
  `tools: []` with a binary resolved (smoke-locked).

Deferred to W4b:

- Sketch step 1 (vendor the 3.8 MB SDK JS into the injected built-in +
  `loadSdk()` vendored-path fallback) — until it lands, a **packaged** build
  still falls back to the proxy coach even with a seeded binary, because the
  SDK JS itself only resolves from node_modules (dev). The seeded binary is
  exercised today via dev hosts and `HPS_SDK_BINARY`-driven e2e.
- Sketch step 4 (in-app consent download flow + progress UI).
- Release-E2E check that a packaged build with a seeded binary runs an SDK
  turn; runbook/D-3 rehearsal line for the seed step.
