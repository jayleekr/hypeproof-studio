// tests/load/report.mjs — pure analysis + verdict over a run's JSONL.
//
// Every function here is pure so selftest.mjs can drive it with fixtures that
// have KNOWN answers (verification.md rule 3: 정답을 심고 시작한다) and with
// deliberately impossible thresholds (negative control). A scorer without
// controls is not trusted.
//
// Metric definitions are stated, not implied — the dental comparison is only
// meaningful if both sides count the same thing:
//
//   TTFT          first TEXT delta (not first byte). A child sees nothing at
//                 message_start.
//   turn total    request send → stream end.
//   billable ITPM sum(input_tokens + cache_creation_input_tokens) over a
//                 sliding 60s window, attributed at REQUEST START.
//                 cache_read is EXCLUDED — that is the "billable" sense used
//                 in the 보아치과 analysis. The cache-inclusive variant is
//                 also reported as `peak_itpm_incl_cache_read` so a reader can
//                 tell which convention a number came from.
//   OTPM          sum(output_tokens) over a sliding 60s window, attributed at
//                 turn COMPLETION (that is when the tokens finished being
//                 produced).
//   concurrency   for a turn, how many turns' [start,end) intervals overlap it
//                 (including itself).

import { readFileSync } from "node:fs";
import { THRESHOLDS, OUTPUT_BUCKETS } from "./config.mjs";

/* ---------------- pure stats ---------------- */

