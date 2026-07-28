// Smoke tests for the SDK-coach gateway 4xx fast-fail (#320, REQ-M15). Pure —
// no vscode, no SDK. e2e finding: the SDK CLI retries 401/400 up to 10x with
// backoff, so a rejected workshop token was a multi-minute SILENT hang for
// a kid. consumeSdkStream must abort the query on the FIRST api_retry event
// carrying error_status 400/401 and surface student-friendly copy.
//
// 2026-07-28 — the copy must NOT be the proxy path's "만료됐어요". An api_retry
// event carries a status and nothing else: 401 can be expiry, a rejected
// credential, or roster trouble, and the SDK path has no `error.code` to tell
// them apart. Naming expiry there sent a real investigation down the wrong
// path for days AND (via kind:"expired") deleted a perfectly valid token on
// every turn. See proxyClientHelpers.GATEWAY_AUTH_FAILED_FRIENDLY.
// Run: node --experimental-strip-types test/sdk-fastfail.smoke.mjs

import assert from "node:assert/strict";

const { sdkFatalAuthStatus, consumeSdkStream, extractSdkText, SDK_FATAL_AUTH_STATUSES } =
  await import("../src/sdkCoachHelpers.ts");
const {
  TOKEN_EXPIRED_FRIENDLY,
  TOKEN_MISSING_FRIENDLY,
  GATEWAY_AUTH_FAILED_FRIENDLY,
  GATEWAY_BAD_REQUEST_FRIENDLY,
} = await import("../src/proxyClientHelpers.ts");

// Mirrors sdkCoach.ts's makeFatalAuthError so the status→copy mapping is
// exercised here rather than only in the (vscode-adjacent) orchestration layer.
const fatalCopyFor = (status) =>
  status === 401 ? GATEWAY_AUTH_FAILED_FRIENDLY : GATEWAY_BAD_REQUEST_FRIENDLY;

// Real SDKAPIRetryMessage shape (sdk.d.ts): type system / subtype api_retry /
// error_status number|null / error SDKAssistantMessageError.
const apiRetry = (error_status, error = "authentication_failed") => ({
  type: "system",
  subtype: "api_retry",
  attempt: 1,
  max_retries: 10,
  retry_delay_ms: 500,
  error_status,
  error,
});
const assistantMsg = (text) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

// Mock stream that records how many events the loop actually pulled.
function mockStream(events, pulled) {
  return (async function* () {
    for (const e of events) {
      pulled.push(e);
      yield e;
    }
  })();
}

function handlers(overrides = {}) {
  const calls = { deltas: [], aborted: 0 };
  const h = {
    isAborted: () => false,
    makeAbortError: () => Object.assign(new Error("Aborted"), { name: "AbortError" }),
    abortQuery: () => {
      calls.aborted++;
    },
    makeFatalAuthError: (status) =>
      Object.assign(new Error(fatalCopyFor(status)), { name: "FatalAuth", status }),
    onDelta: (d) => calls.deltas.push(d),
    ...overrides,
  };
  return { h, calls };
}

// ─── sdkFatalAuthStatus — only api_retry with 400/401 is fatal ───────────────
{
  assert.equal(sdkFatalAuthStatus(apiRetry(401)), 401, "401 api_retry is fatal");
  assert.equal(sdkFatalAuthStatus(apiRetry(400, "invalid_request")), 400, "400 api_retry is fatal");

  // Retryable statuses stay with the SDK's backoff (correct behavior there).
  assert.equal(sdkFatalAuthStatus(apiRetry(429, "rate_limit")), null, "429 keeps retrying");
  assert.equal(sdkFatalAuthStatus(apiRetry(529, "overloaded")), null, "529 keeps retrying");
  assert.equal(sdkFatalAuthStatus(apiRetry(500, "server_error")), null, "500 keeps retrying");
  assert.equal(sdkFatalAuthStatus(apiRetry(null)), null, "connection error (null status) keeps retrying");

  // Non-retry events are never classified fatal.
  assert.equal(sdkFatalAuthStatus(assistantMsg("hi")), null);
  assert.equal(sdkFatalAuthStatus({ type: "system", subtype: "init" }), null);
  assert.equal(sdkFatalAuthStatus({}), null);

  assert.deepEqual([...SDK_FATAL_AUTH_STATUSES].sort(), [400, 401], "fatal set is exactly {400, 401}");
}

