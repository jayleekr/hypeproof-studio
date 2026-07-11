// #278 Phase 3 — shared CDP session over the `browser` proposed API's raw
// startCDPSession() channel.
//
// The 2026-07-11 spike (run inside a real Studio window) established:
//   - Page-level CDP domains (Runtime/DOM/Input/Page/Accessibility) are NOT
//     reachable on the root session — commands fail with "Method not found"
//     until a Target.attachToTarget({flatten:true}) handshake is done, and
//     every subsequent command must carry the returned sessionId.
//   - That sessionId SURVIVES cross-origin navigation (no per-nav re-attach).
//   - Input.dispatch* events land real clicks/keystrokes.
// So: attach once, cache the sessionId, route all commands through it.
//
// The channel is fire-and-forget (sendMessage + onDidReceiveMessage), so we
// correlate responses by a monotonic `id`. Events (no `id`) are ignored — the
// executor drives synchronously (evaluate/wait), it doesn't consume CDP events.
//
// Typed structurally (no `vscode` import) so the handshake logic is unit-
// testable under `node --strip-types` with a mock session. vscode.BrowserTab /
// vscode.BrowserCDPSession satisfy these shapes at the call sites.

export interface RawCdpDisposable {
  dispose(): void;
}
export interface RawCdpSession {
  onDidReceiveMessage(listener: (message: unknown) => void): RawCdpDisposable;
  onDidClose(listener: () => void): RawCdpDisposable;
  sendMessage(message: unknown): Thenable<void>;
  close(): Thenable<void>;
}
export interface CdpTab {
  startCDPSession(): Thenable<RawCdpSession>;
}

export class CdpSession {
  private readonly raw: RawCdpSession;
  private msgId = 0;
  private sessionId: string | undefined;
  private attaching: Promise<void> | undefined;

  private constructor(raw: RawCdpSession) {
    this.raw = raw;
  }

  /** Open a CDP session on `tab` and complete the page-target attach handshake. */
  static async attach(tab: CdpTab): Promise<CdpSession> {
    const raw = await tab.startCDPSession();
    const session = new CdpSession(raw);
    await session.ensureAttached();
    return session;
  }

  /** Send a CDP command to the attached page target. */
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<any> {
    return this.request(method, params, this.sessionId, timeoutMs);
  }

  onDidClose(listener: () => void): RawCdpDisposable {
    return this.raw.onDidClose(listener);
  }

  close(): Thenable<void> {
    return this.raw.close();
  }

  private async ensureAttached(): Promise<void> {
    if (this.sessionId) return;
    if (this.attaching) return this.attaching;
    this.attaching = (async () => {
      // Discover the page target and attach (flatten → sessionId routing).
      await this.request("Target.setDiscoverTargets", { discover: true }, undefined, 10_000).catch(() => {
        /* best-effort; getTargets below is the real probe */
      });
      const targets = await this.request("Target.getTargets", {}, undefined, 10_000);
      const infos: Array<{ type?: string; targetId?: string }> = targets?.targetInfos ?? [];
      const page = infos.find((t) => t.type === "page");
      if (!page?.targetId) throw new Error("CDP: no page target to attach to");
      const attached = await this.request(
        "Target.attachToTarget",
        { targetId: page.targetId, flatten: true },
        undefined,
        10_000,
      );
      const sid = attached?.sessionId;
      if (typeof sid !== "string" || sid.length === 0) {
        throw new Error("CDP: Target.attachToTarget returned no sessionId");
      }
      this.sessionId = sid;
    })();
    try {
      await this.attaching;
    } finally {
      this.attaching = undefined;
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
    timeoutMs: number,
  ): Promise<any> {
    const id = ++this.msgId;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.dispose();
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      const sub = this.raw.onDidReceiveMessage((raw) => {
        const m = raw as { id?: number; result?: unknown; error?: { message?: string } };
        if (!m || m.id !== id) return;
        clearTimeout(timer);
        sub.dispose();
        if (m.error) reject(new Error(m.error.message ?? `CDP ${method} failed`));
        else resolve(m.result);
      });
      void this.raw.sendMessage(
        sessionId ? { id, method, params, sessionId } : { id, method, params },
      );
    });
  }
}
