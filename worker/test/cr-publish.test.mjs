// cr-publish (#1393) — Publish for User Test on the Service, worker D1 layer (SQLite shim by
// default; `--d1` runs the same checks on local workerd D1 through Miniflare). Real Service
// router, real token verifier, the real test-origin dispatch. Synthetic identities; no network.
//
// CR-T02 (Worker half: the curriculum routes and the test origin) · CR-T17 (Worker half) ·
// CR-T18 (no login, Service half) · CR-T19 · CR-T21 · CR-T22 · CR-T60 (pseudonym) ·
// CR-T61 (Service half: the served policy) · CR-T68 · CR-T80. Each with its controls: a
// positive sample that must pass and a planted defect that must be caught.
//
// Run: node --experimental-strip-types --experimental-sqlite test/cr-publish.test.mjs [--d1]

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import { localCurriculum, TEST_ORIGIN } from "./harness/curriculum.mjs";
import { TEST_SECRET } from "./harness/index.mjs";

const { validateExperimentContract, EXPERIMENT_FIELDS, linkState, pinnedVersion } = await import("../src/lib/curriculum/venture.ts");
const { scanFile, judgeToken, scanRefusalText } = await import("../src/lib/curriculum/publish-scan.ts");
const { parseTestOrigin, originFor, matchTestOrigin } = await import("../src/lib/curriculum/test-origin.ts");
const { signSessionToken, verifySessionToken } = await import("../src/lib/curriculum/session-token.ts");
const { PARTICIPANT_SNIPPET } = await import("../src/lib/curriculum/participant-snippet.ts");
const { participantRecord, openParticipantSession, sessionsByChannel, PUBLISHED_HOST } = await import("../src/lib/curriculum/participant-record.ts");
const { CURRICULUM_ROUTES, PUBLISH_LIMITS } = await import("../src/routes/curriculum.ts");
const { CR_SURFACES, CR_TEST_ORIGIN_ROUTE, CR_TEST_ORIGIN_SESSION_ROUTE } = await import("../../extensions/hypeproof-chat/src/curriculumRuntime.ts");
const { issue, issueIssuer } = await import("../src/lib/tokens.ts");
const { scrubSecrets } = await import("../src/lib/scrub-secrets.ts");
const { redactText } = await import("../src/lib/measurement-core/local-record.ts");

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

let mf = null;
async function fixture(opts = {}) {
  if (!D1_MODE) return localCurriculum(opts);
  const { createMiniflare } = await import("./harness/miniflare.mjs");
  const compatibilityDate = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8").match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
  mf ??= createMiniflare({ modules: true, script: 'export default {fetch(){return new Response("local test")}}', compatibilityDate, d1Databases: ["HPS_DB"] });
  const db = await mf.getD1Database("HPS_DB");
  for (const t of ["cr_test_links", "cr_experiments", "cr_product_versions", "cr_hypotheses", "cr_projects"]) await db.prepare(`DROP TABLE IF EXISTS ${t}`).run();
  const sql = readFileSync(new URL("../migrations/0032-curriculum-runtime-publish.sql", import.meta.url), "utf8");
  for (let i = 0; i < 2; i++) for (const s of sql.replace(/^--.*$/gm, "").split(";").map((x) => x.trim()).filter(Boolean)) await db.prepare(s).run();
  return localCurriculum({ ...opts, binding: db });
}

const PAGE = (marker, extra = "") => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>키오스크 연습</title><link rel="stylesheet" href="style.css"></head><body><h1>${marker}</h1>${extra}<script src="app.js"></script></body></html>`;
const V0 = { "index.html": PAGE("버전 0"), "style.css": "h1{font-size:20px}", "app.js": "document.title += ' ok';" };
const V1 = { ...V0, "index.html": PAGE("버전 1") };

/** One project with v0 published, an experiment on it and one live link. */
async function started(f, { channel, files = V0, declarations, token } = {}) {
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
  const l = await f.api(`/v1/curriculum/experiments/${e.json.experiment.id}/links`, { method: "POST", token: t, body: { expires_at: Date.now() + 3600_000, ...(channel ? { channel } : {}) } });
  assert.equal(l.status, 201, l.text);
  return { token: t, project, version: up.id, experiment: e.json.experiment, hypothesis: e.json.hypothesis, link: l.json.link, url: l.json.share_url };
}

/** Follow the share URL like a phone: the redirect to the entry page, then the page. */
async function openEntry(f, url) {
  const first = await f.open(url);
  if (first.status !== 302) return first;
  return f.open(new URL(first.headers.get("location"), url).href);
}
const hpTest = (html) => JSON.parse(/window\.__hpTest=(\{.*?\});<\/script>/.exec(html)?.[1] ?? "null");

/** What the participant snippet does once per visit: open the session the entry page offered. */
const openSessionOf = (f, url, token) => f.raw(new URL(`/l/${new URL(url).pathname.split("/")[2]}/__hp/session`, url).href, { method: "POST", body: { token } });

/** One visit like a phone: the entry page, then the snippet's one session open. */
async function openVisit(f, url) {
  const page = await openEntry(f, url);
  const cfg = page.status === 200 ? hpTest(page.text) : null;
  const opened = cfg ? await openSessionOf(f, url, cfg.session_token) : null;
  return { page, cfg, opened, status: page.status };
}

// ── CR-T02, Worker half ──────────────────────────────────────────────────────

await test("CR-T02 inventory: the App's switch-off inventory lists every curriculum route the Worker mounts, and the test origin", () => {
  assert.deepEqual([...CR_SURFACES.workerRoutes].sort(), [...CURRICULUM_ROUTES, CR_TEST_ORIGIN_ROUTE, CR_TEST_ORIGIN_SESSION_ROUTE].sort());
  // Every inventoried /v1 route is really mounted under that method (a planted typo is caught below).
  const src = readFileSync(new URL("../src/routes/curriculum.ts", import.meta.url), "utf8");
  const mounted = [...src.matchAll(/curriculum\.(get|post|put|delete)\("([^"]+)"/g)].map((m) => `${m[1].toUpperCase()} /v1/curriculum${m[2]}`);
  assert.deepEqual(mounted.sort(), [...CURRICULUM_ROUTES].sort(), "the inventory and the router agree");
  assert.ok(!CURRICULUM_ROUTES.includes("GET /v1/curriculum/projectz"), "control: a name the router does not mount is not in the list");
});

/** The route check: with the switch off a CR route answers exactly as an unknown route. */
async function switchOffProblems(f, method, path, token) {
  const got = await f.api(path, { method, token, ...(method === "GET" ? {} : { body: {} }) });
  const unknown = await f.api("/v1/cr-never-registered", { method, token, ...(method === "GET" ? {} : { body: {} }) });
  const shape = (r) => JSON.stringify({ s: r.status, t: r.json?.error?.type, m: r.json?.error?.message, keys: Object.keys(r.json?.error ?? {}).sort() });
  const headers = (r) => JSON.stringify([...(r.headers ?? [])].filter(([k]) => k !== "x-request-id").sort());
  const problems = [];
  if (shape(got) !== shape(unknown)) problems.push(`${method} ${path}: ${shape(got)} vs unknown ${shape(unknown)}`);
  if (headers(got) !== headers(unknown)) problems.push(`${method} ${path}: headers ${headers(got)} vs unknown ${headers(unknown)}`);
  if (got.json?.error?.path !== new URL("https://x" + path).pathname) problems.push(`${method} ${path}: path differs`);
  return problems;
}

await test("CR-T02 switch OFF: every curriculum route, with real ids of a live project, answers as an unknown route; the test origin as an unknown path", async () => {
  const f = await fixture();
  try {
    const s = await started(f);
    const issuer = await f.issuer();
    f.setSwitch(false);
    const ids = { ":id": s.project.id, ":digest": encodeURIComponent(s.version) };
    const real = (route) => route.replace("/experiments/:id", `/experiments/${s.experiment.id}`).replace("/links/:id", `/links/${s.link.id}`).replace(/:id|:digest/g, (k) => ids[k]);
    for (const route of CURRICULUM_ROUTES) {
      const [method, path] = route.split(" ");
      const token = path.endsWith("/members") ? issuer : s.token;
      assert.deepEqual(await switchOffProblems(f, method, real(path), token), [], route);
      // No token at all: the same unknown-route answer.
      assert.deepEqual(await switchOffProblems(f, method, real(path), undefined), [], route + " (no token)");
    }
    // The published runtime: a live link of a switched-off project = an unknown path of the origin.
    const entry = await openEntry(f, s.url);
    const unknownPath = await f.open(new URL("/cr-never-registered", s.url).href);
    assert.deepEqual([entry.status, entry.text], [unknownPath.status, unknownPath.text]);
    assert.equal(entry.status, 404);
    const sessionOpen = await f.raw(new URL(`/l/${s.link.id}/__hp/session`, s.url).href, { method: "POST", body: { token: "x" } });
    const unknownPost = await f.raw(new URL("/cr-never-registered", s.url).href, { method: "POST", body: { token: "x" } });
    assert.deepEqual([sessionOpen.status, sessionOpen.text], [unknownPost.status, unknownPost.text], "the session route of a switched-off link = an unknown path");
    // Switch ON again: every route is reachable (not the unknown answer).
    f.setSwitch(true);
    const on = await f.api(`/v1/curriculum/projects/${s.project.id}`, { token: s.token });
    assert.equal(on.status, 200, on.text);
    assert.equal((await openEntry(f, s.url)).status, 200);
    // Instrument negative control: a planted route that answers with the switch off is caught.
    f.setSwitch(false);
    const planted = { ...f, api: (path, o) => (path.startsWith("/v1/curriculum/planted") ? Promise.resolve({ status: 200, json: { ok: true } }) : f.api(path, o)) };
    assert.ok((await switchOffProblems(planted, "GET", "/v1/curriculum/planted", s.token)).length > 0, "a route that ignores the switch must be caught");
    // A planted router-wide no-store (the unknown route's status and body, one extra header) is caught too.
    const headerPlant = { ...f, api: async (path, o) => { const r = await f.api(path.replace("/v1/curriculum/hdr", "/v1/cr-never-registered"), o); if (!path.startsWith("/v1/curriculum/hdr")) return r; const h = new Headers(r.headers); h.set("cache-control", "no-store"); return { ...r, headers: h, json: { error: { ...r.json.error, path } } }; } };
    const hp = await switchOffProblems(headerPlant, "GET", "/v1/curriculum/hdr", s.token);
    assert.deepEqual([hp.length, /headers/.test(hp[0] ?? "")], [1, true], JSON.stringify(hp));
  } finally {
    f.close();
  }
});

// ── CR-T17, Worker half ──────────────────────────────────────────────────────

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeSig = "x".repeat(43);
// Samples of each real format, assembled at run time so the repository never holds a key-shaped literal.
async function plantedSecrets() {
  const student = (await issue({ u: "cr-a", c: "canary-internal", p: "canary-sdk-contract" }, 1, TEST_SECRET)).token;
  const issuerTok = (await issueIssuer({ issuer: "director-a", scopes: [{ cohort: "canary-internal", profiles: ["canary-sdk-contract"] }] }, 1, TEST_SECRET)).token;
  const jwt = (payload) => `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u(payload)}.${fakeSig}`;
  return {
    gemini: ["gemini_key", `const k = "${"AI" + "za"}${"Sy".padEnd(35, "B")}";`],
    anthropic: ["anthropic_key", `const k = "${"sk-" + "ant-"}api03-${"a".repeat(40)}";`],
    openai: ["openai_key", `const k = "${"sk-" + "proj-"}${"b".repeat(40)}";`],
    glm: ["glm_key", `const k = "${"0123456789abcdef".repeat(2)}.${"AbCdEfGh12345678"}";`],
    supabase_service: ["jwt", `const k = "${jwt({ iss: "supabase", ref: "abcdefghijklmnop", role: "service_role", iat: 1, exp: 2 })}";`],
    student_token: ["hypeproof_token", `fetch("/x", { headers: { a: "${student}" } });`],
    issuer_token: ["hypeproof_token", `const t = "${issuerTok}";`],
    issuer_assignment: ["hypeproof_token", `HYPEPROOF_TOKEN = "${issuerTok}";`],
    anon_ok: [null, `const supabaseKey = "${jwt({ iss: "supabase", ref: "abcdefghijklmnop", role: "anon", iat: 1, exp: 2 })}";`],
  };
}

await test("CR-T17 scan: one planted key per LLMProvider, a Supabase service key, a student and an issuer token (bare and assigned) are refused; a Supabase anon key is not", async () => {
  const ctx = { projectId: "prj-0000000000000000", testOrigin: "http://prj-0000000000000000.test.invalid" };
  const env = readFileSync(new URL("../src/env.ts", import.meta.url), "utf8");
  const providers = /export type LLMProvider = ([^;]+);/.exec(env)[1].match(/"([a-z]+)"/g).map((s) => s.slice(1, -1));
  const planted = await plantedSecrets();
  assert.deepEqual(providers.sort(), ["anthropic", "gemini", "glm", "openai"], "control: one planted key per LLMProvider value");
  for (const [name, [rule, line]] of Object.entries(planted)) {
    const hits = scanFile("app.js", `// 학생 앱\n${line}\n`, ctx);
    if (rule === null) assert.deepEqual(hits, [], `${name} must publish`);
    else {
      assert.ok(hits.length > 0, `${name} must be refused`);
      assert.ok(hits.some((h) => h.rule === rule && h.line === 2), `${name}: ${JSON.stringify(hits)}`);
      assert.match(scanRefusalText(hits[0]), /app\.js 2번째 줄/);
    }
  }
  // Superset of the existing lists: every sample they mask, the publish scan refuses.
  const theirs = [`gh${"p"}_${"A".repeat(36)}`, `AKIA${"ABCDEFGHIJKLMNOP"}`, "https://user:pass@example.com/x", "API_KEY=abcdefghijkl", "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----", `Bearer ${"c".repeat(30)}`];
  for (const s of theirs) {
    const masked = scrubSecrets(s) !== s || redactText(s).text !== s;
    assert.ok(masked, `control: an existing list masks ${s.slice(0, 12)}`);
    assert.ok(scanFile("a.js", s, ctx).length > 0, `the publish scan misses what an existing list masks: ${s.slice(0, 12)}`);
  }
  // The token rule's app-token branch (cr-gateway mints them): bound to this project and origin passes only.
  const app = (o) => `${b64u({ u: "a", c: "x", p: "y", role: "app", ...o })}.${"s".repeat(43)}`;
  assert.equal(judgeToken(app({ project: ctx.projectId, origin: ctx.testOrigin }), ctx), null);
  assert.equal(judgeToken(app({ project: "prj-other", origin: ctx.testOrigin }), ctx), "app_other_project");
  assert.equal(judgeToken(app({ project: ctx.projectId, origin: "http://evil.test" }), ctx), "app_other_origin");
  assert.equal(judgeToken("eyJub3Rqc29uIjp9broken.abcdefghijkl", ctx), "undecodable");
});

