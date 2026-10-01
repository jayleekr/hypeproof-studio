// cr-publish (#1393) — the published test runtime in REAL Chromium with phone emulation.
//
// Evidence class: synthetic. Real Chromium (Playwright's build, 390 × 844, touch, mobile UA)
// over real HTTP to the real Service router (worker/src/index.ts, local SQLite + in-memory R2
// through worker/test/harness/curriculum.mjs), with `*.test.invalid` mapped to this machine.
// Not a phone and not the Studio app: CR-T20's real-phone timing is a separate, manual record.
//
//   CR-T18  the QR drawn by the App (testQr.ts) decodes, from its rendered pixels, to the
//           share URL; that URL opens at 390 px with no login. Negative: a link variant that
//           redirects to a login page fails the same check.
//   CR-T61  an undeclared experiment's page calling getUserMedia is denied, even after the
//           automation grants the permission to the context; a declared one leaves the
//           browser's own prompt. Negative: a planted CR automation call that grants a
//           device permission is caught by the source check.
//   CR-T60  in one browser: a declared experiment keeps one pseudonym across two sessions
//           with two session ids; another experiment and an undeclared one do not share it.
//   CR-T19  after revocation the same tab gets 410 and no content. A page that registers a
//           cache-first service worker (an offline PWA) cannot install it, so a reload and a
//           new tab after revocation get 410 and no product. Negative: the old behaviour
//           (the test origin ignores `Service-Worker: script` and sends no Clear-Site-Data),
//           planted on one origin, lets the worker keep serving the product and is caught.
//   CR-T19  (sibling links) the 410 of one revoked link clears only the origin's HTTP cache:
//           a live link of the same project keeps its open visit session and its repeated-use
//           pseudonym. Negative: a 410 that also clears "storage", planted on another
//           project's origin, wipes both and is caught.
//   CR-T21  one visit (home → menu → home by a link → reload, one tab) is one session with
//           one pseudonym, counted once. Negative: the pre-fix snippet, which adopts every
//           entry load's candidate, is planted on another link and counts several.
//   CR-T22  a v0 link keeps showing v0 after v1 is published.
//   CR-T20  (synthetic half) publish → first render on the emulated phone, timed; the
//           real-phone run is NOT RUN here.
//
// Run (from e2e/): node --experimental-strip-types --experimental-sqlite curriculum-runtime/publish-runtime.real.mjs [--out result.json]
// Exit: 0 every check and control held · 1 a check or a control failed · 2 could not run.

import "../../worker/test/harness/loader.mjs";
import { chromium, devices } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "../../extensions/hypeproof-chat");
const { localCurriculum } = await import("../../worker/test/harness/curriculum.mjs");
const { PARTICIPANT_SNIPPET } = await import("../../worker/src/lib/curriculum/participant-snippet.ts");
// The pre-fix snippet's behaviour: every entry load adopts the server's candidate session.
const OLD_SNIPPET = PARTICIPANT_SNIPPET.replace("x=g(S,K);if(!(x&&V.test(x.pseudonym)&&x.session_id))x=null;", "x=null;");
if (OLD_SNIPPET === PARTICIPANT_SNIPPET) throw new Error("the old-snippet plant did not apply");
const { qrModules, qrDataUrl } = await import(join(ext, "src/testQr.ts"));
const jsQR = createRequire(join(ext, "package.json"))("jsqr");
const outArg = process.argv.indexOf("--out");
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;

