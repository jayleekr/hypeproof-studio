// cr-evidence (#1394) — participant evidence on the Service, worker D1 layer (SQLite shim by
// default; `--d1` runs the same checks on local workerd D1 and a local workerd R2 bucket through
// Miniflare). Real Service router, real token verifier, the real participant snippets run in a
// VM against it. Synthetic identities; no network.
//
// CR-T02 (Worker half: the evidence routes, the events route, the admin controls) · CR-T23 ·
// CR-T24 · CR-T25 · CR-T26 · CR-T27 (Service half of the negative) · CR-T28 · CR-T60 (schema
// half and a server-side re-check) · CR-T62 · CR-T64 · CR-T65 · CR-T67 · CR-T69, plus decision 6's
// automatic deletion, the per-link rate limits and R2's conditional put. Each with a positive
// sample that must pass and a planted defect that must be caught.
//
// Run: node --experimental-strip-types --experimental-sqlite test/cr-evidence.test.mjs [--d1]
//
// --d1 opens a new local socket per Miniflare round trip, about 15,000 in one run, which stay in
// TIME_WAIT for about a minute. Another --d1 suite started right after it can then fail with
// EADDRNOTAVAIL (a false red); wait a minute between them. CI keeps this step last for that reason.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { localCurriculum, memoryR2 } from "./harness/curriculum.mjs";
import { TEST_SECRET } from "./harness/index.mjs";

const { PARTICIPANT_SNIPPET, PARTICIPANT_EVENTS_SNIPPET } = await import("../src/lib/curriculum/participant-snippet.ts");
const { participantRecord, participantEvents, noteEvent, openParticipantSession, appendParticipantEvents, sameClientEvent, PUBLISHED_HOST, EVIDENCE_LIMITS } = await import("../src/lib/curriculum/participant-record.ts");
const { CURRICULUM_ROUTES } = await import("../src/routes/curriculum.ts");
const { CURRICULUM_ADMIN_ROUTES } = await import("../src/routes/curriculum-admin.ts");
const { runCurriculumRetention } = await import("../src/lib/curriculum/retention.ts");
const { CR_SURFACES, CR_TEST_ORIGIN_EVENTS_ROUTE } = await import("../../extensions/hypeproof-chat/src/curriculumRuntime.ts");
const core = await import("../src/lib/measurement-core/index.ts");
const { LocalRecord } = await import("../src/lib/measurement-core/local-record.ts");
const { issue, issueIssuer } = await import("../src/lib/tokens.ts");

const D1_MODE = process.argv.includes("--d1");
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ ${name}\n   ${err.stack ?? err.message}`);
  }
}

/**
 * Local sockets in TIME_WAIT, or null when they cannot be counted. Miniflare opens a new
 * connection per D1/R2 round trip (its runtime dispatcher sets `reset: true`), so one --d1 run
 * leaves thousands of them; past the ephemeral port range a call fails with EADDRNOTAVAIL.
 */
function socketsWaiting() {
  try {
    let n = 0;
    for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      try {
        n += readFileSync(f, "utf8").split("\n").filter((l) => l.split(/\s+/)[4] === "06").length;
      } catch {}
    }
    if (n > 0 || process.platform === "linux") return n;
    return execFileSync("netstat", ["-an", "-p", "tcp"], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter((l) => l.includes("TIME_WAIT")).length;
  } catch {
    return null;
  }
}
/** Before a --d1 fixture: let closed sockets drain when many are waiting (at most two minutes). */
async function drainSockets(limit = 8000) {
  for (let waited = 0; waited < 120_000; waited += 2000) {
    const n = socketsWaiting();
    if (n === null || n < limit) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

let mf = null;
async function fixture(opts = {}) {
  if (!D1_MODE) return localCurriculum(opts);
  await drainSockets();
  const { createMiniflare } = await import("./harness/miniflare.mjs");
  const compatibilityDate = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8").match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
  mf ??= createMiniflare({ modules: true, script: 'export default {fetch(){return new Response("local test")}}', compatibilityDate, d1Databases: ["HPS_DB"], r2Buckets: ["HPS_TRACES"] });
  const db = await mf.getD1Database("HPS_DB");
  for (const t of ["cr_experiment_records", "cr_link_rates", "cr_cohort_controls", "cr_test_links", "cr_experiments", "cr_product_versions", "cr_hypotheses", "cr_projects"]) await db.prepare(`DROP TABLE IF EXISTS ${t}`).run();
  for (const m of ["0032-curriculum-runtime-publish", "0033-curriculum-runtime-evidence"]) {
    const sql = readFileSync(new URL(`../migrations/${m}.sql`, import.meta.url), "utf8");
    for (let i = 0; i < 2; i++) for (const s of sql.replace(/^--.*$/gm, "").split(";").map((x) => x.trim()).filter(Boolean)) await db.prepare(s).run();
  }
  const bucket = await mf.getR2Bucket("HPS_TRACES");
  // A fresh prefix space per fixture: delete what an earlier fixture left.
  for (let page = await bucket.list(); page.objects.length; page = await bucket.list()) await bucket.delete(page.objects.map((o) => o.key));
  return localCurriculum({ ...opts, binding: db, r2: bucket });
}

const PAGE = (marker) =>
  `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>키오스크 연습</title></head><body><h1>${marker}</h1><button id="order">주문하기</button><input name="memo"><script src="app.js"></script></body></html>`;
const V0 = { "index.html": PAGE("버전 0"), "app.js": "document.title += ' ok';" };
const V1 = { ...V0, "index.html": PAGE("버전 1") };
const V2 = { ...V0, "index.html": PAGE("버전 2") };

/** The task and milestone names the sample apps report; declared by `started` unless `labels: null`. */
const LABELS = ["주문하기", "메뉴 고름", "주문", "x", "늦은 기록"];

/** One project with `files` published, an experiment on it and (unless `noLink`) one live link. */
async function started(f, { channel, files = V0, declarations: given, labels = LABELS, token, noLink = false, linkBody = {} } = {}) {
  const declarations = labels ? { ...given, labels } : given;
  const t = token ?? (await f.student());
  const p = await f.api("/v1/curriculum/projects", { method: "POST", token: t, body: { title: "키오스크 실험" } });
  assert.equal(p.status, 201, p.text);
  const project = p.json.project;
  const up = await f.upload(project.id, files, t);
  assert.ok(up.status === 201 || up.status === 200, up.text);
  const e = await f.api("/v1/curriculum/experiments", {
    method: "POST",
    token: t,
    body: { project_id: project.id, product_version_id: up.id, week: 1, question: "도움 없이 주문을 마칠 수 있나?", method: "task_test", success_criteria: ["5명 중 3명 완료"], hypothesis: "처음 쓰는 사람도 혼자 주문할 수 있다", ...(declarations ? { declarations } : {}) },
  });
  assert.equal(e.status, 201, e.text);
  const out = { token: t, project, version: up.id, experiment: e.json.experiment };
  if (noLink) return out;
  const l = await f.api(`/v1/curriculum/experiments/${e.json.experiment.id}/links`, { method: "POST", token: t, body: { expires_at: Date.now() + 3600_000, ...(channel ? { channel } : {}), ...linkBody } });
  assert.equal(l.status, 201, l.text);
  return { ...out, link: l.json.link, url: l.json.share_url };
}

/** A second experiment, with its own live link, in the same Project as `s`. */
async function sibling(f, s, declarations = {}) {
  const e = await f.api("/v1/curriculum/experiments", { method: "POST", token: s.token, body: { project_id: s.project.id, product_version_id: s.version, week: 2, question: "다시 쓰나?", method: "task_test", success_criteria: ["다시 옴"], hypothesis: `다시 쓰는 사람이 있다 ${Math.random()}`, declarations: { labels: LABELS, ...declarations } } });
  assert.equal(e.status, 201, e.text);
  const l = await f.api(`/v1/curriculum/experiments/${e.json.experiment.id}/links`, { method: "POST", token: s.token, body: { expires_at: Date.now() + 3600_000 } });
  assert.equal(l.status, 201, l.text);
  return { ...s, experiment: e.json.experiment, link: l.json.link, url: l.json.share_url };
}

async function openEntry(f, url) {
  const first = await f.open(url);
  if (first.status !== 302) return first;
  return f.open(new URL(first.headers.get("location"), url).href);
}
const hpTest = (html) => JSON.parse(/window\.__hpTest=(\{.*?\});<\/script>/.exec(html)?.[1] ?? "null");
const settle = async (n = 80) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// ── A participant browser: both snippets in a VM, a tiny DOM, fetch wired to the Service ──
function el(tag, attrs = {}, parent = null) {
  const node = { nodeType: 1, tagName: tag.toUpperCase(), parentNode: parent, previousElementSibling: null, children: [], getAttribute: (k) => attrs[k] ?? null, ...attrs };
  if (parent) {
    node.previousElementSibling = parent.children.at(-1) ?? null;
    parent.children.push(node);
  }
  return node;
}
function participant(f, { seed = 1, lose } = {}) {
  const local = new Map();
  let n = seed;
  const store = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) });
  return {
    local,
    /** One tab (one visit): its sessionStorage lives across page loads. */
    tab() {
      const session = new Map();
      const posts = [];
      // Every fetch the page started and every timer it set, so a step waits until the page is
      // idle (a timer runs only after the fetches before it settled, like a real network does
      // within the snippet's retry window).
      const pending = new Set();
      const track = (p) => {
        pending.add(p);
        p.finally(() => pending.delete(p)).catch(() => undefined);
        return p;
      };
      const idle = async () => {
        for (let quiet = 0; quiet < 3; ) {
          if (pending.size) {
            quiet = 0;
            await Promise.allSettled([...pending]);
          } else quiet++;
          await new Promise((r) => setImmediate(r));
        }
      };
      return {
        session,
        posts,
        /** Load a page of the link like a phone and run both snippets. */
        async load(url, { entry = true } = {}) {
          const page = entry ? await openEntry(f, url) : await f.open(url);
          assert.equal(page.status, 200, page.text);
          const cfg = hpTest(page.text);
          const origin = new URL(url).origin;
          const listeners = {};
          const html = el("html");
          const body = el("body", {}, html);
          const button = el("button", { id: "order" }, body);
          const input = el("input", { name: "memo", value: "" }, body);
          const document = { addEventListener: (type, fn) => ((listeners[type] ??= []).push(fn)) };
          const fetch = (u, init) =>
            track(
              (async () => {
                posts.push({ url: u, body: JSON.parse(init.body) });
                const r = await f.raw(new URL(u, origin).href, { method: init.method, body: init.body });
                // A response lost on the way back: the Service did the work, the page sees a network error.
                if (lose?.(u, r)) throw new TypeError("network error");
                return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => r.headers.get(k) } };
              })(),
            );
          const later = (fn) => track(Promise.allSettled([...pending]).then(() => new Promise((r) => setImmediate(r))).then(fn));
          const win = { __hpTest: cfg, sessionStorage: store(session), localStorage: store(local), fetch };
          const crypto = { getRandomValues: (b) => { for (let i = 0; i < b.length; i++) b[i] = (n = (n * 1103515245 + 12345) & 0x7fffffff) & 255; return b; } };
          const ctx = { window: win, document, location: { pathname: new URL(page.url ?? url).pathname }, crypto, JSON, Date, Object, Uint8Array, String, setTimeout: (fn) => void later(fn) };
          vm.runInNewContext(PARTICIPANT_SNIPPET, ctx);
          vm.runInNewContext(PARTICIPANT_EVENTS_SNIPPET, ctx);
          await idle();
          return {
            cfg,
            test: win.hypeproof.test,
            click: async (node = button) => { for (const fn of listeners.click ?? []) fn({ target: node }); await idle(); },
            type: async (value, node = input) => { node.value = value; for (const fn of listeners.change ?? []) fn({ target: node }); await idle(); },
            task: async (label, phase) => { win.hypeproof.test.task(label, phase); await idle(); },
            milestone: async (label) => { win.hypeproof.test.milestone(label); await idle(); },
          };
        },
      };
    },
  };
}

/** The experiment's stored records, read the way the routes read them. */
async function recordOf(f, s) {
  return participantRecord(f.r2, s.project.cohort_id, s.project.id);
}
async function storedEvents(f, s) {
  return (await (await recordOf(f, s)).observationsOf(PUBLISHED_HOST, s.experiment.id)).map((r) => r.event);
}
async function evidence(f, s, token = s.token) {
  const r = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/evidence`, { token });
  return r;
}
/** Every key of the Project's record under `sub` (relative keys). */
async function recordKeys(f, s, sub) {
  const prefix = `curriculum/${encodeURIComponent(s.project.cohort_id)}/${encodeURIComponent(s.project.id)}/`;
  return (await f.r2.list({ prefix: prefix + sub })).objects.map((o) => o.key.slice(prefix.length));
}
/** Raw records of an experiment by key, with their bytes' sha256 (CR-T26). */
async function rawHashes(f, s) {
  const out = {};
  const prefix = `curriculum/${encodeURIComponent(s.project.cohort_id)}/${encodeURIComponent(s.project.id)}/`;
  const list = await f.r2.list({ prefix });
  for (const o of list.objects) {
    const k = o.key.slice(prefix.length);
    if (!k.startsWith("observations/") && !k.startsWith("sessions/")) continue;
    out[k] = createHash("sha256").update(await (await f.r2.get(o.key)).text()).digest("hex");
  }
  return out;
}

