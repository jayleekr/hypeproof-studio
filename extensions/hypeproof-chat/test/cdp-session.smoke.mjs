// Smoke tests for CdpSession (#278 Phase 3). Verifies the spike-established
// contract: attach does the Target.attachToTarget handshake, and every
// subsequent page command carries the returned sessionId. Mock CDP channel,
// vscode-free. Run:
//   node --experimental-strip-types test/cdp-session.smoke.mjs

import assert from "node:assert/strict";

const { CdpSession } = await import("../src/cdpSession.ts");

/** A mock raw CDP session: records sent envelopes, replies (by id) via `handler`. */
function makeMock(handler) {
  const listeners = new Set();
  const mock = {
    sent: [],
    closed: false,
    onDidReceiveMessage(fn) {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    onDidClose() {
      return { dispose: () => {} };
    },
    async sendMessage(msg) {
      mock.sent.push(msg);
      queueMicrotask(() => {
        const res = handler(msg);
        if (res !== undefined) for (const fn of [...listeners]) fn({ id: msg.id, ...res });
      });
    },
    async close() {
      mock.closed = true;
    },
  };
  return mock;
}

const HANDSHAKE = (msg) => {
  switch (msg.method) {
    case "Target.setDiscoverTargets":
      return { result: {} };
    case "Target.getTargets":
      return { result: { targetInfos: [{ type: "other" }, { type: "page", targetId: "T1" }] } };
    case "Target.attachToTarget":
      return { result: { sessionId: "S1" } };
    default:
      return undefined; // page commands handled per-test
  }
};

// ─── attach does the handshake, page commands carry the sessionId ───
{
  const mock = makeMock((msg) => {
    const h = HANDSHAKE(msg);
    if (h) return h;
    if (msg.method === "Runtime.evaluate") return { result: { result: { value: "hello" } } };
    return { result: {} };
  });
  const tab = { startCDPSession: async () => mock };

  const session = await CdpSession.attach(tab);

  // Handshake happened, and Target.* went to the ROOT (no sessionId).
  const attach = mock.sent.find((m) => m.method === "Target.attachToTarget");
  assert.ok(attach, "Target.attachToTarget was sent");
  assert.equal(attach.sessionId, undefined, "Target.* is sent on the root session (no sessionId)");
  assert.deepEqual(attach.params, { targetId: "T1", flatten: true }, "attaches to the page target with flatten");

  // A page command carries the negotiated sessionId + resolves to result.
  const res = await session.send("Runtime.evaluate", { expression: "1+1" });
  const evalMsg = mock.sent.find((m) => m.method === "Runtime.evaluate");
  assert.equal(evalMsg.sessionId, "S1", "page commands carry the attached sessionId");
  assert.equal(res.result.value, "hello", "response correlated by id → resolved result");

  await session.close();
  assert.equal(mock.closed, true, "close() closes the raw session");
  console.log("✓ CdpSession: handshake attaches to page target, page commands carry sessionId");
}

// ─── missing page target → attach rejects ───
{
  const mock = makeMock((msg) => {
    if (msg.method === "Target.getTargets") return { result: { targetInfos: [{ type: "other" }] } };
    return { result: {} };
  });
  const tab = { startCDPSession: async () => mock };
  await assert.rejects(() => CdpSession.attach(tab), /no page target/, "no page target → attach rejects");
  console.log("✓ CdpSession: attach rejects when no page target is present");
}

// ─── CDP error response → send rejects with the message ───
{
  const mock = makeMock((msg) => {
    const h = HANDSHAKE(msg);
    if (h) return h;
    if (msg.method === "Page.captureScreenshot") return { error: { message: "boom" } };
    return { result: {} };
  });
  const tab = { startCDPSession: async () => mock };
  const session = await CdpSession.attach(tab);
  await assert.rejects(() => session.send("Page.captureScreenshot", {}), /boom/, "CDP error → reject");
  console.log("✓ CdpSession: a CDP error response rejects the send");
}

console.log("All cdp-session smoke tests passed.");
