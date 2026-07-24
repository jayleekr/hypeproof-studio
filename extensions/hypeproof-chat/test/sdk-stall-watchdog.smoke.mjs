// Smoke tests for the SDK-coach stall watchdog (#403, REQ-M26). Pure — no
// vscode, no SDK. The #320 fast-fail only covers 400/401; everything else the
// gateway answers with (429/529/5xx/connection drops) is retried by the SDK CLI
// up to 10x with backoff, and a first turn that simply never produces a token
// emits nothing at all. Both left the student on "생각하는 중… ✨" forever with
// no error and no way out (observed 4/4 on heavy-design-prompt runs).
// consumeSdkStream must therefore abort the query and throw a friendly error
// after `stallMs` without progress — while never mistaking legitimate silence
// (an open approval modal, a tool the SDK is still running) for a stall.
// Run: node --experimental-strip-types test/sdk-stall-watchdog.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { consumeSdkStream, isSdkRetryEvent, SDK_STALL_FRIENDLY, SDK_STREAM_STALL_MS } =
  await import("../src/sdkCoachHelpers.ts");

const here = dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiRetry = (error_status) => ({
  type: "system",
  subtype: "api_retry",
  attempt: 1,
  max_retries: 10,
  error_status,
  error: "overloaded",
});
const assistantMsg = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });

function handlers(overrides = {}) {
  const calls = { deltas: [], aborted: 0, stalls: 0 };
  const h = {
    isAborted: () => false,
    makeAbortError: () => Object.assign(new Error("Aborted"), { name: "AbortError" }),
    abortQuery: () => {
      calls.aborted++;
    },
    makeFatalAuthError: (status) => Object.assign(new Error("auth"), { name: "FatalAuth", status }),
    onDelta: (d) => calls.deltas.push(d),
    makeStallError: () => {
      calls.stalls++;
      return Object.assign(new Error(SDK_STALL_FRIENDLY), { name: "CoachStallError" });
    },
    ...overrides,
  };
  return { h, calls };
}

/** A stream that never yields anything — the observed "무한 생각하는 중" shape. */
function silentStream(state) {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise(() => {}), // never settles
      return: async () => {
        state.closed = true;
        return { done: true, value: undefined };
      },
    }),
  };
}

/** Yields each event after `gapMs`, then completes. */
function pacedStream(events, gapMs, state = {}) {
  return (async function* () {
    try {
      for (const e of events) {
        await sleep(gapMs);
        yield e;
      }
    } finally {
      state.closed = true;
    }
  })();
}

// ─── a stream that never produces anything stalls out (the #403 bug) ─────────
{
  const state = {};
  const { h, calls } = handlers({ stallMs: 40 });
  const started = Date.now();
  const err = await consumeSdkStream(silentStream(state), h).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "a silent stream must reject, not hang forever");
  assert.equal(err.name, "CoachStallError", "throws the injected stall error");
  assert.equal(err.message, SDK_STALL_FRIENDLY, "student sees the Korean retry copy");
  assert.equal(calls.aborted, 1, "SDK query aborted exactly once (kills the CLI retry loop)");
  assert.deepEqual(calls.deltas, [], "no deltas from a stalled turn");
  assert.ok(Date.now() - started >= 35, "waited out the budget before declaring a stall");
  assert.equal(state.closed, true, "iterator closed on the early exit (no leaked generator)");
}

// ─── api_retry ticks do NOT renew the budget ────────────────────────────────
// The SDK's backoff emits a retry event every few hundred ms. If those counted
// as progress the watchdog would re-arm forever — exactly the hang it exists to
// catch. Retry ticks are the pathology, not progress.
{
  const retries = Array.from({ length: 20 }, () => apiRetry(529));
  const { h, calls } = handlers({ stallMs: 60 });
  const err = await consumeSdkStream(pacedStream(retries, 10), h).then(
    () => null,
    (e) => e,
  );
  assert.equal(err?.name, "CoachStallError", "a retry storm still stalls out");
  assert.equal(calls.aborted, 1);
}

// ─── real progress DOES renew the budget ────────────────────────────────────
{
  const events = Array.from({ length: 8 }, (_, i) => assistantMsg(String(i)));
  const { h, calls } = handlers({ stallMs: 60 });
  await consumeSdkStream(pacedStream(events, 15), h);
  assert.deepEqual(calls.deltas, ["0", "1", "2", "3", "4", "5", "6", "7"]);
  assert.equal(calls.aborted, 0, "a slow-but-progressing stream is never aborted");
  assert.equal(calls.stalls, 0);
}

