// Drift lock + controls for the studio-logs READ path (#680, plan task I).
//
// This file is the second half of Chalk's declared contract in products.yaml
// ("read-only cohort JSON under GET /admin/cohorts/:id/*"). board-contract
// pins /state; this pins /logs, plus the two things /state never had to face:
// a shared key layout owned by the OTHER worker, and a payload that contains
// participants' verbatim words.
//
// Four groups:
//   1. Key-layout drift — chalk's logObjectKey must equal the write path's
//      uploadObjectKey, and the readable-filename list must equal the write
//      path's upload allowlist. Both live in worker/src/routes/logs.ts.
//   2. Controls (pure, no R2, milliseconds — .claude/rules/verification.md §2):
//      POSITIVE — the real 2026-08-22 listing must name exactly
//      -01/-11/-12/-13/-14 as missing. That is labelled ground truth from
//      docs/plan/vessel-and-modules.md §3, not a guess.
//      NEGATIVE — a cohort with no uploads returns an empty list, not an error.
//   3. Access control — an instructor issuer token lists but can NEVER
//      retrieve; retrieval fails closed when no operator credential is
//      configured.
//   4. Read-only — the source of the worker contains no R2 put/delete.
//      Deletion is explicitly out of scope for task I and wrangler has no
//      read-only R2 binding, so the guarantee is asserted on the source.
//
// Run: node --experimental-strip-types chalk/test/logs-read-path.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "../../worker/test/harness/loader.mjs";

const SECRET = "test-secret-" + "x".repeat(20);
const OPERATOR_SECRET = "operator-secret-" + "y".repeat(20);

const { default: chalk } = await import("../src/index.ts");
const {
  logObjectKey,
  logsPrefix,
  parseLogKey,
  summarizeArrival,
  summarizeSeatSessions,
  operatorVerdict,
  READABLE_FILENAMES,
} = await import("../src/routes/logs-admin.ts");
const { uploadObjectKey, ALLOWED_UPLOAD_FILENAMES } = await import("../../worker/src/routes/logs.ts");
const { issueIssuer } = await import("../../worker/src/lib/tokens.ts");
const { setRoster } = await import("../../worker/src/lib/kv.ts");

// ---------------------------------------------------------------------------
// 1. Key-layout drift against the write path
// ---------------------------------------------------------------------------

{
  const cohort = "sk-biopharm-2026-a";
  const seat = "SK34-CM6YPX-07";
  const day = "2026-08-22";
  const sessionId = "0f9d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
  for (const filename of ALLOWED_UPLOAD_FILENAMES) {
    assert.equal(
      logObjectKey(cohort, seat, day, sessionId, filename),
      uploadObjectKey({ c: cohort, u: seat }, day, sessionId, filename),
      "read key must be byte-identical to the key the write path assembled",
    );
  }
  assert.deepEqual(
    [...READABLE_FILENAMES].sort(),
    [...ALLOWED_UPLOAD_FILENAMES].sort(),
    "readable filenames must equal the upload allowlist — a file the write path accepts and the read path refuses is a silent hole",
  );
  const key = logObjectKey(cohort, seat, day, sessionId, "events.jsonl");
  assert.ok(key.startsWith(logsPrefix(cohort)), "cohort prefix must select the cohort");
  assert.ok(key.startsWith(logsPrefix(cohort, seat)), "seat prefix must select the seat");
  assert.ok(key.startsWith(logsPrefix(cohort, seat, day)), "day prefix must select the day");
  assert.deepEqual(parseLogKey(key), { cohort, seat, day, sessionId, filename: "events.jsonl" });
  console.log("✓ logs-read-path: key layout matches worker/src/routes/logs.ts");
}