await test("CR-T17 upload: same bytes → same version id; a changed file behind it, a dot-file, a planted key or another team is refused and nothing is stored", async () => {
  const f = await fixture();
  try {
    const s = await started(f);
    const again = await f.upload(s.project.id, V0, s.token);
    assert.deepEqual([again.status, again.json.version.id, again.json.created], [200, s.version, false], "positive: identical bytes are the same version");
    const before = new Map(f.r2.map);
    // Replace a file behind the published version: same id, other bytes.
    const swapped = await f.upload(s.project.id, { ...V0, "app.js": "alert('바뀜')" }, s.token, { digest: s.version });
    assert.equal(swapped.status, 409, swapped.text);
    assert.deepEqual([...f.r2.map.keys()], [...before.keys()], "nothing written");
    assert.equal(new TextDecoder().decode(f.r2.map.get(`test-versions/${s.version.slice(7)}/app.js`)), V0["app.js"], "the published bytes are unchanged");
    // A workspace .env or any dot-file is never accepted.
    for (const path of [".env", ".npmrc", "assets/.secret.json", "node_modules/x.js"]) {
      const r = await f.upload(s.project.id, { ...V0, [path]: "X=1" }, s.token);
      assert.equal(r.status, 422, `${path}: ${r.text}`);
      assert.equal(r.json.error.code, "excluded_path");
    }
    for (const path of ["../up.js", "/abs.js", "a\\b.js"]) assert.equal((await f.upload(s.project.id, { ...V0, [path]: "x" }, s.token)).json.error.code, "invalid_path", path);
    // Every planted secret refuses the whole upload sent directly to the Worker.
    const planted = await plantedSecrets();
    for (const [name, [rule, line]] of Object.entries(planted)) {
      const rows = (await f.api(`/v1/curriculum/projects/${s.project.id}`, { token: s.token })).json.versions.length;
      const objects = f.r2.map.size;
      const r = await f.upload(s.project.id, { ...V0, "app.js": line }, s.token);
      if (rule === null) {
        assert.equal(r.status, 201, `${name}: ${r.text}`);
        continue;
      }
      assert.equal(r.status, 422, `${name}: ${r.text}`);
      assert.equal(r.json.error.code, "secret_found");
      assert.ok(r.json.error.hits.some((h) => h.file === "app.js" && h.rule === rule), `${name}: ${r.text}`);
      assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}`, { token: s.token })).json.versions.length, rows, `${name}: no version recorded`);
      assert.equal(f.r2.map.size, objects, `${name}: no file stored`);
    }
    // A forged app token bound to this project passes the App's decode but not the Worker's signature check.
    const origin = originFor(parseTestOrigin(TEST_ORIGIN, "development").config, s.project.id);
    const forged = `${b64u({ u: "a", c: "x", p: "y", role: "app", project: s.project.id, origin })}.${"s".repeat(43)}`;
    const fr = await f.upload(s.project.id, { ...V0, "app.js": `const t="${forged}";` }, s.token);
    assert.deepEqual([fr.status, fr.json.error.hits?.[0]?.detail], [422, "signature"], fr.text);
    // Another team's student (same cohort, not a member) uploading into this Project: 404, nothing recorded.
    const objects = f.r2.map.size;
    const other = await f.upload(s.project.id, V1, await f.student("cr-b"));
    assert.equal(other.status, 404);
    assert.equal(other.json.error.type, "not_found");
    assert.equal(f.r2.map.size, objects);
    assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}`, { token: s.token })).json.versions.filter((v) => v.id === other.id).length, 0);
    // Control: once the director puts cr-b on the team, the same upload is accepted.
    const team = await f.api(`/v1/curriculum/projects/${s.project.id}/members`, { method: "PUT", token: await f.issuer(), body: { members: ["cr-a", "cr-b"] } });
    assert.equal(team.status, 200, team.text);
    assert.equal((await f.upload(s.project.id, V1, await f.student("cr-b"))).status, 201);
    // A student cannot set the team; a director of another cohort cannot either.
    assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}/members`, { method: "PUT", token: s.token, body: { members: ["cr-a", "cr-c"] } })).status, 404);
    assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}/members`, { method: "PUT", token: await f.issuer(f.otherCohort, f.other.id), body: { members: ["cr-a"] } })).status, 404);
    assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}/members`, { method: "PUT", token: await f.issuer(), body: { members: ["not-on-roster"] } })).json.error.code, "members_not_in_roster");
  } finally {
    f.close();
  }
});

// ── CR-T18 (Service half) and CR-T61 (served policy) ─────────────────────────

await test("CR-T18/CR-T61 Service half: the share URL serves the page with no login; camera and microphone are denied unless the experiment declares them", async () => {
  const f = await fixture();
  try {
    const s = await started(f);
    const first = await f.open(s.url);
    assert.equal(first.status, 302);
    assert.equal(new URL(first.headers.get("location"), s.url).origin, new URL(s.url).origin, "the only redirect stays on the test origin (no login hop)");
    const page = await openEntry(f, s.url);
    assert.equal(page.status, 200);
    assert.match(page.text, /버전 0/);
    assert.doesNotMatch(page.text, /로그인|login|password/i);
    assert.equal(page.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=(), display-capture=()");
    assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
    const declared = await started(f, { declarations: { devices: ["camera"] } });
    const p2 = await openEntry(f, declared.url);
    assert.match(p2.headers.get("permissions-policy"), /camera=\(self\), microphone=\(\)/, "declared: only the declared device, only for this origin");
    // A link opened on another project's origin is not served (origin isolation).
    const foreign = s.url.replace(new URL(s.url).hostname, new URL(declared.url).hostname);
    assert.equal((await f.open(foreign)).status, 404);
  } finally {
    f.close();
  }
});

// ── CR-T19 ───────────────────────────────────────────────────────────────────

await test("CR-T19: live links serve; revoked and expired links answer 410 with no content on every path; no expiry is refused; another team cannot revoke", async () => {
  const f = await fixture();
  try {
    const s = await started(f);
    const asset = new URL(`/l/${s.link.id}/app.js`, s.url).href;
    assert.equal((await openEntry(f, s.url)).status, 200, "positive: before revocation the link serves");
    const assetBefore = await f.open(asset);
    assert.deepEqual([assetBefore.status, assetBefore.headers.get("cache-control")], [200, "no-store"]);
    // No service worker can install on a test origin: the fetch a registration makes for its
    // script (`Service-Worker: script`) is answered as an absent file, on any path of the set.
    for (const path of [asset, new URL(`/l/${s.link.id}/index.html`, s.url).href]) {
      const sw = await f.open(path, { headers: { "service-worker": "script" } });
      assert.deepEqual([sw.status, sw.bytes.length], [404, 0], `service-worker fetch of ${path}`);
    }
    // Another team's student revoking: 404, and the link keeps serving.
    const intruder = await f.api(`/v1/curriculum/links/${s.link.id}/revoke`, { method: "POST", token: await f.student("cr-c"), body: {} });
    assert.equal(intruder.status, 404);
    assert.equal((await openEntry(f, s.url)).status, 200);
    const rv = await f.api(`/v1/curriculum/links/${s.link.id}/revoke`, { method: "POST", token: s.token, body: {} });
    assert.deepEqual([rv.status, rv.json.link.state], [200, "revoked"]);
    for (const url of [s.url, new URL(`/l/${s.link.id}/index.html`, s.url).href, asset]) {
      const r = await f.open(url);
      assert.deepEqual([r.status, r.bytes.length, r.headers.get("cache-control"), r.headers.get("clear-site-data")], [410, 0, "no-store", '"cache", "storage"'], url);
    }
    // A revoked link opens no session either.
    assert.equal((await openSessionOf(f, s.url, "hpsts1.x.y")).status, 410);
    // Expiry: a link whose time has passed answers the same 410.
    const e = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/links`, { method: "POST", token: s.token, body: { expires_at: Date.now() + 150 } });
    assert.equal(e.status, 201, e.text);
    assert.equal((await openEntry(f, e.json.share_url)).status, 200);
    await new Promise((r) => setTimeout(r, 200));
    const ex = await openEntry(f, e.json.share_url);
    assert.deepEqual([ex.status, ex.bytes.length], [410, 0]);
    assert.equal(linkState({ expires_at: 1000 }, 999), "live");
    assert.equal(linkState({ expires_at: 1000 }, 1000), "expired");
    // While no default expiry is set, a link (the publish) without an explicit expiry is refused.
    const none = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/links`, { method: "POST", token: s.token, body: { channel: "단톡방" } });
    assert.deepEqual([none.status, none.json.error.code], [400, "expiry_required"]);
    for (const bad of [Date.now() - 1, "내일", Date.now() + 400 * 24 * 3600_000]) assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/links`, { method: "POST", token: s.token, body: { expires_at: bad } })).json.error.code, "invalid_expiry");
    // Instrument control: the check that "revoked serves nothing" fails on a planted server that still serves.
    const leaky = { status: 200, bytes: new Uint8Array([60]) };
    assert.notDeepEqual([leaky.status, leaky.bytes.length], [410, 0]);
  } finally {
    f.close();
  }
});

