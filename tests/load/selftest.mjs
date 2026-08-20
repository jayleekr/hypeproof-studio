// tests/load/selftest.mjs — controls for the INSTRUMENT, not the product.
//
// verification.md rule 2: 실기기 런 전에 대조군을 돌린다. Runs in milliseconds,
// needs no app, no token, no session.
//
//   positive control — a known-good synthetic run must PASS. Catches a scorer
//                      that is too strict (the failure mode that produced 9/9
//                      wrong calls on 2026-07-25~27).
//   negative control — a known-bad run must FAIL, and impossible thresholds
//                      must FAIL even on a perfect run. Catches a scorer that
//                      is not actually judging anything.
//   unknown control  — missing usage must NOT pass silently.
//
//   run: node --test selftest.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pct, summarize, peakWindow, concurrencyOf, bucketOf, analyze, verdict } from "./report.mjs";
import { THRESHOLDS } from "./config.mjs";
import { makeRng } from "./rng.mjs";
import { buildTurns, GUESTS } from "./script.mjs";
import { toolDefs, toolResultFor, newWorkspaceState, skeletonFor } from "./tools.mjs";
import { withCacheBreakpoint } from "./client.mjs";

/* ---------- planted-answer math checks ---------- */

test("pct — nearest-rank, hand-computed answers", () => {
  const s = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(pct(s, 50), 50);   // ceil(0.5*10)=5 → 5th = 50
  assert.equal(pct(s, 95), 100);  // ceil(9.5)=10   → 10th = 100
  assert.equal(pct(s, 100), 100);
  assert.equal(pct([], 50), null);
  assert.equal(pct([7], 99), 7);
});

test("summarize ignores nulls and non-finite values", () => {
  const s = summarize([5, null, 10, undefined, NaN, 15]);
  assert.equal(s.n, 3);
  assert.equal(s.p50, 10);
  assert.equal(s.max, 15);
});

test("peakWindow — planted answer", () => {
  // Four events, 100 tokens each, at 0s/10s/20s/70s.
  // A 60s window catches the first three (300); the 70s one falls out.
  const ev = [{ t: 0, v: 100 }, { t: 10_000, v: 100 }, { t: 20_000, v: 100 }, { t: 70_000, v: 100 }];
  assert.equal(peakWindow(ev, 60_000).peak, 300);
  // A 120s window catches all four.
  assert.equal(peakWindow(ev, 120_000).peak, 400);
  assert.equal(peakWindow([], 60_000).peak, 0);
});

test("concurrencyOf — planted overlaps", () => {
  const turns = [
    { t_rel_start_ms: 0,    t_rel_end_ms: 1000 },  // overlaps #2 only
    { t_rel_start_ms: 500,  t_rel_end_ms: 1500 },  // overlaps #1 and #3
    { t_rel_start_ms: 1200, t_rel_end_ms: 2000 },  // overlaps #2
    { t_rel_start_ms: 5000, t_rel_end_ms: 6000 },  // alone
  ];
  assert.deepEqual(concurrencyOf(turns), [2, 3, 2, 1]);
});

test("bucketOf — boundaries land in the right bucket", () => {
  assert.equal(bucketOf(0), "0-200");
  assert.equal(bucketOf(199), "0-200");
  assert.equal(bucketOf(200), "200-500");
  assert.equal(bucketOf(2000), "2000-4000");
  assert.equal(bucketOf(16384), "16384+");
  assert.equal(bucketOf(null), "unknown");
});

/* ---------- fixtures ---------- */

function turnRec(over = {}) {
  const start = over.t_rel_start_ms ?? 0;
  const total = over.total_ms ?? 5000;
  return {
    kind: "turn", run_id: "fixture", user: "load-01", worker_index: 0,
    profile: "p", guest: "붕붕", turn_idx: 0, turn_label: "x", heavy: false,
    ok: true, status: 200, error: null, error_type: null,
    ttft_ms: 900, ttfb_ms: 400, total_ms: total,
    t_rel_start_ms: start, t_rel_end_ms: start + total,
    stop_reason: "end_turn",
    usage: {
      input_tokens: 500, output_tokens: 300,
      cache_read_input_tokens: 9000, cache_creation_input_tokens: 0,
      observed: true,
    },
    ...over,
  };
}

/** A healthy 10-turn run, well inside every threshold. */
function goodRun() {
  const recs = [{ kind: "meta", run_id: "fixture", workers: 1, turns: 10, arrival: "burst", path: "messages" }];
  for (let i = 0; i < 10; i++) {
    recs.push(turnRec({
      turn_idx: i,
      t_rel_start_ms: i * 60_000,      // one turn per minute → low RPM/ITPM
      total_ms: 4000 + i * 100,
      ttft_ms: 800 + i * 10,
    }));
  }
  return recs;
}

/* ---------- POSITIVE CONTROL ---------- */

