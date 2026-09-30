// cr-browser (#1391) — CR-T10: every browser result carries the artifact version and
// file-set digest it was taken against (recon R4), persists on the ONE measurement-core
// record (SX-48), and stays readable, labelled with its version, after the files change.
//
// Run: node --experimental-strip-types test/artifact-version.smoke.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { artifactVersionFor, staticReferences } = await import("../src/artifactVersion.ts");
const { browserResultRecord, browserResultEventText, readBrowserResultEvent, labelByVersion } = await import("../src/browserResult.ts");
const { observationProblems } = await import("../src/experimentBrowser.ts");
const { LocalRecord, canonicalJson } = await import("../../../worker/src/lib/measurement-core/local-record.ts");

let passed = 0;
const ok = (name) => { passed++; console.log(`✓ ${name}`); };
const sha = (s) => createHash("sha256").update(s).digest("hex");

const root = mkdtempSync(join(tmpdir(), "cr-artifact-"));
const outside = mkdtempSync(join(tmpdir(), "cr-outside-"));
const write = (rel, text) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };
write("index.html", `<!doctype html><link rel="stylesheet" href="style.css"><script type="module" src="./js/app.js"></script>
<img src="img/logo.png"><a href="https://example.com/">ext</a><a href="#top">top</a><a href=".env">secret</a>
<script src="node_modules/lib/x.js"></script><img src="missing.png">`);
write("style.css", `body{background:url("img/bg.png")}`);
write("js/app.js", `import { f } from "./util.js"; f();`);
write("js/util.js", `export const f = () => 1;`);
write("img/logo.png", "PNG1");
write("img/bg.png", "PNG2");
write(".env", "ANTHROPIC_API_KEY=sk-ant-planted");
write("node_modules/lib/x.js", "lib");
write("unrelated.txt", "not referenced");