// ── CR-T02, Worker half ──────────────────────────────────────────────────────

await test("CR-T02 inventory: the App's switch-off inventory lists the evidence routes, the events route and the admin controls", () => {
  for (const r of [...CURRICULUM_ROUTES, ...CURRICULUM_ADMIN_ROUTES, CR_TEST_ORIGIN_EVENTS_ROUTE]) assert.ok(CR_SURFACES.workerRoutes.includes(r), `${r} missing from CR_SURFACES.workerRoutes`);
  const src = readFileSync(new URL("../src/routes/curriculum-admin.ts", import.meta.url), "utf8");
  const mounted = [...src.matchAll(/curriculumAdmin\.(get|post|put|delete)\("([^"]+)"/g)].map((m) => `${m[1].toUpperCase()} /admin${m[2]}`);
  assert.deepEqual(mounted.sort(), [...CURRICULUM_ADMIN_ROUTES].sort());
  const origin = readFileSync(new URL("../src/routes/curriculum-test-origin.ts", import.meta.url), "utf8");
  assert.match(origin, /testOriginApp\.post\("\/l\/:link\/__hp\/events"/);
  assert.ok(!CR_SURFACES.workerRoutes.includes("POST /v1/curriculum/experiments/:id/notez"), "control: an unmounted name is not listed");
});

await test("CR-T02 switch OFF: the events route answers as an unknown path of the origin; the admin controls as an unknown admin path; ON they answer", async () => {
  const f = await fixture();
  try {
    const s = await started(f);
    const b = participant(f).tab();
    const page = await b.load(s.url);
    const token = page.cfg.session_token;
    f.setSwitch(false);
    const ev = await f.raw(new URL(`/l/${s.link.id}/__hp/events`, s.url).href, { method: "POST", body: { token, events: [{ kind: "milestone", seq: 99, label: "x" }] } });
    const unknownPost = await f.raw(new URL("/cr-never-registered", s.url).href, { method: "POST", body: { token, events: [] } });
    assert.deepEqual([ev.status, ev.text], [unknownPost.status, unknownPost.text]);
    const path = `/admin/curriculum/cohorts/${s.project.cohort_id}/controls`;
    const ctl = await f.admin(path);
    const unknownAdmin = await f.admin("/admin/cr-never-registered");
    assert.deepEqual([ctl.status, ctl.json?.error?.type, ctl.json?.error?.message], [unknownAdmin.status, unknownAdmin.json?.error?.type, unknownAdmin.json?.error?.message]);
    assert.equal(ctl.status, 404);
    f.setSwitch(true);
    assert.equal((await f.admin(path)).status, 200, "ON: the controls answer");
    const on = await f.raw(new URL(`/l/${s.link.id}/__hp/events`, s.url).href, { method: "POST", body: { token, events: [{ kind: "milestone", seq: 99, label: "x" }] } });
    assert.equal(on.status, 204, on.text);
  } finally {
    f.close();
  }
});

// ── CR-T23 · CR-T60 (re-check) ───────────────────────────────────────────────

const IDENTITY_KEYS = /^(name|email|e_mail|phone|tel|user_?agent|ip|address)$/i;
/** The CR-T23 verdict on stored events: problems found, empty when they hold. */
function participantEventProblems(events, s, { channel } = {}) {
  const problems = [];
  const kinds = new Set(events.map((e) => e.kind));
  for (const k of ["session_start", "page_view", "click", "task_start", "task_complete", "milestone"]) if (!kinds.has(k)) problems.push(`missing kind ${k}`);
  const deep = (v, path = "") => {
    if (Array.isArray(v)) return v.forEach((x, i) => deep(x, `${path}[${i}]`));
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (IDENTITY_KEYS.test(k)) problems.push(`identity field ${path}.${k}`); deep(x, `${path}.${k}`); }
  };
  deep(events);
  for (const e of events) {
    if (e.source_state !== "real") problems.push(`${e.id}: source_state ${e.source_state}`);
    if (!/^ps-[0-9a-f]{32}$/.test(e.participant?.session_id ?? "")) problems.push(`${e.id}: no random session id`);
    if (!/^pp-[0-9a-f]{32}$/.test(e.participant?.pseudonym ?? "")) problems.push(`${e.id}: no pseudonym`);
    const a = e.attribution ?? {};
    if (a.project !== s.project.id || a.experiment !== s.experiment.id || a.product_version !== s.version) problems.push(`${e.id}: attribution ${JSON.stringify(a)}`);
    if (channel && a.channel !== channel) problems.push(`${e.id}: channel ${a.channel}`);
    if (e.kind === "click" && /주문하기/.test(JSON.stringify(e))) problems.push(`${e.id}: a click carries the element's text`);
  }
  return problems;
}

await test("CR-T23: one scripted participant session records the six kinds under a random session id and pseudonym, with no identity field, each with its session's project, experiment, version and channel", async () => {
  const f = await fixture();
  try {
    const s = await started(f, { channel: "학교 게시판" });
    const tab = participant(f).tab();
    const page = await tab.load(s.url);
    await page.click();
    await page.task("주문하기", "start");
    await page.milestone("메뉴 고름");
    await page.task("주문하기", "complete");
    // A second page of the same visit: one more page_view, no second session_start.
    await tab.load(new URL("index.html", s.url).href, { entry: false });
    const events = await storedEvents(f, s);
    assert.deepEqual(participantEventProblems(events, s, { channel: "학교 게시판" }), []);
    assert.equal(events.filter((e) => e.kind === "session_start").length, 1, "one session_start per visit");
    assert.equal(new Set(events.map((e) => e.participant.session_id)).size, 1, "one visit, one session");
    assert.equal(events.filter((e) => e.kind === "page_view").length, 2);
    assert.ok(events.every((e) => core.validateObservation({ format: "hps-observation/2", scope: s.experiment.id, session: e.participant.session_id, program: "x", events: [e] })), "every stored event passes the one validator");
    // Instrument controls: a planted identity field, a missing kind and a stripped attribution are each caught.
    assert.ok(participantEventProblems(events.map((e, i) => (i ? e : { ...e, email: "a@b.c" })), s).some((p) => /identity/.test(p)));
    assert.ok(participantEventProblems(events.filter((e) => e.kind !== "milestone"), s).some((p) => /milestone/.test(p)));
    assert.ok(participantEventProblems(events.map((e) => ({ ...e, attribution: { ...e.attribution, product_version: "v-other" } })), s).length > 0);
  } finally {
    f.close();
  }
});

await test("CR-T23 negative: events after revocation (still-valid token), with a name or e-mail field, forged or other-link tokens, or before the session opened are refused and write nothing", async () => {
  const f = await fixture();
  try {
    const s = await started(f);
    const other = await started(f);
    const tab = participant(f).tab();
    const page = await tab.load(s.url);
    const token = page.cfg.session_token;
    const send = (events, t = token, link = s.link.id, url = s.url) => f.raw(new URL(`/l/${link}/__hp/events`, url).href, { method: "POST", body: { token: t, events } });
    const before = (await storedEvents(f, s)).length;
    for (const planted of [{ kind: "milestone", seq: 50, label: "x", name: "홍길동" }, { kind: "click", seq: 51, target: { role: "button", path: "body>button" }, email: "kid@example.com" }, { kind: "milestone", seq: 52, label: "x", meta: { phone: "010" } }]) {
      const r = await send([planted]);
      assert.deepEqual([r.status, r.headers.get("x-hp-refusal")], [400, "identity_field"], JSON.stringify(planted));
    }
    assert.equal((await send([{ kind: "milestone", seq: 53, label: "x" }], token.slice(0, -3) + "AAA")).status, 403, "forged token");
    assert.equal((await send([{ kind: "milestone", seq: 53, label: "x" }], token, other.link.id, other.url)).status, 403, "another link's token");
    // A visit whose session was never opened on the Service (the open did not land yet).
    const unopened = hpTest((await openEntry(f, s.url)).text);
    assert.deepEqual([(await send([{ kind: "milestone", seq: 1, label: "x" }], unopened.session_token)).status], [409]);
    assert.equal((await storedEvents(f, s)).length, before, "nothing written by any refusal");
    // Revoked: the link's state is read on every event, whatever the token's own expiry.
    await f.api(`/v1/curriculum/links/${s.link.id}/revoke`, { method: "POST", token: s.token });
    const gone = await send([{ kind: "milestone", seq: 60, label: "늦은 기록" }]);
    assert.deepEqual([gone.status, gone.text], [410, ""]);
    assert.equal((await storedEvents(f, s)).length, before);
  } finally {
    f.close();
  }
});

await test("CR-T60 schema half: the participant schema has no identity field; a planted email or name field is caught; the server keeps one pseudonym per experiment and per declared device only", async () => {
  assert.deepEqual(core.identityFieldProblems([...core.PARTICIPANT_SCHEMA_FIELDS]), [], "positive: the shipped schema");
  assert.deepEqual(core.identityFieldProblems([...core.PARTICIPANT_SCHEMA_FIELDS, "email"]), ["email"], "negative: a schema change adding email");
  assert.deepEqual(core.identityFieldProblems([...core.PARTICIPANT_SCHEMA_FIELDS, "name"]), ["name"], "negative: a schema change adding name");
  // The validator refuses an identity key on a stored participant event, not only the route.
  const f = await fixture();
  try {
    const declared = await started(f, { declarations: { repeated_use: true } });
    const undeclared = await started(f);
    const phone = participant(f, { seed: 11 });
    await phone.tab().load(declared.url);
    await phone.tab().load(declared.url);
    await phone.tab().load(undeclared.url);
    await phone.tab().load(undeclared.url);
    const links = async (s) => (await (await recordOf(f, s)).sessionLinks(PUBLISHED_HOST)).filter((l) => l.task === s.experiment.id);
    const d = await links(declared);
    const u = await links(undeclared);
    assert.equal(d.length, 2);
    assert.equal(new Set(d.map((l) => l.pseudonym)).size, 1, "declared: two sessions of one browser share the pseudonym");
    assert.notEqual(d[0].session_id, d[1].session_id);
    assert.equal(new Set(u.map((l) => l.pseudonym)).size, 2, "undeclared: a fresh pseudonym per session");
    assert.ok(!u.some((l) => l.pseudonym === d[0].pseudonym), "never the same pseudonym in two experiments");
    const ev = await storedEvents(f, declared);
    const bad = { ...ev[0], name: "홍길동" };
    assert.throws(() => core.validateObservation({ format: "hps-observation/2", scope: "x", session: "y", program: "z", events: [bad] }), /invalid_event|identity_field/);
  } finally {
    f.close();
  }
});

// ── CR-T62 — raw input ───────────────────────────────────────────────────────

/** Typed text that is stored for a field the experiment did not declare: the CR-T62 verdict. */
function undeclaredTypedText(events, declared) {
  return events.filter((e) => e.kind === "input" && e.input_value !== undefined && !declared.includes(/^input: (.*)$/.exec(e.text)?.[1] ?? "")).map((e) => e.id);
}

await test("CR-T62: typed text is kept only for a declared field; an undeclared experiment keeps the fact of the input, not its content", async () => {
  const f = await fixture();
  try {
    const keep = await started(f, { declarations: { raw_input: { fields: ["memo"] } } });
    const drop = await started(f);
    for (const s of [keep, drop]) {
      const page = await participant(f).tab().load(s.url);
      assert.deepEqual(page.cfg.raw_input ?? [], s === keep ? ["memo"] : [], "the page is told which fields it may send");
      await page.type("배달 말고 포장이요");
    }
    const kept = (await storedEvents(f, keep)).filter((e) => e.kind === "input");
    const dropped = (await storedEvents(f, drop)).filter((e) => e.kind === "input");
    assert.equal(kept[0]?.input_value, "배달 말고 포장이요", "positive: the declared field's text is stored");
    assert.equal(dropped.length, 1, "the fact of the input is kept");
    assert.equal(dropped[0].input_value, undefined, "undeclared: no content");
    assert.ok(!JSON.stringify(dropped).includes("포장"));
    // A page that sends a value for an undeclared field anyway: the Service drops it.
    const tok = (await participant(f, { seed: 5 }).tab().load(drop.url)).cfg.session_token;
    const r = await f.raw(new URL(`/l/${drop.link.id}/__hp/events`, drop.url).href, { method: "POST", body: { token: tok, events: [{ kind: "input", seq: 90, target: { role: "input", path: "body>input" }, field: "memo", value: "몰래 보낸 글" }] } });
    assert.equal(r.status, 204);
    assert.deepEqual(undeclaredTypedText(await storedEvents(f, drop), []), [], "positive: nothing undeclared is stored");
    assert.ok(!JSON.stringify(await storedEvents(f, drop)).includes("몰래"));
    // Negative control: an event builder that keeps every value is caught by the same verdict.
    const leaky = participantEvents({ experiment: { id: drop.experiment.id, declarations: { raw_input: { fields: ["memo"] } } }, sessionId: "ps-" + "0".repeat(32), link: { attribution: { project: drop.project.id, experiment: drop.experiment.id, product_version: drop.version } }, linkId: drop.link.id, events: [{ kind: "input", seq: 1, target: { role: "input", path: "x" }, field: "memo", value: "x" }], now: 1 });
    assert.deepEqual(undeclaredTypedText(leaky.events, []), ["e1"], "a planted keep-all builder is caught");
    // The cohort's admin can refuse raw-input declarations altogether (CR-70).
    const ctl = await f.admin(`/admin/curriculum/cohorts/${keep.project.cohort_id}/controls`, { method: "PUT", body: { expected_revision: 0, retention_days_after_end: 30, raw_input_allowed: false, link_expiry_default_days: null, student_deletion: true, team_ceilings: {} } });
    assert.equal(ctl.status, 200, ctl.text);
    const refused = await f.api("/v1/curriculum/experiments", { method: "POST", token: keep.token, body: { project_id: keep.project.id, product_version_id: keep.version, week: 1, question: "q", method: "task_test", success_criteria: ["c"], hypothesis: "다른 가설", declarations: { raw_input: { fields: ["memo"] } } } });
    assert.deepEqual([refused.status, refused.json?.error?.code], [403, "raw_input_not_allowed"]);
  } finally {
    f.close();
  }
});

// ── CR-T24 — manual records ──────────────────────────────────────────────────

const INTERVIEW = { note_kind: "interview_note", text: "\"메뉴가 너무 많아요\" — 키오스크 앞에서 3분 고민함. The order button was hard to find.", provenance: { who: "참가자 3 (60대)", when: "2026-10-01 14:10", where: "학교 앞 카페, 실제 주문 중" }, source_state: "real" };

await test("CR-T24: five manual record kinds with their provenance and source state; KO/EN text verbatim; a record without provenance or source state is refused, not filled", async () => {
  const exp = { id: "exp-0000000000000001", project_id: "prj-0000000000000001", week: 1, product_version_id: "sha256:" + "a".repeat(64) };
  const ok = noteEvent({ experiment: exp, note: INTERVIEW, id: "note-1", now: 1 });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.event.student_text, INTERVIEW.text, "verbatim");
  core.validateObservation({ format: "hps-observation/2", scope: exp.id, session: exp.id, program: "x", events: [ok.event] });
  for (const kind of ["observer_note", "quote", "anomaly"]) assert.equal(noteEvent({ experiment: exp, note: { ...INTERVIEW, note_kind: kind }, id: "n", now: 1 }).ok, true, kind);
  assert.equal(noteEvent({ experiment: exp, note: { ...INTERVIEW, note_kind: "external_source", locator: "https://example.org/report.pdf p.12" }, id: "n", now: 1 }).ok, true);
  // Negatives: each one refused by name, nothing guessed.
  const { provenance: _p, ...noProv } = INTERVIEW;
  const { source_state: _s, ...noState } = INTERVIEW;
  assert.equal(noteEvent({ experiment: exp, note: noProv, id: "n", now: 1 }).code, "missing_provenance");
  assert.equal(noteEvent({ experiment: exp, note: { ...INTERVIEW, provenance: { who: "참가자", when: "오늘" } }, id: "n", now: 1 }).code, "missing_provenance");
  assert.equal(noteEvent({ experiment: exp, note: noState, id: "n", now: 1 }).code, "missing_source_state");
  assert.equal(noteEvent({ experiment: exp, note: { ...INTERVIEW, note_kind: "external_source" }, id: "n", now: 1 }).code, "missing_locator");
  // The validator itself refuses a record with its source_state removed (one validator, SX-48).
  const { source_state: _x, ...stripped } = ok.event;
  assert.throws(() => core.validateObservation({ format: "hps-observation/2", scope: exp.id, session: exp.id, program: "x", events: [stripped] }), /missing_source_state/);
  // Through the route, round trip KO/EN unchanged.
  const f = await fixture();
  try {
    const s = await started(f);
    const r = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/notes`, { method: "POST", token: s.token, body: INTERVIEW });
    assert.equal(r.status, 201, r.text);
    const back = (await evidence(f, s)).json.evidence.notes;
    assert.deepEqual([back.length, back[0].student_text, back[0].note_kind, back[0].source_state], [1, INTERVIEW.text, "interview_note", "real"]);
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/notes`, { method: "POST", token: s.token, body: noState })).json.error.code, "missing_source_state");
  } finally {
    f.close();
  }
});