test("POSITIVE CONTROL — a known-good run PASSES every threshold", () => {
  const a = analyze(goodRun());
  const v = verdict(a);
  const detail = v.checks.map((c) => `${c.name}=${c.value}/${c.limit}:${c.status}`).join("  ");
  assert.equal(v.pass, true, `known-good run was rejected — the scorer is too strict.\n${detail}`);
  assert.equal(v.unknown, 0, `known-good run produced UNKNOWN checks: ${detail}`);
  // Sanity on the numbers themselves, not just the verdict.
  assert.equal(a.counts.ok, 10);
  assert.equal(a.counts.product_errors, 0);
  assert.ok(a.tokens.cache_read_ratio > 0.9, `cache ratio miscomputed: ${a.tokens.cache_read_ratio}`);
});

/* ---------- NEGATIVE CONTROLS ---------- */

test("NEGATIVE CONTROL — impossible thresholds FAIL even on a perfect run", () => {
  const a = analyze(goodRun());
  const v = verdict(a, { ...THRESHOLDS, ttft_p95_ms: 1 });
  assert.equal(v.pass, false, "impossible TTFT threshold (1ms) still PASSED — the reporter is not judging");
  assert.ok(v.checks.find((c) => c.name.startsWith("TTFT") && c.status === "FAIL"));
});

test("NEGATIVE CONTROL — slow p99 FAILS (the 보아치과 211s case)", () => {
  const recs = goodRun();
  recs.push(turnRec({ turn_idx: 99, t_rel_start_ms: 900_000, total_ms: 211_000, ttft_ms: 1200 }));
  const v = verdict(analyze(recs));
  assert.equal(v.pass, false, "a 211s turn passed the p99 gate");
  const p99 = v.checks.find((c) => c.name.includes("p99"));
  assert.equal(p99.status, "FAIL", `p99 check said ${p99.status} on a 211s tail`);
});

test("NEGATIVE CONTROL — learner-exposed errors FAIL", () => {
  const recs = goodRun();
  recs.push(turnRec({ turn_idx: 11, ok: false, status: 502, error_type: "upstream", t_rel_start_ms: 700_000 }));
  const a = analyze(recs);
  const v = verdict(a);
  assert.equal(a.counts.product_errors, 1);
  assert.equal(v.pass, false, "a 502 shown to a child passed the zero-non-200 gate");
});

test("NEGATIVE CONTROL — a cold cache (low cache_read) FAILS", () => {
  const recs = [{ kind: "meta", run_id: "f" }];
  for (let i = 0; i < 5; i++) {
    recs.push(turnRec({
      turn_idx: i, t_rel_start_ms: i * 60_000,
      usage: { input_tokens: 9000, output_tokens: 300, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, observed: true },
    }));
  }
  const v = verdict(analyze(recs));
  assert.equal(v.pass, false, "a 1% cache-hit run passed the >=80% gate");
});

/* ---------- OPERATOR-STATE CONTROL (rule 6) ---------- */

test("403 session_inactive counts as an OPERATOR error, not a product failure", () => {
  const recs = [{ kind: "meta", run_id: "f" },
    turnRec({ ok: false, status: 403, error_type: "session_inactive" })];
  const a = analyze(recs);
  assert.equal(a.counts.operator_errors, 1);
  assert.equal(a.counts.product_errors, 0,
    "a closed session must not be reported as a product regression");
});

/* ---------- UNKNOWN CONTROL ---------- */

test("UNKNOWN CONTROL — unmeasured usage must NOT silently PASS", () => {
  const recs = [{ kind: "meta", run_id: "f" }];
  for (let i = 0; i < 5; i++) {
    recs.push(turnRec({
      turn_idx: i, t_rel_start_ms: i * 60_000,
      usage: { input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, observed: false },
    }));
  }
  const a = analyze(recs);
  const v = verdict(a);
  assert.equal(a.tokens.cache_read_ratio, null, "cache ratio fabricated from unobserved usage");
  assert.equal(v.pass, false, "a run with NO usage data passed — missing data was treated as success");
  assert.ok(v.unknown >= 1, "missing usage should surface as UNKNOWN, not PASS");
});

/* ---------- determinism + script shape ---------- */

test("seeded RNG is reproducible — two runs with one seed are comparable", () => {
  const a = makeRng(42), b = makeRng(42), c = makeRng(43);
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()], seqC = [c(), c(), c()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
});