const results = [];
const record = (id, verdict, detail) => {
  results.push({ id, verdict, detail });
  console.log(`${verdict === "PASS" ? "✅" : verdict === "NOT RUN" ? "⏸" : "❌"} ${id}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};

// ── the local Service on a real port ─────────────────────────────────────────
let f = null;
/** Hosts on which the pre-fix behaviour is planted (negative controls). */
const plantedOldSw = new Set();
const plantedOldSnippet = new Set();
/** Hosts whose 410 also clears storage (the round-1 behaviour; negative control). */
const plantedWipe = new Set();
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const host = (req.headers.host ?? "").split(":")[0];
  // Planted: the test origin as it was before the fix, blind to the service-worker script fetch.
  const headers = Object.entries(req.headers).filter(([k, v]) => typeof v === "string" && !(plantedOldSw.has(host) && k === "service-worker"));
  const r = await f.app.fetch(
    new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined }),
    f.env,
    { waitUntil() {}, passThroughOnException() {} },
  );
  const out = Object.fromEntries(r.headers);
  if (plantedOldSw.has(host)) delete out["clear-site-data"];
  if (plantedWipe.has(host) && r.status === 410) out["clear-site-data"] = '"cache", "storage"';
  let body = Buffer.from(await r.arrayBuffer());
  if (plantedOldSnippet.has(host) && /text\/html/.test(out["content-type"] ?? "")) body = Buffer.from(body.toString("utf8").replace(PARTICIPANT_SNIPPET, OLD_SNIPPET));
  res.writeHead(r.status, out);
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
f = await localCurriculum({ testOrigin: `http://{project}.test.invalid:${PORT}` });

// A login wall the negative control serves (a link variant that sends the participant to log in).
const loginWall = createServer((req, res) => {
  if (req.url.startsWith("/login")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<!doctype html><title>로그인</title><form><input name="id"><input type="password" name="pw"><button>로그인</button></form>');
    return;
  }
  res.writeHead(302, { location: "/login?next=" + encodeURIComponent(req.url) });
  res.end();
});
await new Promise((r) => loginWall.listen(0, "127.0.0.1", r));

const KIOSK = readFileSync(join(here, "fixtures/kiosk-practice/index.html"), "utf8");
const fixtureFiles = Object.fromEntries(readdirSync(join(here, "fixtures/kiosk-practice")).filter((n) => !n.startsWith(".")).map((n) => [n, readFileSync(join(here, "fixtures/kiosk-practice", n))]));
const V1 = { ...fixtureFiles, "index.html": KIOSK.replace("</body>", "<p>버전 1</p></body>") };

async function publish(token, files, declarations, project) {
  const t0 = performance.now();
  const p = project ?? (await f.api("/v1/curriculum/projects", { method: "POST", token, body: { title: "키오스크" } })).json.project;
  const up = await f.upload(p.id, files, token);
  if (up.status !== 201 && up.status !== 200) throw new Error("upload " + up.text);
  const e = await f.api("/v1/curriculum/experiments", { method: "POST", token, body: { project_id: p.id, product_version_id: up.id, week: 1, question: "도움 없이 주문할 수 있나?", method: "task_test", success_criteria: ["5명 중 3명 완료"], hypothesis: "처음 쓰는 사람도 혼자 주문할 수 있다", ...(declarations ? { declarations } : {}) } });
  const l = await f.api(`/v1/curriculum/experiments/${e.json.experiment.id}/links`, { method: "POST", token, body: { expires_at: Date.now() + 3600_000, channel: "학교 게시판" } });
  return { project: p, version: up.id, experiment: e.json.experiment, link: l.json.link, url: l.json.share_url, publishMs: performance.now() - t0 };
}

/** The CR-T18 verdict on one opened page: 390 px, the product, no login. */
async function noLoginAt390(page, url, expectOrigin) {
  const res = await page.goto(url, { waitUntil: "load" });
  const final = new URL(page.url());
  const facts = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    password: !!document.querySelector('input[type="password"]'),
    login: /로그인|log ?in|sign ?in/i.test(document.title + " " + (document.body?.innerText ?? "")),
    heading: document.querySelector("h1, h2")?.textContent?.trim() ?? "",
  }));
  const problems = [];
  if (res?.status() !== 200) problems.push(`status ${res?.status()}`);
  if (final.origin !== expectOrigin) problems.push(`left the test origin for ${final.origin}${final.pathname}`);
  if (facts.width !== 390) problems.push(`viewport ${facts.width}`);
  if (facts.scrollWidth > 390) problems.push(`horizontal overflow ${facts.scrollWidth}`);
  if (facts.password || facts.login) problems.push("a login screen");
  if (!facts.heading) problems.push("no product heading");
  return { problems, facts };
}

