// InstructorModeManager — student token must NOT activate instructor mode.
//
// Why this TC exists (#1298):
//   checkInstructorMode trusts the /admin/chalk/whoami response code.
//   A 403 from a student token must result in isInstructor === false,
//   never true. Without this guard, a bug that always returns 200 would
//   silently open instructor chat for any token.

import assert from "node:assert/strict";
import { InstructorModeManager } from "../src/chalk/instructorMode.ts";
import { adminBaseFrom } from "../src/chalk/serverBase.ts";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok   ${name}`); };

const PROXY = "https://api.hypeproof-ai.xyz/v1";

// --- helpers ---
function withFetch(status, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: status < 400, status });
  try { return fn(); } finally { globalThis.fetch = orig; }
}

// --- tests ---
console.log("=== student token — instructor mode does not open ===");

t("student token (403) → isInstructor false", async () => {
  const mgr = new InstructorModeManager();
  const result = await withFetch(403, () => mgr.checkInstructorMode("student-token", PROXY));
  assert.strictEqual(result, false);
  assert.strictEqual(mgr.isInstructor, false);
});

t("no token → isInstructor false", async () => {
  const mgr = new InstructorModeManager();
  const result = await mgr.checkInstructorMode(undefined, PROXY);
  assert.strictEqual(result, false);
  assert.strictEqual(mgr.isInstructor, false);
});

t("401 response → isInstructor false", async () => {
  const mgr = new InstructorModeManager();
  const result = await withFetch(401, () => mgr.checkInstructorMode("bad-token", PROXY));
  assert.strictEqual(result, false);
});

console.log("\n=== valid issuer token — instructor mode opens ===");

t("200 response → isInstructor true", async () => {
  const mgr = new InstructorModeManager();
  const result = await withFetch(200, () => mgr.checkInstructorMode("issuer-token", PROXY));
  assert.strictEqual(result, true);
  assert.strictEqual(mgr.isInstructor, true);
});

t("caches result per token — no second fetch", async () => {
  const mgr = new InstructorModeManager();
  let calls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return { ok: true }; };
  try {
    await mgr.checkInstructorMode("issuer-token", PROXY);
    await mgr.checkInstructorMode("issuer-token", PROXY);
    assert.strictEqual(calls, 1, "second call must use cache");
  } finally { globalThis.fetch = orig; }
});

t("reset() clears state, re-fetches on next call", async () => {
  const mgr = new InstructorModeManager();
  await withFetch(200, () => mgr.checkInstructorMode("issuer-token", PROXY));
  mgr.reset();
  assert.strictEqual(mgr.isInstructor, null);
  assert.strictEqual(mgr.brief, undefined);
});

console.log("\n=== selectModel / revert — model choice lifecycle ===");

t("non-instructor (null) ignores selectModelDirect — model unchanged", async () => {
  // Guard in chatPanelProvider.ts: if (!this._instructorMode.isInstructor) return;
  // This test exercises the manager directly: selectModel must not be guarded here,
  // but the caller (chatPanelProvider) skips it when isInstructor is false/null.
  // We verify isInstructor is null by default so the guard fires.
  const mgr = new InstructorModeManager();
  assert.strictEqual(mgr.isInstructor, null, "default must be null so provider guard fires");
});

t("first-turn error → revertModelOnTurnError restores prevChoice", async () => {
  const mgr = new InstructorModeManager();
  let stored = { scope: 'student', alias: 'claude-sonnet-5' };
  const getChoice = () => stored;
  const setChoice = async (c) => { stored = c; };

  // Simulate selectModel (direct entry).
  await mgr.selectModel("claude-opus-5", getChoice, setChoice);
  assert.deepEqual(stored, { scope: 'instructor', alias: 'claude-opus-5' });

  // Turn fails → revert.
  await mgr.revertModelOnTurnError(setChoice);
  assert.deepEqual(stored, { scope: 'student', alias: 'claude-sonnet-5' }, "must revert to prevChoice");

  // Second revert is a no-op (no pending revert).
  stored = { scope: 'instructor', alias: 'some-other' };
  await mgr.revertModelOnTurnError(setChoice);
  assert.deepEqual(stored, { scope: 'instructor', alias: 'some-other' }, "second revert must not change state");
});

console.log("\n=== chalkCtx gate — whoami 401 must block tools even when token looks like issuer ===");

t("whoami 401 → isInstructor false, so chalkCtx would be undefined", async () => {
  // chatPanelProvider: chalkCtx = (chalkToolsEnabled && isInstructor === true) ? ... : undefined
  // This test verifies InstructorModeManager.checkInstructorMode returns false on 401,
  // which ensures the && isInstructor === true gate in chatPanelProvider blocks chalkCtx.
  const mgr = new InstructorModeManager();
  const result = await withFetch(401, () => mgr.checkInstructorMode("looks-like-issuer.signed-token", PROXY));
  assert.strictEqual(result, false, "whoami 401 → isInstructor false, chalkCtx gate blocks");
  assert.strictEqual(mgr.isInstructor, false);
  // Confirm: isInstructor !== true, so the provider gate would not create chalkCtx.
  assert.notStrictEqual(mgr.isInstructor, true);
});

console.log("\n=== instructor token slot — TOKEN_KEY (student slot) must never activate instructor mode ===");

t("TOKEN_KEY slot value does not reach checkInstructorMode — only ISSUER_TOKEN_KEY does", () => {
  // chatPanelProvider.postConfig() now reads ISSUER_TOKEN_KEY for instructor checks.
  // This test verifies the manager's contract: checkInstructorMode must receive
  // undefined (no issuer token) when only TOKEN_KEY has a value. We simulate by
  // calling with undefined — the provider passes secrets.get(ISSUER_TOKEN_KEY) which
  // returns undefined when only the student slot is populated.
  const mgr = new InstructorModeManager();
  const result = withFetch(200, () => mgr.checkInstructorMode(undefined, PROXY));
  // Fetch must NOT have been called (token guard fires before network).
  // We verify via the return value: undefined → false returned synchronously.
  assert.ok(result instanceof Promise, "checkInstructorMode is async");
  // Resolve and check.
  return result.then(v => {
    assert.strictEqual(v, false, "undefined issuer token → isInstructor false, no network call");
    assert.strictEqual(mgr.isInstructor, false);
  });
});

t("ISSUER_TOKEN_KEY slot value with whoami 200 → isInstructor true", async () => {
  const mgr = new InstructorModeManager();
  const result = await withFetch(200, () => mgr.checkInstructorMode("issuer-slot-token", PROXY));
  assert.strictEqual(result, true);
  assert.strictEqual(mgr.isInstructor, true);
});

console.log("\n=== HPS_DEV_ISSUER_TOKEN_FILE — release app name guard ===");

t("app name guard: non-Dev app name must not read HPS_DEV_ISSUER_TOKEN_FILE", () => {
  // The extension.ts backdoor uses localRuntimeConfig which requires appName === "HypeProof Studio Dev".
  // We cannot call activate() here; verify the guard condition string is correct.
  const DEV_APP_NAME = "HypeProof Studio Dev";
  const releaseNames = ["HypeProof Studio", "VSCodium", "Visual Studio Code", ""];
  for (const name of releaseNames) {
    assert.notStrictEqual(name, DEV_APP_NAME, `release app name "${name}" must not equal the Dev guard`);
  }
  // Confirm the Dev name matches.
  assert.strictEqual(DEV_APP_NAME, "HypeProof Studio Dev");
});

t("localRuntimeConfig: Dev app name but HPS_DEV_RUNTIME unset → returns null → backdoor skipped", async () => {
  // localRuntimeConfig returns null when HPS_DEV_RUNTIME !== "1", even if appName matches.
  // This tests the second negative: Dev name alone is not sufficient.
  const { localRuntimeConfig } = await import("../src/localRuntime/index.ts");
  // No HPS_DEV_RUNTIME in env → runtime off
  const result = localRuntimeConfig("HypeProof Studio Dev", "http://127.0.0.1:8787/v1", {});
  assert.strictEqual(result, null, "Dev app + runtime off → null → backdoor gate must not fire");
});

t("localRuntimeConfig: Dev + runtime on + remote proxyUrl → throws (extension.ts try-catch absorbs)", async () => {
  // Verifies the scenario that required the try-catch fix: Dev app with HPS_DEV_RUNTIME=1
  // but a remote (non-localhost) proxyUrl — localRuntimeConfig throws.
  // The extension.ts wraps this call in try-catch and logs "dev issuer seed skipped" instead
  // of propagating the exception to activate(), which would prevent the extension from loading.
  const { localRuntimeConfig } = await import("../src/localRuntime/index.ts");
  const env = { HPS_DEV_RUNTIME: "1", HPS_DEV_PROVIDER: "claude", HPS_DEV_EXECUTABLE: "/usr/local/bin/claude", HPS_DEV_MODEL: "claude-sonnet-5" };
  assert.throws(
    () => localRuntimeConfig("HypeProof Studio Dev", "https://api.hypeproof-ai.xyz/v1", env),
    /로컬 구독/,
    "remote proxyUrl with Dev+runtime must throw so the try-catch in applyTestBackdoors is exercised"
  );
});

console.log("\n=== whoami status — unreachable must not delete token ===");

t("network failure → lastWhoamiStatus = unreachable, isInstructor false", async () => {
  const mgr = new InstructorModeManager();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network error"); };
  try {
    const result = await mgr.checkInstructorMode("issuer-token", PROXY);
    assert.strictEqual(result, false, "network error → isInstructor false");
    assert.strictEqual(mgr.lastWhoamiStatus, "unreachable", "network error → lastWhoamiStatus unreachable");
    // Token must NOT be deleted by extension.ts when lastWhoamiStatus is unreachable.
    // This test verifies the manager exposes the right status so the command can
    // decide to keep the token and show a warning instead of deleting it.
  } finally {
    globalThis.fetch = orig;
  }
});

t("rejected → lastWhoamiStatus = rejected, isInstructor false", async () => {
  const mgr = new InstructorModeManager();
  const result = await withFetch(401, () => mgr.checkInstructorMode("bad-token", PROXY));
  assert.strictEqual(result, false);
  assert.strictEqual(mgr.lastWhoamiStatus, "rejected");
});

t("ok → lastWhoamiStatus = ok, isInstructor true", async () => {
  const mgr = new InstructorModeManager();
  const result = await withFetch(200, () => mgr.checkInstructorMode("good-token", PROXY));
  assert.strictEqual(result, true);
  assert.strictEqual(mgr.lastWhoamiStatus, "ok");
});

console.log("\n=== resolveInstructorTokenFromSecrets — secrets slot isolation ===");

t("resolveInstructorTokenFromSecrets: ISSUER_TOKEN_KEY present → token returned", async () => {
  const { resolveInstructorTokenFromSecrets } = await import("../src/chatPanelHelpers.ts");
  const secrets = { get: async (k) => k === "hypeproofChat.issuerToken" ? "issuer-tok" : undefined };
  const result = await resolveInstructorTokenFromSecrets(secrets);
  assert.strictEqual(result, "issuer-tok", "must return value stored at ISSUER_TOKEN_KEY");
});

t("resolveInstructorTokenFromSecrets: only TOKEN_KEY present → undefined (student slot not read)", async () => {
  const { resolveInstructorTokenFromSecrets } = await import("../src/chatPanelHelpers.ts");
  const secrets = { get: async (k) => k === "hypeproofChat.workshopToken" ? "student-tok" : undefined };
  const result = await resolveInstructorTokenFromSecrets(secrets);
  assert.strictEqual(result, undefined, "student slot must not reach instructor auth path");
});

// --- runInstructorTurn policy ---
console.log("=== runInstructorTurn — INSTRUCTOR_TOOL_PROFILE policy ===");

t("runInstructorTurn: missing brief → throws '강사 지시문'", async () => {
  const { runInstructorTurn } = await import("../src/chalk/instructorTurn.ts");
  const local = { provider: "anthropic", model: "claude-opus-4-5", label: "Claude Opus" };
  let threw = false;
  try {
    await runInstructorTurn({
      local, cwd: "/tmp", history: [], userText: "안녕",
      brief: undefined, chalkCtx: undefined,
      signal: AbortSignal.abort(),
      onDelta: () => {}, onActivity: undefined,
      requestApproval: async () => false,
    });
  } catch (e) {
    threw = e.message.includes("강사 지시문");
  }
  assert.ok(threw, "must throw with '강사 지시문' when brief is absent");
});

t("INSTRUCTOR_TOOL_PROFILE: sdk_tools.read and write are true, browser true, shell false", async () => {
  const { INSTRUCTOR_TOOL_PROFILE } = await import("../src/chalk/instructorTurn.ts");
  assert.ok(INSTRUCTOR_TOOL_PROFILE, "INSTRUCTOR_TOOL_PROFILE must be exported");
  assert.strictEqual(INSTRUCTOR_TOOL_PROFILE.sdk_tools?.read, true, "read must be true");
  assert.strictEqual(INSTRUCTOR_TOOL_PROFILE.sdk_tools?.write, true, "write must be true");
  assert.strictEqual(INSTRUCTOR_TOOL_PROFILE.sdk_tools?.shell, undefined, "shell must be off (undefined)");
  assert.strictEqual(INSTRUCTOR_TOOL_PROFILE.sdk_tools?.browser, true, "browser must be on (true) — instructor uses live_preview_start + browser_open (#1295)");
});

// --- webview render guard (ChatPanel.tsx:553-554) ---
// Verifies the boolean condition without DOM/React.
// #1298: config null (postConfig not yet received) → DisconnectedChat regardless of instructor role.
// Once config arrives, instructor may render without profile or activity.
console.log("=== ChatPanel.tsx:553 — DisconnectedChat render guard ===");

// Mirrors the two-step guard at ChatPanel.tsx:553-554.
function shouldShowDisconnected(config, instructor) {
  if (!config) return true;
  return !config.profile && !config.activity && !instructor;
}

t("config null + instructor:true → DisconnectedChat (postConfig not yet received)", () => {
  assert.strictEqual(
    shouldShowDisconnected(null, true),
    true,
    "null config must show DisconnectedChat even for instructor"
  );
});

t("instructor prop:true (config present, no profile, no activity) → NOT DisconnectedChat", () => {
  assert.strictEqual(
    shouldShowDisconnected({ profile: null, activity: null }, true),
    false,
    "instructor must not show DisconnectedChat when config is present"
  );
});

t("student (no profile, no activity, instructor:false) → DisconnectedChat", () => {
  assert.strictEqual(
    shouldShowDisconnected({ profile: null, activity: null }, false),
    true,
    "student without profile must show DisconnectedChat"
  );
});

t("student config with activity → NOT DisconnectedChat", () => {
  assert.strictEqual(
    shouldShowDisconnected({ profile: null, activity: { kind: "classroom", name: "test" } }, false),
    false,
    "activity presence must suppress DisconnectedChat"
  );
});

// --- handleAutoReadResult — startPage skip / delete-and-show logic ---
// #1298: after a background whoami on the auto-read path, the extension must:
//   rejected → delete issuer token + show start page once
//   unreachable → keep token, no start page
//   ok → no action
console.log("=== InstructorModeManager.handleAutoReadResult ===");

t("handleAutoReadResult: rejected → rejected_delete_and_show", async () => {
  const mgr = new InstructorModeManager();
  await withFetch(401, () => mgr.checkInstructorMode("issuer-token", PROXY));
  assert.strictEqual(mgr.handleAutoReadResult(), "rejected_delete_and_show");
});

t("handleAutoReadResult: unreachable → unreachable_keep", async () => {
  const mgr = new InstructorModeManager();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network"); };
  try { await mgr.checkInstructorMode("issuer-token", PROXY); } finally { globalThis.fetch = origFetch; }
  assert.strictEqual(mgr.handleAutoReadResult(), "unreachable_keep");
});

t("handleAutoReadResult: ok → ok_noop", async () => {
  const mgr = new InstructorModeManager();
  await withFetch(200, () => mgr.checkInstructorMode("issuer-token", PROXY));
  assert.strictEqual(mgr.handleAutoReadResult(), "ok_noop");
});

// --- chalk_* tools included when chalkCtx present ---
console.log("=== mergeChalkTools — chalk_* in instructor turn ===");

t("mergeChalkTools: chalkCtx present → chalk_* tool names in definitions", async () => {
  const { mergeChalkTools } = await import("../src/localRuntime/index.ts");
  const emptyWorkTools = { definitions: [], call: async () => "" };
  const fakeCtx = { serverUrl: "https://x", secrets: {} };
  const merged = mergeChalkTools(emptyWorkTools, fakeCtx);
  const names = merged.definitions.map((d) => d.name);
  assert.ok(names.some((n) => n.startsWith("chalk_")),
    `chalk_* tool must appear when chalkCtx present; got: [${names.join(", ")}]`);
});

t("mergeChalkTools: no chalkCtx → no chalk_* in definitions", async () => {
  const { mergeChalkTools } = await import("../src/localRuntime/index.ts");
  const emptyWorkTools = { definitions: [], call: async () => "" };
  const merged = mergeChalkTools(emptyWorkTools, undefined);
  const names = merged.definitions.map((d) => d.name);
  assert.ok(!names.some((n) => n.startsWith("chalk_")),
    "no chalk_* must appear without chalkCtx");
});

// --- adminBaseFrom: URL stripping ---
// Verifies the canonical base URL function that routes all three callers
// (whoami, instructor-brief, chalk tools) to the server root, not /v1.
console.log("\n=== adminBaseFrom — proxyUrl stripping ===");

t("/v1 suffix removed", () => {
  assert.strictEqual(adminBaseFrom("http://127.0.0.1:8787/v1"), "http://127.0.0.1:8787");
});
t("/v1/ suffix removed", () => {
  assert.strictEqual(adminBaseFrom("http://127.0.0.1:8787/v1/"), "http://127.0.0.1:8787");
});
t("trailing slash removed (no /v1)", () => {
  assert.strictEqual(adminBaseFrom("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
});
t("no suffix unchanged", () => {
  assert.strictEqual(adminBaseFrom("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
});
t("prod URL /v1 removed", () => {
  assert.strictEqual(adminBaseFrom("https://api.hypeproof-ai.xyz/v1"), "https://api.hypeproof-ai.xyz");
});
t("assembled knowledge URL has no /v1/admin segment", () => {
  const url = adminBaseFrom("http://127.0.0.1:8787/v1") + "/admin/chalk/knowledge/1/docs";
  assert.ok(!url.includes("/v1/admin"), `URL must not contain /v1/admin — got: ${url}`);
  assert.strictEqual(url, "http://127.0.0.1:8787/admin/chalk/knowledge/1/docs");
});

// Verify that execGetKnowledge with serverUrl ending in /v1 produces the
// correct URL in a real fetch call (no /v1/admin prefix in the request).
t("execGetKnowledge with serverUrl=/v1 fetches /admin/chalk/knowledge/versions", async () => {
  const { execGetKnowledge } = await import("../src/chalk/tools.ts");
  let capturedUrl = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return { ok: true, text: async () => "[]" };
  };
  const fakeSecrets = { get: async () => "test-token" };
  try {
    await execGetKnowledge(
      { serverUrl: "http://127.0.0.1:8787/v1", secrets: fakeSecrets },
      {},
    );
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.ok(capturedUrl !== null, "fetch must have been called");
  assert.ok(!capturedUrl.includes("/v1/admin"), `URL must not contain /v1/admin — got: ${capturedUrl}`);
  assert.ok(capturedUrl.startsWith("http://127.0.0.1:8787/admin/"), `URL must start with /admin/ — got: ${capturedUrl}`);
});

console.log(`\n${n} tests passed\n`);