// ── CR-T25 · CR-T26 · CR-T27 (Service half) · CR-T28 ──────────────────────────

/** One experiment with three participant sessions (two paused) and one note. */
async function withEvidence(f, opts = {}) {
  const s = await started(f, opts);
  const sessions = [];
  for (let i = 0; i < 3; i++) {
    const page = await participant(f, { seed: 100 + i }).tab().load(s.url);
    await page.task("주문하기", "start");
    if (i === 0) await page.task("주문하기", "complete");
    sessions.push(page.cfg.session_id);
  }
  const note = (await f.api(`/v1/curriculum/experiments/${s.experiment.id}/notes`, { method: "POST", token: s.token, body: INTERVIEW })).json.note;
  return { ...s, sessions, note };
}
const draftOf = (items) => ({ items });

await test("CR-T25: a draft whose three observed statements cite real events and notes validates; three planted fabrications (missing, other project's, deleted) are refused, exactly three", async () => {
  const f = await fixture();
  try {
    const s = await withEvidence(f);
    const elsewhere = await withEvidence(f);
    const sib = await sibling(f, s);
    const sibSession = (await participant(f, { seed: 140 }).tab().load(sib.url)).cfg.session_id;
    const ev = (await storedEvents(f, s)).find((e) => e.kind === "task_start" && e.participant.session_id === s.sessions[0]);
    const good = [
      { id: "a", section: "observation", text: "세 명 중 둘이 주문하기에서 멈췄다", source_refs: s.sessions.map((x) => `session:${x}`), review: "draft" },
      { id: "b", section: "observation", text: "첫 참가자가 주문을 시작했다", source_refs: [`event:${ev.participant.session_id}/${ev.id}`], review: "draft" },
      { id: "c", section: "observation", text: "메뉴가 많다는 말을 들었다", source_refs: [`note:${s.note.id}`], review: "draft" },
      { id: "d", section: "interpretation", text: "메뉴가 많아서 멈춘 것 같다", source_refs: [], review: "draft" },
      { id: "e", section: "assumption", text: "어르신은 큰 글씨를 원할 것이다", source_refs: [], review: "draft" },
      { id: "f", section: "next_experiment", text: "메뉴를 6개로 줄인 v1로 다시 테스트", source_refs: [], review: "draft" },
    ];
    const ok = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts`, { method: "POST", token: s.token, body: { author: "ai", items: good } });
    assert.equal(ok.status, 201, ok.text);
    assert.deepEqual(ok.json.draft.items.map((i) => i.section), ["observation", "observation", "observation", "interpretation", "assumption", "next_experiment"], "four separate typed sections");
    // Delete one session, then plant three fabrications beside the good items.
    await f.api(`/v1/curriculum/experiments/${s.experiment.id}/sessions/${s.sessions[2]}`, { method: "DELETE", token: s.token });
    const planted = [
      ...good.slice(1),
      { id: "x1", section: "observation", text: "아무도 주문하지 못했다", source_refs: ["session:ps-" + "f".repeat(32)], review: "draft" },
      { id: "x2", section: "observation", text: "다른 팀 참가자도 멈췄다", source_refs: [`session:${elsewhere.sessions[0]}`], review: "draft" },
      { id: "x3", section: "observation", text: "세 번째 참가자는 포기했다", source_refs: [`session:${s.sessions[2]}`], review: "draft" },
      { id: "x4", section: "observation", text: "다음 실험 참가자도 멈췄다", source_refs: [`session:${sibSession}`], review: "draft" },
    ];
    const bad = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts`, { method: "POST", token: s.token, body: { author: "ai", items: planted } });
    assert.equal(bad.status, 422, bad.text);
    assert.deepEqual(bad.json.error.refusals.map((r) => [r.item, r.code]).sort(), [["x1", "unresolved_source_ref"], ["x2", "unresolved_source_ref"], ["x3", "deleted_source_ref"], ["x4", "foreign_source_ref"]], "exactly the planted statements (a sibling experiment's session is foreign)");
    // An observed statement with no reference at all is refused as well, and an AI cannot mark its own item reviewed.
    const none = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts`, { method: "POST", token: s.token, body: { author: "ai", items: [{ id: "n", section: "observation", text: "다들 좋아했다", source_refs: [], review: "draft" }] } });
    assert.deepEqual(none.json.error.refusals, [{ item: "n", code: "missing_source_refs" }]);
    const self = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts`, { method: "POST", token: s.token, body: { author: "ai", items: [{ ...good[3], review: "accepted", reviewed_by: "user" }] } });
    assert.deepEqual([self.status, self.json.error.code], [400, "invalid_review"]);
    // The author is stated, never defaulted to the student; and revision 1 holds drafts only, whoever wrote it.
    const anon = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts`, { method: "POST", token: s.token, body: { items: [{ ...good[3], review: "accepted", reviewed_by: "user" }] } });
    assert.deepEqual([anon.status, anon.json.error.code], [400, "missing_author"]);
    const userPre = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts`, { method: "POST", token: s.token, body: { author: "user", items: [{ ...good[3], review: "accepted", reviewed_by: "user" }] } });
    assert.deepEqual([userPre.status, userPre.json.error.code], [400, "invalid_review"]);
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts`, { method: "POST", token: s.token, body: { author: "user", items: [good[3]] } })).status, 201, "control: the student's own draft is stored");
    // The runtime's own observed items cite real records and validate.
    const rt = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts`, { method: "POST", token: s.token, body: { from_runtime: true } });
    assert.equal(rt.status, 201, rt.text);
    assert.ok(rt.json.draft.items.every((i) => i.section === "observation" && i.source_refs.length > 0));
  } finally {
    f.close();
  }
});

