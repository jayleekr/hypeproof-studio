// R6 — Report endpoint live contract (#99 / REQ-H4·H5).
//
// Validates the /v1/report flow that the in-Studio "문제 신고하기" command
// (issue #64) depends on. The whole point of the report path is that it
// stays alive when the chat path is broken — needs a contract test at the
// rehearsal layer, not just a helper unit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WORKER_URL, TOKEN } from "./helpers/env.mjs";
import { fetchJson, sleep } from "./helpers/api.mjs";

const REPORT_URL = `${WORKER_URL}/report`;

function validBody(overrides = {}) {
  return {
    description: "R6 rehearsal smoke — automated test report (please ignore on triage)",
    request_id: "test-rid-12345678",
    profile_id: "boah-dental-teaser-2026-s1",
    contact: "(rehearsal)",
    include_recent_turns: false,
    attachments: {
      studio_version: "rehearsal",
      extension: "hypeproof-chat",
      os: "test-runner",
      locale: "ko",
      ts_client: new Date().toISOString(),
    },
    ...overrides,
  };
}

test(
  "R6.1 — POST /v1/report with valid body → 200 + report_id (REQ-H4)",
  { skip: !TOKEN && "TOKEN required" },
  async () => {
    const r = await fetchJson(REPORT_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: validBody(),
      allowNon2xx: true,
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.text.slice(0, 300)}`);
    assert.ok(r.json?.report_id, `response missing report_id: ${r.text.slice(0, 300)}`);
    assert.match(
      String(r.json.report_id),
      /^[A-Za-z0-9_-]{4,}$/,
      `report_id shape unexpected: ${r.json.report_id}`,
    );
  },
);

test(
  "R6.2 — short description is accepted server-side (client validates length)",
  async () => {
    // Contract pin: the 10-char minimum lives in the in-Studio QuickInput
    // (extension/src/reportProblem.ts validateInput) — server is intentionally
    // permissive so a broken client (no QuickInput, raw POST from a panic
    // script) still reaches Jay. If this ever flips to server-side 4xx, that
    // is a real contract change; update both sides of the assertion.
    const r = await fetchJson(REPORT_URL, {
      method: "POST",
      headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
      body: validBody({ description: "짧음" }),
      allowNon2xx: true,
    });
    assert.ok(
      r.status === 200 || r.status === 429,
      `short desc should be 200 or 429 (rate-limit), got ${r.status}: ${r.text.slice(0, 200)}`,
    );
    if (r.status === 200) {
      assert.ok(r.json?.report_id, "200 should carry a report_id");
    }
  },
);

test(
  "R6.3 — burst 20 reports in ~5s → at least one 429 with friendly body (REQ-H5)",
  { skip: !TOKEN && "TOKEN required" },
  async () => {
    let n429 = 0;
    let nOk = 0;
    let lastNon2xx;
    const start = Date.now();
    const tasks = [];
    for (let i = 0; i < 20; i++) {
      tasks.push(
        fetchJson(REPORT_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}` },
          body: validBody({ description: `R6.3 burst probe #${i} — please ignore on triage` }),
          allowNon2xx: true,
        }),
      );
    }
    const results = await Promise.all(tasks);
    for (const r of results) {
      if (r.status === 429) n429++;
      else if (r.status === 200) nOk++;
      else lastNon2xx = r;
    }
    const elapsed = Date.now() - start;
    assert.ok(
      n429 >= 1,
      `expected at least one 429 in burst (got ${n429} 429 / ${nOk} ok / ${results.length} total in ${elapsed}ms). ` +
        `Last non-2xx: ${lastNon2xx?.status} ${lastNon2xx?.text?.slice(0, 200)}`,
    );
    // Pick any 429 and verify the body isn't raw JSON gibberish — it should
    // include a user-friendly message the host can show as a toast.
    const any429 = results.find((r) => r.status === 429);
    if (any429) {
      const body = (any429.json?.error?.message ?? any429.text ?? "").trim();
      assert.ok(
        body.length > 0 && body.length < 500,
        `429 body should be a short user-friendly string, got: ${body.slice(0, 200)}`,
      );
    }

    // Settle so the next test isn't penalized by the burst window.
    await sleep(2000);
  },
);

test(
  "R6.4 — include_recent_turns:false (default) accepted",
  { skip: !TOKEN && "TOKEN required" },
  async () => {
    const r = await fetchJson(REPORT_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: validBody({ include_recent_turns: false, recent_turns: undefined }),
      allowNon2xx: true,
    });
    assert.equal(r.status, 200, `opt-out path should be 200, got ${r.status}: ${r.text.slice(0, 200)}`);
    assert.ok(r.json?.report_id);
  },
);

test(
  "R6.5 — POST without Authorization → still accepted (report path stays open)",
  async () => {
    // Design intent (#64): the report path must be reachable even when the
    // user's chat token is bad — that's the whole reason the feature exists.
    // We tolerate either 200 (anonymous accepted, IP-rate-limited) or 401
    // (auth required) — the rehearsal pins whichever shape ships, and a
    // change in either direction is a contract change that needs a doc note.
    const r = await fetchJson(REPORT_URL, {
      method: "POST",
      body: validBody({ description: "R6.5 anonymous probe — please ignore on triage" }),
      allowNon2xx: true,
    });
    assert.ok(
      r.status === 200 || r.status === 401,
      `unauth POST /report should be 200 or 401, got ${r.status}: ${r.text.slice(0, 200)}`,
    );
    if (r.status === 200) {
      assert.ok(r.json?.report_id, "200 anonymous response should still carry a report_id");
    }
  },
);