/** Nearest-rank percentile. p in [0,100]. Returns null for an empty set. */
export function pct(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export function summarize(values) {
  const s = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return { n: 0, p50: null, p90: null, p95: null, p99: null, max: null, mean: null };
  return {
    n: s.length,
    p50: pct(s, 50), p90: pct(s, 90), p95: pct(s, 95), p99: pct(s, 99),
    max: s[s.length - 1],
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

/** Peak sum over any sliding `windowMs` window of {t, v} events. */
export function peakWindow(events, windowMs = 60_000) {
  if (!events.length) return { peak: 0, at_ms: null };
  const ev = [...events].sort((a, b) => a.t - b.t);
  let best = 0, bestAt = ev[0].t, sum = 0, lo = 0;
  for (let hi = 0; hi < ev.length; hi++) {
    sum += ev[hi].v;
    while (ev[hi].t - ev[lo].t >= windowMs) { sum -= ev[lo].v; lo++; }
    if (sum > best) { best = sum; bestAt = ev[lo].t; }
  }
  return { peak: best, at_ms: bestAt };
}

/** Overlap-based concurrency for each turn. O(n^2) — fine at classroom size. */
export function concurrencyOf(turns) {
  return turns.map((t) => {
    const a0 = t.t_rel_start_ms, a1 = t.t_rel_end_ms;
    let c = 0;
    for (const o of turns) if (o.t_rel_start_ms < a1 && a0 < o.t_rel_end_ms) c++;
    return c;
  });
}

export function bucketOf(outTokens) {
  if (typeof outTokens !== "number") return "unknown";
  for (let i = OUTPUT_BUCKETS.length - 1; i >= 0; i--) {
    if (outTokens >= OUTPUT_BUCKETS[i]) {
      const hi = OUTPUT_BUCKETS[i + 1];
      return hi ? `${OUTPUT_BUCKETS[i]}-${hi}` : `${OUTPUT_BUCKETS[i]}+`;
    }
  }
  return "unknown";
}

/* ---------------- analysis ---------------- */

export function analyze(records) {
  const meta = records.find((r) => r.kind === "meta") ?? {};
  const turns = records.filter((r) => r.kind === "turn");
  const ok = turns.filter((t) => t.ok && t.status === 200);
  const bad = turns.filter((t) => !(t.ok && t.status === 200));

  const conc = concurrencyOf(turns);
  turns.forEach((t, i) => { t._concurrency = conc[i]; });

  const ttft = summarize(ok.map((t) => t.ttft_ms));
  const ttfb = summarize(ok.map((t) => t.ttfb_ms));
  const total = summarize(ok.map((t) => t.total_ms));
  const heavy = summarize(ok.filter((t) => t.heavy).map((t) => t.total_ms));
  const light = summarize(ok.filter((t) => !t.heavy).map((t) => t.total_ms));

  // Token sums. `null` usage means NOT OBSERVED — never coerce it to 0, that
  // would fabricate "used no tokens" (the same discipline enqueueUsageChunk
  // applies server-side).
  const withUsage = ok.filter((t) => t.usage?.observed);
  const sum = (f) => withUsage.reduce((a, t) => a + (f(t) ?? 0), 0);
  const inputT = sum((t) => t.usage.input_tokens);
  const cacheRead = sum((t) => t.usage.cache_read_input_tokens);
  const cacheCreate = sum((t) => t.usage.cache_creation_input_tokens);
  const outputT = sum((t) => t.usage.output_tokens);
  const totalInputSide = inputT + cacheRead + cacheCreate;
  const cacheRatio = totalInputSide > 0 ? cacheRead / totalInputSide : null;

  // Rate windows.
  const rpm = peakWindow(turns.map((t) => ({ t: t.t_rel_start_ms, v: 1 })));
  const itpmBillable = peakWindow(
    withUsage.map((t) => ({
      t: t.t_rel_start_ms,
      v: (t.usage.input_tokens ?? 0) + (t.usage.cache_creation_input_tokens ?? 0),
    })),
  );
  const itpmInclCache = peakWindow(
    withUsage.map((t) => ({
      t: t.t_rel_start_ms,
      v: (t.usage.input_tokens ?? 0) + (t.usage.cache_creation_input_tokens ?? 0) + (t.usage.cache_read_input_tokens ?? 0),
    })),
  );
  const otpm = peakWindow(withUsage.map((t) => ({ t: t.t_rel_end_ms, v: t.usage.output_tokens ?? 0 })));

  // Latency by output-token bucket.
  const byBucket = {};
  for (const t of withUsage) {
    const b = bucketOf(t.usage.output_tokens);
    (byBucket[b] ??= []).push(t.total_ms);
  }
  const buckets = Object.fromEntries(
    Object.entries(byBucket)
      .map(([k, v]) => [k, summarize(v)])
      .sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10)),
  );

  // ms per output token, grouped by observed concurrency.
  const byConc = {};
  for (const t of withUsage) {
    const o = t.usage.output_tokens;
    if (!o || o <= 0 || !t.total_ms) continue;
    (byConc[t._concurrency] ??= []).push(t.total_ms / o);
  }
  const msPerOutputTokenByConcurrency = Object.fromEntries(
    Object.entries(byConc)
      .map(([k, v]) => [k, { n: v.length, median: +(pct(v.sort((a, b) => a - b), 50)).toFixed(2) }])
      .sort((a, b) => Number(a[0]) - Number(b[0])),
  );

  const allMsPerTok = withUsage
    .filter((t) => t.usage.output_tokens > 0)
    .map((t) => t.total_ms / t.usage.output_tokens)
    .sort((a, b) => a - b);

  // Error taxonomy — 403 session_inactive / not_in_roster are OPERATOR states,
  // not product failures. Split them out so a misconfigured run cannot be
  // reported as a product regression (verification.md rule 6).
  const OPERATOR_TYPES = new Set(["session_inactive", "session_window", "not_in_roster", "session_profile_mismatch", "cohort_paused"]);
  const errorsByType = {};
  for (const t of bad) errorsByType[t.error_type ?? `http_${t.status}`] = (errorsByType[t.error_type ?? `http_${t.status}`] ?? 0) + 1;
  const operatorErrors = bad.filter((t) => OPERATOR_TYPES.has(t.error_type)).length;
  const productErrors = bad.length - operatorErrors;
  const rateLimited = turns.filter((t) => t.status === 429).length;

  const clampHits = ok.filter((t) => t.stop_reason === "max_tokens").length;

  return {
    meta,
    counts: {
      turns: turns.length, ok: ok.length, failed: bad.length,
      operator_errors: operatorErrors, product_errors: productErrors,
      http_429: rateLimited,
      usage_observed: withUsage.length,
      max_tokens_clamp_hits: clampHits,
      clamp_hit_rate: ok.length ? clampHits / ok.length : null,
    },
    errors_by_type: errorsByType,
    latency: { ttft_ms: ttft, ttfb_ms: ttfb, turn_total_ms: total, heavy_turn_ms: heavy, light_turn_ms: light },
    tokens: {
      input_tokens: inputT, cache_read: cacheRead, cache_creation: cacheCreate,
      output_tokens: outputT, input_side_total: totalInputSide,
      cache_read_ratio: cacheRatio,
    },
    rates: {
      peak_rpm: rpm.peak, peak_rpm_at_ms: rpm.at_ms,
      peak_billable_itpm: itpmBillable.peak, peak_billable_itpm_at_ms: itpmBillable.at_ms,
      peak_itpm_incl_cache_read: itpmInclCache.peak,
      peak_otpm: otpm.peak, peak_otpm_at_ms: otpm.at_ms,
    },
    latency_by_output_bucket: buckets,
    ms_per_output_token: {
      overall_median: allMsPerTok.length ? +pct(allMsPerTok, 50).toFixed(2) : null,
      by_concurrency: msPerOutputTokenByConcurrency,
    },
    peak_concurrency: turns.length ? Math.max(...conc) : 0,
  };
}

/* ---------------- verdict ---------------- */

/**
 * Apply thresholds. A metric that could NOT be measured is `unknown`, never
 * a silent pass — a scorer that passes on missing data is exactly the failure
 * mode this file exists to prevent.
 */
export function verdict(a, thresholds = THRESHOLDS) {
  const checks = [];
  const add = (name, value, limit, cmp, note = "") => {
    let status;
    if (value === null || value === undefined || Number.isNaN(value)) status = "UNKNOWN";
    else status = cmp(value, limit) ? "PASS" : "FAIL";
    checks.push({ name, value, limit, status, note });
  };
  const lte = (v, l) => v <= l;
  const gte = (v, l) => v >= l;

  // Nearest-rank pXX collapses onto max when n < 1/(1-p). At n=13 the "p95" IS
  // the slowest sample, so a single heavy turn decides the gate. Say so instead
  // of letting a reader treat a 1-person control as a tail measurement.
  const smallSample = (n, p) => {
    const need = Math.ceil(1 / (1 - p / 100));
    return n > 0 && n < need
      ? `n=${n} < ${need}: p${p} == max here, not a real tail`
      : "";
  };

  add("TTFT p95 (ms)", a.latency.ttft_ms.p95, thresholds.ttft_p95_ms, lte,
      smallSample(a.latency.ttft_ms.n, 95));
  add("turn total p95 (ms)", a.latency.turn_total_ms.p95, thresholds.turn_p95_ms, lte,
      smallSample(a.latency.turn_total_ms.n, 95));
  add("turn total p99 (ms)", a.latency.turn_total_ms.p99, thresholds.turn_p99_ms, lte,
      smallSample(a.latency.turn_total_ms.n, 99));

  const nonOkRate = a.counts.turns ? a.counts.product_errors / a.counts.turns : null;
  add("learner-exposed non-200 rate", nonOkRate, thresholds.non_200_rate, lte,
      a.counts.operator_errors ? `${a.counts.operator_errors} operator-state errors excluded (session/roster)` : "");

  add("cache_read / input-side", a.tokens.cache_read_ratio, thresholds.cache_read_ratio_min, gte);
  add("peak billable ITPM", a.rates.peak_billable_itpm, thresholds.peak_billable_itpm_max, lte);

  const failed = checks.filter((c) => c.status === "FAIL");
  const unknown = checks.filter((c) => c.status === "UNKNOWN");
  return {
    checks,
    pass: failed.length === 0 && unknown.length === 0,
    failed: failed.length,
    unknown: unknown.length,
  };
}

/* ---------------- io + cli ---------------- */

export function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export function format(a, v) {
  const L = [];
  const ms = (o) => o.n ? `n=${o.n} p50=${o.p50} p90=${o.p90} p95=${o.p95} p99=${o.p99} max=${o.max}` : "n=0";
  L.push("");
  L.push("================ LOAD REPORT ================");
  L.push(`run           ${a.meta.run_id ?? "?"}`);
  L.push(`path          /v1/${a.meta.path === "messages" ? "messages" : "chat/completions"}   workers=${a.meta.workers} arrival=${a.meta.arrival} turns/worker=${a.meta.turns}`);
  L.push(`session       ${a.meta.session_id ?? "?"} (profile ${a.meta.session_profile_id ?? "?"}, coach_runtime=${a.meta.profile_probe?.coach_runtime ?? "?"})`);
  L.push("");
  L.push("-- counts --");
  L.push(`turns=${a.counts.turns} ok=${a.counts.ok} failed=${a.counts.failed} (product=${a.counts.product_errors} operator=${a.counts.operator_errors}) http429=${a.counts.http_429}`);
  L.push(`usage observed on ${a.counts.usage_observed}/${a.counts.ok} ok turns`);
  L.push(`max_tokens clamp hits: ${a.counts.max_tokens_clamp_hits} (${a.counts.clamp_hit_rate === null ? "?" : (a.counts.clamp_hit_rate * 100).toFixed(1) + "%"})`);
  if (Object.keys(a.errors_by_type).length) L.push(`errors: ${JSON.stringify(a.errors_by_type)}`);
  L.push("");
  L.push("-- latency --");
  L.push(`TTFT (first text delta)  ${ms(a.latency.ttft_ms)}`);
  L.push(`TTFB (first SSE byte)    ${ms(a.latency.ttfb_ms)}`);
  L.push(`turn total               ${ms(a.latency.turn_total_ms)}`);
  L.push(`  heavy (full-HTML)      ${ms(a.latency.heavy_turn_ms)}`);
  L.push(`  light (chat)           ${ms(a.latency.light_turn_ms)}`);
  L.push("");
  L.push("-- tokens --");
  L.push(`input=${a.tokens.input_tokens} cache_read=${a.tokens.cache_read} cache_create=${a.tokens.cache_creation} output=${a.tokens.output_tokens}`);
  L.push(`cache_read / input-side = ${a.tokens.cache_read_ratio === null ? "n/a" : (a.tokens.cache_read_ratio * 100).toFixed(1) + "%"}`);
  L.push("");
  L.push("-- rates (sliding 60s) --");
  L.push(`peak RPM             ${a.rates.peak_rpm}`);
  L.push(`peak billable ITPM   ${a.rates.peak_billable_itpm}   (incl cache_read: ${a.rates.peak_itpm_incl_cache_read})`);
  L.push(`peak OTPM            ${a.rates.peak_otpm}`);
  L.push(`peak concurrency     ${a.peak_concurrency}`);
  L.push("");
  L.push("-- latency by output-token bucket --");
  for (const [k, s] of Object.entries(a.latency_by_output_bucket)) L.push(`  ${k.padEnd(12)} ${ms(s)}`);
  L.push("");
  L.push("-- ms per output token --");
  L.push(`  overall median ${a.ms_per_output_token.overall_median}`);
  for (const [k, s] of Object.entries(a.ms_per_output_token.by_concurrency)) {
    L.push(`  concurrency ${String(k).padStart(2)}  median ${s.median} ms/tok (n=${s.n})`);
  }
  L.push("");
  L.push("-- VERDICT --");
  for (const c of v.checks) {
    L.push(`  [${c.status.padEnd(7)}] ${c.name.padEnd(30)} ${c.value} (limit ${c.limit})${c.note ? "  — " + c.note : ""}`);
  }
  L.push(`  => ${v.pass ? "PASS" : "FAIL"}  (failed=${v.failed} unknown=${v.unknown})`);
  L.push("=============================================");
  return L.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node report.mjs <run.jsonl>");
    process.exit(2);
  }
  const a = analyze(readJsonl(path));
  const v = verdict(a);
  console.log(format(a, v));
  if (process.env.LOAD_JSON === "1") console.log(JSON.stringify({ analysis: a, verdict: v }, null, 2));
  process.exit(v.pass ? 0 : 1);
}
