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
