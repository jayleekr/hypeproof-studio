// Counts the SX requirement ↔ verification trace **in both directions**.
// Run: node --experimental-strip-types test/sx-traceability.test.mjs
//
// ## Why this file exists
//
// Out of the 2026-09-20 full requirement sweep: **42 of the 60 requirement rows wrote down
// "the thing that verifies me is SX-Txx", and that SX-Txx was verifying something else.**
//
//   SX-09 → SX-T18   but SX-T18 verifies SX-11 (the five conversation situations)
//                     what actually verifies SX-09 (calling the instructor) is SX-T17
//
// The dangerous part is that a person can report "SX-10 verified" on the strength of
// **a test that never once looked at the reason code**.
//
// And `scripts/docs-harness/check.py` gave this state **100/100**.
// Because it looks at one direction only (is the link alive) and never at
// **whether the two point at each other**.
//
// This check counts three things, so the two documents cannot quietly drift apart again.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const REQ = read("../../docs/requirements/studio-learning-experience.md");
const TST = read("../../docs/testing/studio-learning-experience.md");

/** Pulls the SX-T ids out of a requirement row's last cell (the verification column). */
function requirementColumn(text) {
  const out = new Map();
  for (const m of text.matchAll(/^\|\s*(SX-\d+)\s*\|.*\|\s*([^|]*?)\s*\|\s*$/gm)) {
    out.set(m[1], new Set(m[2].match(/SX-T\d+/g) ?? []));
  }
  return out;
}

/** Pulls the SX ids out of a test row's last cell (target SX) and inverts the mapping. */
function testTargets(text) {
  const out = new Map();
  for (const m of text.matchAll(/^\|\s*(SX-T\d+)\s*\|(.*)\|\s*$/gm)) {
    const last = m[2].split("|").pop() ?? "";
    for (const sx of last.match(/SX-\d+(?!\d)/g) ?? []) {
      if (!out.has(sx)) out.set(sx, new Set());
      out.get(sx).add(m[1]);
    }
  }
  return out;
}

/** The `커버리지` (coverage) table at the end of the doc. Expands the `T01` shorthand. */
function coverageTable(text) {
  const out = new Map();
  let inside = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("## 커버리지")) { inside = true; continue; }
    if (inside && line.startsWith("## ")) break;
    if (!inside) continue;
    const m = line.match(/^\|\s*[^|]*\|\s*(SX-\d+)\s*\|\s*([^|]*)\|/);
    if (!m) continue;
    const ids = new Set((m[2].match(/\bSX-T\d+\b|\bT\d+\b/g) ?? []).map((t) => (t.startsWith("SX-") ? t : "SX-" + t)));
    out.set(m[1], ids);
  }
  return out;
}

const req = requirementColumn(REQ);
const targets = testTargets(TST);
const coverage = coverageTable(TST);
const sorted = (s) => [...s].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));

// ── 0. If the samples are empty, every assertion below passes vacuously ─────
assert.ok(req.size >= 60, `요구 행을 ${req.size}개만 읽었다 — 파싱이 깨졌다`);
assert.ok(targets.size >= 60, `검증 대상을 ${targets.size}개만 읽었다`);
assert.ok(coverage.size >= 60, `커버리지 행을 ${coverage.size}개만 읽었다`);

// ── 1. Requirement → test: does the test I point at list me as its target? ──
{
  const bad = [];
  for (const [sx, ts] of req) {
    for (const t of ts) {
      if (!targets.get(sx)?.has(t)) bad.push(`${sx} → ${t} (${t} 의 대상에 ${sx} 가 없다)`);
    }
  }
  assert.deepEqual(bad, [], `요구의 검증 열이 자기를 가리키지 않는 검사를 적고 있다:\n  ${bad.join("\n  ")}`);
}

// ── 2. Test → requirement: do I point at the test that lists me as target? ──
// Look at one side only and you miss the "the requirement wrote down less" case. SX-01 was
// exactly that — SX-T60 lists SX-01 as a target, but it was missing from the coverage table.
{
  const bad = [];
  for (const [sx, ts] of targets) {
    if (!req.has(sx)) continue;
    for (const t of ts) {
      if (!req.get(sx).has(t)) bad.push(`${t} → ${sx} (${sx} 의 검증 열에 ${t} 가 없다)`);
    }
  }
  assert.deepEqual(bad, [], `검사가 대상으로 적은 요구가 그 검사를 가리키지 않는다:\n  ${bad.join("\n  ")}`);
}

// ── 3. Inside the test doc: do the per-row target SX and the coverage table agree? ──
// If those two diverge, the premise "there is one canonical source" breaks and there is
// no way to tell which way 1 and 2 should be fixed.
{
  const bad = [];
  for (const sx of new Set([...targets.keys(), ...coverage.keys()])) {
    const a = sorted(targets.get(sx) ?? new Set()).join(",");
    const b = sorted(coverage.get(sx) ?? new Set()).join(",");
    if (a !== b) bad.push(`${sx}: 행별=[${a}] 커버리지=[${b}]`);
  }
  assert.deepEqual(bad, [], `검증 문서가 자기 자신과 어긋난다:\n  ${bad.join("\n  ")}`);
}

// ── 4. No orphans ───────────────────────────────────────────────────────────
{
  const noTest = [...req].filter(([, ts]) => ts.size === 0).map(([sx]) => sx);
  assert.deepEqual(noTest, [], `검증 행이 없는 요구: ${noTest.join(", ")}`);
}

// ── 5. Negative control — does this check really count something ────────────
// With all four above passing, feeding in a drifted sample must get caught.
// Without it, this becomes "green while counting zero".
{
  const drifted = requirementColumn("| SX-01 | 아무 내용 | SX-T99 |\n");
  assert.equal(drifted.get("SX-01")?.has("SX-T99"), true, "파서가 검증 열을 못 읽는다");
  assert.equal(targets.get("SX-01")?.has("SX-T99"), undefined ?? false,
    "SX-T99 는 없는 검사다 — 있으면 이 대조군이 무의미하다");
  // That is: feed this sample to the logic in 1 above and it must land in bad.
  const wouldCatch = ![...drifted.get("SX-01")].every((t) => targets.get("SX-01")?.has(t));
  assert.equal(wouldCatch, true, "드리프트한 시료를 넣어도 1번이 잡지 못한다 — 규칙이 공전한다");
}

console.log(
  `sx-traceability: OK — 요구 ${req.size}행 · 검사 ${new Set([...targets.values()].flatMap((s) => [...s])).size}개 · 양방향 일치`,
);