// ─── fast-fail: aborts within ONE event, maps to the auth error ──────────────
{
  const pulled = [];
  const { h, calls } = handlers();
  // A poisoned turn: first retry event, then chunks that would arrive minutes
  // later if we waited out the backoff. The loop must never reach them.
  const stream = mockStream([apiRetry(401), assistantMsg("늦은 응답"), apiRetry(401)], pulled);

  const err = await consumeSdkStream(stream, h).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "fatal 401 must reject the turn");
  assert.equal(err.name, "FatalAuth", "throws the injected auth error, not a raw error");
  assert.equal(err.status, 401);
  assert.equal(err.message, GATEWAY_AUTH_FAILED_FRIENDLY, "401 copy does not claim expiry");
  assert.equal(calls.aborted, 1, "SDK query aborted exactly once (kills the CLI retry loop)");
  assert.equal(pulled.length, 1, "aborts within one event — no further stream consumption");
  assert.deepEqual(calls.deltas, [], "no delta flushed from the poisoned turn");
}

// ─── 400 takes the same fast-fail path ───────────────────────────────────────
{
  const pulled = [];
  const { h, calls } = handlers();
  const err = await consumeSdkStream(mockStream([apiRetry(400, "invalid_request")], pulled), h).then(
    () => null,
    (e) => e,
  );
  assert.equal(err?.status, 400);
  assert.equal(calls.aborted, 1);
}

// ─── healthy stream: deltas flow, no abort ───────────────────────────────────
{
  const pulled = [];
  const { h, calls } = handlers();
  await consumeSdkStream(
    mockStream([assistantMsg("안녕"), { type: "text", text: "하세요" }, { type: "result" }], pulled),
    h,
  );
  assert.deepEqual(calls.deltas, ["안녕", "하세요"], "text extracted across message shapes");
  assert.equal(calls.aborted, 0, "no abort on a healthy stream");
  assert.equal(pulled.length, 3, "stream fully consumed");
}

// ─── a retryable 529 does NOT abort — the SDK's backoff handles it ───────────
{
  const { h, calls } = handlers();
  await consumeSdkStream(mockStream([apiRetry(529, "overloaded"), assistantMsg("복구됨")], []), h);
  assert.deepEqual(calls.deltas, ["복구됨"], "stream continues past a retryable event");
  assert.equal(calls.aborted, 0);
}

// ─── user stop still wins: AbortError before any processing (REQ-M8) ─────────
{
  const { h } = handlers({ isAborted: () => true });
  const err = await consumeSdkStream(mockStream([assistantMsg("x")], []), h).then(
    () => null,
    (e) => e,
  );
  assert.equal(err?.name, "AbortError", "user stop surfaces as AbortError (proxy parity)");
}

// ─── extractSdkText — candidate shapes ───────────────────────────────────────
{
  assert.equal(extractSdkText({ text: "a" }), "a");
  assert.equal(extractSdkText({ delta: { text: "b" } }), "b");
  assert.equal(extractSdkText(assistantMsg("c")), "c");
  assert.equal(extractSdkText({ message: { content: [{ type: "tool_use" }] } }), "");
  assert.equal(extractSdkText({}), "");
}

// ─── copy single-source: constants are the REQ-B5 sentences ──────────────────
// If someone rewords proxyClient's token copy without updating the shared
// constants (or vice versa), this pins the contract.
{
  assert.equal(TOKEN_EXPIRED_FRIENDLY, "토큰이 만료됐어요. 선생님께 새 토큰을 받아서 다시 넣어주세요. 🔑");
  assert.equal(TOKEN_MISSING_FRIENDLY, "토큰이 필요해요. 선생님께 받은 토큰을 넣어주세요. 🔑");

  // The SDK path may not diagnose a cause it cannot observe.
  assert.ok(
    !GATEWAY_AUTH_FAILED_FRIENDLY.includes("만료"),
    "a bare 401 is not evidence of expiry — never say it is",
  );
  assert.notEqual(
    GATEWAY_AUTH_FAILED_FRIENDLY,
    TOKEN_EXPIRED_FRIENDLY,
    "the proxy path reads error.code and MAY say 만료; the SDK path cannot",
  );
  // 400 is a malformed request. Mentioning the token there sends a student
  // (and whoever they escalate to) after the wrong thing entirely.
  assert.ok(
    !GATEWAY_BAD_REQUEST_FRIENDLY.includes("토큰"),
    "400 is not an auth failure — keep tokens out of its copy",
  );
  assert.notEqual(GATEWAY_BAD_REQUEST_FRIENDLY, GATEWAY_AUTH_FAILED_FRIENDLY);
}

console.log("✓ #320: sdk fast-fail — 401/400 api_retry aborts within one event + proxy-path token copy");
