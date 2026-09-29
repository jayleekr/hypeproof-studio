// cr-recon (#1390) evidence probe: does the `browser` proposed API give an extension
// what the Experiment Browser needs (docs/plan/curriculum-runtime-recon.md, decision R1)?
//
// Real-Mac layer. Launches an existing HypeProof Studio app (HPS_APP_PATH, same knob as
// the Playwright suite; see e2e/README.md) with a test-only development extension
// (./cdp-probe-extension) that opens a local fixture page in the integrated browser via
// window.openBrowserTab + BrowserTab.startCDPSession and records what CDP returns.
// No worker, token or network beyond 127.0.0.1 is needed; the app's own proxy setting
// points at a dead local port so nothing reaches production.
//
// Planted answers (verification.md rule 3): the fixture logs one console.error, throws
// once, gets one 404 and one refused connection. The instrument must report exactly
// those four error records per document, zero for a clean page, and must not carry the
// first document's records into the second one after a reload.
//
// Run: HPS_APP_PATH="/path/to/HypeProof Studio.app" node e2e/curriculum-runtime/cdp-probe.mjs [--out result.json]
// Exit: 0 all expectations hold · 1 an expectation failed · 2 could not run · 3 every runnable
// expectation holds but the screen was locked, so the checks that need composited frames
// (wheel scroll, element crop) were NOT RUN. Run it again unlocked before calling it a pass.
import { _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = process.env.HPS_APP_PATH?.trim();
if (!appRoot) { console.error("HPS_APP_PATH is required (a HypeProof Studio.app to drive)"); process.exit(2); }
const binary = appRoot.includes("/Contents/MacOS/") ? appRoot : join(appRoot, "Contents/MacOS/HypeProof Studio");
if (!existsSync(binary)) { console.error(`app binary missing: ${binary}`); process.exit(2); }
const productJson = join(binary, "../../Resources/app/product.json");
const product = existsSync(productJson) ? JSON.parse(readFileSync(productJson, "utf8")) : {};
console.log(`INFO  app ${product.version ?? "?"} (${product.commit ?? "?"}) · ${binary}`);
const outArg = process.argv.indexOf("--out");
const outFile = outArg > 0 ? process.argv[outArg + 1] : null;

const PLANTED = `<!doctype html><html><head><meta charset="utf-8"><title>CR recon probe</title>
<style>body{font-family:sans-serif;min-height:3000px}#target{padding:12px;background:rgb(10, 20, 30);color:rgb(250, 250, 250);font-size:18px}</style></head>
<body><h1>키오스크 연습</h1>
<button id="target" onmouseover="document.body.dataset.hovered='yes'" onclick="document.body.dataset.clicked=String(Number(document.body.dataset.clicked||0)+1)">주문하기</button>
<label>옵션 <select id="opt" aria-label="옵션" onchange="document.body.dataset.selected=this.value"><option value="a">A</option><option value="b">B</option></select></label>
<script>
console.log('probe-log');
console.error('probe-planted-error');
setTimeout(function(){ throw new Error('probe-planted-throw'); }, 50);
fetch('/missing-404').catch(function(){});
fetch('http://127.0.0.1:__REFUSED_PORT__/unreachable').catch(function(){});
</script></body></html>`;
// Negative control for the instrument itself: HPS_CR_PROBE_NEGATIVE=1 plants one error the
// expectations below do not list, so the exact-count checks must FAIL (exit 1).
const NEGATIVE = process.env.HPS_CR_PROBE_NEGATIVE === "1";
const CLEAN = `<!doctype html><html><head><meta charset="utf-8"><title>clean</title></head><body><p>clean</p><script>console.log('clean-log')</script></body></html>`;

// A port that was just free: the planted fetch fails with a refused connection, not an
// "unsafe port" block (port 9 is on Chromium's restricted list).
const probe = createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const refusedPort = probe.address().port;
await new Promise((r) => probe.close(r));
const server = createServer((req, res) => {
  if (req.url === "/planted") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(PLANTED.replace("__REFUSED_PORT__", String(refusedPort)).replace("</script>", NEGATIVE ? "console.error('probe-unlisted-error');</script>" : "</script>")); }
  if (req.url === "/clean") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(CLEAN); }
  if (req.url === "/favicon.ico") { res.writeHead(204); return res.end(); }
  res.writeHead(404, { "content-type": "text/plain" }); res.end("missing");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const work = mkdtempSync(join(tmpdir(), "hps-cr-probe-"));
const ext = join(work, "cdp-probe-extension");
cpSync(join(here, "cdp-probe-extension"), ext, { recursive: true });
const resultPath = join(work, "result.json");
writeFileSync(join(ext, "probe-config.json"), JSON.stringify({ plantedUrl: `${base}/planted`, cleanUrl: `${base}/clean`, out: resultPath }));
const userDir = join(work, "user-data", "User");
mkdirSync(userDir, { recursive: true });
writeFileSync(join(userDir, "settings.json"), JSON.stringify({
  "hypeproofChat.proxyUrl": "http://127.0.0.1:9/v1",
  "workbench.startupEditor": "none",
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "workbench.tips.enabled": false,
}));
const wsDir = join(work, "ws");
mkdirSync(wsDir);

const app = await electron.launch({
  executablePath: binary,
  args: [
    `--user-data-dir=${join(work, "user-data")}`,
    `--extensions-dir=${join(work, "extensions")}`,
    `--extensionDevelopmentPath=${ext}`,
    "--enable-proposed-api=hypeproof-recon.cr-recon-cdp-probe",
    "--disable-workspace-trust", "--disable-updates", "--skip-welcome", "--skip-release-notes",
    "--use-inmemory-secretstorage", "--no-sandbox",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--folder-uri", pathToFileURL(wsDir).href,
  ],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  timeout: 60_000,
});
// Quiet mode, as e2e/fixtures/app.ts does: keep the window off Jay's display.
await app.evaluate(({ app: a, BrowserWindow }) => {
  try { a.dock?.hide(); } catch { /* not macOS */ }
  const stash = (w) => { try { w.setPosition(-4000, -4000); w.showInactive(); } catch { /* gone */ } };
  for (const w of BrowserWindow.getAllWindows()) stash(w);
  a.on("browser-window-created", (_e, w) => { stash(w); w.on("show", () => stash(w)); });
}).catch(() => {});

let result;
try {
  const until = Date.now() + 120_000;
  while (!existsSync(resultPath) && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
  if (!existsSync(resultPath)) { console.error("probe produced no result within 120 s"); process.exitCode = 2; }
  else result = JSON.parse(readFileSync(resultPath, "utf8"));
} finally {
  await app.close().catch(() => {});
  server.close();
  // HPS_CR_PROBE_KEEP=1 keeps the user-data dir (extension host logs) for diagnosis.
  if (process.env.HPS_CR_PROBE_KEEP === "1") console.error(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
if (!result) process.exit(process.exitCode ?? 2);
if (outFile) writeFileSync(outFile, JSON.stringify(result, null, 2));
if (result.fatal) { console.error(result.fatal); process.exit(2); }

// ── Expectations (planted answers) ─────────────────────────────────────────
const s = result.steps;
const planted = { console_error: 1, console_log: 1, exception: 1, http_error: 1, loading_failed: 1 };
// A locked screen produces no composited frames: screenshots time out and wheel scrolling
// does not move the page (observed 2026-09-29). Those checks are NOT RUN then, never PASS.
let locked = null;
try { locked = /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(execFileSync("ioreg", ["-n", "Root", "-d1", "-a"], { encoding: "utf8" })); }
catch { /* not macOS or no ioreg: unknown */ }
const COMPOSITED = true;
const checks = [
  ["attach over the proposed API", s.attach?.ok && s.attach.flat_session],
  ["reload gives a distinct document id", s.capture_planted_reload?.distinct_documents === true],
  ["first document: exactly the planted records", JSON.stringify(s.capture_planted_reload?.first) === JSON.stringify(planted)],
  ["second document: exactly the planted records (none carried over)", JSON.stringify(s.capture_planted_reload?.second) === JSON.stringify(planted)],
  ["every record attributed to a document", s.capture_planted_reload?.unattributed === 0],
  ["clean page: zero error records", s.capture_clean?.ok && s.capture_clean.error_records === 0],
  ["hover reaches the page", s.hover?.hovered === "yes"],
  ["wheel scroll moves the page", s.scroll?.ok && s.scroll.after > s.scroll.before, COMPOSITED],
  ["DOM-level scroll moves the page", s.scroll?.ok && s.scroll.dom_scroll_after > 0],
  ["select changes the value and fires change", s.select?.selected === "b"],
  ["reload makes a new document", s.reload_and_stale_ref?.new_document === true],
  ["element pick returns the node the AX ref names", s.element_pick?.same_node_as_ax_ref === true],
  ["element pick: DOM snippet and style", /주문하기/.test(s.element_pick?.outer_html ?? "") && s.element_pick?.style?.["background-color"] === "rgb(10, 20, 30)"],
  ["element pick: element crop", s.element_pick?.crop_bytes > 0, COMPOSITED],
  ["element pick does not click the product", s.element_pick?.ok === true && s.element_pick.page_click_handler_ran === null],
  ["overlay outline leaves DOM and AX unchanged", s.overlay_indicator?.ax_unchanged === true && s.overlay_indicator.dom_unchanged === true],
];
let notRun = 0;
for (const [name, pass, composited] of checks) {
  if (composited && locked) { notRun++; console.log(`NOT RUN  ${name} (screen locked: no composited frames)`); continue; }
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
}
console.log(`INFO  screen locked: ${locked}`);
console.log("INFO  upstream LM browser tools registered:", JSON.stringify(s.upstream_lm_tools?.browser_tools));
console.log("INFO  overlay indicator candidate:", JSON.stringify(s.overlay_indicator));
console.log("INFO  viewport:", JSON.stringify(s.viewport));
console.log("INFO  stale backend node after reload:", s.reload_and_stale_ref?.stale_backend_node);
console.log("INFO  replayed on Runtime.enable (attach-time document):", JSON.stringify(s.capture_planted_reload?.replayed_from_initial_document));
console.log("INFO  failed request kinds:", JSON.stringify((s.capture_planted_reload?.sample ?? []).filter((r) => r.kind !== "console").map((r) => r.text)));
console.log("INFO  element pick local processing ms (n=1, not a timing claim):", s.element_pick?.local_processing_ms);
const failed = checks.filter(([, pass, composited]) => !(composited && locked) && !pass).length;
process.exit(failed ? 1 : notRun ? 3 : 0);