// ── CR-T21 ───────────────────────────────────────────────────────────────────

await test("CR-T21: opening the v0 link creates one participant session record carrying project, experiment and version; a fetch that runs no script opens none; a session whose version is not the experiment's is refused", async () => {
  const f = await fixture();
  try {
    const s = await started(f, { channel: "학교 게시판" });
    const record = participantRecord(f.r2, f.cohort, s.project.id);
    const sessionKeys = () => [...f.r2.map.keys()].filter((k) => k.includes("/sessions/published/"));
    const counted = async () => (await f.api(`/v1/curriculum/experiments/${s.experiment.id}/channels`, { token: s.token })).json.sessions_opened.channels["학교 게시판"] ?? 0;
    // A fetch of the entry page alone (a link-preview bot, a prefetch) records nothing.
    const bot = await openEntry(f, s.url);
    assert.equal(bot.status, 200);
    assert.deepEqual([sessionKeys().length, await counted()], [0, 0], "the entry page load writes no session");
    const { page, cfg, opened } = await openVisit(f, s.url);
    assert.equal(page.status, 200);
    assert.match(cfg.session_id, /^ps-[0-9a-f]{32}$/);
    assert.equal(opened.status, 204, opened.text);
    // Idempotent: the same visit opening again (a retry, a second tab of the visit) counts once.
    assert.equal((await openSessionOf(f, s.url, cfg.session_token)).status, 204);
    assert.deepEqual([sessionKeys().length, await counted()], [1, 1], "one visit, one session, counted once");
    // A forged or another link's token opens nothing.
    assert.equal((await openSessionOf(f, s.url, cfg.session_token.slice(0, -2) + "xx")).status, 403);
    const other = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/links`, { method: "POST", token: s.token, body: { expires_at: Date.now() + 3600_000, channel: "단톡방" } });
    assert.equal((await openSessionOf(f, other.json.share_url, cfg.session_token)).status, 403, "a token is bound to its link");
    assert.deepEqual([sessionKeys().length, await counted()], [1, 1]);
    assert.deepEqual(await record.sessionAttribution(PUBLISHED_HOST, cfg.session_id), { project: s.project.id, experiment: s.experiment.id, product_version: s.version, link: s.link.id, channel: "학교 게시판" });
    assert.equal(await record.taskForSession(PUBLISHED_HOST, cfg.session_id), s.experiment.id, "the session is linked to the experiment's task (same id, R6)");
    const task = await record.getTask(s.experiment.id);
    assert.equal(task.project, s.project.id);
    // The session record is on the measurement-core record (R2), not a traffic table (SX-48).
    assert.ok([...f.r2.map.keys()].some((k) => k.endsWith(`sessions/published/${cfg.session_id}`)));
    // The session token is bound to that link and session.
    assert.equal((await verifySessionToken(cfg.session_token, s.link.id, Date.now(), TEST_SECRET))?.session, cfg.session_id);
    // Negative: a session claiming a version that is not the experiment's is refused and writes nothing.
    const before = f.r2.map.size;
    const r = await openParticipantSession(record, { link: s.link, experiment: s.experiment, sessionId: "ps-planted-mismatch", at: Date.now(), claimed: { product_version: "sha256:" + "0".repeat(64) } });
    assert.deepEqual(r, { ok: false, code: "session_version_mismatch" });
    assert.equal(f.r2.map.size, before);
    // Control: the same call with the experiment's own version is accepted.
    assert.equal((await openParticipantSession(record, { link: s.link, experiment: s.experiment, sessionId: "ps-planted-match", at: Date.now(), claimed: { product_version: s.version } })).ok, true);
    // Session tokens: forged, expired or another link's are refused.
    const tok = await signSessionToken({ link: s.link.id, session: "ps-x", linkExpiresAt: Date.now() + 10_000, now: Date.now() }, TEST_SECRET);
    assert.ok(await verifySessionToken(tok.token, s.link.id, Date.now(), TEST_SECRET));
    assert.equal(await verifySessionToken(tok.token, "AAAAAAAAAAAAAAAAAAAAAA", Date.now(), TEST_SECRET), null);
    assert.equal(await verifySessionToken(tok.token, s.link.id, Date.now() + 20_000, TEST_SECRET), null);
    assert.equal(await verifySessionToken(tok.token.slice(0, -2) + "xx", s.link.id, Date.now(), TEST_SECRET), null);
    assert.ok(tok.exp <= Date.now() + 10_000, "never later than the link's own expiry");
  } finally {
    f.close();
  }
});

// ── CR-T22 ───────────────────────────────────────────────────────────────────

/** Does every page this link serves show v0? The pinning check (its own controls below). */
async function servesMarker(f, url, marker) {
  const p = await openEntry(f, url);
  return p.status === 200 && p.text.includes(marker);
}

await test("CR-T22: publishing v1 while the v0 experiment runs leaves its link, its sessions and a pinned demo on v0", async () => {
  const f = await fixture();
  try {
    const s = await started(f);
    const demo = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/links`, { method: "POST", token: s.token, body: { expires_at: Date.now() + 3600_000, channel: "6주차 데모" } });
    const v1 = await f.upload(s.project.id, V1, s.token);
    assert.equal(v1.status, 201);
    assert.notEqual(v1.id, s.version);
    assert.equal(await servesMarker(f, s.url, "버전 0"), true, "the running experiment's link keeps v0");
    assert.equal(await servesMarker(f, demo.json.share_url, "버전 0"), true, "a demo pinned to v0 keeps showing v0");
    const { cfg } = await openVisit(f, s.url);
    assert.equal((await participantRecord(f.r2, f.cohort, s.project.id).sessionAttribution(PUBLISHED_HOST, cfg.session_id)).product_version, s.version);
    // A new experiment on v1 serves v1 beside it.
    const e1 = await f.api("/v1/curriculum/experiments", { method: "POST", token: s.token, body: { project_id: s.project.id, product_version_id: v1.id, week: 2, question: "q", method: "task_test", success_criteria: ["c"], hypothesis_id: s.hypothesis.id } });
    const l1 = await f.api(`/v1/curriculum/experiments/${e1.json.experiment.id}/links`, { method: "POST", token: s.token, body: { expires_at: Date.now() + 3600_000 } });
    assert.equal(await servesMarker(f, l1.json.share_url, "버전 1"), true, "positive control: the instrument sees v1 where v1 is pinned");
    assert.equal(await servesMarker(f, s.url, "버전 1"), false, "and the v0 link never serves v1");
    assert.equal(pinnedVersion({ product_version_id: "a", declarations: { variants: [{ id: "b", product_version_id: "b" }] } }, "b"), "b");
    // Negative control: a planted defect that re-points the running experiment at v1 is caught by the same check.
    const planted = { ...s.experiment, product_version_id: v1.id };
    if (f.db) f.db.prepare("UPDATE cr_experiments SET doc = ? WHERE id = ?").run(JSON.stringify(planted), s.experiment.id);
    else await f.env.HPS_DB.prepare("UPDATE cr_experiments SET doc = ? WHERE id = ?").bind(JSON.stringify(planted), s.experiment.id).run();
    assert.equal(await servesMarker(f, s.url, "버전 0"), false, "the pinning check must turn red when the link starts serving v1");
  } finally {
    f.close();
  }
});

