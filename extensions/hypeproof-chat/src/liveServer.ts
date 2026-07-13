import * as http from "node:http";
import * as path from "node:path";
import * as vscode from "vscode";
import { LIVERELOAD_PATH, serveStatic } from "./liveServerHelpers";

// #278 Phase 1 — in-process live server for the "live_server" preview path.
//
// Why: a real (multi-file) homepage needs a real HTTP origin — relative asset
// paths (`./styles.css`, `./img/x.png`), same-origin `fetch`, storage, and page
// navigation all fail inside the sandboxed opaque-origin iframe used by
// PreviewProvider. This serves the workspace root over http://127.0.0.1:PORT so
// the native integrated browser (openBrowserTab) can load it like a real site.
//
// Live reload: served HTML gets a tiny SSE client injected (see
// liveServerHelpers.injectLiveReload); a FileSystemWatcher on the served root
// pushes a "reload" event whenever any file changes (the coach regenerating
// index.html, or the user editing a sibling file), so the browser refreshes
// itself. No CDP / browser-tab plumbing needed for reload.
//
// Security: binds 127.0.0.1 only; path traversal is rejected in serveStatic.
// Lifecycle is owned by the extension — dispose() on deactivate closes the
// server + watcher + open SSE streams.

export class LiveServer {
  private server: http.Server | undefined;
  private root: string | undefined;
  private baseUrl: string | undefined;
  private startPromise: Promise<string> | undefined;
  private readonly sseClients = new Set<http.ServerResponse>();
  private watcher: vscode.FileSystemWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Ensure a server is running rooted at `root`. Returns its base URL. If a
   * server is already running for a different root it is restarted. Concurrent
   * calls for the same root share one start.
   */
  async ensure(root: string): Promise<string> {
    const resolvedRoot = path.resolve(root);
    if (this.server && this.root === resolvedRoot && this.baseUrl) return this.baseUrl;
    if (this.startPromise && this.root === resolvedRoot) return this.startPromise;
    this.startPromise = this.start(resolvedRoot).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  /** Push a reload to all connected browser pages. */
  reload(): void {
    for (const res of this.sseClients) {
      try {
        res.write("data: reload\n\n");
      } catch {
        /* client gone; the 'close' handler removes it */
      }
    }
  }

  dispose(): void {
    void this.stop();
  }

  // ---- internals ----------------------------------------------------------

  private async start(root: string): Promise<string> {
    await this.stop();
    this.root = root;
    const server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    this.baseUrl = `http://127.0.0.1:${port}/`;
    this.startWatching(root);
    return this.baseUrl;
  }

  private async stop(): Promise<void> {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
    for (const res of this.sseClients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.sseClients.clear();
    this.watcher?.dispose();
    this.watcher = undefined;
    const server = this.server;
    this.server = undefined;
    this.baseUrl = undefined;
    this.root = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private startWatching(root: string): void {
    this.watcher?.dispose();
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(root), "**/*"),
    );
    const bump = () => {
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => this.reload(), 150);
    };
    watcher.onDidChange(bump);
    watcher.onDidCreate(bump);
    watcher.onDidDelete(bump);
    this.watcher = watcher;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const root = this.root;
    if (!root) {
      res.writeHead(503);
      res.end("live server not ready");
      return;
    }
    const urlPath = (req.url ?? "/").split("?")[0];
    if (urlPath === LIVERELOAD_PATH) {
      this.handleSse(res);
      return;
    }
    const result = serveStatic(root, req.url ?? "/");
    res.writeHead(result.status, {
      "content-type": result.contentType,
      "cache-control": "no-store",
    });
    res.end(result.body);
  }

  private handleSse(res: http.ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    this.sseClients.add(res);
    res.on("close", () => this.sseClients.delete(res));
  }
}