await test("CR-T26: accept / edit / reject adds a revision; raw records keep their bytes; a planted rewrite of a raw note is caught by the hashes", async () => {
  const f = await fixture();
  try {
    const s = await withEvidence(f);
    const items = [
      { id: "a", section: "observation", text: "둘이 멈췄다", source_refs: s.sessions.slice(1).map((x) => `session:${x}`), review: "draft" },
      { id: "b", section: "interpretation", text: "메뉴가 많아서다", source_refs: [`note:${s.note.id}`], review: "draft" },
      { id: "c", section: "assumption", text: "글씨가 작다", source_refs: [], review: "draft" },
    ];
    const d = (await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts`, { method: "POST", token: s.token, body: { author: "ai", items } })).json.draft;
    const before = await rawHashes(f, s);
    const r = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts/${d.id}/review`, { method: "POST", token: s.token, body: { revision: 1, reason: "읽어 보고 고침", actions: [{ item: "a", action: "accept" }, { item: "b", action: "edit", text: "메뉴 이름이 낯설어서다" }, { item: "c", action: "reject" }] } });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.json.draft.revision, r.json.draft.supersedes, r.json.draft.items.map((i) => i.review)], [2, { id: d.id, revision: 1 }, ["accepted", "edited", "rejected"]]);
    const drafts = (await evidence(f, s)).json.evidence.drafts.filter((x) => x.id === d.id);
    assert.deepEqual(drafts.map((x) => x.revision), [1, 2], "revision 1 is kept as it was");
    assert.equal(drafts[0].items[1].text, "메뉴가 많아서다");
    assert.deepEqual(await rawHashes(f, s), before, "raw events, notes and sessions keep their bytes");
    // An observed statement is accepted or rejected, never rewritten; a stale revision is refused.
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts/${d.id}/review`, { method: "POST", token: s.token, body: { revision: 2, actions: [{ item: "a", action: "edit", text: "셋 다 멈췄다" }] } })).json.error.code, "observation_not_editable");
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts/${d.id}/review`, { method: "POST", token: s.token, body: { revision: 1, actions: [{ item: "c", action: "accept" }] } })).status, 409);
    // Negative control: a code path that rewrites the raw note during an edit is caught by the hash comparison.
    const noteKey = Object.keys(before).find((k) => k.startsWith("observations/notes/"));
    const prefix = `curriculum/${encodeURIComponent(s.project.cohort_id)}/${encodeURIComponent(s.project.id)}/`;
    const raw = JSON.parse(await (await f.r2.get(prefix + noteKey)).text());
    raw.event.student_text = "편집 중에 바뀐 원문";
    await f.r2.put(prefix + noteKey, JSON.stringify(raw));
    const after = await rawHashes(f, s);
    assert.notDeepEqual(after, before);
    assert.deepEqual(Object.keys(after).filter((k) => after[k] !== before[k]), [noteKey], "the rewritten note is named");
  } finally {
    f.close();
  }
});