// A stray object under the prefix must not be able to invent a seat.
for (const bad of [
  "studio-logs/c/seat/2026-08-22/sess/secrets.txt",   // filename off the allowlist
  "studio-logs/c/seat/2026-13-99/sess/events.jsonl",  // impossible day
  "studio-logs/c/seat/2026-08-22/sess/sub/events.jsonl", // extra depth
  "studio-logs/c/../etc/2026-08-22/sess/events.jsonl",  // traversal in a segment
  "other-root/c/seat/2026-08-22/sess/events.jsonl",   // wrong root
]) {
  assert.equal(parseLogKey(bad), null, `parseLogKey must reject ${bad}`);
}
console.log("✓ logs-read-path: malformed keys are rejected, never folded into a seat");

// ---------------------------------------------------------------------------
// 2. Controls — pure over rows, no R2, no app
// ---------------------------------------------------------------------------

const COHORT = "sk-biopharm-2026-a";
const DAY = "2026-08-22";
const BATCH = "SK34-CM6YPX-";

// Ground truth as docs/plan/vessel-and-modules.md §3 states it: -02 .. -10
// uploaded, -01/-11/-12/-13/-14 did not.
const DOC_ROSTER = Array.from({ length: 14 }, (_, i) => `${BATCH}${String(i + 1).padStart(2, "0")}`);
const PRESENT_0822 = DOC_ROSTER.slice(1, 10);
const DOC_MISSING = [`${BATCH}01`, `${BATCH}11`, `${BATCH}12`, `${BATCH}13`, `${BATCH}14`];

// Ground truth as PRODUCTION actually holds it. Read 2026-09-04 from
// cohort:sk-biopharm-2026-a:roster: the batch has FIFTEEN rows, not fourteen.
// -15 was minted and never uploaded, so the honest roster diff names six seats,
// not the five the spec lists. The spec's list is not wrong about the nine that
// arrived; it undercounts the absences by one. Both are pinned here on purpose
// — the fixture control proves the function reproduces the documented answer,
// and this one proves the function does not quietly round production down to
// match a document.
const PROD_ROSTER = [...DOC_ROSTER, `${BATCH}15`];
const PROD_MISSING = [...DOC_MISSING, `${BATCH}15`];

// Kept for the assertions below that only need "a roster".
const ROSTER_0822 = PROD_ROSTER;
const EXPECTED_MISSING = PROD_MISSING;

function fixtureObjects(seats, { day = DAY, complete = true } = {}) {
  const out = [];
  for (const [i, seat] of seats.entries()) {
    const sessionId = `sess-${seat.toLowerCase()}`;
    const files = complete ? [...ALLOWED_UPLOAD_FILENAMES] : ALLOWED_UPLOAD_FILENAMES.filter((f) => f !== "manifest.json");
    for (const [j, filename] of files.entries()) {
      out.push({
        key: logObjectKey(COHORT, seat, day, sessionId, filename),
        size: 1000 + i * 10 + j,
        uploaded: new Date(Date.parse(`${day}T05:00:00Z`) + i * 60_000 + j * 1_000).toISOString(),
      });
    }
  }
  return out;
}