// ── CR-T68 ───────────────────────────────────────────────────────────────────

await test("CR-T68: two channel-labelled links attribute their sessions to their own channel; a mismatched claim is refused; no link = unknown channel; revoking one leaves the other", async () => {
  const f = await fixture();
  try {
    const s = await started(f, { channel: "학교 게시판" });
    const dm = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/links`, { method: "POST", token: s.token, body: { expires_at: Date.now() + 3600_000, channel: "1:1 메시지" } });
    const plain = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/links`, { method: "POST", token: s.token, body: { expires_at: Date.now() + 3600_000 } });
    await openVisit(f, s.url);
    await openVisit(f, s.url);
    await openVisit(f, dm.json.share_url);
    await openVisit(f, plain.json.share_url);
    const record = participantRecord(f.r2, f.cohort, s.project.id);
    // A session linked with no recorded link (an App-side or legacy link): "unknown channel", never guessed.
    await record.linkSession(s.experiment.id, { host: PUBLISHED_HOST, session_id: "ps-no-link", by: "adapter_explicit", at: Date.now() });
    const read = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/channels`, { token: s.token });
    // The route counts what the published links opened (the per-link index): never a session without a link.
    assert.deepEqual(read.json.sessions_opened, { channels: { "학교 게시판": 2, "1:1 메시지": 1 }, unlabelled: 1, unknown: 0 });
    assert.equal(read.json.note, "usage_observation");
    // The index agrees with the record it indexes; the record's own reading keeps the unlinked session "unknown".
    assert.deepEqual(await sessionsByChannel(record, s.experiment.id), { channels: { "학교 게시판": 2, "1:1 메시지": 1 }, unlabelled: 1, unknown: 1 });
    // A session claiming an experiment other than its link's is refused and writes nothing.
    const other = await started(f, { token: s.token });
    const before = f.r2.map.size;
    assert.deepEqual(await openParticipantSession(record, { link: s.link, experiment: other.experiment, sessionId: "ps-claim", at: Date.now() }), { ok: false, code: "session_experiment_mismatch" });
    assert.deepEqual(await openParticipantSession(record, { link: s.link, experiment: s.experiment, sessionId: "ps-claim2", at: Date.now(), claimed: { experiment: other.experiment.id } }), { ok: false, code: "session_experiment_mismatch" });
    assert.equal(f.r2.map.size, before);
    // Revoking one channel's link leaves the other serving.
    await f.api(`/v1/curriculum/links/${s.link.id}/revoke`, { method: "POST", token: s.token, body: {} });
    assert.equal((await openEntry(f, s.url)).status, 410);
    assert.equal((await openEntry(f, dm.json.share_url)).status, 200);
    // Instrument negative control: a counter that assigned unlinked sessions to a channel would differ.
    const counts = await sessionsByChannel(record, s.experiment.id);
    assert.notEqual(counts.unknown, 0, "the unlinked session stays unknown");
    // A visit to the revoked link's channel no longer counts; the live one still does.
    await openVisit(f, s.url);
    await openVisit(f, dm.json.share_url);
    assert.deepEqual((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/channels`, { token: s.token })).json.sessions_opened.channels, { "학교 게시판": 2, "1:1 메시지": 2 });
    // Channel labels are the student's short words, bounded.
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/links`, { method: "POST", token: s.token, body: { expires_at: Date.now() + 1000_000, channel: "가".repeat(41) } })).json.error.code, "invalid_channel");
  } finally {
    f.close();
  }
});

// ── CR-T80 ───────────────────────────────────────────────────────────────────

const PRD_SAMPLE = { id: "exp_001", project_id: "prj_abc", week: 2, hypothesis_id: "hyp_003", question: "Can the user complete the order without help?", method: "task_test", success_criteria: ["3/5 complete", "no critical blocker"], product_version_id: "v7", status: "running" };

/** Experiment or hypothesis tables outside the Venture Memory storage (migration 0032's cr_* tables). */
function strayTables(sql) {
  const names = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)/gi)].map((m) => m[1]);
  return names.filter((n) => /experiment|hypothes/i.test(n) && !["cr_experiments", "cr_hypotheses"].includes(n));
}

await test("CR-T80: the PRD §10.1 sample validates; any one field removed is refused; starting a test stores the hypothesis and one Experiment whose ids resolve; an unresolved hypothesis is refused; no stray table", async () => {
  assert.equal(validateExperimentContract(PRD_SAMPLE).ok, true, "positive: the PRD sample validates");
  for (const field of EXPERIMENT_FIELDS) {
    const { [field]: _gone, ...rest } = PRD_SAMPLE;
    const r = validateExperimentContract(rest);
    assert.equal(r.ok, false, `${field} removed must be refused`);
    assert.ok(r.problems.includes(`missing:${field}`), JSON.stringify(r));
  }
  assert.deepEqual(EXPERIMENT_FIELDS, ["id", "project_id", "week", "hypothesis_id", "question", "method", "success_criteria", "product_version_id", "status"], "every PRD §10.1 field, none dropped");
  const f = await fixture();
  try {
    const s = await started(f);
    const state = (await f.api(`/v1/curriculum/projects/${s.project.id}`, { token: s.token })).json;
    assert.equal(state.hypotheses.length, 1, "the project had none: starting the test stored the student's hypothesis");
    assert.deepEqual([state.hypotheses[0].statement, state.hypotheses[0].status], ["처음 쓰는 사람도 혼자 주문할 수 있다", "open"]);
    assert.equal(state.experiments.length, 1);
    const e = state.experiments[0];
    for (const field of EXPERIMENT_FIELDS) assert.ok(e[field] !== undefined, `stored experiment has ${field}`);
    assert.equal(validateExperimentContract(e).ok, true);
    assert.equal(e.hypothesis_id, state.hypotheses[0].id);
    assert.equal(e.project_id, s.project.id);
    assert.ok(state.versions.some((v) => v.id === e.product_version_id), "product_version_id resolves");
    // Negative: an experiment whose hypothesis_id does not resolve (or is another project's) is refused; nothing written.
    const other = await started(f, { token: s.token });
    for (const hid of ["hyp-0000000000000000", other.hypothesis.id]) {
      const r = await f.api("/v1/curriculum/experiments", { method: "POST", token: s.token, body: { project_id: s.project.id, product_version_id: s.version, week: 1, question: "q", method: "m", success_criteria: ["c"], hypothesis_id: hid } });
      assert.deepEqual([r.status, r.json.error.code], [409, "hypothesis_unresolved"], r.text);
    }
    const missing = await f.api("/v1/curriculum/experiments", { method: "POST", token: s.token, body: { project_id: s.project.id, product_version_id: s.version, week: 1, method: "m", success_criteria: ["c"], hypothesis_id: s.hypothesis.id } });
    assert.deepEqual([missing.status, missing.json.error.problems], [400, ["missing:question"]]);
    assert.equal((await f.api("/v1/curriculum/experiments", { method: "POST", token: s.token, body: { project_id: s.project.id, product_version_id: "sha256:" + "1".repeat(64), week: 1, question: "q", method: "m", success_criteria: ["c"], hypothesis: "h" } })).json.error.code, "version_unresolved");
    assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}`, { token: s.token })).json.experiments.length, 1, "no refused experiment was stored");
    assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}`, { token: s.token })).json.hypotheses.length, 1, "no orphan hypothesis from a refused start");
  } finally {
    f.close();
  }
  // Store inventory: the experiment and hypothesis records live only in the Venture Memory tables.
  const sql = [readFileSync(new URL("../schema.sql", import.meta.url), "utf8"), ...readdirSync(new URL("../migrations/", import.meta.url)).map((m) => readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"))].join("\n");
  assert.deepEqual(strayTables(sql), []);
  assert.deepEqual(strayTables(sql + "\nCREATE TABLE IF NOT EXISTS student_experiments (id TEXT);"), ["student_experiments"], "negative control: a planted table beside the storage is caught");
});

// ── CR-T60 (the pseudonym half; the event schema half is cr-evidence's) ─────

/** One browser: localStorage persists across sessions; each visit has its own sessionStorage. */
function browser({ ua = "Mozilla/5.0 (iPhone)", seed = 1 } = {}) {
  const local = new Map();
  let n = seed;
  const store = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) });
  return {
    local,
    /** One tab: its sessionStorage lives across page loads; `fetch` answers the session open with `status`. */
    tab({ status = 204 } = {}) {
      const session = new Map();
      const posts = [];
      return {
        posts,
        session,
        async load(cfg, snippet = PARTICIPANT_SNIPPET) {
          const fetch = (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return Promise.resolve({ ok: status >= 200 && status < 300 }); };
          const win = { __hpTest: { ...cfg }, sessionStorage: store(session), localStorage: store(local), navigator: { userAgent: ua }, fetch };
          const crypto = { getRandomValues: (b) => { for (let i = 0; i < b.length; i++) b[i] = (n = (n * 1103515245 + 12345) & 0x7fffffff) & 255; return b; } };
          vm.runInNewContext(snippet, { window: win, navigator: win.navigator, crypto, JSON, Date, Object, Uint8Array });
          await new Promise((r) => setImmediate(r));
          return win.hypeproof.test;
        },
      };
    },
    visit(cfg, snippet = PARTICIPANT_SNIPPET) {
      const win = { __hpTest: { ...cfg }, sessionStorage: store(new Map()), localStorage: store(local), navigator: { userAgent: ua } };
      const crypto = { getRandomValues: (b) => { for (let i = 0; i < b.length; i++) b[i] = (n = (n * 1103515245 + 12345) & 0x7fffffff) & 255; return b; } };
      vm.runInNewContext(snippet, { window: win, navigator: win.navigator, crypto, JSON, Date, Object, Uint8Array });
      return win.hypeproof.test;
    },
  };
}

/** The CR-T60 verdict on a snippet (its own controls below): problems found, empty when it holds. */
function pseudonymProblems(snippet) {
  const problems = [];
  const exp = (link, repeated, extra = {}) => ({ link, experiment: extra.experiment ?? "exp-a", repeated_use: repeated, link_expires_at: Date.now() + 3600_000, session_token: "t", ...extra });
  const b = browser();
  const s1 = b.visit({ ...exp("L1", true), session_id: "ps-1" }, snippet);
  const s2 = b.visit({ ...exp("L1", true), session_id: "ps-2" }, snippet);
  if (!/^pp-[0-9a-f]{32}$/.test(s1.pseudonym ?? "")) problems.push("pseudonym is not a random pp- value");
  if (s1.pseudonym !== s2.pseudonym) problems.push("declared experiment: two sessions of one browser do not share the pseudonym");
  if (s1.session_id === s2.session_id) problems.push("two sessions share a session id");
  const other = b.visit({ ...exp("L9", true, { experiment: "exp-b" }), session_id: "ps-3" }, snippet);
  if (other.pseudonym === s1.pseudonym) problems.push("one pseudonym appears in two experiments");
  const u = browser();
  const u1 = u.visit({ ...exp("L2", false), session_id: "ps-4" }, snippet);
  const u2 = u.visit({ ...exp("L2", false), session_id: "ps-5" }, snippet);
  if (u1.pseudonym === u2.pseudonym) problems.push("undeclared experiment: two sessions carry the same pseudonym");
  const after = b.visit({ ...exp("L1-new", true), session_id: "ps-6" }, snippet);
  if (after.pseudonym === s1.pseudonym) problems.push("a session under a new link (the old one expired or revoked) reuses the earlier pseudonym");
  const stale = browser();
  const s7 = stale.visit({ ...exp("L3", true, { link_expires_at: Date.now() - 1 }), session_id: "ps-7" }, snippet);
  const s8 = stale.visit({ ...exp("L3", true), session_id: "ps-8" }, snippet);
  if (s8.pseudonym === s7.pseudonym) problems.push("a pseudonym past its link's expiry is reused");
  if (stale.local.get("hp:pseudonym:exp-a") === undefined) problems.push("declared experiment stored no pseudonym");
  // Device data: the same user agent with different randomness must give different pseudonyms.
  const d1 = browser({ seed: 7 }).visit({ ...exp("L4", false), session_id: "ps-9" }, snippet);
  const d2 = browser({ seed: 99 }).visit({ ...exp("L4", false), session_id: "ps-10" }, snippet);
  if (d1.pseudonym === d2.pseudonym) problems.push("pseudonym derived from device data (same UA, different randomness, same value)");
  if (/navigator|userAgent|screen\.|devicePixelRatio|platform/.test(snippet)) problems.push("the snippet reads device attributes");
  return problems;
}

/** The one-visit verdict on a snippet: problems found, empty when it holds. */
async function oneVisitProblems(snippet) {
  const problems = [];
  const cfg = (session, entry = true) => ({ link: "L1", experiment: "exp-a", repeated_use: false, link_expires_at: Date.now() + 3600_000, ...(entry ? { session_id: session, session_token: `tok-${session}` } : {}) });
  const tab = browser({ seed: 3 }).tab();
  const home = await tab.load(cfg("ps-1"), snippet);
  const menu = await tab.load(cfg(null, false), snippet);
  const back = await tab.load(cfg("ps-2"), snippet);
  const reload = await tab.load(cfg("ps-3"), snippet);
  if (new Set([home, menu, back, reload].map((t) => t.session_id)).size !== 1) problems.push(`a second session in one visit: ${[home, menu, back, reload].map((t) => t.session_id)}`);
  if (new Set([home, menu, back, reload].map((t) => t.pseudonym)).size !== 1) problems.push("a second pseudonym in one visit");
  if (tab.posts.length !== 1 || tab.posts[0]?.body.token !== "tok-ps-1" || tab.posts[0]?.url !== "/l/L1/__hp/session") problems.push(`the session is not opened exactly once: ${JSON.stringify(tab.posts)}`);
  // A refused open (429, network) is retried by the next page load of the same visit, with the same session.
  const busy = browser({ seed: 5 }).tab({ status: 429 });
  await busy.load(cfg("ps-9"), snippet);
  await busy.load(cfg("ps-10"), snippet);
  if (busy.posts.length !== 2 || busy.posts.some((p) => p.body.token !== "tok-ps-9")) problems.push(`a refused open is not retried with the visit's session: ${JSON.stringify(busy.posts)}`);
  // Two tabs are two visits.
  const other = await browser({ seed: 3 }).tab().load(cfg("ps-4"), snippet);
  if (other.session_id === home.session_id) problems.push("two tabs share a session");
  return problems;
}