await test("CR-T27 (Service half): an observed claim opens its sources; a deleted source reads as needs-review; another team's student and an out-of-scope director get 404; an in-scope director reads", async () => {
  const f = await fixture();
  try {
    const s = await withEvidence(f);
    const paused = s.sessions.slice(1);
    const d = (await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts`, { method: "POST", token: s.token, body: { author: "ai", items: [{ id: "p", section: "observation", text: "3명 중 2명이 멈췄다", source_refs: [...paused, s.sessions[0]].map((x) => `session:${x}`), review: "draft" }] } })).json.draft;
    const read = (await evidence(f, s)).json.evidence;
    const claim = read.drafts.find((x) => x.id === d.id).items[0];
    assert.deepEqual(claim.sources.map((x) => x.state), ["ok", "ok", "ok"]);
    assert.deepEqual(claim.sources.map((x) => x.ref.slice(8)).sort(), read.sessions.map((x) => x.session_id).sort(), "the claim resolves to the three sessions of this experiment");
    // A source removed later: the claim's draft goes with it (CR-69), so no claim keeps citing it.
    await f.api(`/v1/curriculum/experiments/${s.experiment.id}/sessions/${paused[0]}`, { method: "DELETE", token: s.token });
    assert.ok(!(await evidence(f, s)).json.evidence.drafts.some((x) => x.id === d.id), "the derived draft citing a deleted session is gone");
    // Another team and an out-of-scope director: 404 like an unknown route; the in-scope director reads.
    const other = await f.student("cr-c");
    const unknown = await f.api("/v1/cr-never-registered", { token: other });
    const r1 = await evidence(f, s, other);
    assert.deepEqual([r1.status, r1.json.error.message], [unknown.status, unknown.json.error.message]);
    const outside = (await issueIssuer({ issuer: "director-b", scopes: [{ cohort: "another-cohort", profiles: [s.project.profile_id] }] }, 2, TEST_SECRET)).token;
    assert.equal((await evidence(f, s, outside)).status, 404);
    const inside = await f.issuer();
    const r2 = await evidence(f, s, inside);
    assert.equal(r2.status, 200, r2.text);
    assert.equal(r2.json.evidence.sessions.length, 2);
  } finally {
    f.close();
  }
});

await test("CR-T28: the review input builder reads evidence items; chat history alone yields 'no evidence recorded' and no claims", async () => {
  const exp = { id: "exp-a", product_version_id: "v0" };
  const chatOnly = core.reviewInput({ experiment: exp, sessions: [], notes: [], drafts: [], chat: [{ role: "user", content: "다들 좋아했어요!" }] });
  assert.deepEqual(chatOnly, { status: "no_evidence_recorded", claims: [] });
  const f = await fixture();
  try {
    const s = await withEvidence(f);
    const input = (await evidence(f, s)).json.evidence.review_input;
    assert.equal(input.status, "evidence");
    assert.ok(input.claims.length >= 2);
    assert.ok(input.claims.every((c) => c.source_refs.length > 0), "every claim cites records");
    assert.ok(input.claims.some((c) => c.source_refs.includes(`note:${s.note.id}`)));
    // A rejected interpretation never reaches the Weekly Review; the accepted one does.
    const d = (await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts`, { method: "POST", token: s.token, body: { author: "ai", items: [{ id: "k", section: "interpretation", text: "메뉴 이름이 낯설다", source_refs: [`note:${s.note.id}`], review: "draft" }, { id: "j", section: "interpretation", text: "가격이 비싸서 멈췄다", source_refs: [`note:${s.note.id}`], review: "draft" }] } })).json.draft;
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts/${d.id}/review`, { method: "POST", token: s.token, body: { revision: 1, actions: [{ item: "k", action: "accept" }, { item: "j", action: "reject" }] } })).status, 201);
    const texts = (await evidence(f, s)).json.evidence.review_input.claims.map((c) => c.text);
    assert.ok(texts.includes("메뉴 이름이 낯설다") && !texts.includes("가격이 비싸서 멈췄다"), JSON.stringify(texts));
    // Negative control: a builder that reads chat would produce a claim here; this one does not.
    const leaky = (i) => ({ status: "evidence", claims: (i.chat ?? []).map((m) => ({ text: m.content, source_refs: [] })) });
    assert.notDeepEqual(leaky({ chat: [{ content: "x" }] }), chatOnly, "control: a chat-reading builder is told apart");
  } finally {
    f.close();
  }
});

await test("CR-T27 (App view against the real Service): the panel's session reads the experiment, a claim opens its three sessions, a deleted one reads 확인 필요", async () => {
  const { EvidenceSession } = await import("../../extensions/hypeproof-chat/src/evidenceSession.ts");
  const { claimSources } = await import("../../extensions/hypeproof-chat/src/evidenceView.ts");
  const { makeCtx } = await import("./harness/index.mjs");
  const f = await fixture();
  try {
    const s = await withEvidence(f);
    const fetchImpl = (url, init) => f.app.fetch(new Request(url, init), f.env, makeCtx());
    const session = new EvidenceSession({ switchOn: () => true, token: async () => s.token, base: () => "https://service.test/v1/curriculum", fetchImpl, projectId: () => s.project.id });
    const made = await session.makeDraft(s.experiment.id);
    assert.equal(made.ok, true, JSON.stringify(made));
    const v = await session.view();
    assert.deepEqual([v.selected, v.sessions.length, v.notes.length], [s.experiment.id, 3, 1]);
    const claim = v.drafts[0].items.find((i) => i.source_refs.length === 3);
    assert.ok(claim, JSON.stringify(v.drafts));
    const rows = claimSources(v, claim);
    assert.deepEqual(rows.map((r) => r.state), ["ok", "ok", "ok"]);
    assert.ok(rows.every((r) => /참가 세션/.test(r.label)));
    // The draft's source is deleted through the panel's own action: it goes, and a planted draft citing it reads 확인 필요.
    assert.equal((await session.delete(s.experiment.id, s.sessions[1])).ok, true);
    const after = await session.view();
    assert.ok(!after.drafts.some((d) => d.id === v.drafts[0].id), "the draft citing the deleted session is gone");
    const planted = claimSources(after, { source_refs: [`session:${s.sessions[1]}`], sources: [{ ref: `session:${s.sessions[1]}`, state: await (await recordOf(f, s)).resolveEvidenceRef(s.experiment.id, `session:${s.sessions[1]}`) }] });
    assert.deepEqual([planted[0].label, planted[0].state], ["확인 필요", "deleted"]);
    // Switch off: the session reaches nothing; the routes answer as unknown.
    f.setSwitch(false);
    const off = await new EvidenceSession({ switchOn: () => false, token: async () => s.token, base: () => "https://service.test/v1/curriculum", fetchImpl, projectId: () => s.project.id }).view();
    assert.equal(off.available, false);
  } finally {
    f.close();
  }
});

// ── CR-T64 — deletion ────────────────────────────────────────────────────────

await test("CR-T64: deleting a session or an experiment's test data removes events, notes and derived drafts with a receipt; another team gets 404 and nothing is removed", async () => {
  const f = await fixture();
  try {
    const s = await withEvidence(f);
    const intruder = await f.student("cr-b");
    const before = await rawHashes(f, s);
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}`, { method: "DELETE", token: intruder })).status, 404);
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/sessions/${s.sessions[0]}`, { method: "DELETE", token: intruder })).status, 404);
    assert.deepEqual(await rawHashes(f, s), before, "nothing removed by another team");
    const draft = (await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts`, { method: "POST", token: s.token, body: { from_runtime: true } })).json.draft;
    assert.ok(draft.items.some((i) => i.source_refs.includes(`session:${s.sessions[0]}`)));
    const one = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/sessions/${s.sessions[0]}`, { method: "DELETE", token: s.token });
    assert.equal(one.status, 200, one.text);
    assert.equal(one.json.receipt.kind, "participant_session_deleted");
    assert.ok(one.json.receipt.removed.observations >= 2 && one.json.receipt.removed.drafts >= 1, JSON.stringify(one.json.receipt));
    const ev = (await evidence(f, s)).json.evidence;
    assert.ok(!ev.sessions.some((x) => x.session_id === s.sessions[0]));
    assert.ok(!ev.drafts.some((d) => d.items.some((i) => i.source_refs.some((r) => r.includes(s.sessions[0])))), "no derived draft still cites the deleted session");
    // The link's counter follows the record.
    const state = (await f.api(`/v1/curriculum/projects/${s.project.id}`, { token: s.token })).json;
    assert.equal(state.sessions_opened[s.experiment.id].unlabelled, 2);
    // A retried delivery of a deleted event is refused (tombstone).
    const rec = await recordOf(f, s);
    assert.equal(await rec.resolveEvidenceRef(s.experiment.id, `session:${s.sessions[0]}`), "deleted");
    // The whole experiment.
    const all = await f.api(`/v1/curriculum/experiments/${s.experiment.id}`, { method: "DELETE", token: s.token });
    assert.equal(all.status, 200, all.text);
    assert.equal(all.json.receipt.kind, "experiment_test_data_deleted");
    assert.ok(all.json.receipt.removed.observations >= 1 && all.json.receipt.removed.sessions >= 2, JSON.stringify(all.json.receipt));
    assert.deepEqual(Object.keys(await rawHashes(f, s)), [], "no event, note or session left");
    assert.deepEqual(await recordKeys(f, s, "pseudonyms/"), [], "no pseudonym index key left");
    const after = (await evidence(f, s)).json.evidence;
    assert.deepEqual([after.sessions.length, after.notes.length, after.drafts.length], [0, 0, 0]);
    assert.equal((await openEntry(f, s.url)).status, 410, "its links are revoked: nothing can bring data back");
    assert.equal(all.json.experiment.status, "closed");
    // Negative control for the instrument: a planted draft citing a deleted record is refused as deleted.
    assert.equal(await rec.resolveEvidenceRef(s.experiment.id, `note:${s.note.id}`), "deleted");
  } finally {
    f.close();
  }
});

// ── CR-T65 — admin controls ──────────────────────────────────────────────────

await test("CR-T65: an admin sets a team ceiling and a cohort retention policy; a student, a director or no admin credential is refused; a stale revision conflicts", async () => {
  const f = await fixture();
  try {
    const s = await started(f);
    const path = `/admin/curriculum/cohorts/${s.project.cohort_id}/controls`;
    const body = { expected_revision: 0, retention_days_after_end: 14, raw_input_allowed: true, link_expiry_default_days: 7, student_deletion: true, team_ceilings: { [s.project.id]: { "requests:count": 500 } } };
    for (const token of [s.token, await f.issuer()]) {
      const r = await f.raw("https://service.test" + path, { method: "PUT", token, body });
      assert.equal(r.status, 401, `a Bearer token is not an admin: ${r.text}`);
    }
    assert.equal((await f.raw("https://service.test" + path, { method: "PUT", body })).status, 401);
    assert.equal((await f.raw("https://service.test" + path, { method: "PUT", body, headers: { authorization: "Basic " + Buffer.from("admin:wrong").toString("base64") } })).status, 401);
    assert.equal((await f.admin(path)).json.controls.revision, 0, "nothing changed by a refused call");
    const ok = await f.admin(path, { method: "PUT", body });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual([ok.json.controls.retention_days_after_end, ok.json.controls.team_ceilings[s.project.id]["requests:count"], ok.json.controls.revision], [14, 500, 1]);
    assert.equal((await f.admin(path, { method: "PUT", body })).status, 409, "a second write at revision 0 conflicts");
    assert.equal((await f.admin(path, { method: "PUT", body: { ...body, expected_revision: 1, team_ceilings: { [s.project.id]: { "not-a-meter": 1 } } } })).status, 400);
    // The link expiry default now applies when the student names none (CR-19 until set: required).
    const l = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/links`, { method: "POST", token: s.token, body: {} });
    assert.equal(l.status, 201, l.text);
    assert.ok(Math.abs(l.json.link.expires_at - (Date.now() + 7 * 86_400_000)) < 60_000);
    // Deletion reserved for directors: a student's delete is refused, and the action does not
    // disappear: an in-scope director deletes a session and the experiment's data, with receipts.
    await f.admin(path, { method: "PUT", body: { ...body, expected_revision: 1, student_deletion: false } });
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}`, { method: "DELETE", token: s.token })).json.error.code, "deletion_reserved");
    const sid = (await participant(f, { seed: 31 }).tab().load(s.url)).cfg.session_id;
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/sessions/${sid}`, { method: "DELETE", token: s.token })).json.error.code, "deletion_reserved");
    const outside = (await issueIssuer({ issuer: "director-b", scopes: [{ cohort: "another-cohort", profiles: [s.project.profile_id] }] }, 2, TEST_SECRET)).token;
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}`, { method: "DELETE", token: outside })).status, 404, "an out-of-scope director");
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/sessions/${sid}`, { method: "DELETE", token: outside })).status, 404);
    const director = await f.issuer();
    const one = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/sessions/${sid}`, { method: "DELETE", token: director });
    assert.deepEqual([one.status, one.json?.receipt?.kind, one.json?.receipt?.deleted_by], [200, "participant_session_deleted", "director"], one.text);
    const all = await f.api(`/v1/curriculum/experiments/${s.experiment.id}`, { method: "DELETE", token: director });
    assert.deepEqual([all.status, all.json?.receipt?.kind, all.json?.receipt?.deleted_by, all.json?.experiment?.status], [200, "experiment_test_data_deleted", "director", "closed"], all.text);
  } finally {
    f.close();
  }
});

// ── CR-T67 — returning sessions ──────────────────────────────────────────────

const DAY = 86_400_000;
async function sessionsAt(f, s, ats, pseudonym, { link = s.link } = {}) {
  const record = await recordOf(f, s);
  const ids = [];
  for (const at of ats) {
    const sid = "ps-" + createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 32);
    const r = await openParticipantSession(record, { link: { ...link, project_id: s.project.id }, experiment: s.experiment, sessionId: sid, at, pseudonym });
    assert.equal(r.ok, true);
    ids.push(sid);
  }
  return ids;
}

await test("CR-T67: one pseudonym's three sessions over two days give return count 2 and both intervals, citing the three sessions; undeclared is 'not measured'; experiments never merge; twenty concurrent sessions are all kept", async () => {
  const f = await fixture();
  try {
    const s = await started(f, { declarations: { repeated_use: true } });
    const pp = "pp-" + "1".repeat(32);
    const t0 = Date.UTC(2026, 9, 1, 9);
    const ids = await sessionsAt(f, s, [t0, t0 + DAY, t0 + 2 * DAY], pp);
    const r = (await evidence(f, s)).json.evidence.returns;
    assert.equal(r.status, "measured");
    assert.equal(r.basis, "per_device_pseudonym", "labelled as devices, never people");
    const dev = r.devices.find((d) => d.pseudonym === pp);
    assert.deepEqual([dev.return_count, dev.intervals_ms, dev.source_refs], [2, [DAY, DAY], ids.map((x) => `session:${x}`)]);
    const runtime = (await evidence(f, s)).json.evidence.runtime_draft;
    assert.ok(runtime.items.some((i) => i.basis === "per_device_pseudonym" && i.source_refs.length === 3), "the observed item cites the three sessions");
    // Undeclared: not measured, never 0.
    const u = await started(f);
    const uIds = await sessionsAt(f, u, [t0, t0 + DAY], pp);
    assert.deepEqual((await evidence(f, u)).json.evidence.returns, { status: "not_measured", reason: "not_declared" });
    // ...and a draft cannot store "zero returns" for it either (SX-33): any return basis or count is refused.
    const zeroItem = { id: "z", section: "observation", text: "같은 기기에서 다시 온 횟수 0번", source_refs: [`session:${uIds[0]}`], review: "draft" };
    const zero = await f.api(`/v1/curriculum/experiments/${u.experiment.id}/drafts`, { method: "POST", token: u.token, body: { author: "ai", items: [{ ...zeroItem, basis: "per_device_pseudonym", return_count: 0 }] } });
    assert.deepEqual([zero.status, zero.json?.error?.refusals?.map((x) => x.code)], [422, ["return_not_measured"]], zero.text);
    assert.equal((await f.api(`/v1/curriculum/experiments/${u.experiment.id}/drafts`, { method: "POST", token: u.token, body: { author: "ai", items: [{ ...zeroItem, text: "첫 세션이 열렸다" }] } })).status, 201, "control: the same session cited without a return claim is stored");
    // Two experiments with the same pseudonym (planted) are never merged: the Service refuses
    // the second experiment's open of a pseudonym already recorded under the first.
    const s2 = await sibling(f, s, { repeated_use: true });
    const reused = await openParticipantSession(await recordOf(f, s2), { link: { ...s2.link, project_id: s2.project.id }, experiment: s2.experiment, sessionId: "ps-" + "9".repeat(32), at: t0 + 3 * DAY, pseudonym: pp });
    assert.deepEqual(reused, { ok: false, code: "pseudonym_in_other_experiment" });
    assert.equal((await evidence(f, s2)).json.evidence.sessions.length, 0, "nothing stored for the reused pseudonym");
    assert.equal((await evidence(f, s)).json.evidence.returns.devices.find((d) => d.pseudonym === pp).return_count, 2, "the other experiment's session is not a return here");
    // A return count is checked where drafts are stored, through the route (CR-72).
    const ext = (await f.api(`/v1/curriculum/experiments/${s.experiment.id}/notes`, { method: "POST", token: s.token, body: INTERVIEW })).json.note;
    const draft = (items) => f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts`, { method: "POST", token: s.token, body: { author: "ai", items } });
    const ret = (extra) => ({ id: "r", section: "observation", basis: "per_device_pseudonym", text: "같은 기기에서 다시 온 횟수 4번", review: "draft", ...extra });
    const refusalOf = async (items) => {
      const r = await draft(items);
      return [r.status, r.json?.error?.refusals?.map((x) => x.code)];
    };
    assert.deepEqual(await refusalOf([ret({ source_refs: [`note:${ext.id}`], return_count: 4 })]), [422, ["return_without_sessions"]], "a return count citing no session");
    assert.deepEqual(await refusalOf([ret({ source_refs: [`session:${ids[0]}`], return_count: 4 })]), [422, ["return_count_mismatch"]], "a count that its one session cannot show");
    assert.deepEqual(await refusalOf([ret({ source_refs: ids.map((x) => `session:${x}`) })]), [422, ["return_count_mismatch"]], "a count left unstated");
    const otherDevice = (await sessionsAt(f, s, [t0 + 4 * DAY], "pp-" + "2".repeat(32)))[0];
    assert.deepEqual(await refusalOf([ret({ source_refs: [`session:${ids[0]}`, `session:${otherDevice}`], return_count: 1 })]), [422, ["return_sessions_not_one_device"]], "two devices counted as one");
    const good = await draft([ret({ text: "같은 기기에서 다시 온 횟수 2번", source_refs: ids.map((x) => `session:${x}`), return_count: 2 })]);
    assert.equal(good.status, 201, good.text);
    // The pure check, with a planted always-same-device lookup as the instrument's control.
    assert.equal(core.returnItemProblem({ return_count: 1, source_refs: ["session:a", "session:b"] }, () => "pp-x"), null);
    assert.equal(core.returnItemProblem({ return_count: 1, source_refs: ["session:a", "session:b"] }, (r) => (r === "session:a" ? "pp-x" : "pp-y")), "return_sessions_not_one_device");
    // Twenty sessions linked at the same time through the route all appear (R6: per-session keys).
    const c = await started(f, { declarations: { repeated_use: true } });
    const pages = await Promise.all(Array.from({ length: 20 }, async () => hpTest((await openEntry(f, c.url)).text)));
    const opened = await Promise.all(pages.map((p) => f.raw(new URL(`/l/${c.link.id}/__hp/session`, c.url).href, { method: "POST", body: { token: p.session_token, pseudonym: pp } })));
    assert.deepEqual(opened.map((o) => o.status), Array(20).fill(204));
    const all = (await evidence(f, c)).json.evidence;
    assert.equal(all.sessions.length, 20);
    assert.equal(all.returns.devices.find((d) => d.pseudonym === pp).return_count, 19);
    // Negative control: the pre-change path (`linkSession`, a read-modify-write of the task) loses sessions under the same load.
    const rec = new LocalRecord((await import("../src/lib/curriculum/participant-record.ts")).r2RecordPort(memoryR2(), "x/"));
    await rec.createTask({ id: "exp-race", project: "prj-race", at: 1 });
    await Promise.all(Array.from({ length: 20 }, (_, i) => rec.linkSession("exp-race", { host: PUBLISHED_HOST, session_id: `ps-${i}`, by: "adapter_explicit", at: i })));
    const kept = (await rec.getTask("exp-race")).sessions.length;
    assert.ok(kept < 20, `the old task.sessions read keeps ${kept} of 20, so it would fail this check`);
    assert.equal((await rec.sessionLinks(PUBLISHED_HOST)).length, 20, "the per-session keys keep all twenty");
  } finally {
    f.close();
  }
});

// ── CR-T69 — comparison experiments ──────────────────────────────────────────

