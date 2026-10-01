// Publish for User Test, App half at the smoke layer (cr-publish #1393). No Service: the
// Service half and the App session against the real Service router are in
// worker/test/cr-publish.test.mjs.
//
//   CR-T17 (set)       the published set is R4's: the entry, what it reaches and the
//                      confirmed manifest; never a .env, a dot-file, node_modules, an
//                      unreachable file or a symlink out of the root; a planted key refuses
//                      the set and names the file and line; same bytes, same id
//   CR-T11 (published) runner steps on the project's published test origin run; a step to
//                      another project's origin is refused with a reason before any CDP call
//   CR-T02 (session)   with the switch off the session sends nothing
//   CR-T11 (restart)   a fresh App with a remembered Project allows its published origin
//                      before the publish panel is opened; a changed token drops it
//
// Run: node --experimental-strip-types test/cr-publish.smoke.mjs

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFakePage, fakePort } from "./fixtures/fake-cdp-page.mjs";

const { buildPublishSet, publishSetRefusalText } = await import("../src/publishSet.ts");
const { artifactVersionFor } = await import("../src/artifactVersion.ts");
const { PublishSession } = await import("../src/publishSession.ts");
const { crAllowedOrigins, CrProjectMemory, crBytesOwner } = await import("../src/crHostWiring.ts");
const { CrExecutor } = await import("../src/experimentBrowser.ts");
const { runCriterionPlan } = await import("../src/verifyRunner.ts");
const { curriculumBase } = await import("../src/galleryPublish.ts");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

const PAGE = (extra = "") => `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>키오스크</h1>${extra}<script src="app.js"></script></body></html>`;
function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), "cr-publish-smoke-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}
const SCAN = { projectId: "prj-0000000000000000", testOrigin: "http://prj-0000000000000000.test.invalid" };
const BASE = { "index.html": PAGE(), "style.css": "h1{}", "app.js": "console.log('ok')" };