{
  // POSITIVE CONTROL (a) — the answer the spec documents, on the roster the
  // spec describes.
  const documented = summarizeArrival(fixtureObjects(PRESENT_0822), DOC_ROSTER);
  assert.deepEqual(
    documented.missing_seats,
    DOC_MISSING,
    "2026-08-22 roster diff must name exactly -01, -11, -12, -13, -14",
  );
  assert.equal(documented.roster_size, 14);

  // POSITIVE CONTROL (b) — the same day against the roster production really
  // holds. -15 exists and never uploaded; it must be named.
  const production = summarizeArrival(fixtureObjects(PRESENT_0822), PROD_ROSTER);
  assert.deepEqual(
    production.missing_seats,
    PROD_MISSING,
    "against the real 15-row batch the diff names six seats — -15 included",
  );

  const summary = production;
  assert.equal(summary.uploaded_seats, 9);
  assert.equal(summary.roster_size, 15);
  assert.deepEqual(summary.unknown_seats, []);
  assert.equal(summary.seats.length, 9);
  for (const s of summary.seats) {
    assert.equal(s.on_roster, true);
    assert.equal(s.sessions, 1, "one session per seat in the fixture");
    assert.equal(s.complete_sessions, 1, "manifest.json present => complete");
    assert.equal(s.files, 3);
    assert.ok(s.bytes > 0, "byte total is reported per seat");
    assert.ok(Number.isFinite(Date.parse(s.first_upload)) && Number.isFinite(Date.parse(s.last_upload)));
    assert.deepEqual(s.days, [DAY]);
  }
  console.log("✓ logs-read-path: POSITIVE control — documented roster gives the five; the real 15-row roster gives six (-15 included)");

  // A seat whose upload died before manifest.json must NOT read as complete —
  // otherwise partial arrival looks identical to full arrival, which is the
  // failure mode that hid the 2026-08-22 gap for twelve days.
  const partial = summarizeArrival(fixtureObjects(["SK34-CM6YPX-05"], { complete: false }), ROSTER_0822);
  assert.equal(partial.seats[0].sessions, 1);
  assert.equal(partial.seats[0].complete_sessions, 0, "no manifest => session is not complete");
  console.log("✓ logs-read-path: a manifest-less session reports as incomplete, not as absent");

  // An uploaded seat that is not on the roster is surfaced, never dropped.
  const stale = summarizeArrival(fixtureObjects(["SK56-ZZZZZZ-01"]), ROSTER_0822);
  assert.deepEqual(stale.unknown_seats, ["SK56-ZZZZZZ-01"]);
  assert.equal(stale.seats[0].on_roster, false);
  assert.deepEqual(stale.missing_seats, ROSTER_0822, "every roster row is still rendered");

  // NEGATIVE CONTROL (pure half) — nothing uploaded is an empty list, and the
  // whole roster is named missing. Not an error.
  const none = summarizeArrival([], ROSTER_0822);
  assert.deepEqual(none.seats, []);
  assert.deepEqual(none.missing_seats, ROSTER_0822);
  assert.equal(none.total_files, 0);
  assert.equal(none.total_bytes, 0);

  // No roster at all: list what arrived, name nothing missing.
  const noRoster = summarizeArrival(fixtureObjects(PRESENT_0822), null);
  assert.deepEqual(noRoster.missing_seats, []);
  assert.equal(noRoster.roster_size, 0);
  assert.equal(noRoster.uploaded_seats, 9);

  const sessions = summarizeSeatSessions(fixtureObjects(["SK34-CM6YPX-02"]));
  assert.deepEqual(Object.keys(sessions[0]).sort(), [
    "bytes", "complete", "day", "files", "first_upload", "last_upload", "session_id",
  ]);
  console.log("✓ logs-read-path: NEGATIVE control (pure) — empty listing, roster still fully rendered");
}

// ---------------------------------------------------------------------------
// Operator gate — pure verdict function
// ---------------------------------------------------------------------------

{
  assert.equal(operatorVerdict({}, undefined).status, 503, "unconfigured deployment fails CLOSED");
  assert.equal(operatorVerdict({}, "short").status, 503, "a weak operator secret is treated as unconfigured");
  assert.equal(operatorVerdict({ secret: OPERATOR_SECRET }, OPERATOR_SECRET).ok, true);
  assert.equal(operatorVerdict({ secret: "wrong-" + "z".repeat(25) }, OPERATOR_SECRET).status, 401);
  assert.equal(operatorVerdict({ access: "ops@hypeproof.ai" }, undefined).ok, true, "Cloudflare Access is the production path and needs no secret");
  assert.equal(operatorVerdict({ access: "ops@hypeproof.ai" }, undefined).who, "ops@hypeproof.ai");
  console.log("✓ logs-read-path: operator gate — Access, then dedicated secret, else 503");
}

// ---------------------------------------------------------------------------
// 3. HTTP surface — access control and the closed key set
// ---------------------------------------------------------------------------

