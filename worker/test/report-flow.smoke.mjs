// In-process smoke test for the bug-report flow (#64).
// Same code path that's deployed to prod — only difference is signing secret
// + mock KV/D1 + mock global fetch (Discord webhook capture). Invokes
// app.fetch() directly, no wrangler.
//
// Run: node --experimental-strip-types worker/test/report-flow.smoke.mjs

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Mirror wrangler's [[rules]] type="Text" for .html/.md imports, and the
// extensionless-relative-import → .ts resolution. Same hook as
// issuer-flow.smoke.mjs (PR #61).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.(ts|js|mjs|cjs|json|html|md)$/.test(specifier)
    ) {
      const base = new URL(specifier, context.parentURL);
      for (const candidate of [".ts", "/index.ts"]) {
        const tryUrl = new URL(base.href + candidate);
        try {
          statSync(fileURLToPath(tryUrl));
          return nextResolve(specifier + candidate, context);
        } catch { /* try next */ }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".html") || url.endsWith(".md") || url.endsWith(".yaml")) {
      const text = readFileSync(fileURLToPath(url), "utf8");
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${JSON.stringify(text)};`,
      };
    }
    return nextLoad(url, context);
  },
});

const SECRET = "test-secret-" + "x".repeat(20);

const { issue } = await import("../src/lib/tokens.ts");
const { default: worker } = await import("../src/index.ts");

// In-memory KV mock (incl. expirationTtl honored for the rate-limit key).
function makeKV() {
  const store = new Map();
  const expiry = new Map();
  function purgeExpired() {
    const now = Date.now();
    for (const [k, t] of expiry.entries()) {
      if (t <= now) { store.delete(k); expiry.delete(k); }
    }
  }
  return {
    async get(key, type) {
      purgeExpired();
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value, opts = {}) {
      // Match Cloudflare KV's hard minimum: expirationTtl must be >= 60.
      // Caught a real prod bug in the rate-limit path (issue #64 hotfix).
      if (opts.expirationTtl !== undefined && opts.expirationTtl < 60) {
        throw new Error(
          `KV PUT failed: 400 Invalid expiration_ttl of ${opts.expirationTtl}. Expiration TTL must be at least 60.`,
        );
      }
      store.set(key, value);
      if (opts.expirationTtl) {
        expiry.set(key, Date.now() + opts.expirationTtl * 1000);
      } else {
        expiry.delete(key);
      }
    },
    async delete(key) { store.delete(key); expiry.delete(key); },
    async list({ prefix } = {}) {
      purgeExpired();
      const keys = [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
    // Test helper — clear everything (e.g. between rate-limit cases).
    _reset() { store.clear(); expiry.clear(); },
  };
}

// In-memory D1 mock — only the rows + columns the report flow touches. We
// implement just enough SQL to back the insert/select/update queries used by
// routes/report.ts and routes/admin.ts.
function makeD1() {
  const reports = new Map();
  function prepare(sql) {
    let params = [];
    return {
      bind(...p) { params = p; return this; },
      async run() {
        if (/^INSERT INTO reports/i.test(sql)) {
          const [id, ts, jti_hash, profile_id, request_id, description,
            attachments_json, contact] = params;
          reports.set(id, {
            id, ts, jti_hash, profile_id, request_id, description,
            attachments_json, contact, status: "open",
            resolved_at: null, resolution_note: null, github_issue_url: null,
          });
          return { meta: { changes: 1 } };
        }
        if (/^UPDATE reports/i.test(sql)) {
          const [resolved_at, resolution_note, github_issue_url, id] = params;
          const row = reports.get(id);
          if (!row) return { meta: { changes: 0 } };
          row.status = "resolved";
          row.resolved_at = resolved_at;
          row.resolution_note = resolution_note;
          row.github_issue_url = github_issue_url;
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
      async first() {
        if (/SELECT id, status, resolution_note/i.test(sql)) {
          const [id] = params;
          const row = reports.get(id);
          return row ? {
            id: row.id, status: row.status,
            resolution_note: row.resolution_note,
            github_issue_url: row.github_issue_url,
            resolved_at: row.resolved_at,
          } : null;
        }
        return null;
      },
      async all() {
        if (/FROM reports WHERE status = \?/i.test(sql)) {
          const [status, limit] = params;
          const results = [...reports.values()]
            .filter((r) => r.status === status)
            .sort((a, b) => b.ts - a.ts)
            .slice(0, limit);
          return { results };
        }
        if (/FROM reports ORDER BY ts DESC/i.test(sql)) {
          const [limit] = params;
          const results = [...reports.values()]
            .sort((a, b) => b.ts - a.ts)
            .slice(0, limit);
          return { results };
        }
        return { results: [] };
      },
    };
  }
  return { prepare, _reports: reports };
}

const kv = makeKV();
const db = makeD1();

// Captured Discord webhook calls — fetch is monkey-patched per-test.
let discordCalls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (typeof url === "string" && url.startsWith("https://discord.test/")) {
    discordCalls.push({ url, init });
    // Discord normally returns 204; Node's Response constructor rejects null
    // bodies as <200 OR ==204 OR ==205 OR ==304, so use 200 in the mock.
    return new Response("", { status: 200 });
  }
  return originalFetch(url, init);
};

const env = {
  HPS_SIGNING_SECRET: SECRET,
  HPS_ADMIN_PASSWORD: "test-admin-pw",
  HPS_KV: kv,
  HPS_DB: db,
  ENVIRONMENT: "test",
  // No DISCORD_REPORT_WEBHOOK_URL by default — case 10 sets it.
};

const results = [];

async function fetchOnce(req) {
  const res = await worker.fetch(req, env, {
    waitUntil() {},
    passThroughOnException() {},
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json, headers: res.headers };
}

async function check(label, fn) {
  try {
    await fn();
    results.push({ label, ok: true });
    console.log(`✅ ${label}`);
  } catch (err) {
    results.push({ label, ok: false, err: String(err) });
    console.log(`❌ ${label}\n   ${err && err.stack ? err.stack : err}`);
  }
}

function adminAuthHeader() {
  return "Basic " + Buffer.from("admin:test-admin-pw").toString("base64");
}

// Helper: bump cf-connecting-ip per case so the per-IP rate limit doesn't
// bleed across unrelated tests.
let ipCounter = 0;
function reportRequest(body, opts = {}) {
  ipCounter += 1;
  const ip = opts.ip ?? `10.0.0.${ipCounter}`;
  const headers = {
    "content-type": "application/json",
    "cf-connecting-ip": ip,
    ...(opts.headers ?? {}),
  };
  return new Request("https://x/v1/report", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// 1. Anon submit → 200 + valid report_id, jti_hash null
let anonReportId;
await check("1. anonymous submit → 200 + rep_<base32>, jti_hash null", async () => {
  const { status, text, json } = await fetchOnce(reportRequest({
    description: "the chat panel froze when I clicked send",
  }));
  assert.equal(status, 200, `got ${status}: ${text}`);
  assert.match(json.report_id, /^rep_[a-z2-7]+$/);
  assert.equal(json.status, "open");
  anonReportId = json.report_id;
  const row = db._reports.get(anonReportId);
  assert.ok(row, "row inserted");
  assert.equal(row.jti_hash, null);
  assert.equal(row.status, "open");
});

// 2. With valid token → jti_hash captured (16 hex chars)
let withTokenReportId;
await check("2. valid token → jti_hash captured (16 hex)", async () => {
  const { token } = await issue(
    { u: "alice", c: "sk-biopharm-2026-a", p: "sk-biopharm-kids-2026-grade-3-4-s1" },
    1,
    SECRET,
  );
  const { status, json } = await fetchOnce(reportRequest(
    { description: "error after my third turn" },
    { headers: { authorization: `Bearer ${token}` } },
  ));
  assert.equal(status, 200);
  withTokenReportId = json.report_id;
  const row = db._reports.get(withTokenReportId);
  assert.ok(row);
  assert.match(row.jti_hash, /^[0-9a-f]{16}$/);
});

// 3. Invalid token → still accepted, jti_hash null
await check("3. invalid token → 200 + jti_hash null (broken token may BE the bug)", async () => {
  const { status, json } = await fetchOnce(reportRequest(
    { description: "I can't even log in" },
    { headers: { authorization: "Bearer garbage.not-a-token" } },
  ));
  assert.equal(status, 200);
  const row = db._reports.get(json.report_id);
  assert.ok(row);
  assert.equal(row.jti_hash, null);
});

// 4. Description empty → 400
await check("4. empty description → 400", async () => {
  const { status, json } = await fetchOnce(reportRequest({ description: "" }));
  assert.equal(status, 400);
  assert.equal(json.error.type, "invalid_body");
});

// 5. Description too long → 400
await check("5. description > 5000 chars → 400", async () => {
  const { status, json } = await fetchOnce(reportRequest({
    description: "a".repeat(5001),
  }));
  assert.equal(status, 400);
  assert.match(json.error.message, /5000/);
});

// 6. Rate limit: 4th submission from same IP within window → 429
await check("6. rate limit — 4th submission within 60s → 429", async () => {
  const sharedIp = "10.99.99.99";
  for (let i = 0; i < 3; i++) {
    const { status } = await fetchOnce(reportRequest(
      { description: `burst ${i}` },
      { ip: sharedIp },
    ));
    assert.equal(status, 200, `burst ${i} should pass`);
  }
  const { status, json } = await fetchOnce(reportRequest(
    { description: "burst 4 should fail" },
    { ip: sharedIp },
  ));
  assert.equal(status, 429);
  assert.equal(json.error.type, "rate_limited");
});

// 7. include_recent_turns:false → recent_turns ignored even if present
await check("7. include_recent_turns:false → recent_turns stripped", async () => {
  const { status, json } = await fetchOnce(reportRequest({
    description: "test",
    include_recent_turns: false,
    recent_turns: [
      { role: "user", content: "secret stuff" },
      { role: "assistant", content: "more secret stuff" },
    ],
  }));
  assert.equal(status, 200);
  const row = db._reports.get(json.report_id);
  if (row.attachments_json) {
    const parsed = JSON.parse(row.attachments_json);
    assert.ok(!("recent_turns" in parsed), "recent_turns must be stripped");
  }
});

// 8. include_recent_turns:true with 5 turns → truncated to 3
await check("8. include_recent_turns:true with 5 turns → truncated to 3", async () => {
  const { status, json } = await fetchOnce(reportRequest({
    description: "with context",
    include_recent_turns: true,
    recent_turns: [
      { role: "user", content: "t1" },
      { role: "assistant", content: "t2" },
      { role: "user", content: "t3" },
      { role: "assistant", content: "t4" },
      { role: "user", content: "t5" },
    ],
  }));
  assert.equal(status, 200);
  const row = db._reports.get(json.report_id);
  assert.ok(row.attachments_json, "attachments_json should be present");
  const parsed = JSON.parse(row.attachments_json);
  assert.equal(parsed.recent_turns.length, 3);
  assert.equal(parsed.recent_turns[0].content, "t1");
  assert.equal(parsed.recent_turns[2].content, "t3");
});

// 8b. include_recent_turns:true with oversized content → truncated to 2000 chars
await check("8b. turn content > 2000 chars → truncated", async () => {
  const big = "x".repeat(3000);
  const { status, json } = await fetchOnce(reportRequest({
    description: "big turn",
    include_recent_turns: true,
    recent_turns: [{ role: "user", content: big }],
  }));
  assert.equal(status, 200);
  const row = db._reports.get(json.report_id);
  const parsed = JSON.parse(row.attachments_json);
  assert.equal(parsed.recent_turns[0].content.length, 2000);
});

// 9. GET /v1/report/:id → status + resolution fields, no PII
await check("9. GET /v1/report/:id → status open, no PII", async () => {
  const { status, json } = await fetchOnce(new Request(
    `https://x/v1/report/${anonReportId}`,
  ));
  assert.equal(status, 200);
  assert.equal(json.report_id, anonReportId);
  assert.equal(json.status, "open");
  assert.equal(json.resolution_note, null);
  assert.ok(!("description" in json), "must not leak description");
  assert.ok(!("contact" in json), "must not leak contact");
  assert.ok(!("jti_hash" in json), "must not leak jti_hash");
});

