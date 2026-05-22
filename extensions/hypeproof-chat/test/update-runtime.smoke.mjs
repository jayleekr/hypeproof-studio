// Smoke tests for the runtime guards extracted from updateChecker.ts
// (#97 / REQ-I5 free-disk + REQ-I7 idempotency). Pure helpers, no vscode,
// no fs, no child processes.
//
// Run: node --experimental-strip-types test/update-runtime.smoke.mjs

import assert from "node:assert/strict";

const { hasFreeDisk, pickInflight, MIN_FREE_DISK_BYTES } = await import(
  "../src/updateCheckerHelpers.ts"
);

// ─── hasFreeDisk — happy path ───────────────────────────────────────
{
  assert.equal(hasFreeDisk(2 * 1024 ** 3), true, "2 GB > 1 GB default → true");
  assert.equal(hasFreeDisk(1 * 1024 ** 3), true, "exactly 1 GB → true (>=, not >)");
  assert.equal(hasFreeDisk(500 * 1024 ** 2), false, "500 MB < 1 GB → false");
  console.log("✅ hasFreeDisk: above/at/below default 1 GB threshold");
}

// ─── hasFreeDisk — explicit threshold ──────────────────────────────
{
  assert.equal(hasFreeDisk(100, 50), true);
  assert.equal(hasFreeDisk(50, 100), false);
  assert.equal(hasFreeDisk(0, 0), true, "0 >= 0 → true");
  console.log("✅ hasFreeDisk: custom threshold");
}

// ─── hasFreeDisk — defensive against bad inputs ───────────────────
{
  assert.equal(hasFreeDisk(NaN), false, "NaN → false");
  assert.equal(hasFreeDisk(Infinity), false, "Infinity not finite → false");
  assert.equal(hasFreeDisk(-1), false, "negative → false");
  // @ts-expect-error testing runtime type coercion
  assert.equal(hasFreeDisk(undefined), false, "undefined → false");
  // @ts-expect-error
  assert.equal(hasFreeDisk("1000000000"), false, "string number → false (no coercion)");
  console.log("✅ hasFreeDisk: defensive against NaN/Infinity/negative/non-number");
}

// ─── MIN_FREE_DISK_BYTES constant ─────────────────────────────────
{
  assert.equal(MIN_FREE_DISK_BYTES, 1024 ** 3, "exported default = 1 GB");
  console.log("✅ MIN_FREE_DISK_BYTES = 1 GB exactly");
}

// ─── pickInflight — first call invokes factory ────────────────────
{
  const map = new Map();
  let calls = 0;
  const p = pickInflight(map, "v1", async () => {
    calls++;
    return "done";
  });
  assert.equal(await p, "done");
  assert.equal(calls, 1);
  console.log("✅ pickInflight: first call invokes factory");
}

// ─── pickInflight — concurrent same-key reuses one factory ────────
{
  const map = new Map();
  let calls = 0;
  let resolveInner;
  const inner = new Promise((r) => {
    resolveInner = r;
  });
  const factory = async () => {
    calls++;
    return inner;
  };

  // Five concurrent calls — only ONE should hit the factory
  const ps = [
    pickInflight(map, "v1", factory),
    pickInflight(map, "v1", factory),
    pickInflight(map, "v1", factory),
    pickInflight(map, "v1", factory),
    pickInflight(map, "v1", factory),
  ];
  assert.equal(calls, 1, "double-click guard: factory invoked once");
  assert.equal(map.size, 1, "map holds the inflight promise");

  resolveInner("done");
  const results = await Promise.all(ps);
  assert.deepEqual(results, ["done", "done", "done", "done", "done"]);
  // After settle, inflight cleared
  assert.equal(map.size, 0, "inflight entry cleaned up on settle");
  console.log("✅ pickInflight: 5 concurrent same-key → 1 factory call + cleanup");
}

// ─── pickInflight — different keys → separate invocations ─────────
{
  const map = new Map();
  let calls = 0;
  const factory = async () => {
    calls++;
    return calls;
  };

  const a = pickInflight(map, "v1", factory);
  const b = pickInflight(map, "v2", factory);
  await Promise.all([a, b]);
  assert.equal(calls, 2, "distinct keys invoke factory each");
  console.log("✅ pickInflight: different keys → separate factory invocations");
}

// ─── pickInflight — rejected factory still cleans up ──────────────
{
  const map = new Map();
  let calls = 0;
  const failingFactory = async () => {
    calls++;
    throw new Error("nope");
  };

  await assert.rejects(pickInflight(map, "v1", failingFactory), /nope/);
  assert.equal(map.size, 0, "inflight cleared even on rejection");

  // Subsequent call with same key gets a fresh invocation
  await assert.rejects(pickInflight(map, "v1", failingFactory), /nope/);
  assert.equal(calls, 2);
  console.log("✅ pickInflight: rejection clears inflight, next call re-invokes");
}

// ─── pickInflight — sequential same-key after settle ─────────────
{
  const map = new Map();
  let calls = 0;
  const factory = async () => {
    calls++;
    return calls;
  };

  const a = await pickInflight(map, "v1", factory);
  const b = await pickInflight(map, "v1", factory);
  assert.equal(a, 1);
  assert.equal(b, 2, "second call after settle gets a fresh invocation");
  console.log("✅ pickInflight: sequential same-key → fresh invocation per round");
}

console.log("\nAll update-runtime smoke tests passed.");
