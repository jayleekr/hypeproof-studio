import * as fs from "node:fs";
import * as path from "node:path";

// Pure (vscode-free) core of the live server: path resolution, traversal guard,
// content-type, live-reload injection, and static file serving. Split out so
// the security-critical bits are unit-testable under `node --strip-types`
// without a `vscode` module. See liveServer.ts for the http/vscode shell.

export const LIVERELOAD_PATH = "/__hp_livereload";

const LIVERELOAD_SNIPPET =
  `<script>(function(){try{var s=new EventSource(${JSON.stringify(LIVERELOAD_PATH)});` +
  `s.onmessage=function(e){if(e.data==="reload")location.reload();};}catch(e){}})();</script>`;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolve a request path against `root`, rejecting traversal. Returns the
 * absolute file path to serve, or null if it escapes the root (`..`, absolute
 * smuggling, etc.). This is the security boundary — keep it strict.
 */
export function resolveWithinRoot(root: string, urlPath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null; // malformed percent-encoding
  }
  rel = rel.replace(/^\/+/, "");
  if (rel === "") rel = "index.html";
  // A leading-slash-stripped absolute Windows path or a NUL byte is hostile.
  if (rel.includes("\0")) return null;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, rel);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  return resolved;
}

/** Inject the live-reload SSE client into an HTML document (before </body>). */
export function injectLiveReload(html: string): string {
  return html.includes("</body>")
    ? html.replace("</body>", `${LIVERELOAD_SNIPPET}</body>`)
    : html + LIVERELOAD_SNIPPET;
}

export interface ServeResult {
  status: number;
  contentType: string;
  body: Buffer;
}

/**
 * Serve a static file from `root` for `urlPath`. Directory requests fall back
 * to `index.html`; HTML gets the live-reload snippet injected. Returns a
 * 403 on traversal, 404 on miss. Pure + synchronous (real fs), no http/vscode.
 */
export function serveStatic(root: string, urlPath: string): ServeResult {
  const resolved = resolveWithinRoot(root, urlPath);
  if (!resolved) {
    return { status: 403, contentType: "text/plain; charset=utf-8", body: Buffer.from("forbidden") };
  }
  let filePath = resolved;
  try {
    if (fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
  } catch {
    return { status: 404, contentType: "text/plain; charset=utf-8", body: Buffer.from("not found") };
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return { status: 404, contentType: "text/plain; charset=utf-8", body: Buffer.from("not found") };
  }
  const type = contentTypeFor(filePath);
  if (type === "text/html") {
    buf = Buffer.from(injectLiveReload(buf.toString("utf8")), "utf8");
  }
  const charset = type.startsWith("text/") || type === "image/svg+xml" ? "; charset=utf-8" : "";
  return { status: 200, contentType: type + charset, body: buf };
}