await test("CR-T69: v1 against an outside alternative reports per variant under the same criteria; an event or note without a variant is refused; a one-sided claim is flagged; publishing v2 changes no pinned version", async () => {
  const f = await fixture();
  try {
    const t = await f.student();
    const p = (await f.api("/v1/curriculum/projects", { method: "POST", token: t, body: { title: "비교" } })).json.project;
    const v1 = (await f.upload(p.id, V1, t)).id;
    const declarations = { variants: [{ id: "ours", product_version_id: v1 }, { id: "paper", alternative: "가게의 종이 메뉴판" }], labels: ["주문"] };
    const e = await f.api("/v1/curriculum/experiments", { method: "POST", token: t, body: { project_id: p.id, product_version_id: v1, week: 4, question: "어느 쪽이 더 빨리 주문하나?", method: "task_test", success_criteria: ["주문 완료"], hypothesis: "우리 키오스크가 종이 메뉴보다 빠르다", declarations } });
    assert.equal(e.status, 201, e.text);
    const s = { token: t, project: p, version: v1, experiment: e.json.experiment };
    // A link must name a variant; an outside alternative is never served.
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/links`, { method: "POST", token: t, body: { expires_at: Date.now() + 3600_000 } })).json.error.code, "variant_required");
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/links`, { method: "POST", token: t, body: { expires_at: Date.now() + 3600_000, variant_id: "paper" } })).json.error.code, "variant_is_alternative");
    const l = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/links`, { method: "POST", token: t, body: { expires_at: Date.now() + 3600_000, variant_id: "ours" } });
    s.link = l.json.link;
    s.url = l.json.share_url;
    const page = await participant(f).tab().load(s.url);
    await page.task("주문", "start");
    await page.task("주문", "complete");
    const notePaper = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/notes`, { method: "POST", token: t, body: { ...INTERVIEW, note_kind: "observer_note", text: "종이 메뉴로는 2분 만에 주문함", variant: "paper" } });
    assert.equal(notePaper.status, 201, notePaper.text);
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/notes`, { method: "POST", token: t, body: { ...INTERVIEW, note_kind: "observer_note" } })).json.error.code, "variant_required", "a note without a variant");
    const ev = (await evidence(f, s)).json.evidence;
    const by = Object.fromEntries(ev.variants.map((v) => [v.variant, v]));
    assert.deepEqual([by.ours.kind, by.ours.sessions, by.ours.tasks["주문"], by.paper.kind, by.paper.notes], ["version", 1, { started: 1, completed: 1 }, "alternative", 1]);
    assert.ok(by.ours.source_refs.every((r) => r.startsWith("session:")) && by.paper.source_refs.every((r) => r.startsWith("note:")), "each variant cites its own records");
    assert.ok((await storedEvents(f, s)).every((x) => x.attribution.variant === "ours"), "every event carries exactly its variant");
    // An event without a variant (a session attributed to none) is refused.
    const noVariant = participantEvents({ experiment: s.experiment, sessionId: "ps-" + "2".repeat(32), link: { attribution: { project: p.id, experiment: s.experiment.id, product_version: v1 } }, linkId: s.link.id, events: [{ kind: "milestone", seq: 1, label: "x" }], now: 1 });
    assert.deepEqual(noVariant, { ok: false, code: "variant_required" });
    // A comparison claim citing one variant only is flagged unsupported; one citing both is supported.
    const one = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts`, { method: "POST", token: t, body: { author: "ai", items: [{ id: "c1", section: "observation", text: "우리 것이 더 빠르다", source_refs: by.ours.source_refs, review: "draft", compares: ["ours", "paper"] }, { id: "c2", section: "observation", text: "둘 다 기록이 있다", source_refs: [...by.ours.source_refs, ...by.paper.source_refs], review: "draft", compares: ["ours", "paper"] }] } });
    assert.equal(one.status, 201, one.text);
    const items = (await evidence(f, s)).json.evidence.drafts.find((d) => d.id === one.json.draft.id).items;
    assert.deepEqual(items.map((i) => i.comparison), ["unsupported", "supported"]);
    // Publishing v2 leaves both variants' pinned versions.
    const v2 = (await f.upload(p.id, V2, t)).id;
    assert.notEqual(v2, v1);
    const after = (await f.api(`/v1/curriculum/projects/${p.id}`, { token: t })).json.experiments.find((x) => x.id === s.experiment.id);
    assert.deepEqual(after.declarations.variants, declarations.variants);
    assert.match((await openEntry(f, s.url)).text, /버전 1/, "the link still serves v1");
  } finally {
    f.close();
  }
});

// ── Decision 6 — automatic deletion; rate limits; R2 ────────────────────────

await test("decision 6: test data is deleted 30 days after the experiment's last link ended (a cohort may change the period); nothing before; the sweep is gated on the tables, not on a test origin", async () => {
  const f = await fixture();
  try {
    const s = await withEvidence(f);
    await f.api(`/v1/curriculum/links/${s.link.id}/revoke`, { method: "POST", token: s.token });
    const ended = Date.now();
    assert.deepEqual((await runCurriculumRetention(f.env, ended + 29 * DAY)).deleted, [], "29 days: kept");
    assert.ok(Object.keys(await rawHashes(f, s)).length > 0);
    const r = await runCurriculumRetention(f.env, ended + 31 * DAY);
    assert.deepEqual(r.deleted, [s.experiment.id]);
    assert.deepEqual(Object.keys(await rawHashes(f, s)), []);
    assert.deepEqual((await runCurriculumRetention(f.env, ended + 32 * DAY)).deleted, [], "deleted once");
    // A cohort override.
    const t = await withEvidence(f);
    await f.admin(`/admin/curriculum/cohorts/${t.project.cohort_id}/controls`, { method: "PUT", body: { expected_revision: 0, retention_days_after_end: 7, raw_input_allowed: true, link_expiry_default_days: null, student_deletion: true, team_ceilings: {} } });
    await f.api(`/v1/curriculum/links/${t.link.id}/revoke`, { method: "POST", token: t.token });
    assert.deepEqual((await runCurriculumRetention(f.env, Date.now() + 8 * DAY)).deleted, [t.experiment.id]);
    // A live link keeps the experiment running: nothing is due.
    const live = await withEvidence(f);
    assert.ok(!(await runCurriculumRetention(f.env, Date.now() + 40 * 60_000)).deleted.includes(live.experiment.id));
    // The sweep is gated on the tables, not on a test origin: a Service with no test origin can
    // still hold manual records, and it sweeps them (P7). A D1 without the migrations is asked
    // one schema read and nothing else.
    assert.equal((await runCurriculumRetention({ ...f.env, HPS_TEST_ORIGIN: undefined }, Date.now() + 400 * DAY)).ran, true);
    const asked = [];
    const bare = { prepare: (sql) => (asked.push(sql), { bind: () => bare.prepare(sql), first: async () => ({ n: 0 }), all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }) };
    assert.deepEqual(await runCurriculumRetention({ ...f.env, HPS_DB: bare }, Date.now() + 400 * DAY), { ran: false, deleted: [] });
    assert.ok(asked.length >= 1 && asked.every((q) => /sqlite_master/.test(q)), `only the schema read: ${asked.join(" | ")}`);
  } finally {
    f.close();
  }
});

await test("rate limits: session opens and event batches past the link's window answer 429 and write nothing; an event past the per-session limit is refused", async () => {
  const f = await fixture();
  try {
    const s = await started(f);
    const page = await participant(f).tab().load(s.url);
    const before = (await storedEvents(f, s)).length;
    const big = await f.raw(new URL(`/l/${s.link.id}/__hp/events`, s.url).href, { method: "POST", body: { token: page.cfg.session_token, events: [{ kind: "milestone", seq: EVIDENCE_LIMITS.maxEventsPerSession + 1, label: "x" }] } });
    assert.deepEqual([big.status, big.headers.get("x-hp-refusal")], [413, "session_event_limit"]);
    // Fill the event window with the D1 counter (the same statement the route runs), then one more is refused.
    const { admitLinkRate } = await import("../src/lib/curriculum/store.ts");
    const now = Date.now();
    while (await admitLinkRate(f.env.HPS_DB, s.link.id, "event", now, EVIDENCE_LIMITS.windowMs, EVIDENCE_LIMITS.eventBatchesPerWindow));
    const limited = await f.raw(new URL(`/l/${s.link.id}/__hp/events`, s.url).href, { method: "POST", body: { token: page.cfg.session_token, events: [{ kind: "milestone", seq: 200, label: "x" }] } });
    assert.deepEqual([limited.status, limited.headers.get("x-hp-refusal")], [429, "rate_limited"]);
    assert.equal((await storedEvents(f, s)).length, before);
    while (await admitLinkRate(f.env.HPS_DB, s.link.id, "open", now, EVIDENCE_LIMITS.windowMs, EVIDENCE_LIMITS.opensPerWindow));
    const fresh = hpTest((await openEntry(f, s.url)).text);
    assert.equal((await f.raw(new URL(`/l/${s.link.id}/__hp/session`, s.url).href, { method: "POST", body: { token: fresh.session_token } })).status, 429);
    // The window rolls over.
    assert.equal(await admitLinkRate(f.env.HPS_DB, s.link.id, "open", now + EVIDENCE_LIMITS.windowMs, EVIDENCE_LIMITS.windowMs, EVIDENCE_LIMITS.opensPerWindow), true);
  } finally {
    f.close();
  }
});

await test("store inventory (SX-48): no evidence, event, note, draft or session table, no new KV namespace or R2 bucket; a planted one is caught", () => {
  const sql = [readFileSync(new URL("../schema.sql", import.meta.url), "utf8"), ...readdirSync(new URL("../migrations/", import.meta.url)).map((m) => readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"))].join("\n");
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const problems = (sqlText, tomlText) => [
    ...[...sqlText.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)/gi)].map((m) => m[1]).filter((n) => /^cr_/.test(n) && /evidence|event|observ|note|draft|session|participant|interpret/i.test(n)),
    ...[...tomlText.matchAll(/^\s*binding\s*=\s*"([^"]+)"/gm)].map((m) => m[1]).filter((b) => !["HPS_KV", "HPS_DB", "HPS_TRACES", "HPS_BACKUPS", "AI", "HPS_RATE"].includes(b) && /KV|TRACE|EVID|R2|BUCKET/i.test(b)),
  ];
  assert.deepEqual(problems(sql, toml), []);
  assert.deepEqual(problems(sql + "\nCREATE TABLE IF NOT EXISTS cr_participant_events (id TEXT);", toml), ["cr_participant_events"], "a planted evidence table is caught");
  assert.deepEqual(problems(sql, toml + '\n[[kv_namespaces]]\nbinding = "HPS_EVIDENCE_KV"\nid = "x"\n'), ["HPS_EVIDENCE_KV"], "a planted KV namespace is caught");
});

await test("R2 conditional put: twenty concurrent `ifAbsent` writes of one key keep exactly one (the port's atomicity, recorded per mode)", async () => {
  const f = await fixture();
  try {
    const { r2RecordPort } = await import("../src/lib/curriculum/participant-record.ts");
    const port = r2RecordPort(f.r2, "atomic-check/");
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => port.write("k", `v${i}`, { ifAbsent: true })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, `${D1_MODE ? "local workerd R2" : "in-memory R2"}: exactly one conditional put wins`);
    assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.message === "exists"));
    // Without the precondition, the bucket itself does not refuse: the guard is the conditional put, not the read before it.
    const direct = await Promise.all(Array.from({ length: 5 }, (_, i) => f.r2.put("atomic-check/u", `w${i}`)));
    assert.ok(direct.every((r) => r !== null));
    const raced = await Promise.all(Array.from({ length: 20 }, (_, i) => f.r2.put("atomic-check/c", `x${i}`, { onlyIf: { etagDoesNotMatch: "*" } })));
    assert.equal(raced.filter((r) => r !== null).length, 1, "the bucket's own conditional put lets one through");
  } finally {
    f.close();
  }
});


// ── Review round 1 (cr-evidence): the controls each finding asked for ─────────

await test("CR-T60 server side: an undeclared experiment stores a fresh Service pseudonym per session whatever the page sends; a declared experiment's pseudonym is refused in another experiment of the project", async () => {
  const f = await fixture();
  try {
    const u = await started(f);
    const pp = "pp-" + "a".repeat(32);
    const open = async (s, pseudonym) => {
      const cfg = hpTest((await openEntry(f, s.url)).text);
      const r = await f.raw(new URL(`/l/${s.link.id}/__hp/session`, s.url).href, { method: "POST", body: { token: cfg.session_token, pseudonym } });
      return r.status;
    };
    assert.deepEqual([await open(u, pp), await open(u, pp)], [204, 204]);
    const stored = (await (await recordOf(f, u)).sessionLinks(PUBLISHED_HOST)).filter((l) => l.task === u.experiment.id).map((l) => l.pseudonym);
    assert.equal(stored.length, 2);
    assert.ok(stored.every((p) => /^pp-[0-9a-f]{32}$/.test(p) && p !== pp), "the page's value is never stored for an undeclared experiment");
    assert.equal(new Set(stored).size, 2, "two sessions, two pseudonyms: nothing links them");
    // Declared: the page's pseudonym is kept (positive), and refused in a sibling experiment.
    const d1 = await sibling(f, u, { repeated_use: true });
    const d2 = await sibling(f, u, { repeated_use: true });
    assert.deepEqual([await open(d1, pp), await open(d1, pp)], [204, 204]);
    assert.deepEqual((await evidence(f, d1)).json.evidence.sessions.map((x) => x.pseudonym), [pp, pp]);
    assert.equal(await open(d2, pp), 404, "one pseudonym in two experiments is refused");
    assert.equal((await evidence(f, d2)).json.evidence.sessions.length, 0);
    // Instrument control: a record written without the Service's rule (the page's value kept) is told apart.
    const planted = [pp, pp];
    assert.notEqual(new Set(planted).size, planted.length);
  } finally {
    f.close();
  }
});

