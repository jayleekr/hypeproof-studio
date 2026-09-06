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
  if (urlPath.split("?")[0] === "/__hp_viewport") return serveViewport(root, urlPath);
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

/** Local-only responsive inspection; reuse static serving and its containment guard. */
function serveViewport(root: string, requestPath: string): ServeResult {
  const bad = (status: number, message: string): ServeResult => ({ status, contentType: "text/plain; charset=utf-8", body: Buffer.from(message) });
  const target = new URL(requestPath, "http://localhost").searchParams.get("path") || "";
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) return bad(400, "local page path required");
  const url = new URL(target, "http://localhost");
  if (url.origin !== "http://localhost" || url.pathname === "/__hp_viewport") return bad(400, "invalid preview target");
  const file = serveStatic(root, target.split("#")[0]);
  if (file.status !== 200) return file;
  if (!file.contentType.startsWith("text/html")) return bad(400, "HTML preview required");
  const attr = target.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>화면 크기 검수</title>
<style>body{margin:0;background:#20242b;color:#eee;font:16px/1.5 system-ui}nav{position:sticky;left:0;top:0;padding:12px;max-width:100vw;box-sizing:border-box;background:#20242b}button,a{font:inherit;padding:8px;color:inherit;background:#344864;border:1px solid #8396b0;border-radius:4px}iframe{display:block;border:0;background:white;width:390px;height:844px}p{margin:8px 0}#status{font-weight:bold}</style>
<nav><button data-width="390">모바일 390px</button> <button data-width="1280">데스크톱 1280px</button> <a id="original" href="${attr}">원본 크기로 열기</a><p id="status" role="status">페이지 로딩 중</p><small>CSS 화면 너비 검수 · 실제 휴대전화 검증은 별도입니다.</small></nav><iframe id="site" title="검수할 홈페이지" src="${attr}"></iframe>
<script>const frame=document.getElementById('site');const status=document.getElementById('status');function report(){try{status.textContent='실제 페이지 너비 '+frame.contentWindow.innerWidth+'px';document.getElementById('original').href=frame.contentWindow.location.href;}catch{status.textContent='외부 페이지로 이동했습니다. 로컬 페이지로 돌아와 검수하세요.';}}frame.addEventListener('load',report);document.querySelectorAll('[data-width]').forEach(b=>b.addEventListener('click',()=>{frame.style.width=b.dataset.width+'px';requestAnimationFrame(report);}));</script></html>`;
  return { status: 200, contentType: "text/html; charset=utf-8", body: Buffer.from(html) };
}