try {
  // ── positive: the set, the digest, determinism ─────────────────────────
  const v0 = await artifactVersionFor(root, "/");
  assert.deepEqual(v0.files.map((f) => f.path), ["img/bg.png", "img/logo.png", "index.html", "js/app.js", "js/util.js", "style.css"]);
  assert.equal(v0.entry, "index.html");
  const logo = v0.files.find((f) => f.path === "img/logo.png");
  assert.deepEqual(logo, { path: "img/logo.png", sha256: sha("PNG1"), bytes: 4 }, "each file keeps the plain sha256 artifact events carry");
  assert.equal(v0.id, `sha256:${sha(canonicalJson(v0.files))}`, "version id = sha256 of the canonical sorted list (R4)");
  assert.equal((await artifactVersionFor(root, "/index.html")).id, v0.id, "same content → same version");
  assert.deepEqual(staticReferences(`<a href="//cdn.x/y.js">`, "index.html"), [], "protocol-relative URLs are not local files");
  ok("CR-T10 positive: file set = entry + static references; dot-files, node_modules, externals and unreferenced files excluded");

  // ── a result on v0 persists on the measurement-core record ─────────────
  const observation = {
    url: "http://127.0.0.1:5173/index.html", route: "/index.html", documentGeneration: "L0", step: 2,
    records: [{ kind: "console", level: "error", message: "boom", step: 2, time: 1, documentGeneration: "L0" }],
    artifact: v0, screenshot: { data: Buffer.from("JPEG").toString("base64") },
  };
  const r0 = await browserResultRecord({ kind: "action", tool: "browser_click", input: { ref: "e1" }, outcome: "success", observation, at: 1000 });
  assert.equal(r0.artifact_version, v0.id);
  assert.equal(r0.screenshot_digest, `sha256:${sha("JPEG")}`, "screenshots are referenced by content digest");
  assert.match(r0.trace_digest, /^sha256:[a-f0-9]{64}$/);

  const store = new Map();
  const port = {
    read: async (k) => store.get(k) ?? null,
    write: async (k, v, o) => { if (o?.ifAbsent && store.has(k)) throw new Error("exists"); store.set(k, v); },
    list: async (p) => [...store.keys()].filter((k) => k.startsWith(p)),
    remove: async (k) => { store.delete(k); },
  };
  const record = new LocalRecord(port);
  const batch = (events) => ({ format: "hps-observation/1", scope: "synthetic-cr", session: "s1", program: "p1", events });
  const ev = (seq, kind, text, extra = {}) => ({ id: `e${seq}`, seq, task: "t1", at: 1000 + seq, kind, text, assistance: "unknown", ...extra });
  await record.appendObservations("studio", batch([
    ev(1, "tool_request", "browser_click(e1)", { tool_id: "c1" }),
    ev(2, "tool_result", browserResultEventText(r0), { tool_id: "c1", outcome: "success" }),
  ]));

  // The files change: v1.
  write("js/util.js", `export const f = () => 2;`);
  const v1 = await artifactVersionFor(root, "/");
  assert.notEqual(v1.id, v0.id, "a changed file is a new version");
  const r1 = await browserResultRecord({ kind: "observation", tool: "browser_observe", outcome: "success", observation: { ...observation, artifact: v1 }, at: 2000 });
  await record.appendObservations("studio", batch([
    ev(1, "tool_request", "browser_click(e1)", { tool_id: "c1" }),
    ev(2, "tool_result", browserResultEventText(r0), { tool_id: "c1", outcome: "success" }),
    ev(3, "tool_request", "browser_observe()", { tool_id: "c2" }),
    ev(4, "tool_result", browserResultEventText(r1), { tool_id: "c2", outcome: "success" }),
  ]));
  const stored = [...store.entries()].filter(([k]) => k.includes("observation")).map(([, v]) => JSON.parse(v).event);
  const results = stored.map(readBrowserResultEvent).filter(Boolean).sort((a, b) => a.at - b.at);
  assert.equal(results.length, 2, "both results read back from the existing record");
  const labelled = labelByVersion(results, v1.id);
  assert.deepEqual(labelled.map((l) => [l.record.tool, l.version, l.current]), [["browser_click", v0.id, false], ["browser_observe", v1.id, true]]);
  assert.equal(labelled[0].record.records[0].message, "boom", "the v0 result is still readable after v1");
  ok("CR-T10 positive: a v0 result stays readable and labelled v0 after v1, stored on the measurement-core record");

  // ── negative: no version, no result ─────────────────────────────────────
  await assert.rejects(browserResultRecord({ kind: "action", tool: "browser_click", outcome: "success", observation: { ...observation, artifact: null } }), /missing_artifact_version/);
  await assert.rejects(browserResultRecord({ kind: "action", tool: "browser_click", outcome: "success", observation: { ...observation, artifact: { ...v0, id: "v0" } } }), /missing_artifact_version/);
  assert.throws(() => browserResultEventText({ ...r0, artifact_version: "" }), /missing_artifact_version/);
  assert.deepEqual(observationProblems({ ...observation, snapshot: "x", screenshot: { data: "x" }, viewport: { width: 1, height: 1 }, artifact: null }), ["artifact"]);
  assert.equal(readBrowserResultEvent({ kind: "tool_result", text: "도구 실행 완료" }), null, "an ordinary tool result is not mistaken for one");
  ok("CR-T10 negative: a result without an artifact version is refused");

  // ── negative: the set never follows a symlink or leaves the root ────────
  symlinkSync(join(outside, "secret.js"), join(root, "js/link.js"));
  writeFileSync(join(outside, "secret.js"), "outside");
  write("index.html", `<script src="js/link.js"></script>`);
  await assert.rejects(artifactVersionFor(root, "/"), (e) => e.code === "symlink" && e.file === "js/link.js");
  await assert.rejects(artifactVersionFor(root, "/../outside.html"), (e) => e.code === "outside_root" || e.code === "not_found");
  await assert.rejects(artifactVersionFor(root, "/.env"), (e) => e.code === "excluded_path");
  await assert.rejects(artifactVersionFor(root, "/nope.html"), (e) => e.code === "not_found");
  ok("CR-T10 negative: symlinks, dot-files, paths outside the root and missing entries refuse the version");
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

console.log(`\n${passed} artifact-version checks passed`);
