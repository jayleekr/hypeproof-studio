// Credential changes must not inherit a previously authenticated instructor session.
import assert from "node:assert/strict";
import { InstructorModeManager } from "../src/chalk/instructorMode.ts";
const originalFetch = globalThis.fetch;
try {
  for (const failure of ["network", "500", "429"]) {
    const manager = new InstructorModeManager();
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: 1, text: "synthetic issuer A brief" }) });
    assert.equal(await manager.checkInstructorMode("synthetic-A", "http://localhost:8787"), true);
    await manager.fetchInstructorBrief("synthetic-A", "http://localhost:8787");
    assert.equal(manager.brief, "synthetic issuer A brief");
    globalThis.fetch = async () => { if (failure === "network") throw new Error("offline"); return { ok: false, status: Number(failure) }; };
    assert.equal(await manager.checkInstructorMode("synthetic-B", "http://localhost:8787"), false, failure);
    assert.notEqual(manager.isInstructor, true, failure);
    assert.equal(manager.brief, undefined, "the previous issuer brief is cleared");
    globalThis.fetch = async () => ({ ok: true });
    assert.equal(await manager.checkInstructorMode("synthetic-B", "http://localhost:8787"), true, "a transient failure remains retryable");
    console.log(`PASS token change ${failure}: deny, clear brief, recover`);
  }
} finally { globalThis.fetch = originalFetch; }