await test("CR-T62 labels: a task or milestone label is stored only when the experiment declared it; an undeclared one keeps the event without its name (counted in the evidence read); a page passing typed text as a label stores none of it", async () => {
  const f = await fixture();
  try {
    const undeclared = await started(f, { labels: null });
    const declared = await started(f, { labels: ["주문하기"] });
    const typed = ["이름 입력: 김민수 010-1234-5678", "주문 메모: 땅콩 알레르기 있어요"];
    for (const s of [undeclared, declared]) {
      const page = await participant(f).tab().load(s.url);
      await page.milestone(typed[0]);
      await page.task(typed[1], "start");
      await page.task("주문하기", "start");
    }
    const leaks = (v) => JSON.stringify(v).match(/김민수|010-1234|땅콩/g) ?? [];
    for (const s of [undeclared, declared]) {
      assert.deepEqual(leaks(await storedEvents(f, s)), [], "no typed text in the stored events");
      assert.deepEqual(leaks((await evidence(f, s)).json), [], "none in the evidence read");
    }
    const stored = await storedEvents(f, undeclared);
    const labelled = stored.filter((e) => ["milestone", "task_start", "task_complete"].includes(e.kind));
    // CR-67: the fact of the task start and the milestone survives, its name does not.
    assert.deepEqual(labelled.map((e) => e.kind).sort(), ["milestone", "task_start", "task_start"], "undeclared: every task and milestone event is kept");
    assert.ok(labelled.every((e) => e.label === undefined && !/:/.test(e.text)), "undeclared: kept without a name");
    assert.ok(stored.some((e) => e.kind === "session_start") && stored.some((e) => e.kind === "page_view"), "the rest of the visit is kept");
    assert.deepEqual((await evidence(f, undeclared)).json.evidence.sessions.map((x) => x.unnamed), [3], "the evidence read counts the unnamed events");
    assert.deepEqual((await evidence(f, declared)).json.evidence.sessions.map((x) => x.unnamed), [2], "declared experiment: the two typed labels are unnamed, the declared one is not");
    const direct = participantEvents({ experiment: { id: undeclared.experiment.id, declarations: {} }, sessionId: "ps-" + "1".repeat(32), link: { attribution: { project: undeclared.project.id, experiment: undeclared.experiment.id, product_version: undeclared.version } }, linkId: undeclared.link.id, events: [{ kind: "task_start", seq: 1, label: typed[1] }, { kind: "task_complete", seq: 2, label: typed[1] }], now: 1 });
    assert.deepEqual([direct.events.map((e) => [e.kind, e.label, e.text]), direct.labels_dropped], [[["task_start", undefined, "task_start"], ["task_complete", undefined, "task_complete"]], 2], "a start and a finish with an undeclared name are both kept, nameless");
    assert.deepEqual((await storedEvents(f, declared)).filter((e) => e.kind === "task_start" && e.label).map((e) => e.label), ["주문하기"], "positive: the declared label is stored");
    // Negative control: the pre-fix rule (any label of 80 characters) is caught by the same verdict.
    const keepAll = participantEvents({ experiment: { id: declared.experiment.id, declarations: { labels: [typed[0]] } }, sessionId: "ps-" + "0".repeat(32), link: { attribution: { project: declared.project.id, experiment: declared.experiment.id, product_version: declared.version } }, linkId: declared.link.id, events: [{ kind: "milestone", seq: 1, label: typed[0] }], now: 1 });
    assert.notDeepEqual(leaks(keepAll.events), []);
    // The declaration itself is checked.
    const bad = await f.api("/v1/curriculum/experiments", { method: "POST", token: declared.token, body: { project_id: declared.project.id, product_version_id: declared.version, week: 1, question: "q", method: "task_test", success_criteria: ["c"], hypothesis: "중복 이름", declarations: { labels: ["주문", "주문"] } } });
    assert.equal(bad.status, 400, bad.text);
  } finally {
    f.close();
  }
});

await test("redelivery: the same batch twice is a duplicate (204), not a conflict; a lost response does not block the session's later events; a permanent refusal drops only its batch", async () => {
  const f = await fixture();
  try {
    const s = await started(f);
    const page = await participant(f, { seed: 41 }).tab().load(s.url);
    const send = (events) => f.raw(new URL(`/l/${s.link.id}/__hp/events`, s.url).href, { method: "POST", body: { token: page.cfg.session_token, events } });
    const batch = [{ kind: "milestone", seq: 100, label: "x" }];
    const first = await send(batch);
    await new Promise((r) => setTimeout(r, 5));
    const again = await send(batch);
    assert.deepEqual([first.status, again.status], [204, 204], again.headers.get("x-hp-refusal") ?? "");
    assert.equal((await storedEvents(f, s)).filter((e) => e.id === "e100").length, 1);
    const changed = await send([{ kind: "milestone", seq: 100, label: "주문" }]);
    assert.deepEqual([changed.status, changed.headers.get("x-hp-refusal")], [409, "conflicting_event"], "different content under one id is still a conflict");
    // Control: the strict comparison (pre-fix) calls the same redelivery a conflict.
    const rec = await recordOf(f, s);
    const stored = (await storedEvents(f, s)).find((e) => e.id === "e100");
    const later = { ...stored, at: stored.at + 5, provenance: { ...stored.provenance, when: new Date(stored.at + 5).toISOString() } };
    assert.equal(sameClientEvent(stored, later), true);
    await assert.rejects(rec.appendObservations(PUBLISHED_HOST, { format: "hps-observation/2", scope: s.experiment.id, session: page.cfg.session_id, program: "hps-participant/1", events: [later] }, { quota: "none", gaps: false }), /conflicting_event/);

    // The snippet: the first events response is lost after the Service stored it.
    let lost = 0;
    const tab = participant(f, { seed: 42, lose: (u) => /__hp\/events/.test(u) && lost++ === 0 }).tab();
    const p2 = await tab.load(s.url);
    await p2.click();
    await p2.task("주문하기", "start");
    const mine = (await storedEvents(f, s)).filter((e) => e.participant.session_id === p2.cfg.session_id).map((e) => e.kind);
    assert.deepEqual(mine.sort(), ["click", "page_view", "session_start", "task_start"], "nothing after the lost response is held back");
    // A permanent refusal (a conflicting event planted at the page's next number) drops that batch only.
    const p3 = await participant(f, { seed: 43 }).tab().load(s.url);
    const tab3 = (await f.raw(new URL(`/l/${s.link.id}/__hp/events`, s.url).href, { method: "POST", body: { token: p3.cfg.session_token, events: [{ kind: "milestone", seq: 3, label: "주문" }] } })).status;
    assert.equal(tab3, 204);
    await p3.click();
    await p3.task("주문하기", "start");
    const third = (await storedEvents(f, s)).filter((e) => e.participant.session_id === p3.cfg.session_id);
    assert.deepEqual(third.map((e) => e.id).sort(), ["e1", "e2", "e3", "e4"]);
    assert.equal(third.find((e) => e.id === "e3").kind, "milestone", "the planted event is not overwritten");
    assert.equal(third.find((e) => e.id === "e4").kind, "task_start", "the event after the refused batch is stored");
  } finally {
    f.close();
  }
});

await test("per-session rate window: one session past its own window gets 429 while another session of the same link keeps recording", async () => {
  const f = await fixture();
  try {
    const s = await started(f);
    const a = await participant(f, { seed: 51 }).tab().load(s.url);
    const b = await participant(f, { seed: 52 }).tab().load(s.url);
    const send = (page, seq) => f.raw(new URL(`/l/${s.link.id}/__hp/events`, s.url).href, { method: "POST", body: { token: page.cfg.session_token, events: [{ kind: "milestone", seq, label: "x" }] } });
    const statuses = [];
    // The load already sent one batch; the rest of the window is spent by re-sending one event.
    for (let i = 0; i < EVIDENCE_LIMITS.eventBatchesPerSessionWindow; i++) statuses.push((await send(a, 7)).status);
    assert.equal(statuses.at(-1), 429, `the session's own window: ${statuses.slice(-3)}`);
    const other = await send(b, 7);
    assert.equal(other.status, 204, "another participant is not turned away");
    // Control: the link's shared window, once full, still refuses everyone (the existing limit).
    const { admitLinkRate } = await import("../src/lib/curriculum/store.ts");
    while (await admitLinkRate(f.env.HPS_DB, s.link.id, "event", Date.now(), EVIDENCE_LIMITS.windowMs, EVIDENCE_LIMITS.eventBatchesPerWindow));
    assert.equal((await send(b, 8)).status, 429);
  } finally {
    f.close();
  }
});

/** `n` participant sessions that started `label` (every second one finished), written the way the routes write them. */
async function bulkSessions(f, s, n, label = "주문하기") {
  const record = await recordOf(f, s);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const sid = "ps-" + createHash("sha256").update(`bulk-${s.experiment.id}-${label}-${i}`).digest("hex").slice(0, 32);
    const o = await openParticipantSession(record, { link: { ...s.link, project_id: s.project.id }, experiment: s.experiment, sessionId: sid, at: Date.now() + i });
    assert.equal(o.ok, true);
    const built = participantEvents({ experiment: s.experiment, sessionId: sid, link: { attribution: o.attribution }, linkId: s.link.id, events: [{ kind: "task_start", seq: 1, label }, ...(i % 2 ? [{ kind: "task_complete", seq: 2, label }] : [])], now: Date.now() });
    await appendParticipantEvents(record, s.experiment.id, sid, built.events);
    ids.push(sid);
  }
  return ids;
}

await test("runtime draft at class size: 120 sessions of one task give a stored draft whose statements each cite at most 50 sessions and together cite all 120; at most 60 statements", async () => {
  const f = await fixture();
  try {
    const s = await started(f);
    const ids = await bulkSessions(f, s, 120);
    const r = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts`, { method: "POST", token: s.token, body: { from_runtime: true } });
    assert.equal(r.status, 201, r.text);
    const items = r.json.draft.items;
    assert.ok(items.every((i) => i.source_refs.length <= 50), "every statement within the validator's bound");
    const cited = new Set(items.filter((i) => /시작한 세션 120개 중 60개/.test(i.text)).flatMap((i) => i.source_refs));
    assert.deepEqual([...cited].sort(), ids.map((x) => `session:${x}`).sort(), "the parts together cite every session");
    // Control: the pre-fix single statement over 120 sessions is refused by the same validator.
    const one = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts`, { method: "POST", token: s.token, body: { author: "ai", items: [{ id: "all", section: "observation", text: "120개 중 60개", source_refs: ids.map((x) => `session:${x}`), review: "draft" }] } });
    assert.deepEqual([one.status, one.json.error.code], [400, "invalid_source_ref"]);
    // Statement count: thirty labels over 120 sessions each, built by the pure function, fit the draft bound.
    const sessions = Array.from({ length: 120 }, (_, i) => ({ session_id: `ps-${i}`, at: i, pseudonym: null, variant: null, channel: null, product_version: "v", events: 1, pages: 0, clicks: 0, inputs: 0, tasks: Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`과제${k}`, { started: true, completed: i % 2 === 0 }])), milestones: [], event_ids: [] }));
    const draft = core.runtimeDraft({ id: "rt", experiment: { id: s.experiment.id, product_version_id: "v" }, sessions, notes: [], at: 1 });
    assert.equal(draft.items.length, 60);
    core.validateEvidenceDraftShape(draft);
  } finally {
    f.close();
  }
});

