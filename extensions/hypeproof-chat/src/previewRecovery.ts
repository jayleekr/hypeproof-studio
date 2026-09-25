// #751 U4 — what "the preview came back" means. Pure: no vscode, no http.
//
// The server answering is not the learner's page opening: the live server answers a missing page with 404, and a check
// that accepted "anything below 500" counted that 404 as a recovery. The page that matters is the one the learner had
// open — its PATH, because the address (a random port) dies with the server.

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i;
export const isLoopbackPreview = (url: string | undefined): boolean => !!url && LOOPBACK.test(url);

/** Path + query of a loopback preview tab; "/" when there is none. Never an absolute URL: it is re-joined to the NEW base only. */
export function previewPagePath(tabUrl: string | undefined): string {
  if (!isLoopbackPreview(tabUrl)) return "/";
  try { const u = new URL(tabUrl as string); return (u.pathname || "/") + u.search; } catch { return "/"; }
}
/** The page on the running server. A path can only ever resolve under `base`; anything else falls back to the base itself. */
export function previewPageUrl(base: string, pagePath: string): string {
  try { const u = new URL(pagePath.startsWith("/") ? pagePath : "/" + pagePath, base); return u.origin === new URL(base).origin ? u.toString() : base; } catch { return base; }
}
export type ArtifactState = "opened" | "missing" | "unreachable";
/** 2xx with a document = opened. 4xx = the server is fine and the page is not there. No answer or 5xx = unreachable. */
export function classifyArtifact(status: number | null, contentType: string | null): ArtifactState {
  if (status === null || status >= 500) return "unreachable";
  if (status >= 200 && status < 300) return /^(text\/html|application\/xhtml\+xml)/i.test(contentType ?? "") ? "opened" : "missing";
  return "missing";
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"];
/**
 * A tab belongs to the learner's preview server only when it is on THAT server: same scheme and port as the address the
 * server had before the action (the two loopback spellings count as one host). Any other localhost tab is someone else's.
 */
export function isTabOfServer(tabUrl: string | undefined, serverBase: string | undefined): boolean {
  if (!tabUrl || !serverBase) return false;
  try {
    const t = new URL(tabUrl), b = new URL(serverBase);
    return t.protocol === b.protocol && t.port === b.port && LOOPBACK_HOSTS.includes(t.hostname) && LOOPBACK_HOSTS.includes(b.hostname);
  } catch { return false; }
}
const sameDocument = (a: string, b: string): boolean => { try { const x = new URL(a), y = new URL(b); x.hash = ""; y.hash = ""; return x.href === y.href; } catch { return false; } };

/** What the learner's own preview tabs showed afterwards: every one loaded its page anew / not all did / there were none. */
export type PreviewTabsState = "loaded" | "not_loaded" | "none";
export interface PreviewRecoveryDeps<T extends { readonly url: string | undefined }> {
  tabs(): readonly T[];
  /** The running server's base URL NOW (before recovery); undefined when nothing serves. */
  serverUrl(): string | undefined;
  /** Reload a healthy server, or start it again (new port). */
  recover(): Promise<{ state: "no_preview" | "reloaded" | "restarted"; url?: string }>;
  fetchPage(url: string): Promise<{ status: number | null; contentType: string | null }>;
  /** Load `url` in THIS tab (never another) and report the document it then holds; null when the tab is gone or unreachable. */
  load(tab: T, url: string): Promise<{ href: string; complete: boolean; fresh: boolean } | null>;
  close(tab: T): Promise<void>;
  open(url: string): Promise<T | undefined>;
}
/**
 * #751 U4 — bring back the learner's OWN preview: only tabs on the server the learner had before the action, each at its own
 * path. Nothing else is read for a path, navigated or closed. "Loaded" is what the tab itself reported afterwards (a fresh
 * document at that address that finished loading) — an HTTP answer to this host is not the learner's tab showing it.
 */
export async function recoverLearnerPreview<T extends { readonly url: string | undefined }>(deps: PreviewRecoveryDeps<T>, preferred?: T): Promise<{ state: "no_preview" | "reloaded" | "restarted"; artifact: ArtifactState; tabs: PreviewTabsState }> {
  const before = deps.serverUrl();
  const own = before ? deps.tabs().filter((t) => isTabOfServer(t.url, before)) : [];
  const primary = preferred && own.includes(preferred) ? preferred : own[0];
  const r = await deps.recover();
  if (r.state === "no_preview" || !r.url) return { state: "no_preview", artifact: "unreachable", tabs: "none" };
  const base = r.url;
  const judge = async (url: string): Promise<ArtifactState> => { try { const res = await deps.fetchPage(url); return classifyArtifact(res.status, res.contentType); } catch { return "unreachable"; } };
  if (!own.length) return { state: r.state, artifact: await judge(previewPageUrl(base, previewPagePath(undefined))), tabs: "none" };
  // Every page a tab will be said to show is judged on its own — the primary tab's page answering says nothing about another
  // tab's path. One page that is missing or does not answer is the artifact state for the whole action, and no tab moves.
  const targets = [primary, ...own.filter((t) => t !== primary)].map((tab) => ({ tab, url: previewPageUrl(base, previewPagePath(tab!.url)) }));
  const pages = new Map<string, ArtifactState>();
  for (const { url } of targets) if (!pages.has(url)) pages.set(url, await judge(url));
  const states = [...pages.values()];
  const artifact: ArtifactState = states.includes("unreachable") ? "unreachable" : states.includes("missing") ? "missing" : "opened";
  if (artifact !== "opened") return { state: r.state, artifact, tabs: "not_loaded" };
  let all = true;
  for (const { tab: owned, url: target } of targets) {
    const tab = owned!;
    const shown = (d: { href: string; complete: boolean; fresh: boolean } | null) => !!d && d.complete && d.fresh && sameDocument(d.href, target);
    if (shown(await deps.load(tab, target).catch(() => null))) continue;
    // Only a tab of the learner's own dead server is replaced, and only by the same page on the running one.
    let replaced = false;
    if (r.state === "restarted") {
      try { await deps.close(tab); const next = await deps.open(target); replaced = !!next && shown(await deps.load(next, target).catch(() => null)); } catch { replaced = false; }
    }
    all &&= replaced;
  }
  return { state: r.state, artifact, tabs: all ? "loaded" : "not_loaded" };
}
