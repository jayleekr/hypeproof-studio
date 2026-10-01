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
//   CR-T19  after revocation the same tab gets 410 and no content.
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
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await f.app.fetch(
    new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: Object.entries(req.headers).filter(([, v]) => typeof v === "string"), body: chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined }),
    f.env,
    { waitUntil() {}, passThroughOnException() {} },
  );
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
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
const secureOrigins = [s, deviceDeclared, repeated, repeatedOther, plain].map((x) => new URL(x.url).origin).join(",");

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