// 9b. GET unknown → 404
await check("9b. GET /v1/report/<unknown> → 404", async () => {
  const { status } = await fetchOnce(new Request("https://x/v1/report/rep_doesnotexist"));
  assert.equal(status, 404);
});

// 10. Discord side-effect: with webhook URL set, fetch is called exactly once
await check("10. webhook configured → Discord fetch called once with embed", async () => {
  discordCalls = [];
  env.DISCORD_REPORT_WEBHOOK_URL = "https://discord.test/webhook/abc";
  try {
    const { status } = await fetchOnce(reportRequest({
      description: "fan this to discord",
      attachments: { studio_version: "0.1.0", os: "macOS 14.5" },
    }));
    assert.equal(status, 200);
    assert.equal(discordCalls.length, 1, `expected 1 discord call, got ${discordCalls.length}`);
    const payload = JSON.parse(discordCalls[0].init.body);
    assert.ok(payload.embeds, "embed payload");
    assert.match(payload.embeds[0].title, /^⚠️ New report: rep_/);
    // studio_version + os surfaced as fields
    const fieldNames = payload.embeds[0].fields.map((f) => f.name);
    assert.ok(fieldNames.includes("studio_version"));
    assert.ok(fieldNames.includes("os"));
  } finally {
    delete env.DISCORD_REPORT_WEBHOOK_URL;
  }
});

