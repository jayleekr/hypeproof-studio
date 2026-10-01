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
// correlate responses by a monotonic `id`. Events (no `id`) reach only listeners
// registered with `onEvent` (CR-05, recon R1): the flat session tags each event with
// its `sessionId`, and only events of the attached page session are delivered.
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

/** A CDP event of the attached page session. */
export interface CdpEvent {
  method: string;
  params: Record<string, any>;
}

export class CdpSession {
  private readonly raw: RawCdpSession;
  private msgId = 0;
  private sessionId: string | undefined;
  private attaching: Promise<void> | undefined;
  private readonly eventListeners = new Set<(event: CdpEvent) => void>();
  private eventSub: RawCdpDisposable | undefined;

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

  /**
   * Subscribe to events of the attached page session (messages without an `id` whose
   * `sessionId` is ours). Events of other sessions, root-session events and responses
   * are never delivered. A throwing listener does not stop the others.
   */
  onEvent(listener: (event: CdpEvent) => void): RawCdpDisposable {
    this.eventListeners.add(listener);
    this.eventSub ??= this.raw.onDidReceiveMessage((raw) => {
      const m = raw as { id?: unknown; method?: unknown; params?: unknown; sessionId?: unknown };
      if (!m || m.id !== undefined || typeof m.method !== "string") return;
      if (!this.sessionId || m.sessionId !== this.sessionId) return;
      const event: CdpEvent = {
        method: m.method,
        params: m.params && typeof m.params === "object" ? (m.params as Record<string, any>) : {},
      };
      for (const fn of [...this.eventListeners]) {
        try {
          fn(event);
        } catch {
          /* one listener's bug must not starve the others */
        }
      }
    });
    return {
      dispose: () => {
        this.eventListeners.delete(listener);
        if (this.eventListeners.size === 0 && this.eventSub) {
          this.eventSub.dispose();
          this.eventSub = undefined;
        }
      },
    };
  }

  close(): Promise<void> {
    this.eventSub?.dispose();
    this.eventSub = undefined;
    this.eventListeners.clear();
    return Promise.resolve(this.raw.close());
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
