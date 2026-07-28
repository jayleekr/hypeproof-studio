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

// --- Approval policy lock (#499) ---------------------------------------
// The manifest `default` IS the policy. VS Code only falls back to the
// getConfiguration() second argument when the manifest declares no default —
// which it does, so the code-side array is unreachable. #499: the code was
// updated for #464 and the manifest was not, so writeFile still opened a modal
// and browserType (fully wired: sdkCoachHelpers.ts, protocol.ts, APPROVAL_COPY)
// was never in the policy → auto-allowed every time. items.enum matters too:
// a kind missing there cannot be toggled from the Settings UI.
//
// 아래 층까지 확인해 둔다 (리뷰 #501 — 매번 다시 파지 않도록). 이 목록에 넣어도
// **한 층 아래가 `allow` 를 돌려주면 무효**다. 확인 결과 3층이 다 연결돼 있다:
//   1. sdkCoachHelpers.ts — MCP_BROWSER_CLICK | MCP_BROWSER_TYPE → { decision: "ask" }
//      (browser_read/screenshot 는 "allow" 로 자동 허용, 의도대로다)
//   2. protocol.ts ActionRequest.kind 에 "browserType" 존재
//   3. chatPanelProvider.ts APPROVAL_COPY.browserType 한국어 문구 존재
// browserClick 은 `ask` 로 올라온 뒤 이 목록에 없어 Tier 3 에서 자동 허용된다 —
// 의도된 동작이다(같은 페이지 안의 검증 행위).
const EXPECTED_APPROVAL = ["executeShell", "openBrowser", "delegateAgent", "browserType"];

const approval = props["hypeproofChat.requireApprovalFor"];
assert.deepEqual(
  [...(approval.default ?? [])].sort(),
  [...EXPECTED_APPROVAL].sort(),
  "requireApprovalFor.default is the effective policy — writeFile out (#464), browserType in (#499)",
);
assert.deepEqual(
  [...(approval.items?.enum ?? [])].sort(),
  [...EXPECTED_APPROVAL, "writeFile"].sort(),
  "items.enum must offer every gateable kind (incl. writeFile as an opt-in) or Settings UI cannot set it",
);

console.log("manifest-security-scope.smoke: all assertions passed");