await test("CR-T17 set positive: the entry and what it reaches, same bytes same id, equal to the verified version id", async () => {
  const root = workspace({ ...BASE, ".env": "SECRET=1", ".npmrc": "//r/:_authToken=x", "notes.txt": "unreferenced", "node_modules/x/index.js": "x", "data/menu.json": "[]" });
  try {
    const a = await buildPublishSet(root, "/index.html", [], SCAN);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.deepEqual(a.set.files.map((f) => f.path), ["app.js", "index.html", "style.css"], "no .env, .npmrc, node_modules or unreachable file");
    const b = await buildPublishSet(root, "/index.html", [], SCAN);
    assert.equal(b.set.id, a.set.id, "same bytes, same id");
    assert.equal(a.set.id, (await artifactVersionFor(root, "/index.html")).id, "the published version is the version a verification names");
    const m = await buildPublishSet(root, "/index.html", ["data/menu.json"], SCAN);
    assert.deepEqual([m.ok, m.set.manifest_added], [true, ["data/menu.json"]]);
    assert.ok(m.set.files.some((f) => f.path === "data/menu.json"));
    writeFileSync(join(root, "app.js"), "console.log('changed')");
    assert.notEqual((await buildPublishSet(root, "/index.html", [], SCAN)).set.id, a.set.id, "changed bytes, another version");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("CR-T17 set negative: a referenced dot-file is not in the set; a manifest .env, ../ path or node_modules is refused; an out-of-root symlink refuses the set", async () => {
  const root = workspace({ ...BASE, "index.html": PAGE('<script src=".config.js"></script>'), ".config.js": "x", ".env": "A=1" });
  const outside = mkdtempSync(join(tmpdir(), "cr-publish-outside-"));
  try {
    const ok = await buildPublishSet(root, "/index.html", [], SCAN);
    assert.ok(!ok.set.files.some((f) => f.path.startsWith(".")), "a referenced dot-file is never in the set");
    for (const [bad, code] of [[".env", "excluded_path"], ["sub/.secret", "excluded_path"], ["node_modules/a.js", "excluded_path"], ["../x", "invalid_path"]]) {
      const r = await buildPublishSet(root, "/index.html", [bad], SCAN);
      assert.deepEqual([r.ok, r.refusal.code], [false, code], bad);
    }
    writeFileSync(join(outside, "photo.png"), "outside");
    symlinkSync(join(outside, "photo.png"), join(root, "photo.png"));
    writeFileSync(join(root, "index.html"), PAGE('<img src="photo.png">'));
    const s = await buildPublishSet(root, "/index.html", [], SCAN);
    assert.deepEqual([s.ok, s.refusal.code, s.refusal.file], [false, "symlink", "photo.png"]);
    assert.match(publishSetRefusalText(s.refusal), /photo\.png/);
    // In the manifest too.
    writeFileSync(join(root, "index.html"), PAGE());
    const viaManifest = await buildPublishSet(root, "/index.html", ["photo.png"], SCAN);
    assert.deepEqual([viaManifest.ok, viaManifest.refusal.code], [false, "symlink"]);
    // Control: once the link is a real file inside the root, the same set publishes.
    rmSync(join(root, "photo.png"));
    writeFileSync(join(root, "photo.png"), "inside");
    assert.equal((await buildPublishSet(root, "/index.html", ["photo.png"], SCAN)).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

await test("CR-T17 scan: a planted key refuses the set with file and line; a Supabase anon key does not", async () => {
  const anon = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(JSON.stringify({ iss: "supabase", role: "anon" })).toString("base64url")}.${"s".repeat(43)}`;
  const ok = workspace({ ...BASE, "app.js": `const supabaseKey = "${anon}";` });
  const bad = workspace({ ...BASE, "app.js": `// 결제\nconst key = "${"sk-" + "proj-"}${"z".repeat(30)}";` });
  try {
    assert.equal((await buildPublishSet(ok, "/index.html", [], SCAN)).ok, true, "positive: an anon key publishes");
    const r = await buildPublishSet(bad, "/index.html", [], SCAN);
    assert.deepEqual([r.ok, r.refusal.code, r.refusal.file, r.refusal.hits[0].line, r.refusal.hits[0].rule], [false, "secret_found", "app.js", 2, "openai_key"]);
  } finally {
    rmSync(ok, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});

await test("CR-T11 published origin (runner): steps on the project's own test origin run; another project's origin is refused before any CDP call", async () => {
  const PUB = "http://prj-aaaaaaaaaaaaaaaa.test.invalid";
  const FOREIGN = "http://prj-bbbbbbbbbbbbbbbb.test.invalid";
  const allowed = crAllowedOrigins("http://127.0.0.1:5173/", [PUB]);
  const page = makeFakePage({ origin: PUB, route: "/l/AAAAAAAAAAAAAAAAAAAAAA/index.html", elements: [{ key: "begin", role: "button", name: "주문 시작", tag: "button", id: "begin" }], onClick: (p, key) => { if (key === "begin") p.state.elements = [{ key: "m", role: "combobox", name: "음료 고르기", tag: "select", options: [] }]; } });
  const ex = new CrExecutor(fakePort(page), { allowedOrigins: () => allowed, artifactVersion: async () => ({ id: `sha256:${"c".repeat(64)}`, entry: "index.html", files: [] }), settleMs: 0, sleep: async () => {} });
  const plan = { steps: [{ action: "click", target: { role: "button", name: "주문 시작" } }], expect: [{ kind: "element", role: "combobox", name: "음료 고르기" }] };
  const out = await runCriterionPlan(ex, plan, { startUrl: `${PUB}/l/AAAAAAAAAAAAAAAAAAAAAA/index.html`, allowedOrigins: () => allowed });
  assert.equal(out.verdict.status, "pass", JSON.stringify(out.verdict));
  const before = page.calls.length;
  const off = await runCriterionPlan(ex, plan, { startUrl: `${FOREIGN}/l/AAAAAAAAAAAAAAAAAAAAAA/index.html`, allowedOrigins: () => allowed });
  assert.equal(off.verdict.status, "not_verified");
  assert.match(off.verdict.reason, /범위 밖이라 거절/);
  assert.equal(page.calls.length, before, "nothing was sent toward another project's origin");
  const step = await runCriterionPlan(ex, { steps: [{ action: "navigate", path: `${FOREIGN}/l/x/index.html` }], expect: [{ kind: "text", text: "x" }] }, { startUrl: `${PUB}/l/AAAAAAAAAAAAAAAAAAAAAA/index.html`, allowedOrigins: () => allowed });
  assert.equal(step.verdict.status, "not_verified");
  assert.ok(!page.calls.some((c) => c.method === "Page.navigate" && c.params.url.startsWith(FOREIGN)));
});

await test("CR-T02 session: with the switch off nothing is built or sent; curriculumBase follows the proxy URL", async () => {
  const calls = [];
  const s = new PublishSession({
    switchOn: () => false,
    token: async () => "t",
    base: () => "https://api.test/v1/curriculum",
    fetchImpl: async (...a) => { calls.push(a); throw new Error("no request with the switch off"); },
    root: () => { throw new Error("no file read with the switch off"); },
    entry: () => "/index.html",
    events: async () => [],
    projectId: () => "prj-0000000000000000",
    setProjectId: async () => {},
    week: () => 1,
    defaultTitle: () => "t",
    qr: (u) => u,
  });
  assert.equal((await s.view()).available, false);
  assert.equal((await s.submit({ question: "q", method: "m", success_criteria: ["c"], hypothesis: "h", expires_in_days: 1 })).ok, false);
  assert.equal((await s.link("exp-x", { expires_in_days: 1 })).ok, false);
  assert.equal((await s.revoke("AAAAAAAAAAAAAAAAAAAAAA")).ok, false);
  assert.deepEqual(s.publishedOrigins(), []);
  assert.equal(calls.length, 0);
  assert.equal(curriculumBase("https://api.hypeproof-ai.xyz/v1"), "https://api.hypeproof-ai.xyz/v1/curriculum");
  assert.equal(curriculumBase("http://localhost:8787/v1/"), "http://localhost:8787/v1/curriculum");
  // No expiry chosen: refused before anything else (CR-19).
  const on = new PublishSession({ switchOn: () => true, token: async () => { throw new Error("not reached"); }, base: () => "", root: () => null, entry: () => null, events: async () => [], projectId: () => undefined, setProjectId: async () => {}, week: () => null, defaultTitle: () => "t", qr: (u) => u });
  assert.deepEqual(await on.submit({ question: "q", method: "m", success_criteria: ["c"], hypothesis: "h" }), { ok: false, message: "링크를 언제까지 열어 둘지 골라 주세요." });
});

await test("CR-T11 after a restart: a fresh App with a remembered Project allows its published origin before the panel opens; a changed token drops it", async () => {
  const tok = (u) => `${Buffer.from(JSON.stringify({ u, c: "cohort-a", p: "prof", iat: 1, exp: 9e9 })).toString("base64url")}.sig`;
  const PUB = "http://prj-aaaaaaaaaaaaaaaa.test.invalid";
  let stored = tok("cr-a");
  // What workspaceState holds from an earlier run of the App.
  let state = { [crBytesOwner(tok("cr-a"))]: { id: "prj-aaaaaaaaaaaaaaaa", origin: PUB } };
  const memory = new CrProjectMemory({ get: () => state, update: (v) => { state = v; } }, async () => stored);
  const session = new PublishSession({
    switchOn: () => true,
    token: () => memory.refresh(),
    base: () => "https://api.test/v1/curriculum",
    fetchImpl: async () => { throw new Error("no request: the origin comes from what was remembered"); },
    root: () => null,
    entry: () => null,
    events: async () => [],
    projectId: () => memory.projectId(),
    setProjectId: (id) => memory.set(id ? { id } : { id: undefined, origin: null }),
    rememberedOrigin: () => memory.origin(),
    rememberOrigin: (o) => memory.set({ origin: o }),
    week: () => 1,
    defaultTitle: () => "t",
    qr: (u) => u,
  });
  // Negative control: before the host reads the stored token (the old wiring), nothing is allowed.
  assert.deepEqual(session.publishedOrigins(), []);
  await memory.refresh(); // what the provider does at activation
  assert.deepEqual(session.publishedOrigins(), [PUB], "positive: allowed without opening the publish panel");
  assert.deepEqual(crAllowedOrigins(null, session.publishedOrigins()), [PUB]);
  stored = tok("cr-b"); // another student signs in on the same Mac
  await memory.refresh(); // the provider follows secrets.onDidChange
  assert.deepEqual(session.publishedOrigins(), [], "the previous person's origin is dropped");
  stored = null;
  await memory.refresh();
  assert.deepEqual(session.publishedOrigins(), [], "signed out: nothing");
});

console.log(`\n${passed} cr-publish smoke checks passed`);