// ─── an open approval modal is not a stall ──────────────────────────────────
// canUseTool blocks the stream for as long as the human takes to decide. That
// silence is CORRECT; aborting it would kill the turn the kid just approved.
{
  let awaiting = true;
  const { h, calls } = handlers({ stallMs: 40, isTurnBlocked: () => awaiting });
  setTimeout(() => {
    awaiting = false; // the student clicked Approve at ~100ms
  }, 100);
  await consumeSdkStream(pacedStream([assistantMsg("승인 후 응답")], 130), h);
  assert.deepEqual(calls.deltas, ["승인 후 응답"], "turn survives a long modal wait");
  assert.equal(calls.aborted, 0);
  assert.equal(calls.stalls, 0);
}

// ─── …but the grace after a modal is ONE window, not a free pass ────────────
// A turn that wedges right after an approval must still end in a message.
{
  let awaiting = true;
  const { h, calls } = handlers({ stallMs: 30, isTurnBlocked: () => awaiting });
  setTimeout(() => {
    awaiting = false;
  }, 60);
  const err = await consumeSdkStream(silentStream({}), h).then(
    () => null,
    (e) => e,
  );
  assert.equal(err?.name, "CoachStallError", "silence after the modal closes still stalls out");
  assert.equal(calls.aborted, 1);
}

// ─── stallMs: 0 disables the watchdog (escape hatch) ────────────────────────
{
  const { h, calls } = handlers({ stallMs: 0 });
  await consumeSdkStream(pacedStream([assistantMsg("느림")], 80), h);
  assert.deepEqual(calls.deltas, ["느림"]);
  assert.equal(calls.aborted, 0);
}

// ─── the fatal 400/401 fast-fail still wins (no #320 regression) ────────────
{
  const { h, calls } = handlers({ stallMs: 5_000 });
  const err = await consumeSdkStream(pacedStream([apiRetry(401)], 1), h).then(
    () => null,
    (e) => e,
  );
  assert.equal(err?.name, "FatalAuth", "401 keeps its own fast-fail path");
  assert.equal(err.status, 401);
  assert.equal(calls.aborted, 1);
}

// ─── no makeStallError wired → still a friendly error, never a hang ─────────
{
  const { h } = handlers({ stallMs: 20, makeStallError: undefined });
  const err = await consumeSdkStream(silentStream({}), h).then(
    () => null,
    (e) => e,
  );
  assert.equal(err?.message, SDK_STALL_FRIENDLY, "defaults to the shared Korean copy");
}

// ─── isSdkRetryEvent classification ─────────────────────────────────────────
{
  assert.equal(isSdkRetryEvent(apiRetry(529)), true);
  assert.equal(isSdkRetryEvent(apiRetry(null)), true);
  assert.equal(isSdkRetryEvent(assistantMsg("x")), false);
  assert.equal(isSdkRetryEvent({ type: "system", subtype: "init" }), false);
  assert.equal(isSdkRetryEvent({}), false);
}

// ─── manifest ↔ code single source: the setting default IS the constant ─────
{
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  const prop = pkg.contributes.configuration.properties["hypeproofChat.sdkStallTimeoutMs"];
  assert.ok(prop, "hypeproofChat.sdkStallTimeoutMs declared");
  assert.equal(prop.type, "number");
  assert.equal(prop.default, SDK_STREAM_STALL_MS, "manifest default matches SDK_STREAM_STALL_MS");
  assert.equal(prop.scope, "machine");
  assert.equal(SDK_STREAM_STALL_MS, 120_000, "budget is generous — a heavy first turn is slow, not stalled");
  assert.equal(SDK_STALL_FRIENDLY, "코치 응답이 너무 오래 걸려요. 다시 한 번 보내주세요. 🕐");
}

// ─── wiring: the orchestration layer actually arms the watchdog ─────────────
// The helper contract above is worthless if runSdkCoach forgets to pass a
// budget, or if chatPanelProvider stops threading the setting. sdkCoach.ts
// can't be imported here (extensionless relative imports don't resolve under
// --experimental-strip-types), so this is a source-level lock — same pattern
// as sdk-vendor.smoke's inject-script assertions.
{
  const coach = readFileSync(join(here, "..", "src", "sdkCoach.ts"), "utf8");
  assert.match(coach, /stallMs,/, "runSdkCoach passes stallMs to consumeSdkStream");
  assert.match(coach, /makeStallError:/, "…and a CoachStallError factory");
  assert.match(coach, /isTurnBlocked:/, "…and the modal/tool-in-flight predicate");
  assert.match(
    coach,
    /args\.stallTimeoutMs \?\? SDK_STREAM_STALL_MS/,
    "budget defaults to the shared constant when the host passes nothing",
  );
  assert.match(coach, /class CoachStallError/, "distinct error class for the stall exit");

  const provider = readFileSync(join(here, "..", "src", "chatPanelProvider.ts"), "utf8");
  assert.match(
    provider,
    /stallTimeoutMs: cfg\.get<number>\("sdkStallTimeoutMs"\)/,
    "the host threads hypeproofChat.sdkStallTimeoutMs into the coach",
  );
}

console.log("✓ #403: sdk stall watchdog — silent/retry-storm turns abort with a friendly retry message");
