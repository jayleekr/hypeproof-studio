// cr-evidence (#1394) — participant events from a published test version in REAL Chromium.
//
// Evidence class: synthetic. Real Chromium (Playwright's build, 390 × 844 phone emulation) over
// real HTTP to the real Service router (worker/src/index.ts, local SQLite + in-memory R2 through
// worker/test/harness/curriculum.mjs), with `*.test.invalid` mapped to this machine. The page is
// the kiosk-practice fixture plus a few lines a student writes to report their own tasks
// (`window.hypeproof.test.task` / `.milestone`). Not a phone and not the Studio app.
//
//   CR-T23  one participant visit in a real browser records the six kinds (session_start,
//           page_view, click, task_start, task_complete, milestone) under a random session id
//           and pseudonym, every event with its project, experiment, version and channel, and no
//           identity field. Negative: a planted page that adds an e-mail field to its events is
//           refused by the Service and stores nothing.
//   CR-T62  typed text is kept for the declared field only. Negative: a planted snippet that
//           sends the value of an undeclared field is caught: the Service drops it.
//   CR-T67  (browser half) the same phone coming back to a repeated-use experiment is the same
//           pseudonym, counted as a return of the device.
//   CR-T19  (events half) after revocation the open tab's next event gets 410 and nothing is stored.
//
// Run (from e2e/): node --experimental-strip-types --experimental-sqlite curriculum-runtime/evidence-runtime.real.mjs [--out result.json]
// Exit: 0 every check and control held · 1 a check or a control failed · 2 could not run.

import "../../worker/test/harness/loader.mjs";
import { chromium, devices } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { localCurriculum } = await import("../../worker/test/harness/curriculum.mjs");
const { PARTICIPANT_EVENTS_SNIPPET } = await import("../../worker/src/lib/curriculum/participant-snippet.ts");
const { participantRecord, PUBLISHED_HOST } = await import("../../worker/src/lib/curriculum/participant-record.ts");
const outArg = process.argv.indexOf("--out");
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;