await test("CR-T60 pseudonym: random, one experiment, shared across sessions only when repeated use is declared, ended with its link; planted defects are caught", async () => {
  assert.deepEqual(pseudonymProblems(PARTICIPANT_SNIPPET), [], "positive: the shipped snippet holds");
  assert.ok(new TextEncoder().encode(PARTICIPANT_SNIPPET).length < 2048, "under 2 KB");
  // Negative controls: each planted variant must be caught.
  const uaDerived = PARTICIPANT_SNIPPET.replace('function r(){var b=new Uint8Array(16),h="";crypto.getRandomValues(b);', 'function r(){var b=new Uint8Array(16),h="",u=navigator.userAgent;for(var j=0;j<16;j++)b[j]=u.charCodeAt(j%u.length);');
  assert.notEqual(uaDerived, PARTICIPANT_SNIPPET, "plant applied");
  assert.ok(pseudonymProblems(uaDerived).some((p) => /device/.test(p)), "a UA-derived pseudonym is caught");
  const alwaysStore = PARTICIPANT_SNIPPET.replace(/if\(C\.repeated_use\)\{var s=/, "if(1){var s=").replace(/if\(C\.repeated_use\)p\(L,/, "p(L,");
  assert.notEqual(alwaysStore, PARTICIPANT_SNIPPET, "plant applied");
  assert.ok(pseudonymProblems(alwaysStore).some((p) => /undeclared/.test(p)), "linking sessions of an undeclared experiment is caught");
  // One browser-wide pseudonym (no per-experiment key, no link binding).
  const globalKey = PARTICIPANT_SNIPPET.replaceAll('"hp:pseudonym:"+C.experiment', '"hp:pseudonym"').replace("s.link===C.link&&", "");
  assert.ok(pseudonymProblems(globalKey).some((p) => /two experiments/.test(p)), "one pseudonym across experiments is caught");
  const noLinkCheck = PARTICIPANT_SNIPPET.replace("s.link===C.link&&", "");
  assert.ok(pseudonymProblems(noLinkCheck).some((p) => /new link/.test(p)), "reusing a pseudonym under a later link is caught");
  // One visit, one session (CR-21): home → menu → home → reload in one tab keeps the first
  // session and pseudonym, and the session is opened on the Service once.
  assert.deepEqual(await oneVisitProblems(PARTICIPANT_SNIPPET), [], "positive: the shipped snippet keeps one session per visit");
  const overwrite = PARTICIPANT_SNIPPET.replace("x=g(S,K);if(!(x&&V.test(x.pseudonym)&&x.session_id))x=null;", "x=null;");
  assert.notEqual(overwrite, PARTICIPANT_SNIPPET, "plant applied");
  assert.ok((await oneVisitProblems(overwrite)).some((p) => /second session/.test(p)), "a snippet that adopts every candidate (the old behaviour) is caught");
  const noRetry = PARTICIPANT_SNIPPET.replace("if(q.ok){x.o=1;p(S,K,x)}", "x.o=1;p(S,K,x)");
  assert.ok((await oneVisitProblems(noRetry)).some((p) => /retried/.test(p)), "a snippet that marks a refused open as done is caught");
  // The Service serves two different session ids to two loads of one link.
  const f = await fixture();
  try {
    const s = await started(f, { declarations: { repeated_use: true } });
    const a = hpTest((await openEntry(f, s.url)).text);
    const b = hpTest((await openEntry(f, s.url)).text);
    assert.notEqual(a.session_id, b.session_id);
    assert.equal(a.repeated_use, true);
  } finally {
    f.close();
  }
});

// ── Test origin configuration ────────────────────────────────────────────────

await test("test origin: unset means no link; production refuses a shared or http origin; one origin per project; API paths never answer on it", async () => {
  assert.deepEqual(parseTestOrigin(undefined, "production"), { ok: false, problem: "not_configured" });
  assert.equal(parseTestOrigin("https://abc.ngrok-free.app", "production").problem, "shared_in_production");
  assert.equal(parseTestOrigin("http://{project}.try.hypeproof-ai.xyz", "production").problem, "http_in_production");
  const prod = parseTestOrigin("https://{project}.try.hypeproof-ai.xyz", "production");
  assert.equal(originFor(prod.config, "prj-0123456789abcdef"), "https://prj-0123456789abcdef.try.hypeproof-ai.xyz");
  assert.equal(matchTestOrigin(prod.config, new URL("https://api.hypeproof-ai.xyz/v1/profile")), null, "the API host is not a test origin");
  const dev = parseTestOrigin("https://abc.ngrok-free.app", "development");
  assert.equal(matchTestOrigin(dev.config, new URL("https://abc.ngrok-free.app/v1/profile")), null, "shared dev origin: only /l/ paths");
  assert.ok(matchTestOrigin(dev.config, new URL("https://abc.ngrok-free.app/l/x/")));
  const f = await fixture({ testOrigin: null });
  try {
    const t = await f.student();
    const p = await f.api("/v1/curriculum/projects", { method: "POST", token: t, body: { title: "t" } });
    const up = await f.upload(p.json.project.id, V0, t);
    const e = await f.api("/v1/curriculum/experiments", { method: "POST", token: t, body: { project_id: p.json.project.id, product_version_id: up.id, week: 1, question: "q", method: "m", success_criteria: ["c"], hypothesis: "h" } });
    const l = await f.api(`/v1/curriculum/experiments/${e.json.experiment.id}/links`, { method: "POST", token: t, body: { expires_at: Date.now() + 60_000 } });
    assert.deepEqual([l.status, l.json.error.code, l.json.error.problem], [503, "test_origin_unavailable", "not_configured"]);
  } finally {
    f.close();
  }
  const g = await fixture();
  try {
    const s = await started(g);
    const onOrigin = await g.open(new URL("/v1/profile", s.url).href, { token: s.token });
    assert.deepEqual([onOrigin.status, onOrigin.bytes.length], [404, 0], "no API route answers on a test origin");
  } finally {
    g.close();
  }
});

// ── CR-T17 App half + CR-81 + CR-11 (published origin), the App's session against the real Service ──

const core = await import("../src/lib/measurement-core/index.ts");
const { PublishSession, publishTiming } = await import("../../extensions/hypeproof-chat/src/publishSession.ts");
const { artifactVersionFor } = await import("../../extensions/hypeproof-chat/src/artifactVersion.ts");
const { crAllowedOrigins } = await import("../../extensions/hypeproof-chat/src/crHostWiring.ts");
const { checkAgentOrigin } = await import("../../extensions/hypeproof-chat/src/experimentBrowser.ts");
const { makeCtx } = await import("./harness/index.mjs");
const { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

/** Verdict events of one all-pass (or failing) verification run on `version`, as VerifySession records them. */
function verificationEvents(version, status = "pass") {
  const CTX = { week: 1, step_id: "test-my-product", task: "task-1", module_version: "unversioned" };
  const b = { format: "hps-observation/2", scope: "synthetic-cr-publish", session: "s1", program: "p1", events: [] };
  let n = 0;
  const push = (e) => { const ev = { id: `e${++n}`, seq: n, task: "task-1", at: 1_000 + n, text: "", assistance: "unknown", ...e }; b.events.push(ev); core.validateObservation(b); return ev; };
  const h = version.slice(7);
  const PLAN = { steps: [{ action: "click", target: { role: "button", name: "주문 시작" } }], expect: [{ kind: "text", text: "버전 0" }] };
  const SNAP = 'heading: 버전 0';
  const verdict = core.evaluate({ step: 1, snapshot: SNAP, route: "/index.html", errors: [], screenshot: null, viewport: { width: 390, height: 800 } }, [{ kind: "text", text: status === "pass" ? "버전 0" : "결제 완료" }], [{ index: 0, action: "navigate", ok: true, message: "이동 완료" }]);
  for (const text of ["첫 화면이 보인다", "주문이 된다", "오류가 없다"]) {
    const c = push({ kind: "criterion_set", actor: "user", context: CTX, evidence_type: "criterion", source_state: "self_reported", student_text: text });
    const last = [...b.events].reverse().find((e) => e.kind === "artifact");
    if (last?.sha256 !== h) push({ kind: "artifact", text: core.versionArtifactText({ id: version, entry: "index.html", files: [] }), sha256: h });
    const tool_id = `verify-run-1-${c.id}`;
    push({ kind: "tool_request", text: "verify_criterion", tool_id, sha256: h });
    const result = push({ kind: "tool_result", tool_id, outcome: "success", sha256: h, artifact_version: version, text: core.verifyResultText({ format: "hps-verify-result/1", run_id: "run-1", criterion_id: c.id, criterion_text: text, artifact_version: version, tested_at: 5_000 + n, plan: PLAN, verdict }) });
    push({ kind: core.testEventKind(b.events, c.id, verdict.status, { retest: false, versionHex: h }), actor: "ai", context: CTX, evidence_type: "action", source_state: "real", criterion_ref: c.id, artifact_after: h, outcome: core.outcomeOf(verdict.status), result_ref: result.id });
  }
  return b.events;
}

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), "cr-publish-ws-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}

function appSession(f, root, { events = [], switchOn = () => true } = {}) {
  const calls = [];
  let project;
  let origin = null;
  const session = new PublishSession({
    switchOn,
    token: async () => f.student(),
    base: () => "https://service.test/v1/curriculum",
    fetchImpl: async (url, init) => {
      calls.push({ method: init?.method ?? "GET", path: new URL(url).pathname, body: init?.body ? JSON.parse(init.body) : undefined });
      return f.app.fetch(new Request(url, init), f.env, makeCtx());
    },
    root: () => root,
    entry: () => "/index.html",
    events: async () => events,
    projectId: () => project,
    setProjectId: async (id) => { project = id; },
    rememberedOrigin: () => origin,
    rememberOrigin: async (o) => { origin = o; },
    week: () => 1,
    defaultTitle: () => "키오스크",
    qr: (u) => `qr:${u}`,
  });
  return { session, calls, project: () => project };
}

const FORM = { hypothesis: "처음 쓰는 사람도 혼자 주문할 수 있다", question: "도움 없이 주문을 마칠 수 있나?", method: "task_test", success_criteria: ["5명 중 3명 완료"], channel: "학교 게시판", expires_in_days: 3 };

await test("CR-T17 App half (synthetic, real Service): the publish action shows verified only for an all-pass report bound to this version; .env, dot-files, unreachable files and an out-of-root symlink are never uploaded; a planted key refuses before any request", async () => {
  const f = await fixture();
  const root = workspace({ ...V0, ".env": "OPENAI_API_KEY=sk-should-never-leave", ".hidden.js": "x", "notes.txt": "not referenced", "data/menu.json": "[]" });
  try {
    const version = await artifactVersionFor(root, "/index.html");
    // CR-81 on the publish panel: no report → not verified; a report bound to another version → not verified.
    const none = appSession(f, root);
    assert.equal((await none.session.view()).verification.state, "not_verified");
    const other = appSession(f, root, { events: verificationEvents("sha256:" + "9".repeat(64)) });
    assert.equal((await other.session.view()).verification.state, "needs_recheck");
    const failing = appSession(f, root, { events: verificationEvents(version.id, "fail") });
    assert.equal((await failing.session.view()).verification.state, "failed");
    // Positive: three passes bound to exactly this version → verified, and the publish carries that report.
    const a = appSession(f, root, { events: verificationEvents(version.id) });
    const v = await a.session.view();
    assert.deepEqual([v.version.id, v.verification.state], [version.id, "verified"], "the set id equals the verified version id (no manifest)");
    assert.deepEqual(v.version.files.map((x) => x.path).sort(), ["app.js", "index.html", "style.css"]);
    a.session.setManifest(["data/menu.json"]);
    const withManifest = await a.session.view();
    assert.deepEqual(withManifest.version.manifest_added, ["data/menu.json"]);
    assert.notEqual(withManifest.version.id, version.id, "a manifest addition is another version, which needs its own verification");
    a.session.setManifest([]);
    const r = await a.session.submit(FORM);
    assert.equal(r.ok, true, JSON.stringify(r));
    const put = a.calls.find((c) => c.method === "PUT");
    assert.deepEqual(put.body.files.map((x) => x.path).sort(), ["app.js", "index.html", "style.css"], "only the R4 set left the machine");
    assert.equal(put.body.verification_report, "run-1");
    assert.ok(!JSON.stringify(a.calls).includes("sk-should-never-leave"));
    // The share link opens; the panel lists it with its QR.
    assert.equal((await openEntry(f, r.share_url)).status, 200);
    const after = await a.session.view();
    assert.equal(after.experiments[0].links[0].qr, `qr:${r.share_url}`);
    assert.equal(after.experiments[0].current_version, true);
    // Manifest: a dot-file or a path outside the root is refused by name, before any upload.
    for (const bad of [".env", "../outside.txt"]) {
      const b2 = appSession(f, root);
      const out = await b2.session.submit({ ...FORM, manifest: [bad] });
      assert.equal(out.ok, false, bad);
      assert.equal(b2.calls.filter((c) => c.method !== "GET").length, 0, `${bad}: nothing sent`);
    }
    // A planted key: refused before any request at all.
    const keyed = workspace({ ...V0, "app.js": `const k = "${"AI" + "za"}${"Sy".padEnd(35, "Q")}";` });
    const k = appSession(f, keyed);
    const kr = await k.session.submit(FORM);
    assert.equal(kr.ok, false);
    assert.match(kr.lines.join(), /app\.js 1번째 줄 \(gemini_key\)/);
    assert.equal(k.calls.length, 0, "the scan refuses before any request");
    // A symlink the entry references that resolves outside the root: refused, nothing uploaded.
    const linked = workspace({ ...V0, "index.html": PAGE("버전 0", '<img src="photo.png">') });
    const outside = mkdtempSync(join(tmpdir(), "cr-publish-outside-"));
    writeFileSync(join(outside, "secret.png"), "outside bytes");
    symlinkSync(join(outside, "secret.png"), join(linked, "photo.png"));
    const l = appSession(f, linked);
    const lr = await l.session.submit(FORM);
    assert.equal(lr.ok, false);
    assert.match(lr.message, /photo\.png/);
    assert.equal(l.calls.filter((c) => c.method !== "GET").length, 0);
    // Switch off: the session refuses without a request.
    const off = appSession(f, root, { switchOn: () => false });
    assert.equal((await off.session.submit(FORM)).ok, false);
    assert.equal((await off.session.view()).available, false);
    assert.equal(off.calls.length, 0);
    rmSync(outside, { recursive: true, force: true });
    for (const d of [keyed, linked]) rmSync(d, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
    f.close();
  }
});

await test("CR-T11 published-origin cases: agent actions and runner steps may act on the project's own test origin; another project's origin is refused with a reason", async () => {
  const f = await fixture();
  const root = workspace(V0);
  try {
    const mine = appSession(f, root);
    assert.equal((await mine.session.submit(FORM)).ok, true);
    await mine.session.view();
    const own = mine.session.publishedOrigins();
    assert.equal(own.length, 1);
    const allowed = crAllowedOrigins("http://127.0.0.1:5173/index.html", own);
    assert.deepEqual(checkAgentOrigin(`${own[0]}/l/AAAAAAAAAAAAAAAAAAAAAA/index.html`, allowed), { ok: true }, "positive: the project's own published origin");
    assert.deepEqual(checkAgentOrigin("http://127.0.0.1:5173/index.html", allowed), { ok: true }, "the live preview stays allowed");
    // Another team's project, with its own published origin.
    const otherRoot = workspace(V1);
    const theirs = appSession({ ...f, student: () => f.student("cr-b") }, otherRoot);
    assert.equal((await theirs.session.submit(FORM)).ok, true);
    await theirs.session.view();
    const foreign = theirs.session.publishedOrigins()[0];
    assert.notEqual(foreign, own[0]);
    const refused = checkAgentOrigin(`${foreign}/l/AAAAAAAAAAAAAAAAAAAAAA/index.html`, allowed);
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /범위 밖이라 거절/);
    assert.equal(checkAgentOrigin("https://example.com/", allowed).ok, false, "an external origin is refused");
    // Control: a list that let any test origin through would allow the foreign one.
    assert.equal(checkAgentOrigin(`${foreign}/x`, [...allowed, foreign]).ok, true);
    assert.deepEqual(crAllowedOrigins(null, ["javascript:alert(1)", "http://x.test.invalid/path"]), [], "non-origins are dropped");
    // A browser result on a published page names the version its link pins (CR-10 on a published origin).
    const st = (await mine.session.view()).experiments[0];
    const ver = mine.session.publishedArtifactVersion(st.links[0].share_url + "index.html");
    assert.equal(ver.id, st.product_version_id);
    assert.equal(mine.session.publishedArtifactVersion(`${foreign}/l/AAAAAAAAAAAAAAAAAAAAAA/index.html`), null);
    rmSync(otherRoot, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
    f.close();
  }
});

// ── CR-18/CR-20 at classroom scale: the open path is constant cost ───────────

/** R2 calls made by `fn`, counted on the fixture's bucket. */
async function r2Calls(f, fn) {
  const n = { get: 0, put: 0, list: 0, delete: 0 };
  const orig = {};
  for (const k of Object.keys(n)) {
    orig[k] = f.r2[k];
    f.r2[k] = (...a) => { n[k]++; return orig[k].apply(f.r2, a); };
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(n)) f.r2[k] = orig[k];
  }
  return n;
}

await test("CR-18/CR-20 scale: one visit costs the same R2 calls at the 1st and the 500th session, and the task document never grows; the old append-and-scan path would not", async () => {
  const f = await fixture();
  try {
    const s = await started(f, { channel: "학교 게시판" });
    const taskKey = [...f.r2.map.keys()].find((k) => k.endsWith(`tasks/${s.experiment.id}`));
    assert.ok(taskKey, "the experiment's record task exists");
    const taskBytes = () => f.r2.map.get(taskKey).byteLength;
    const before = taskBytes();
    const first = await r2Calls(f, () => openVisit(f, s.url));
    for (let i = 0; i < 498; i++) await openVisit(f, s.url);
    const last = await r2Calls(f, () => openVisit(f, s.url));
    assert.deepEqual(last, first, `R2 calls per visit: first ${JSON.stringify(first)}, 500th ${JSON.stringify(last)}`);
    assert.ok(first.get + first.put + first.list <= 8, `a small constant: ${JSON.stringify(first)}`);
    assert.equal(first.list, 0, "no listing on the open path");
    assert.equal(taskBytes(), before, "the task document is not rewritten per open");
    const channels = await r2Calls(f, () => f.api(`/v1/curriculum/experiments/${s.experiment.id}/channels`, { token: s.token }));
    assert.deepEqual(channels, { get: 0, put: 0, list: 0, delete: 0 }, "the per-channel counts read no session");
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/channels`, { token: s.token })).json.sessions_opened.channels["학교 게시판"], 500);
    // Negative control: the pre-fix path (linkSession: quota scan plus task append) grows with N.
    const record = participantRecord(f.r2, f.cohort, s.project.id);
    const old = await r2Calls(f, () => record.linkSession(s.experiment.id, { host: PUBLISHED_HOST, session_id: "ps-old-path", by: "adapter_explicit", at: Date.now(), attribution: { project: s.project.id, experiment: s.experiment.id, product_version: s.version } }));
    assert.ok(old.get > 500 && old.list > 0, `the planted old path must be caught: ${JSON.stringify(old)}`);
    // The per-link bound: a full link opens no more sessions and answers 429; its pages still serve.
    if (f.db) f.db.prepare("UPDATE cr_test_links SET sessions_opened = ? WHERE id = ?").run(PUBLISH_LIMITS.maxSessionsPerLink, s.link.id);
    else await f.env.HPS_DB.prepare("UPDATE cr_test_links SET sessions_opened = ? WHERE id = ?").bind(PUBLISH_LIMITS.maxSessionsPerLink, s.link.id).run();
    const full = await openVisit(f, s.url);
    assert.deepEqual([full.status, full.opened.status], [200, 429]);
  } finally {
    f.close();
  }
});

// ── Ownership guards on the student routes (R5) ──────────────────────────────

await test("guards: a revoked student token or one whose student is off the roster publishes, links and revokes nothing; a director scoped to another profile cannot set the team; the test origin is matched on its port", async () => {
  const f = await fixture();
  try {
    const s = await started(f);
    const writes = async (token) => [
      (await f.upload(s.project.id, V1, token)).status,
      (await f.api(`/v1/curriculum/experiments/${s.experiment.id}/links`, { method: "POST", token, body: { expires_at: Date.now() + 3600_000 } })).status,
      (await f.api(`/v1/curriculum/links/${s.link.id}/revoke`, { method: "POST", token, body: {} })).status,
      (await f.api("/v1/curriculum/projects", { method: "POST", token, body: { title: "x" } })).status,
    ];
    const state = async () => JSON.stringify([(await f.api(`/v1/curriculum/projects/${s.project.id}`, { token: s.token })).json, f.r2.map.size]);
    // Positive control: a fresh token of the same member is accepted.
    assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}`, { token: await f.student() })).status, 200);
    const before = await state();
    const { revokeToken } = await import("../src/lib/kv.ts");
    const revoked = await f.student();
    await revokeToken(f.env.HPS_KV, JSON.parse(Buffer.from(revoked.split(".")[0], "base64url")).jti, { reason: "synthetic" }, 3600);
    assert.deepEqual(await writes(revoked), [401, 401, 401, 401], "revoked token");
    const { setRoster } = await import("../src/lib/kv.ts");
    await setRoster(f.env.HPS_KV, f.cohort, ["cr-b", "cr-c"]);
    assert.deepEqual(await writes(await f.student()), [403, 403, 403, 403], "student no longer on the roster");
    await setRoster(f.env.HPS_KV, f.cohort, ["cr-a", "cr-b", "cr-c"]);
    assert.equal(await state(), before, "nothing was written");
    // The director's scope must name the Project's profile, not only its cohort.
    const offProfile = await f.issuer(f.cohort, f.other.id);
    assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}/members`, { method: "PUT", token: offProfile, body: { members: ["cr-a", "cr-b"] } })).status, 404);
    assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}/members`, { method: "PUT", token: await f.issuer(), body: { members: ["cr-a", "cr-b"] } })).status, 200, "control: the scoped director can");
    // The test origin is its host AND its port: another port of the same host is not it.
    const cfg = parseTestOrigin(TEST_ORIGIN, "development").config;
    const label = new URL(s.url).hostname;
    assert.ok(matchTestOrigin(cfg, new URL(`http://${label}:8799/l/x/`)), "control: the configured port matches");
    assert.equal(matchTestOrigin(cfg, new URL(`http://${label}:8800/l/x/`)), null);
    assert.equal(matchTestOrigin(cfg, new URL(`http://${label}/l/x/`)), null);
    const otherPort = await f.open(s.url.replace(":8799", ":8800"));
    assert.notEqual(otherPort.status, 302, "a request on another port is not served as the test origin");
  } finally {
    f.close();
  }
});