test("turn script — heavy build turns exist and history grows", () => {
  const { guest, turns } = buildTurns(makeRng(1), 8);
  assert.ok(GUESTS.some((g) => g.name === guest.name));
  assert.equal(turns.length, 8);
  const heavy = turns.filter((t) => t.heavy);
  assert.ok(heavy.length >= 2, "no full-HTML build turns — the expensive case is not being loaded");
  // The Studio-injected prefixes must be present verbatim, else the request
  // bytes differ from production.
  assert.match(turns[0].text, /^\[Studio 안내: 아이가 /);
  assert.match(turns[5].text, /^\[게스트 결과\] (성공|실패) · /);
});

test("turn script scales past the base script without losing heavy turns", () => {
  const { turns } = buildTurns(makeRng(2), 14);
  assert.equal(turns.length, 14);
  assert.ok(turns.filter((t) => t.heavy).length >= 4);
});

/* ---------- tool-loop controls ---------- */

test("skeletonFor returns the REAL skeleton bytes, big enough to matter", () => {
  const html = skeletonFor("붕붕");
  // The kids-quest skeletons are 11.8-14.0 KB on disk. If this ever returns a
  // stub, the heavy turns silently stop being heavy — which is the exact bug
  // the tool loop was added to fix.
  assert.ok(html.length > 8000, `skeleton too small (${html.length} chars) — heavy turns will be fake`);
  assert.match(html, /<html|<!DOCTYPE/i);
});

test("each guest maps to a distinct readable skeleton", () => {
  for (const g of GUESTS) {
    const html = skeletonFor(g.name);
    assert.ok(html.length > 8000, `${g.name} skeleton too small`);
  }
});

test("Write then Read round-trips — context must grow the way it does in class", () => {
  const ws = newWorkspaceState("붕붕");
  const before = ws.files["index.html"];
  const wrote = toolResultFor(
    { type: "tool_use", id: "t1", name: "Write", input: { file_path: "index.html", content: "<html>MINE</html>" } },
    ws,
  );
  assert.equal(wrote.type, "tool_result");
  assert.equal(ws.writes, 1);
  const read = toolResultFor({ type: "tool_use", id: "t2", name: "Read", input: { file_path: "index.html" } }, ws);
  assert.match(read.content, /MINE/, "Read after Write returned stale content — the coach's edit vanished");
  assert.notEqual(before, ws.files["index.html"]);
});

test("Read returns cat -n numbered content (the shape the model expects)", () => {
  const ws = newWorkspaceState("초코");
  const read = toolResultFor({ type: "tool_use", id: "t1", name: "Read", input: { file_path: "index.html" } }, ws);
  assert.match(read.content, /^\s+1\t/, "Read result is not line-numbered");
});

test("a tool the cohort does not grant comes back as an error result", () => {
  const ws = newWorkspaceState("초코");
  const r = toolResultFor({ type: "tool_use", id: "t1", name: "Bash", input: { command: "rm -rf /" } }, ws);
  assert.equal(r.is_error, true);
});

test("small-sample warning fires when pXX collapses onto max", () => {
  // 13 samples: ceil(1/(1-0.95)) = 20 needed, so p95 == max. Must be flagged.
  const a = analyze(goodRun().slice(0, 11));      // meta + 10 turns
  const v = verdict(a);
  const p95 = v.checks.find((c) => c.name.includes("p95") && c.name.includes("turn"));
  assert.match(p95.note, /p95 == max here/, "small-sample caveat missing — a 1-person run would read as a tail measurement");
});

test("small-sample warning is silent when there is enough data", () => {
  const recs = [{ kind: "meta", run_id: "f" }];
  for (let i = 0; i < 200; i++) recs.push(turnRec({ turn_idx: i, t_rel_start_ms: i * 60_000 }));
  const v = verdict(analyze(recs));
  const p95 = v.checks.find((c) => c.name.includes("p95") && c.name.includes("turn"));
  assert.equal(p95.note, "", `spurious small-sample caveat at n=200: ${p95.note}`);
});

/* ---------- cache-breakpoint controls ---------- */

test("cache breakpoint lands on the LAST block of the LAST message only", () => {
  const hist = [
    { role: "user", content: "안녕" },
    { role: "assistant", content: [{ type: "text", text: "네" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }, { type: "text", text: "됐어?" }] },
  ];
  const out = withCacheBreakpoint(hist);
  assert.equal(out[2].content[1].cache_control.type, "ephemeral");
  assert.equal(out[2].content[0].cache_control, undefined, "breakpoint leaked onto a non-final block");
  assert.equal(out[0].content, "안녕", "earlier messages must be untouched");
  // Anthropic allows at most 4 breakpoints — one per request is the SDK's
  // incremental pattern and can never trip that limit.
  const count = JSON.stringify(out).split("cache_control").length - 1;
  assert.equal(count, 1, `expected exactly 1 breakpoint, got ${count}`);
});

test("cache breakpoint promotes a string message to block form without losing text", () => {
  const out = withCacheBreakpoint([{ role: "user", content: "바꿔줘" }]);
  assert.equal(out[0].content[0].type, "text");
  assert.equal(out[0].content[0].text, "바꿔줘");
  assert.equal(out[0].content[0].cache_control.type, "ephemeral");
});

test("cache breakpoint does not mutate the caller's history", () => {
  const hist = [{ role: "user", content: "안녕" }];
  const snapshot = JSON.stringify(hist);
  withCacheBreakpoint(hist);
  assert.equal(JSON.stringify(hist), snapshot, "history was mutated — later turns would carry stale breakpoints");
});

test("tool defs match the Agent SDK names the cohort grants", () => {
  const names = toolDefs().map((t) => t.name);
  assert.deepEqual(names, ["Read", "Write", "Edit"]);
  for (const t of toolDefs()) {
    assert.equal(t.input_schema.type, "object");
    assert.ok(Array.isArray(t.input_schema.required) && t.input_schema.required.length > 0);
  }
});