// 10b. No webhook URL → fetch NOT called, response still 200
await check("10b. no webhook URL → succeeds without side-effect", async () => {
  discordCalls = [];
  assert.ok(!env.DISCORD_REPORT_WEBHOOK_URL);
  const { status } = await fetchOnce(reportRequest({
    description: "no discord configured here",
  }));
  assert.equal(status, 200);
  assert.equal(discordCalls.length, 0);
});

// 11. Admin resolve → status=resolved, resolved_at set, Discord follow-up posted
await check("11. admin resolve → status=resolved + discord follow-up", async () => {
  discordCalls = [];
  env.DISCORD_REPORT_WEBHOOK_URL = "https://discord.test/webhook/abc";
  try {
    const { status, json } = await fetchOnce(new Request(
      `https://x/admin/reports/${anonReportId}/resolve`,
      {
        method: "POST",
        headers: {
          authorization: adminAuthHeader(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          resolution_note: "fixed in 0.1.1 — try again",
          github_issue_url: "https://github.com/jayleekr/hypeproof-studio/issues/99",
        }),
      },
    ));
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.ok, true);
    assert.equal(json.status, "resolved");
    const row = db._reports.get(anonReportId);
    assert.equal(row.status, "resolved");
    assert.ok(typeof row.resolved_at === "number");
    assert.equal(row.resolution_note, "fixed in 0.1.1 — try again");
    assert.equal(row.github_issue_url, "https://github.com/jayleekr/hypeproof-studio/issues/99");
    // Follow-up discord message
    assert.equal(discordCalls.length, 1);
    const body = JSON.parse(discordCalls[0].init.body);
    assert.match(body.content, /^✅ rep_/);
    assert.match(body.content, /fixed in 0\.1\.1/);
  } finally {
    delete env.DISCORD_REPORT_WEBHOOK_URL;
  }
});