const results = [];
const record = (id, verdict, detail) => {
  results.push({ id, verdict, detail });
  console.log(`${verdict === "PASS" ? "✅" : "❌"} ${id}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};

// Planted variants of the event half, served on chosen hosts (negative controls).
const IDENTITY_PLANT = PARTICIPANT_EVENTS_SNIPPET.replace("o.kind=k;o.seq=s.n;", 'o.kind=k;o.seq=s.n;o.email="kid@example.com";');
const VALUE_PLANT = PARTICIPANT_EVENTS_SNIPPET.replace("if(k&&~D.indexOf(k)&&n.value)o.value", "if(k&&n.value)o.value");
for (const [name, v] of Object.entries({ IDENTITY_PLANT, VALUE_PLANT })) if (v === PARTICIPANT_EVENTS_SNIPPET) throw new Error(`${name} did not apply`);
const planted = new Map();

let f = null;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const host = (req.headers.host ?? "").split(":")[0];
  const headers = Object.entries(req.headers).filter(([, v]) => typeof v === "string");
  const r = await f.app.fetch(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: chunks.length && req.method !== "GET" ? Buffer.concat(chunks) : undefined }), f.env, { waitUntil() {}, passThroughOnException() {} });
  const out = Object.fromEntries(r.headers);
  if (process.env.HP_DEBUG) console.log("·", req.method, host, req.url, r.status);
  let body = Buffer.from(await r.arrayBuffer());
  if (planted.has(host) && /text\/html/.test(out["content-type"] ?? "")) {
    body = Buffer.from(body.toString("utf8").replace(PARTICIPANT_EVENTS_SNIPPET, planted.get(host)));
    delete out["content-length"];
  }
  res.writeHead(r.status, out);
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
f = await localCurriculum({ testOrigin: `http://{project}.test.invalid:${PORT}` });

const dir = join(here, "fixtures/kiosk-practice");
const fixture = Object.fromEntries(readdirSync(dir).filter((n) => !n.startsWith(".")).map((n) => [n, readFileSync(join(dir, n))]));
// What a student adds to report their own tasks, plus one free-text field.
const REPORT = `<label>요청 사항 <input name="memo" id="memo"></label><script>
document.getElementById("begin").addEventListener("click",function(){window.hypeproof.test.task("주문","start")});
document.getElementById("drink").addEventListener("change",function(){window.hypeproof.test.milestone("음료 고름")});
document.getElementById("pay").addEventListener("click",function(){window.hypeproof.test.task("주문","complete")});
</script>`;
const FILES = { ...fixture, "index.html": String(fixture["index.html"]).replace("</body>", `${REPORT}</body>`) };

const token = await f.student();
// The task and milestone names REPORT sends, declared on every experiment (only declared names are recorded).
const LABELS = ["주문", "음료 고름", "늦은 기록"];
async function publish(given) {
  const declarations = { ...given, labels: LABELS };
  const p = (await f.api("/v1/curriculum/projects", { method: "POST", token, body: { title: "키오스크" } })).json.project;
  const up = await f.upload(p.id, FILES, token);
  const e = await f.api("/v1/curriculum/experiments", { method: "POST", token, body: { project_id: p.id, product_version_id: up.id, week: 1, question: "도움 없이 주문할 수 있나?", method: "task_test", success_criteria: ["5명 중 3명 완료"], hypothesis: "처음 쓰는 사람도 혼자 주문할 수 있다", ...(declarations ? { declarations } : {}) } });
  const l = await f.api(`/v1/curriculum/experiments/${e.json.experiment.id}/links`, { method: "POST", token, body: { expires_at: Date.now() + 3600_000, channel: "학교 게시판" } });
  if (l.status !== 201) throw new Error("link " + l.text);
  return { project: p, version: up.id, experiment: e.json.experiment, link: l.json.link, url: l.json.share_url };
}
const events = async (s) => (await participantRecord(f.r2, s.project.cohort_id, s.project.id).observationsOf(PUBLISHED_HOST, s.experiment.id)).map((r) => r.event);

const declared = await publish({ repeated_use: true, raw_input: { fields: ["memo"] } });
const undeclared = await publish();
const identityPlant = await publish();
planted.set(new URL(identityPlant.url).hostname, IDENTITY_PLANT);
const valuePlant = await publish();
planted.set(new URL(valuePlant.url).hostname, VALUE_PLANT);
const origins = [declared, undeclared, identityPlant, valuePlant].map((x) => new URL(x.url).origin).join(",");

let browser;
try {
  browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--host-resolver-rules=MAP *.test.invalid 127.0.0.1", `--unsafely-treat-insecure-origin-as-secure=${origins}`] });
} catch (err) {
  console.error(`could not launch Chromium: ${err.message}`);
  server.close();
  process.exit(2);
}
const phone = { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } };

/** One visit: order a drink with a typed request, as a participant would. */
async function visit(ctx, s) {
  const page = await ctx.newPage();
  if (process.env.HP_DEBUG) {
    page.on("console", (m) => console.log("console", m.type(), m.text()));
    page.on("pageerror", (e) => console.log("pageerror", e.message));
    page.on("requestfailed", (r) => console.log("requestfailed", r.url(), r.failure()?.errorText));
    page.on("request", (r) => console.log("request", r.method(), r.url()));
  }
  await page.goto(s.url, { waitUntil: "networkidle" });
  await page.click("#begin");
  await page.selectOption("#drink", "tea");
  await page.fill("#memo", "얼음 적게 주세요");
  await page.press("#memo", "Tab");
  await page.click("#add");
  await page.click("#pay");
  await page.waitForTimeout(400);
  await page.waitForLoadState("networkidle");
  return page;
}
const IDENTITY = /^(name|email|e_mail|phone|tel|user_?agent|ip|address)$/i;
const identityKeys = (v, out = []) => {
  if (Array.isArray(v)) v.forEach((x) => identityKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (IDENTITY.test(k)) out.push(k); identityKeys(x, out); }
  return out;
};

try {
  const ctx = await browser.newContext(phone);
  // ── CR-T23 ──
  {
    const page = await visit(ctx, declared);
    const ev = await events(declared);
    const kinds = [...new Set(ev.map((e) => e.kind))].sort();
    const needed = ["click", "milestone", "page_view", "session_start", "task_complete", "task_start"];
    const missing = needed.filter((k) => !kinds.includes(k));
    const badAttr = ev.filter((e) => e.attribution?.project !== declared.project.id || e.attribution?.experiment !== declared.experiment.id || e.attribution?.product_version !== declared.version || e.attribution?.channel !== "학교 게시판");
    const ids = new Set(ev.map((e) => e.participant?.session_id));
    const pseud = new Set(ev.map((e) => e.participant?.pseudonym));
    const ok = missing.length === 0 && badAttr.length === 0 && ids.size === 1 && /^ps-[0-9a-f]{32}$/.test([...ids][0]) && pseud.size === 1 && /^pp-[0-9a-f]{32}$/.test([...pseud][0]) && identityKeys(ev).length === 0 && ev.every((e) => e.source_state === "real");
    // Negative control: the planted page that adds an e-mail field stores nothing.
    const ctxP = await browser.newContext(phone);
    await visit(ctxP, identityPlant);
    await ctxP.close();
    const plantedEvents = await events(identityPlant);
    const caught = plantedEvents.length === 0;
    record("CR-T23 (browser)", ok && caught ? "PASS" : "FAIL", { kinds, missing, bad_attribution: badAttr.length, sessions: ids.size, pseudonyms: pseud.size, identity_keys: identityKeys(ev), planted_email_events_stored: plantedEvents.length, planted_caught: caught });
    await page.close();
  }
  // ── CR-T62 ──
  {
    const keep = (await events(declared)).filter((e) => e.kind === "input");
    const ctxU = await browser.newContext(phone);
    await visit(ctxU, undeclared);
    const drop = (await events(undeclared)).filter((e) => e.kind === "input");
    await visit(ctxU, valuePlant);
    await ctxU.close();
    const plantedInputs = (await events(valuePlant)).filter((e) => e.kind === "input");
    const ok = keep.some((e) => e.input_value === "얼음 적게 주세요") && drop.length > 0 && drop.every((e) => e.input_value === undefined) && !JSON.stringify(await events(undeclared)).includes("얼음");
    // The planted page did send the value; the Service kept only the fact.
    const caught = plantedInputs.length > 0 && plantedInputs.every((e) => e.input_value === undefined) && !JSON.stringify(plantedInputs).includes("얼음");
    record("CR-T62 (browser)", ok && caught ? "PASS" : "FAIL", { declared_kept: keep.map((e) => e.input_value), undeclared_inputs: drop.length, undeclared_values: drop.filter((e) => e.input_value !== undefined).length, planted_value_dropped: caught });
  }
  // ── CR-T67 browser half: the same phone comes back ──
  {
    const again = await visit(ctx, declared);
    await again.close();
    const ev = (await f.api(`/v1/curriculum/experiments/${declared.experiment.id}/evidence`, { token })).json.evidence;
    const dev = ev.returns.devices?.[0];
    const ok = ev.returns.status === "measured" && ev.returns.devices.length === 1 && dev.return_count === 1 && dev.source_refs.length === 2;
    const und = (await f.api(`/v1/curriculum/experiments/${undeclared.experiment.id}/evidence`, { token })).json.evidence.returns;
    record("CR-T67 (browser)", ok && und.status === "not_measured" ? "PASS" : "FAIL", { returns: ev.returns, undeclared: und });
  }
  // ── CR-T19 events half: revoke, then the open tab's next event ──
  {
    const page = await ctx.newPage();
    await page.goto(declared.url, { waitUntil: "networkidle" });
    const before = (await events(declared)).length;
    await f.api(`/v1/curriculum/links/${declared.link.id}/revoke`, { method: "POST", token });
    const status = await page.evaluate(async (link) => {
      const k = Object.keys(sessionStorage).find((x) => x === "hp:test:" + link);
      const x = JSON.parse(sessionStorage.getItem(k));
      const r = await fetch(`/l/${link}/__hp/events`, { method: "POST", body: JSON.stringify({ token: x.session_token, events: [{ kind: "milestone", seq: 250, label: "늦은 기록" }] }) });
      return { status: r.status, body: await r.text() };
    }, declared.link.id);
    const after = (await events(declared)).length;
    record("CR-T19 (events after revocation, browser)", status.status === 410 && status.body === "" && after === before ? "PASS" : "FAIL", { status, stored_before: before, stored_after: after });
  }
  await ctx.close();
} catch (err) {
  record("run", "FAIL", err.stack ?? String(err));
} finally {
  await browser.close();
  server.close();
  f.close();
}

if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), class: "synthetic", results }, null, 2));
process.exit(results.some((r) => r.verdict === "FAIL") ? 1 : 0);