const store = new Map();
const kv = {
  async get(k, t) { const v = store.get(k); return v === undefined ? null : t === "json" ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
  async list({ prefix } = {}) { return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
};

const EVENTS_BODY = '{"role":"user","text":"엄마 생일 카드 만들어줘"}\n';
const r2 = new Map();
for (const o of fixtureObjects(PRESENT_0822)) {
  r2.set(o.key, { size: o.size, uploaded: new Date(o.uploaded), body: EVENTS_BODY });
}
let r2Writes = 0;
const bucket = {
  async list({ prefix, cursor, limit }) {
    void cursor; void limit;
    const objects = [...r2.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, v]) => ({ key, size: v.size, uploaded: v.uploaded }));
    return { objects, truncated: false, cursor: undefined };
  },
  async get(key) {
    const v = r2.get(key);
    if (!v) return null;
    return { size: v.size, body: new Blob([v.body]).stream() };
  },
  async put() { r2Writes++; throw new Error("Chalk must never write to R2"); },
  async delete() { r2Writes++; throw new Error("Chalk must never delete from R2"); },
};

const env = {
  HPS_SIGNING_SECRET: SECRET,
  ENVIRONMENT: "production",
  HPS_KV: kv,
  HPS_DB: {},
  HPS_TRACES: bucket,
};
const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = (path, headers = {}) =>
  chalk.fetch(new Request(`https://chalk.test${path}`, { headers }), env, ctx);

await setRoster(kv, COHORT, ROSTER_0822);

const { token: instructorToken } = await issueIssuer(
  { issuer: "task-i", scopes: [{ cohort: COHORT, profiles: ["sk-biopharm-kids-s1"], max_hours: 6 }] },
  24,
  SECRET,
);
const asInstructor = { authorization: `Bearer ${instructorToken}` };
const asOperator = { "x-hps-operator-secret": OPERATOR_SECRET };

// --- listing: instructor is enough -----------------------------------------
{
  const res = await call(`/admin/cohorts/${COHORT}/logs`, asInstructor);
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.deepEqual(
    Object.keys(body).sort(),
    ["cohort", "day", "missing_seats", "now", "roster_scope", "roster_size", "seats", "total_bytes", "total_files", "truncated", "unknown_seats", "upload_opt_in", "uploaded_seats"],
    "GET /admin/cohorts/:id/logs — top-level keys are a closed set",
  );
  assert.deepEqual(body.missing_seats, EXPECTED_MISSING, "HTTP path reproduces the 2026-08-22 answer");
  assert.deepEqual(body.roster_scope, { seat_prefix: null, cohort_roster_size: ROSTER_0822.length, scoped_roster_size: ROSTER_0822.length });
  assert.equal(body.upload_opt_in, true, "sk-biopharm carries analytics.upload_session_logs");
  for (const s of body.seats) {
    assert.deepEqual(
      Object.keys(s).sort(),
      ["bytes", "complete_sessions", "days", "files", "first_upload", "last_upload", "on_roster", "seat", "sessions"],
      "seat rows are a closed set",
    );
  }
  // PRIVACY: the listing endpoint never opens a file, so no participant text
  // can reach it. Assert it on the wire, not on the intent.
  assert.ok(!text.includes("엄마"), "listing must never contain participant text");
  assert.ok(!text.includes(EVENTS_BODY.trim()), "listing must never contain an events.jsonl body");
  console.log("✓ logs-read-path: listing is instructor-readable, closed key set, zero participant text");
}

{
  const res = await call(`/admin/cohorts/${COHORT}/logs/SK34-CM6YPX-02`, asInstructor);
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(), ["cohort", "now", "seat", "sessions", "truncated"]);
  assert.equal(body.sessions.length, 1);
  assert.ok(!text.includes("엄마"), "per-seat listing must never contain participant text");
  console.log("✓ logs-read-path: per-seat session listing carries ids and sizes only");
}

