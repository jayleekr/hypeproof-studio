// Smoke tests for the manifest security hardening (#282 W4a, REQ-M24).
// A workspace-settable executable path or gateway URL = RCE / coach-hijack in a
// minor-facing product. These locks assert the security-sensitive settings stay
// machine-scoped (user/machine settings only — NOT workspace/folder overridable)
// and that the untrustedWorkspaces capability lists them as restricted, so the
// hardening cannot regress silently.
// Run: node --experimental-strip-types test/manifest-security-scope.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));

// Settings that select an executable, a trusted endpoint, or the approval gate
// itself. Each MUST be machine-scoped so a shared/malicious repo's
// .vscode/settings.json cannot set it.
const MACHINE_SCOPED = [
  "hypeproofChat.sdkBinaryPath",
  "hypeproofChat.coachRuntime",
  "hypeproofChat.proxyUrl",
  "hypeproofChat.requireApprovalFor",
];

const props = pkg.contributes?.configuration?.properties ?? {};

for (const key of MACHINE_SCOPED) {
  assert.ok(props[key], `${key} declared in contributes.configuration.properties`);
  assert.equal(
    props[key].scope,
    "machine",
    `${key} must be scope:"machine" (workspace-settable executable/gateway/approval = RCE)`,
  );
}

// The untrustedWorkspaces capability is defense-in-depth: 'limited' support
// (the coach runs shell/SDK — never declare full 'true') plus every
// security-sensitive setting listed as restricted.
const caps = pkg.capabilities?.untrustedWorkspaces;
assert.ok(caps, "capabilities.untrustedWorkspaces declared");
assert.equal(caps.supported, "limited", "runs shell/SDK → 'limited', never full 'true' support");
const restricted = new Set(caps.restrictedConfigurations ?? []);
for (const key of MACHINE_SCOPED) {
  assert.ok(
    restricted.has(key),
    `${key} listed in untrustedWorkspaces.restrictedConfigurations`,
  );
}

console.log("manifest-security-scope.smoke: all assertions passed");
