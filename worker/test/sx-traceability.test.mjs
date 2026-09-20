// SX 요구 ↔ 검증 추적을 **양방향으로** 센다.
// Run: node --experimental-strip-types test/sx-traceability.test.mjs
//
// ## 왜 이 파일이 있나
//
// 2026-09-20 요구 전수 점검에서 나온 것: **요구 60행 중 42행이 "나를 검증하는 것은
// SX-Txx" 라고 적어 놓고, 그 SX-Txx 는 다른 것을 검증하고 있었다.**
//
//   SX-09 → SX-T18   그런데 SX-T18 은 SX-11(다섯 대화 상황)을 검증한다
//                     SX-09(강사 호출)를 실제로 검증하는 것은 SX-T17 이다
//
// 위험한 것은 사람이 "SX-10 검증됨" 을 **사유 코드를 한 번도 안 본 테스트**로 보고할
// 수 있다는 것이다.
//
// 그리고 `scripts/docs-harness/check.py` 는 이 상태에 **100/100** 을 줬다.
// 한 방향(링크가 살아 있나)만 보고 **서로를 가리키는가**는 보지 않기 때문이다.
//
// 이 검사는 세 가지를 센다. 문서 두 개가 조용히 다시 갈라지지 못하게.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const REQ = read("../../docs/requirements/studio-learning-experience.md");
const TST = read("../../docs/testing/studio-learning-experience.md");

/** 요구 행의 마지막 칸(검증 열)에서 SX-T 를 뽑는다. */
function requirementColumn(text) {
  const out = new Map();
  for (const m of text.matchAll(/^\|\s*(SX-\d+)\s*\|.*\|\s*([^|]*?)\s*\|\s*$/gm)) {
    out.set(m[1], new Set(m[2].match(/SX-T\d+/g) ?? []));
  }
  return out;
}

/** 검증 행의 마지막 칸(대상 SX)에서 SX 를 뽑아 뒤집는다. */
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

/** 문서 끝 `커버리지` 표. `T01` 축약형을 편다. */
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

// ── 0. 시료가 비어 있으면 아래 단언이 전부 공허하게 통과한다 ────────────────
assert.ok(req.size >= 60, `요구 행을 ${req.size}개만 읽었다 — 파싱이 깨졌다`);
assert.ok(targets.size >= 60, `검증 대상을 ${targets.size}개만 읽었다`);
assert.ok(coverage.size >= 60, `커버리지 행을 ${coverage.size}개만 읽었다`);

// ── 1. 요구 → 검증: 내가 가리킨 검사가 나를 대상으로 적는가 ─────────────────
{
  const bad = [];
  for (const [sx, ts] of req) {
    for (const t of ts) {
      if (!targets.get(sx)?.has(t)) bad.push(`${sx} → ${t} (${t} 의 대상에 ${sx} 가 없다)`);
    }
  }
  assert.deepEqual(bad, [], `요구의 검증 열이 자기를 가리키지 않는 검사를 적고 있다:\n  ${bad.join("\n  ")}`);
}

// ── 2. 검증 → 요구: 나를 대상으로 적은 검사를 내가 가리키는가 ───────────────
// 한쪽만 보면 "요구가 덜 적은" 경우를 놓친다. SX-01 이 실제로 그랬다 —
// SX-T60 이 대상에 SX-01 을 적는데 커버리지 표에만 빠져 있었다.
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

// ── 3. 검증 문서 내부: 행별 대상 SX 와 커버리지 표가 같은 말을 하는가 ────────
// 이 둘이 갈라지면 "정본이 하나" 라는 전제가 깨지고 1·2번을 어느 쪽으로 고쳐야
// 하는지 알 수 없게 된다.
{
  const bad = [];
  for (const sx of new Set([...targets.keys(), ...coverage.keys()])) {
    const a = sorted(targets.get(sx) ?? new Set()).join(",");
    const b = sorted(coverage.get(sx) ?? new Set()).join(",");
    if (a !== b) bad.push(`${sx}: 행별=[${a}] 커버리지=[${b}]`);
  }
  assert.deepEqual(bad, [], `검증 문서가 자기 자신과 어긋난다:\n  ${bad.join("\n  ")}`);
}

// ── 4. 고아 없음 ────────────────────────────────────────────────────────────
{
  const noTest = [...req].filter(([, ts]) => ts.size === 0).map(([sx]) => sx);
  assert.deepEqual(noTest, [], `검증 행이 없는 요구: ${noTest.join(", ")}`);
}

// ── 5. 음성 대조군 — 이 검사가 정말 세는지 ──────────────────────────────────
// 위 넷이 전부 통과하는 상태에서, 어긋난 시료를 넣으면 잡혀야 한다.
// 없으면 "0 을 세면서 초록" 이 된다.
{
  const drifted = requirementColumn("| SX-01 | 아무 내용 | SX-T99 |\n");
  assert.equal(drifted.get("SX-01")?.has("SX-T99"), true, "파서가 검증 열을 못 읽는다");
  assert.equal(targets.get("SX-01")?.has("SX-T99"), undefined ?? false,
    "SX-T99 는 없는 검사다 — 있으면 이 대조군이 무의미하다");
  // 즉, 위 1번 로직에 이 시료를 넣으면 반드시 bad 에 들어간다.
  const wouldCatch = ![...drifted.get("SX-01")].every((t) => targets.get("SX-01")?.has(t));
  assert.equal(wouldCatch, true, "드리프트한 시료를 넣어도 1번이 잡지 못한다 — 규칙이 공전한다");
}

console.log(
  `sx-traceability: OK — 요구 ${req.size}행 · 검사 ${new Set([...targets.values()].flatMap((s) => [...s])).size}개 · 양방향 일치`,
);