// --- the cumulative-roster trap (found by running against production) ------
{
  // Production's cohort roster is not one class: it accumulates every batch
  // ever minted, plus probes. Unscoped, the diff drowns; `?seat_prefix=`
  // recovers the class, and `roster_scope` reports which was used.
  const OTHER_BATCHES = [
    ...Array.from({ length: 20 }, (_, i) => `SK56-3SDBN4-${String(i + 1).padStart(2, "0")}`),
    ...Array.from({ length: 10 }, (_, i) => `SK34-D8YAFE-${String(i + 1).padStart(2, "0")}`),
    "deploy-verify", "kids-sdk-verify", "보아치과-01",
  ];
  await setRoster(kv, COHORT, [...OTHER_BATCHES, ...ROSTER_0822]);

  const wide = await (await call(`/admin/cohorts/${COHORT}/logs?day=${DAY}`, asInstructor)).json();
  assert.equal(wide.roster_scope.cohort_roster_size, OTHER_BATCHES.length + ROSTER_0822.length);
  assert.equal(
    wide.missing_seats.length,
    OTHER_BATCHES.length + EXPECTED_MISSING.length,
    "unscoped: every never-uploading handle the cohort ever held is named — legal, and visibly noisy",
  );

  const scoped = await (await call(`/admin/cohorts/${COHORT}/logs?day=${DAY}&seat_prefix=${BATCH}`, asInstructor)).json();
  assert.deepEqual(scoped.missing_seats, EXPECTED_MISSING, "seat_prefix recovers the single class");
  assert.deepEqual(scoped.roster_scope, {
    seat_prefix: BATCH,
    cohort_roster_size: OTHER_BATCHES.length + ROSTER_0822.length,
    scoped_roster_size: ROSTER_0822.length,
  });
  assert.deepEqual(scoped.unknown_seats, [], "scoping the roster must also scope the objects — no cross-batch bleed");
  assert.equal(scoped.uploaded_seats, PRESENT_0822.length);
  assert.equal((await call(`/admin/cohorts/${COHORT}/logs?seat_prefix=has%2Fslash`, asInstructor)).status, 400);
  console.log("✓ logs-read-path: cumulative roster is scoped by seat_prefix, and the scope is reported");

  await setRoster(kv, COHORT, ROSTER_0822);
}

// --- listing: no token, or wrong cohort ------------------------------------
{
  assert.equal((await call(`/admin/cohorts/${COHORT}/logs`)).status, 401, "listing requires a credential");
  const { token: other } = await issueIssuer(
    { issuer: "elsewhere", scopes: [{ cohort: "boah-dental-2026-a", max_hours: 6 }] },
    24,
    SECRET,
  );
  const res = await call(`/admin/cohorts/${COHORT}/logs`, { authorization: `Bearer ${other}` });
  assert.equal(res.status, 403, "an issuer scoped to another cohort cannot list this one");
}

// --- NEGATIVE CONTROL over HTTP: a cohort with no uploads ------------------
{
  const res = await call(`/admin/cohorts/boah-dental-2026-a/logs`, {
    authorization: `Bearer ${(await issueIssuer({ issuer: "d", scopes: [{ cohort: "boah-dental-2026-a", max_hours: 6 }] }, 24, SECRET)).token}`,
  });
  assert.equal(res.status, 200, "a cohort with no uploads is 200, NOT 404 and NOT 500");
  const body = await res.json();
  assert.deepEqual(body.seats, [], "empty list");
  assert.equal(body.total_files, 0);
  assert.equal(body.upload_opt_in, false, "boah-dental never opted in — reported, not thrown");
  console.log("✓ logs-read-path: NEGATIVE control (HTTP) — no uploads returns an empty list, not an error");
}

// --- retrieval: the whole point of the access-control decision -------------
const RETRIEVE = `/admin/cohorts/${COHORT}/logs/SK34-CM6YPX-02/${DAY}/sess-sk34-cm6ypx-02/events.jsonl`;

{
  // Unconfigured deployment (no Cloudflare Access, no operator secret): fail
  // CLOSED for everyone, and say so distinctly from "denied". The gate runs
  // before any path or R2 work, so an instructor token gets the same 503.
  for (const headers of [asOperator, asInstructor, {}]) {
    const res = await call(RETRIEVE, headers);
    assert.equal(res.status, 503, "no operator credential configured => 503, fail closed");
    assert.equal((await res.json()).error.code, "retrieval_not_configured");
  }
  console.log("✓ logs-read-path: retrieval fails closed on an unconfigured deployment");
}