// ── The publish scan on ordinary student code ────────────────────────────────

await test("CR-T17 scan precision: a login-form mockup, a random-id helper and an env read publish; a literal value under the same names is still refused; a forged token's refusal names its real line", async () => {
  const ctx = { projectId: "prj-0000000000000000", testOrigin: "http://prj-0000000000000000.test.invalid" };
  for (const ordinary of [
    "const password = document.querySelector('#pw').value;",
    "let token = Math.random().toString(36).slice(2);",
    "const API_KEY = process.env.API_KEY;",
    "const secret = getSecretFromForm();",
    "user.password = form.password.value;",
  ]) assert.deepEqual(scanFile("app.js", ordinary, ctx), [], ordinary);
  for (const literal of ['const password = "hunter2hunter2";', "API_KEY=abcdefghijkl", "let token = 'abcdefgh12345678';", "SECRET: `a1b2c3d4e5f6`"]) {
    assert.ok(scanFile("app.js", literal, ctx).some((h) => h.rule === "secret_assignment"), `a literal must still be refused: ${literal}`);
  }
  const f = await fixture();
  try {
    const s = await started(f);
    const origin = originFor(parseTestOrigin(TEST_ORIGIN, "development").config, s.project.id);
    const forged = `${b64u({ u: "a", c: "x", p: "y", role: "app", project: s.project.id, origin })}.${"s".repeat(43)}`;
    const r = await f.upload(s.project.id, { ...V0, "app.js": `// 1\n// 2\nconst t="${forged}";` }, s.token);
    assert.deepEqual([r.status, r.json.error.hits[0].detail, r.json.error.hits[0].line], [422, "signature", 3], r.text);
    assert.match(scanRefusalText({ file: "app.js", line: 3, rule: "hypeproof_token", detail: "student" }), /참여 코드/);
    assert.match(scanRefusalText({ file: "app.js", line: 3, rule: "hypeproof_token", detail: "issuer" }), /강사용 코드/);
  } finally {
    f.close();
  }
});