await test("deleted session: replaying its still-valid token opens nothing and records nothing; its events are refused permanently", async () => {
  const f = await fixture();
  try {
    const s = await started(f);
    const page = await participant(f, { seed: 61 }).tab().load(s.url);
    const reopen = () => f.raw(new URL(`/l/${s.link.id}/__hp/session`, s.url).href, { method: "POST", body: { token: page.cfg.session_token } });
    assert.equal((await reopen()).status, 204, "control: before deletion a reopen is an idempotent 204");
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/sessions/${page.cfg.session_id}`, { method: "DELETE", token: s.token })).status, 200);
    assert.equal((await reopen()).status, 404);
    const ev = await f.raw(new URL(`/l/${s.link.id}/__hp/events`, s.url).href, { method: "POST", body: { token: page.cfg.session_token, events: [{ kind: "milestone", seq: 9, label: "x" }] } });
    assert.deepEqual([ev.status, ev.headers.get("x-hp-refusal")], [409, "session_deleted"]);
    assert.ok(!(await evidence(f, s)).json.evidence.sessions.some((x) => x.session_id === page.cfg.session_id));
    assert.equal((await storedEvents(f, s)).filter((e) => e.participant.session_id === page.cfg.session_id).length, 0);
    const state = (await f.api(`/v1/curriculum/projects/${s.project.id}`, { token: s.token })).json;
    assert.equal(state.sessions_opened[s.experiment.id].unlabelled, 0, "the link's counter is not raised again");
  } finally {
    f.close();
  }
});

await test("decision 6, manual records: an experiment with no link and only notes is deleted 30 days after its last record, on a Service with no test origin too", async () => {
  const f = await fixture();
  try {
    const s = await started(f, { noLink: true });
    const quote = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/notes`, { method: "POST", token: s.token, body: { ...INTERVIEW, note_kind: "quote" } });
    assert.equal(quote.status, 201, quote.text);
    const env = { ...f.env, HPS_TEST_ORIGIN: undefined };
    const at = Date.now();
    assert.ok(!(await runCurriculumRetention(env, at + 29 * DAY)).deleted.includes(s.experiment.id), "29 days after the last record: kept");
    assert.equal((await evidence(f, s)).json.evidence.notes.length, 1);
    assert.ok((await runCurriculumRetention(env, at + 31 * DAY)).deleted.includes(s.experiment.id));
    assert.equal((await evidence(f, s)).json.evidence.notes.length, 0, "the quote is gone");
    assert.equal(await (await recordOf(f, s)).resolveEvidenceRef(s.experiment.id, `note:${quote.json.note.id}`), "deleted");
    // It never ran with participants: its status is left alone, not closed, so the student can still record and publish.
    const after = (await f.api(`/v1/curriculum/projects/${s.project.id}`, { token: s.token })).json.experiments.find((x) => x.id === s.experiment.id);
    assert.deepEqual([after.status, after.data_deleted_at], ["running", undefined]);
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/notes`, { method: "POST", token: s.token, body: INTERVIEW })).status, 201);
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/links`, { method: "POST", token: s.token, body: { expires_at: Date.now() + 3600_000 } })).status, 201);
  } finally {
    f.close();
  }
});

await test("decision 6, not swept early: an experiment with no link and no record stays running and can still publish a link; a note written after the link ended keeps the data 30 days from that note; a draft and a draft review count as records", async () => {
  const f = await fixture();
  try {
    const DB = f.env.HPS_DB;
    const now = Date.now();
    const statusOf = async (x) => (await f.api(`/v1/curriculum/projects/${x.project.id}`, { token: x.token })).json.experiments.find((e) => e.id === x.experiment.id);
    // A planned experiment (no link, no record) is not due, however long it waits.
    const planned = await started(f, { noLink: true });
    assert.ok(!(await runCurriculumRetention(f.env, now + 400 * DAY)).deleted.includes(planned.experiment.id), "nothing to delete: not due");
    const p = await statusOf(planned);
    assert.deepEqual([p.status, p.data_deleted_at], ["running", undefined]);
    assert.equal((await f.api(`/v1/curriculum/experiments/${planned.experiment.id}/links`, { method: "POST", token: planned.token, body: { expires_at: Date.now() + 3600_000 } })).status, 201, "a link can still be published");
    // A note written after the link ended: the experiment ends at the note, not at the link.
    const s = await withEvidence(f);
    await DB.prepare("UPDATE cr_test_links SET revoked_at = ? WHERE experiment_id = ?").bind(now - 25 * DAY, s.experiment.id).run();
    assert.ok(!(await runCurriculumRetention(f.env, now + 6 * DAY)).deleted.includes(s.experiment.id), "the link ended 31 days earlier, the note 6: kept");
    assert.equal((await evidence(f, s)).json.evidence.notes.length, 1);
    assert.ok((await runCurriculumRetention(f.env, now + 31 * DAY)).deleted.includes(s.experiment.id), "30 days after the note: deleted");
    assert.equal((await statusOf(s)).status, "closed", "it ran with participants: closed with its data deleted");
    // A draft and a draft review move the last record too.
    const d = await started(f, { noLink: true });
    const n = (await f.api(`/v1/curriculum/experiments/${d.experiment.id}/notes`, { method: "POST", token: d.token, body: INTERVIEW })).json.note;
    const backdate = () => DB.prepare("UPDATE cr_experiment_records SET last_record_at = ? WHERE experiment_id = ?").bind(now - 25 * DAY, d.experiment.id).run();
    await backdate();
    const dr = await f.api(`/v1/curriculum/experiments/${d.experiment.id}/drafts`, { method: "POST", token: d.token, body: { author: "user", items: [{ id: "i", section: "interpretation", text: "메뉴가 많다", source_refs: [`note:${n.id}`], review: "draft" }] } });
    assert.equal(dr.status, 201, dr.text);
    assert.ok(!(await runCurriculumRetention(f.env, now + 6 * DAY)).deleted.includes(d.experiment.id), "a draft is a record");
    await backdate();
    assert.equal((await f.api(`/v1/curriculum/experiments/${d.experiment.id}/drafts/${dr.json.draft.id}/review`, { method: "POST", token: d.token, body: { revision: 1, actions: [{ item: "i", action: "accept" }] } })).status, 201);
    assert.ok(!(await runCurriculumRetention(f.env, now + 6 * DAY)).deleted.includes(d.experiment.id), "a draft review is a record");
    // Control: the same backdated record with nothing after it is due.
    await backdate();
    assert.ok((await runCurriculumRetention(f.env, now + 6 * DAY)).deleted.includes(d.experiment.id), "control: due without a later record");
  } finally {
    f.close();
  }
});

await test("CR-69 races: an event batch in flight while its session is deleted leaves nothing behind (409 session_deleted); deleting the experiment removes an observation stored under it with no task", async () => {
  const f = await fixture();
  try {
    const s = await started(f);
    const page = await participant(f, { seed: 71 }).tab().load(s.url);
    const sid = page.cfg.session_id;
    // The Service's bucket, wrapped: the student's delete lands right before the batch's first event write.
    const bucket = f.env.HPS_TRACES;
    let armed = true;
    f.env.HPS_TRACES = {
      get: (...a) => bucket.get(...a),
      list: (...a) => bucket.list(...a),
      delete: (...a) => bucket.delete(...a),
      head: (...a) => bucket.head(...a),
      async put(key, value, opts) {
        if (armed && key.includes("/observations/") && key.includes(sid)) {
          armed = false;
          const del = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/sessions/${sid}`, { method: "DELETE", token: s.token });
          assert.equal(del.status, 200, del.text);
        }
        return bucket.put(key, value, opts);
      },
    };
    let ev;
    try {
      ev = await f.raw(new URL(`/l/${s.link.id}/__hp/events`, s.url).href, { method: "POST", body: { token: page.cfg.session_token, events: [{ kind: "milestone", seq: 50, label: "x" }] } });
    } finally {
      f.env.HPS_TRACES = bucket;
    }
    assert.equal(armed, false, "the delete landed inside the batch's write");
    assert.deepEqual([ev.status, ev.headers.get("x-hp-refusal")], [409, "session_deleted"]);
    const left = async (match) => [...(await recordKeys(f, s, "observations/")), ...(await recordKeys(f, s, "assignments/"))].filter((k) => k.includes(match));
    assert.deepEqual(await left(sid), [], "no event or assignment of the deleted session");
    // An observation a race stored with no task (the pre-fix path) under the experiment's scope.
    const stray = "ps-" + "7".repeat(32);
    const built = participantEvents({ experiment: s.experiment, sessionId: stray, link: { attribution: { project: s.project.id, experiment: s.experiment.id, product_version: s.version, link: s.link.id } }, linkId: s.link.id, events: [{ kind: "milestone", seq: 1, label: "x" }], now: Date.now() });
    const rec = await recordOf(f, s);
    const r = await rec.appendObservations(PUBLISHED_HOST, { format: "hps-observation/2", scope: s.experiment.id, session: stray, program: "hps-participant/1", events: built.events }, { quota: "none", gaps: false });
    assert.equal(r.task, null);
    assert.equal((await left(stray)).length, 2, "control: the stray event and its task-less assignment are there");
    // The participant path refuses the same write: the session is not open.
    await assert.rejects(rec.appendObservations(PUBLISHED_HOST, { format: "hps-observation/2", scope: s.experiment.id, session: stray, program: "hps-participant/1", events: built.events }, { quota: "none", gaps: false, participant: true }), /session_not_open/);
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}`, { method: "DELETE", token: s.token })).status, 200);
    assert.deepEqual(await left(stray), [], "the experiment's deletion takes it too");
  } finally {
    f.close();
  }
});

await test("CR-65 on the Service: a declared experiment's pseudonym ends with its link; on a new link of the same experiment it gets a fresh pseudonym and is not counted as a return", async () => {
  const f = await fixture();
  try {
    const s = await started(f, { declarations: { repeated_use: true } });
    const pp = "pp-" + "a".repeat(32);
    const t0 = Date.UTC(2026, 9, 1, 9);
    await sessionsAt(f, s, [t0, t0 + DAY], pp);
    const returnsOf = async () => (await evidence(f, s)).json.evidence.returns.devices.filter((d) => d.pseudonym === pp).map((d) => d.return_count);
    assert.deepEqual(await returnsOf(), [1], "control: on the same link the device's second session is a return");
    await f.api(`/v1/curriculum/links/${s.link.id}/revoke`, { method: "POST", token: s.token });
    const b = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/links`, { method: "POST", token: s.token, body: { expires_at: Date.now() + 3600_000 } });
    assert.equal(b.status, 201, b.text);
    const [onB] = await sessionsAt(f, s, [t0 + 2 * DAY], pp, { link: b.json.link });
    assert.deepEqual(await returnsOf(), [1], "the revoked link's pseudonym does not carry over");
    const link = await (await recordOf(f, s)).sessionLink(PUBLISHED_HOST, onB);
    assert.ok(link && /^pp-[0-9a-f]{32}$/.test(link.pseudonym) && link.pseudonym !== pp, "the new link's session is kept under a fresh pseudonym");
  } finally {
    f.close();
  }
});

await test("page paths: a page_view path is stored only when it names one of the version's files; any other path is stored without it", async () => {
  const f = await fixture();
  try {
    const s = await started(f);
    const page = await participant(f, { seed: 91 }).tab().load(s.url);
    const views = async () => (await storedEvents(f, s)).filter((e) => e.kind === "page_view" && e.participant.session_id === page.cfg.session_id).map((e) => e.text);
    const send = (seq, path) => f.raw(new URL(`/l/${s.link.id}/__hp/events`, s.url).href, { method: "POST", body: { token: page.cfg.session_token, events: [{ kind: "page_view", seq, path }] } });
    assert.equal((await send(89, "/app.js")).status, 204);
    assert.ok((await views()).includes("page_view: /app.js"), "control: a published file's path is kept");
    assert.equal((await send(90, "/주문메모-땅콩알레르기")).status, 204);
    assert.equal((await views()).filter((t) => t === "page_view").length, (await views()).length - 1, "every other view is stored without a path");
    assert.ok(!JSON.stringify(await storedEvents(f, s)).includes("땅콩"), "the made-up path is not stored");
  } finally {
    f.close();
  }
});

await test("snippet size: each half of the participant snippet stays under 2 KB", async () => {
  const size = (x) => new TextEncoder().encode(x).length;
  assert.ok(size(PARTICIPANT_SNIPPET) < 2048, `session half ${size(PARTICIPANT_SNIPPET)}`);
  assert.ok(size(PARTICIPANT_EVENTS_SNIPPET) < 2048, `event half ${size(PARTICIPANT_EVENTS_SNIPPET)}`);
  assert.ok(!(size(PARTICIPANT_EVENTS_SNIPPET + "x".repeat(10)) < 2048), "control: ten more bytes would cross the limit");
});

if (mf) await mf.dispose();
if (failed) {
  console.error(`\n${failed} cr-evidence check(s) failed`);
  process.exit(1);
}
console.log("\ncr-evidence: all checks passed");