// Every project is published before the browser starts: getUserMedia needs a secure context,
// so the test origins (plain http on this machine) are named to Chromium as secure ones, the
// way an https origin in production is. Origins differ per project, so they must be known first.
const token = await f.student();
const s = await publish(token, fixtureFiles);
const origin = new URL(s.url).origin;
const deviceDeclared = await publish(token, fixtureFiles, { devices: ["camera"] });
const repeated = await publish(token, fixtureFiles, { repeated_use: true });
const repeatedOther = await publish(token, fixtureFiles, { repeated_use: true });
const plain = await publish(token, fixtureFiles);
// An offline PWA: app.js registers sw.js, a cache-first worker that caches every response.
const PWA = {
  "index.html": '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>PWA</title></head><body><h1>PRODUCT-CONTENT</h1><p id="sw">-</p><script src="app.js"></script></body></html>',
  "app.js": 'navigator.serviceWorker.register("sw.js").then(function(){document.getElementById("sw").textContent="sw-registered"},function(e){document.getElementById("sw").textContent="sw-refused:"+e.name});',
  "sw.js": 'self.addEventListener("install",function(e){self.skipWaiting()});self.addEventListener("activate",function(e){e.waitUntil(self.clients.claim())});self.addEventListener("fetch",function(e){e.respondWith(caches.open("v1").then(function(c){return c.match(e.request).then(function(hit){return hit||fetch(e.request).then(function(r){if(r.ok)c.put(e.request,r.clone());return r})})}))});',
};
const pwa = await publish(token, PWA);
const pwaPlanted = await publish(token, PWA);
plantedOldSw.add(new URL(pwaPlanted.url).hostname);
// Two pages that link to each other, for the one-visit check.
const TWO_PAGES = {
  "index.html": '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>홈</title></head><body><h1>홈</h1><a id="go" href="menu.html">메뉴</a></body></html>',
  "menu.html": '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>메뉴</title></head><body><h1>메뉴</h1><a id="home" href="index.html">처음으로</a></body></html>',
};
const visit = await publish(token, TWO_PAGES);
const visitPlanted = await publish(token, TWO_PAGES);
plantedOldSnippet.add(new URL(visitPlanted.url).hostname);
// One project, two experiments: the Week-2 test (repeated use, live) and the Week-1 one whose
// link will end. Twice: the second project's 410 is planted to clear storage as well.
const sibLive = await publish(token, TWO_PAGES, { repeated_use: true });
const sibOld = await publish(token, TWO_PAGES, undefined, sibLive.project);
const sibLivePlanted = await publish(token, TWO_PAGES, { repeated_use: true });
const sibOldPlanted = await publish(token, TWO_PAGES, undefined, sibLivePlanted.project);
plantedWipe.add(new URL(sibLivePlanted.url).hostname);
if (new URL(sibOld.url).origin !== new URL(sibLive.url).origin || sibOld.experiment.id === sibLive.experiment.id) throw new Error("sibling links must be two experiments on one origin");
const secureOrigins = [s, deviceDeclared, repeated, repeatedOther, plain, pwa, pwaPlanted, visit, visitPlanted, sibLive, sibLivePlanted].map((x) => new URL(x.url).origin).join(",");

let browser;
try {
  browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--host-resolver-rules=MAP *.test.invalid 127.0.0.1", `--unsafely-treat-insecure-origin-as-secure=${secureOrigins}`] });
} catch (err) {
  console.error(`could not launch Chromium: ${err.message}`);
  server.close();
  loginWall.close();
  process.exit(2);
}
const phone = { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } };

try {

  // ── CR-T18: QR → URL → page at 390 px, no login ──
  {
    const ctx = await browser.newContext(phone);
    const page = await ctx.newPage();
    // Decode the App's QR from its rendered pixels in the browser (what a camera sees).
    await page.setContent(`<img id="q" src="${qrDataUrl(s.url)}">`);
    const px = await page.evaluate(async () => {
      const img = document.getElementById("q");
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      return { w: c.width, h: c.height, data: Array.from(g.getImageData(0, 0, c.width, c.height).data) };
    });
    const decoded = jsQR(new Uint8ClampedArray(px.data), px.w, px.h)?.data ?? null;
    const t0 = performance.now();
    const opened = await noLoginAt390(page, decoded, origin);
    const renderMs = performance.now() - t0;
    const ok = decoded === s.url && opened.problems.length === 0;
    // Negative control: the same instrument on a link variant that redirects to a login page.
    const wall = await noLoginAt390(page, `http://127.0.0.1:${loginWall.address().port}/l/variant/`, `http://127.0.0.1:${loginWall.address().port}`);
    const caught = wall.problems.some((p) => /login/.test(p));
    record("CR-T18", ok && caught ? "PASS" : "FAIL", { decoded_equals_share_url: decoded === s.url, problems: opened.problems, facts: opened.facts, modules: qrModules(s.url).length, negative_login_variant: wall.problems });
    // CR-T20, synthetic half: publish → first render on the emulated phone.
    record("CR-T20 (synthetic)", "PASS", { publish_ms: Math.round(s.publishMs), open_to_render_ms: Math.round(renderMs), note: "same machine, emulated phone; the real-phone run is NOT RUN", target: { publish_ms: 10_000, publish_to_render_ms: 60_000 } });
    record("CR-T20 (real phone)", "NOT RUN", "no physical phone in this run");
    await ctx.close();
  }

  // ── CR-T61: devices denied unless declared; automation never grants ──
  {
    const ctx = await browser.newContext(phone);
    // The automation itself tries to grant both devices: the served policy must still deny them.
    await ctx.grantPermissions(["camera", "microphone"], { origin });
    const page = await ctx.newPage();
    await page.goto(s.url);
    const undeclared = await page.evaluate(async () => {
      const allows = { camera: document.featurePolicy?.allowsFeature("camera"), microphone: document.featurePolicy?.allowsFeature("microphone") };
      let gum;
      try {
        const st = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        st.getTracks().forEach((t) => t.stop());
        gum = "granted";
      } catch (e) {
        gum = e.name;
      }
      return { allows, gum };
    });
    await ctx.close();
    const declared = deviceDeclared;
    const ctx2 = await browser.newContext(phone);
    const p2 = await ctx2.newPage();
    await p2.goto(declared.url);
    const dec = await p2.evaluate(async () => ({
      allows: { camera: document.featurePolicy?.allowsFeature("camera"), microphone: document.featurePolicy?.allowsFeature("microphone") },
      state: (await navigator.permissions.query({ name: "camera" })).state,
    }));
    await ctx2.close();
    // Source check: no CR automation path grants a device permission (positive: none; negative: a planted call is caught).
    const GRANT = /Browser\.grantPermissions|Browser\.setPermission|grantPermissions\(/;
    const crSources = ["experimentBrowser.ts", "verifyRunner.ts", "verifySession.ts", "browserControl.ts", "browserMcp.ts", "publishSession.ts"].map((n) => readFileSync(join(ext, "src", n), "utf8"));
    const granted = crSources.filter((src) => GRANT.test(src)).length;
    const plantCaught = GRANT.test(crSources[0] + '\nawait cdp.send("Browser.grantPermissions", { permissions: ["videoCapture"] });');
    const ok = undeclared.gum === "NotAllowedError" && undeclared.allows.camera === false && undeclared.allows.microphone === false && dec.allows.camera === true && dec.allows.microphone === false && dec.state === "prompt" && granted === 0 && plantCaught;
    record("CR-T61", ok ? "PASS" : "FAIL", { undeclared, declared: dec, cr_sources_granting: granted, planted_grant_caught: plantCaught });
  }

  // ── CR-T60: pseudonyms in one real browser ──
  {
    const declared = repeated;
    const other = repeatedOther;
    const undeclared = plain;
    const ctx = await browser.newContext(phone);
    const read = async (url) => {
      const pg = await ctx.newPage();
      await pg.goto(url);
      const v = await pg.evaluate(() => ({ ...window.hypeproof.test }));
      await pg.close();
      return v;
    };
    const a = await read(declared.url);
    const b = await read(declared.url);
    const c = await read(other.url);
    const u1 = await read(undeclared.url);
    const u2 = await read(undeclared.url);
    await ctx.close();
    const ok = /^pp-[0-9a-f]{32}$/.test(a.pseudonym) && a.pseudonym === b.pseudonym && a.session_id !== b.session_id && c.pseudonym !== a.pseudonym && u1.pseudonym !== u2.pseudonym;
    // The planted-defect controls of this row run on the same snippet bytes in worker/test/cr-publish.test.mjs.
    record("CR-T60 (browser)", ok ? "PASS" : "FAIL", { declared_two_sessions: [a, b], other_experiment: c.pseudonym !== a.pseudonym, undeclared_differs: u1.pseudonym !== u2.pseudonym });
  }

  // ── CR-T22 and CR-T19 in the browser ──
  {
    const ctx = await browser.newContext(phone);
    const page = await ctx.newPage();
    await f.upload(s.project.id, V1, token);
    await page.goto(s.url);
    const stillV0 = !(await page.content()).includes("버전 1");
    record("CR-T22 (browser)", stillV0 ? "PASS" : "FAIL", { v0_link_after_v1_publish_shows_v1: !stillV0 });
    // The tab's own origin asks again after revocation (what a refresh or a cached path would get).
    const entry = page.url();
    await f.api(`/v1/curriculum/links/${s.link.id}/revoke`, { method: "POST", token, body: {} });
    const after = await page.evaluate(async (u) => {
      const out = {};
      for (const path of [u, u.replace(/[^/]*$/, "app.js"), u.replace(/[^/]*$/, "")]) {
        const r = await fetch(path, { cache: "default", redirect: "manual" });
        out[path.slice(-12)] = { status: r.status, bytes: (await r.arrayBuffer()).byteLength, cache: r.headers.get("cache-control") };
      }
      return out;
    }, entry);
    let reload = "loaded";
    try {
      await page.reload();
    } catch (e) {
      reload = /ERR_HTTP_RESPONSE_CODE_FAILURE/.test(e.message) ? "410, Chromium shows its own error page" : e.message;
    }
    const heading = await page.evaluate(() => document.querySelector("h1")?.textContent ?? null).catch(() => null);
    await ctx.close();
    const gone = Object.values(after).every((r) => r.status === 410 && r.bytes === 0 && r.cache === "no-store");
    record("CR-T19 (browser)", gone && heading === null ? "PASS" : "FAIL", { after, reload, product_heading_after_reload: heading });
  }

  // ── CR-T19 with a service worker: nothing serves the product after revocation ──
  {
    /** Open, let any worker install and take control, revoke, then reload and open a new tab. */
    async function swRun(target) {
      const ctx = await browser.newContext(phone);
      const page = await ctx.newPage();
      await page.goto(target.url, { waitUntil: "load" });
      await page.waitForFunction(() => document.getElementById("sw")?.textContent !== "-", null, { timeout: 5000 }).catch(() => {});
      const registration = await page.evaluate(() => document.getElementById("sw")?.textContent ?? null);
      await page.waitForTimeout(300);
      await page.reload({ waitUntil: "load" }); // a worker, if installed, now controls the page and caches it
      const controlledBefore = await page.evaluate(() => !!navigator.serviceWorker.controller);
      const entry = page.url();
      const rv = await f.api(`/v1/curriculum/links/${target.link.id}/revoke`, { method: "POST", token, body: {} });
      const answer = async (p) => {
        let res = null;
        try {
          res = await p.goto(entry, { waitUntil: "load" });
        } catch (e) {
          return { error: e.message.split("\n")[0], status: null, fromServiceWorker: false, product: false };
        }
        return { status: res?.status() ?? null, fromServiceWorker: res?.fromServiceWorker() ?? false, product: await p.evaluate(() => document.body?.innerText.includes("PRODUCT-CONTENT") ?? false).catch(() => false) };
      };
      const reload = await answer(page);
      const tab = await answer(await ctx.newPage());
      await ctx.close();
      return { registration, controlledBefore, revoke: rv.status, reload, tab };
    }
    const fixed = await swRun(pwa);
    const old = await swRun(pwaPlanted);
    const served = (r) => r.product || r.status === 200 || r.fromServiceWorker;
    const ok = /^sw-refused/.test(fixed.registration ?? "") && !fixed.controlledBefore && fixed.revoke === 200 && !served(fixed.reload) && !served(fixed.tab) && (fixed.reload.status === 410 || fixed.reload.status === null);
    const caught = old.registration === "sw-registered" && (served(old.reload) || served(old.tab));
    record("CR-T19 (service worker)", ok && caught ? "PASS" : "FAIL", { fixed, planted_old_behaviour: old, planted_caught: caught });
  }

  // ── CR-T19 sibling links: a revoked link never ends another link's visit or pseudonym ──
  {
    async function siblingRun(live, old) {
      const ctx = await browser.newContext(phone);
      const page = await ctx.newPage();
      const read = () => page.evaluate(() => ({ ...window.hypeproof.test, kept: localStorage.getItem("hp:pseudonym:" + window.__hpTest.experiment) !== null }));
      await page.goto(live.url, { waitUntil: "networkidle" });
      const before = await read();
      const rv = await f.api(`/v1/curriculum/links/${old.link.id}/revoke`, { method: "POST", token, body: {} });
      let oldStatus;
      try {
        oldStatus = (await page.goto(old.url, { waitUntil: "load" }))?.status() ?? null;
      } catch (e) {
        oldStatus = /ERR_HTTP_RESPONSE_CODE_FAILURE/.test(e.message) ? 410 : e.message.split("\n")[0];
      }
      // Chromium commits its own error page for an empty 410; let it settle before going back.
      await page.waitForURL(/^chrome-error:/, { timeout: 2000 }).catch(() => {});
      await page.waitForLoadState("load").catch(() => {});
      await page.goto(live.url, { waitUntil: "networkidle" });
      const after = await read();
      await ctx.close();
      return { revoke: rv.status, oldStatus, before, after, sameSession: before.session_id === after.session_id, samePseudonym: before.pseudonym === after.pseudonym };
    }
    const fixed = await siblingRun(sibLive, sibOld);
    const old = await siblingRun(sibLivePlanted, sibOldPlanted);
    const ok = fixed.revoke === 200 && fixed.oldStatus === 410 && fixed.before.kept && fixed.after.kept && fixed.sameSession && fixed.samePseudonym;
    const caught = old.oldStatus === 410 && (!old.sameSession || !old.samePseudonym || !old.after.kept);
    record("CR-T19 (sibling links)", ok && caught ? "PASS" : "FAIL", { fixed, planted_storage_wipe: old, planted_caught: caught });
  }

  // ── CR-T21: one visit is one session ──
  {
    async function oneVisit(target) {
      const ctx = await browser.newContext(phone);
      const page = await ctx.newPage();
      const seen = [];
      const note = async () => seen.push(await page.evaluate(() => ({ ...window.hypeproof.test })));
      await page.goto(target.url, { waitUntil: "networkidle" });
      await note();
      await page.click("#go");
      await page.waitForLoadState("networkidle");
      await note();
      await page.click("#home");
      await page.waitForLoadState("networkidle");
      await note();
      await page.reload({ waitUntil: "networkidle" });
      await note();
      await ctx.close();
      const counts = (await f.api(`/v1/curriculum/experiments/${target.experiment.id}/channels`, { token })).json.sessions_opened;
      return { seen, sessions: new Set(seen.map((x) => x.session_id)).size, pseudonyms: new Set(seen.map((x) => x.pseudonym)).size, counted: counts.channels["학교 게시판"] ?? 0 };
    }
    const fixed = await oneVisit(visit);
    const old = await oneVisit(visitPlanted);
    const ok = fixed.sessions === 1 && fixed.pseudonyms === 1 && fixed.counted === 1;
    const caught = old.sessions > 1 || old.counted > 1;
    record("CR-T21 (one visit, browser)", ok && caught ? "PASS" : "FAIL", { fixed: { sessions: fixed.sessions, pseudonyms: fixed.pseudonyms, counted: fixed.counted }, planted_old_snippet: { sessions: old.sessions, counted: old.counted }, planted_caught: caught });
  }
} catch (err) {
  record("run", "FAIL", err.stack ?? String(err));
} finally {
  await browser.close();
  server.close();
  loginWall.close();
  f.close();
}

if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), class: "synthetic", results }, null, 2));
process.exit(results.some((r) => r.verdict === "FAIL") ? 1 : 0);