// 11b. GET /v1/report/:id after resolve → status=resolved
await check("11b. GET status after resolve → resolved + note + url", async () => {
  const { status, json } = await fetchOnce(new Request(
    `https://x/v1/report/${anonReportId}`,
  ));
  assert.equal(status, 200);
  assert.equal(json.status, "resolved");
  assert.equal(json.resolution_note, "fixed in 0.1.1 — try again");
  assert.equal(json.github_issue_url, "https://github.com/jayleekr/hypeproof-studio/issues/99");
  assert.ok(typeof json.resolved_at === "number");
});

// 12. Admin resolve requires admin auth → 401 without
await check("12. admin resolve without auth → 401", async () => {
  const { status } = await fetchOnce(new Request(
    `https://x/admin/reports/${withTokenReportId}/resolve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolution_note: "should not work" }),
    },
  ));
  assert.equal(status, 401);
});

// 13. Admin resolve unknown id → 404
await check("13. admin resolve unknown id → 404", async () => {
  const { status } = await fetchOnce(new Request(
    "https://x/admin/reports/rep_doesnotexist/resolve",
    {
      method: "POST",
      headers: {
        authorization: adminAuthHeader(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ resolution_note: "x" }),
    },
  ));
  assert.equal(status, 404);
});

// 14. Admin list — default = open only
await check("14. GET /admin/reports?status=open returns only open reports", async () => {
  const { status, json } = await fetchOnce(new Request(
    "https://x/admin/reports?status=open",
    { headers: { authorization: adminAuthHeader() } },
  ));
  assert.equal(status, 200);
  for (const r of json.reports) assert.equal(r.status, "open");
});

// 14b. Admin list — all
await check("14b. GET /admin/reports?status=all returns mixed", async () => {
  const { status, json } = await fetchOnce(new Request(
    "https://x/admin/reports?status=all",
    { headers: { authorization: adminAuthHeader() } },
  ));
  assert.equal(status, 200);
  const statuses = new Set(json.reports.map((r) => r.status));
  assert.ok(statuses.has("resolved"));
  assert.ok(statuses.has("open"));
});

// 15. Admin resolve with missing resolution_note → 400
await check("15. admin resolve without resolution_note → 400", async () => {
  const { status } = await fetchOnce(new Request(
    `https://x/admin/reports/${withTokenReportId}/resolve`,
    {
      method: "POST",
      headers: {
        authorization: adminAuthHeader(),
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    },
  ));
  assert.equal(status, 400);
});

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n${passed}/${results.length} passed`);
if (failed > 0) process.exit(1);