// ── The App never forks or orphans the student's Project ─────────────────────

await test("App project: a transient failure aborts instead of creating a second Project; a switch-off answer keeps the remembered id; a teammate adopts the team's Project; a declared device reaches the served policy", async () => {
  const f = await fixture();
  const root = workspace(V0);
  try {
    const a = appSession(f, root);
    assert.equal((await a.session.submit(FORM)).ok, true);
    const first = a.project();
    const projectsOf = async (u) => (await f.api("/v1/curriculum/projects", { token: await f.student(u) })).json.projects.map((p) => p.id);
    // One transient 503 on the project read: the publish stops with a message, no second Project.
    const flaky = appSession(f, root);
    await flaky.session.submit(FORM);
    const remembered = flaky.project();
    let fail = true;
    const inner = flaky.session.ports.fetchImpl;
    flaky.session.ports.fetchImpl = async (url, init) => {
      if (fail && (init?.method ?? "GET") === "GET" && new URL(url).pathname.endsWith(`/projects/${remembered}`)) {
        fail = false;
        return new Response(JSON.stringify({ error: { type: "upstream", code: "unavailable" } }), { status: 503 });
      }
      return inner(url, init);
    };
    const r = await flaky.session.submit(FORM);
    assert.equal(r.ok, false);
    assert.match(r.message, /503/);
    assert.equal(flaky.project(), remembered, "the remembered Project is kept");
    assert.deepEqual((await projectsOf("cr-a")).filter((id) => id !== first && id !== remembered), [], "no new Project was created");
    // Control: with the network back the same publish goes into the same Project.
    assert.equal((await flaky.session.submit(FORM)).ok, true);
    assert.equal(flaky.project(), remembered);
    // The switch off for a lesson: every route answers 404; the id stays, and comes back with the switch.
    f.setSwitch(false);
    await flaky.session.view();
    assert.equal(flaky.project(), remembered, "a switch-off 404 does not erase the remembered Project");
    f.setSwitch(true);
    const back = await flaky.session.view();
    assert.equal(back.project.id, remembered);
    // A teammate the director adds finds the team Project instead of making a solo one.
    await f.api(`/v1/curriculum/projects/${first}/members`, { method: "PUT", token: await f.issuer(), body: { members: ["cr-a", "cr-c"] } });
    const mate = appSession({ ...f, student: () => f.student("cr-c") }, root);
    assert.equal((await mate.session.view()).project.id, first, "the team Project is adopted");
    assert.equal((await mate.session.submit(FORM)).ok, true);
    assert.deepEqual(await projectsOf("cr-c"), [first], "no solo Project for the teammate");
    // A remembered Project the student was removed from, with no other: forgotten, a new one is made on publish.
    await f.api(`/v1/curriculum/projects/${first}/members`, { method: "PUT", token: await f.issuer(), body: { members: ["cr-a"] } });
    assert.equal((await mate.session.view()).project, null);
    assert.equal(mate.project(), undefined);
    // Declared devices from the panel reach the served Permissions-Policy (CR-66 declared path).
    const cam = appSession(f, root);
    const cr = await cam.session.submit({ ...FORM, devices: ["camera"], repeated_use: true });
    assert.equal(cr.ok, true, JSON.stringify(cr));
    const page = await openEntry(f, cr.share_url);
    assert.match(page.headers.get("permissions-policy"), /camera=\(self\), microphone=\(\)/);
    assert.equal(hpTest(page.text).repeated_use, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    f.close();
  }
});

await test("CR-64 timing instrument: a publish under 10 s is a pass; a planted slow upload is a recorded miss with its cause", () => {
  assert.deepEqual(publishTiming(0, 3_200, { scan: 100, upload: 2_000, link: 300 }), { ms: 3_200, ok: true, cause: null });
  assert.deepEqual(publishTiming(0, 12_500, { scan: 100, upload: 11_900, link: 300 }), { ms: 12_500, ok: false, cause: "upload 11900ms" });
  assert.equal(publishTiming(0, 10_000, {}).ok, false, "exactly 10 s is not under 10 s");
});

if (mf) await mf.dispose();
if (failed) {
  console.error(`\n${failed} cr-publish check(s) failed`);
  process.exit(1);
}
console.log(`\ncr-publish (worker ${D1_MODE ? "local workerd D1" : "SQLite"}): OK`);