const opEnv = { ...env, HPS_LOGS_OPERATOR_SECRET: OPERATOR_SECRET };
const callOp = (path, headers = {}) =>
  chalk.fetch(new Request(`https://chalk.test${path}`, { headers }), opEnv, ctx);

{
  const res = await callOp(RETRIEVE, asOperator);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(await res.text(), EVENTS_BODY, "operator retrieval returns the file verbatim");
  console.log("✓ logs-read-path: operator retrieval works and returns the raw file");
}

{
  // Even with the operator secret configured, an instructor Bearer is still not
  // an operator — the two credentials are not interchangeable. This is the
  // assertion the whole file exists for: the same token that lists happily
  // cannot read a child's words.
  const res = await callOp(RETRIEVE, asInstructor);
  assert.equal(res.status, 401, "an instructor issuer token must never retrieve session log content");
  assert.equal((await res.json()).error.code, "operator_required");
  // A bare request, and a wrong secret, are denied the same way.
  assert.equal((await callOp(RETRIEVE)).status, 401);
  assert.equal((await callOp(RETRIEVE, { "x-hps-operator-secret": "nope-" + "q".repeat(30) })).status, 401);
  console.log("✓ logs-read-path: instructor token lists but CANNOT retrieve");
  // And a Cloudflare Access identity works with no secret presented.
  const viaAccess = await callOp(RETRIEVE, { "cf-access-authenticated-user-email": "ops@hypeproof.ai" });
  assert.equal(viaAccess.status, 200);
}

{
  // Cohort opt-in is re-checked on READ. boah-dental has no upload_session_logs,
  // so even an operator gets a policy refusal rather than bytes.
  const res = await callOp(
    `/admin/cohorts/boah-dental-2026-a/logs/X-01/${DAY}/sess/events.jsonl`,
    asOperator,
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, "cohort_not_opted_in");
  console.log("✓ logs-read-path: retrieval re-checks the cohort consent basis, operator or not");
}

{
  // Path shape is validated before R2 is touched.
  for (const [path, status] of [
    [`/admin/cohorts/${COHORT}/logs/SK34-CM6YPX-02/${DAY}/sess/secrets.txt`, 400],
    [`/admin/cohorts/${COHORT}/logs/SK34-CM6YPX-02/2026-13-99/sess/events.jsonl`, 400],
    [`/admin/cohorts/${COHORT}/logs/SK34-CM6YPX-99/${DAY}/nope/events.jsonl`, 404],
  ]) {
    const res = await callOp(path, asOperator);
    assert.equal(res.status, status, `${path} => ${status}`);
  }
  assert.equal((await callOp(`/admin/cohorts/${COHORT}/logs?day=nonsense`, asOperator)).status, 400);
  const dayFiltered = await callOp(`/admin/cohorts/${COHORT}/logs?day=2026-09-01`, asOperator);
  assert.equal(dayFiltered.status, 200);
  assert.deepEqual((await dayFiltered.json()).missing_seats, [...ROSTER_0822].sort(), "a day with no uploads: every seat missing");
}

assert.equal(r2Writes, 0, "no R2 write or delete was attempted by any request in this suite");

// ---------------------------------------------------------------------------
// 4. Read-only, asserted on the source
// ---------------------------------------------------------------------------

{
  const src = readFileSync(fileURLToPath(new URL("../src/routes/logs-admin.ts", import.meta.url)), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
    .join("\n");
  for (const forbidden of [".put(", ".delete(", ".createMultipartUpload(", "HPS_DB"]) {
    assert.ok(
      !code.includes(forbidden),
      `logs-admin.ts must contain no ${forbidden} — deletion and writes are explicitly out of scope for task I`,
    );
  }
  assert.ok(code.includes("HPS_TRACES.get("), "sanity: the read path does exist");
  console.log("✓ logs-read-path: the module is read-only by construction — no put, no delete");
}

console.log("All logs-read-path tests passed (#680 task I — arrival, roster diff, retrieval).");
