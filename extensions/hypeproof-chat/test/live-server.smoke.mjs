// Smoke tests for the live-server core (#278 Phase 1). Covers the security
// boundary (path-traversal guard) + the serving behavior that the homepage
// live-preview depends on: index fallback, live-reload injection into HTML,
// content-type mapping, and 404/403. Pure helpers, vscode-free. Run:
//   node --experimental-strip-types test/live-server.smoke.mjs

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { resolveWithinRoot, injectLiveReload, contentTypeFor, serveStatic, LIVERELOAD_PATH } =
  await import("../src/liveServerHelpers.ts");

// ─── resolveWithinRoot: the traversal guard (security) ──────────────
{
  const root = path.resolve("/tmp/hp-root");
  // Normal paths resolve under root.
  assert.equal(resolveWithinRoot(root, "/index.html"), path.join(root, "index.html"));
  assert.equal(resolveWithinRoot(root, "/css/site.css"), path.join(root, "css/site.css"));
  // Empty / "/" → index.html.
  assert.equal(resolveWithinRoot(root, "/"), path.join(root, "index.html"));
  assert.equal(resolveWithinRoot(root, ""), path.join(root, "index.html"));
  // Query string stripped.
  assert.equal(resolveWithinRoot(root, "/index.html?v=2"), path.join(root, "index.html"));

  // Traversal MUST be rejected.
  assert.equal(resolveWithinRoot(root, "/../secret.txt"), null);
  assert.equal(resolveWithinRoot(root, "/../../etc/passwd"), null);
  assert.equal(resolveWithinRoot(root, "/css/../../secret"), null);
  // Encoded traversal (%2e%2e = "..").
  assert.equal(resolveWithinRoot(root, "/%2e%2e/secret"), null);
  // NUL byte injection.
  assert.equal(resolveWithinRoot(root, "/index.html%00.png"), null);
  // A sibling dir that shares a name prefix must NOT be treated as inside.
  assert.equal(resolveWithinRoot(root, "/../hp-root-evil/x"), null);

  console.log("✓ resolveWithinRoot: normal paths under root, traversal/NUL/encoded rejected");
}

// ─── injectLiveReload ───────────────────────────────────────────────
{
  const withBody = "<html><body><h1>hi</h1></body></html>";
  const out = injectLiveReload(withBody);
  assert.ok(out.includes(LIVERELOAD_PATH), "snippet references the live-reload endpoint");
  assert.ok(out.includes("location.reload"), "snippet reloads on message");
  assert.ok(out.indexOf(LIVERELOAD_PATH) < out.indexOf("</body>"), "injected before </body>");

  // No </body> → appended at end (still present).
  const noBody = "<h1>fragment</h1>";
  assert.ok(injectLiveReload(noBody).includes(LIVERELOAD_PATH));

  console.log("✓ injectLiveReload: SSE client injected before </body>, appended when absent");
}

// ─── contentTypeFor ─────────────────────────────────────────────────
{
  assert.equal(contentTypeFor("/a/index.html"), "text/html");
  assert.equal(contentTypeFor("styles.CSS"), "text/css"); // case-insensitive
  assert.equal(contentTypeFor("app.js"), "text/javascript");
  assert.equal(contentTypeFor("logo.png"), "image/png");
  assert.equal(contentTypeFor("icon.svg"), "image/svg+xml");
  assert.equal(contentTypeFor("data.json"), "application/json");
  assert.equal(contentTypeFor("weird.xyz"), "application/octet-stream");
  console.log("✓ contentTypeFor: known extensions mapped, unknown → octet-stream");
}

// ─── serveStatic (real files in a temp dir) ─────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-live-"));
  try {
    fs.writeFileSync(path.join(dir, "index.html"), "<html><body>home</body></html>");
    fs.writeFileSync(path.join(dir, "styles.css"), "body{color:red}");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "index.html"), "<html><body>sub</body></html>");

    // "/" serves index.html WITH the live-reload snippet injected.
    const home = serveStatic(dir, "/");
    assert.equal(home.status, 200);
    assert.ok(home.contentType.startsWith("text/html"));
    const homeBody = home.body.toString("utf8");
    assert.ok(homeBody.includes("home"));
    assert.ok(homeBody.includes(LIVERELOAD_PATH), "html served with live-reload injected");

    // CSS served verbatim (no injection), correct content-type.
    const css = serveStatic(dir, "/styles.css");
    assert.equal(css.status, 200);
    assert.ok(css.contentType.startsWith("text/css"));
    assert.equal(css.body.toString("utf8"), "body{color:red}");

    // Directory → index.html fallback.
    const sub = serveStatic(dir, "/sub");
    assert.equal(sub.status, 200);
    assert.ok(sub.body.toString("utf8").includes("sub"));

    // Missing file → 404.
    assert.equal(serveStatic(dir, "/nope.html").status, 404);

    // Traversal → 403 (never reads outside root).
    assert.equal(serveStatic(dir, "/../../etc/passwd").status, 403);

    console.log("✓ serveStatic: index fallback, css verbatim, dir→index, 404 miss, 403 traversal");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("All live-server smoke tests passed.");
