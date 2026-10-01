// The published test runtime (cr-publish #1393; recon §6 `GET <test-origin>/l/:link/*`;
// CR-18, CR-19, CR-21, CR-22, CR-66, CR-73).
//
// Served on a dedicated origin per project (`HPS_TEST_ORIGIN`, lib/curriculum/test-origin.ts),
// dispatched by host in src/index.ts before any API route, so nothing of the API (and no
// cookie or Basic auth of it) is same-origin with a student's page. No login: a participant
// opens the link on a phone and the product runs (CR-18).
//
// Each request re-reads the link: a revoked or expired link answers 410 with no body, for
// every path it used to serve (CR-19), and every response is `Cache-Control: no-store` so no
// cache can keep serving it. A link serves only its experiment's pinned version (the
// variant's when it names one), never the project's newest (CR-22). Camera and microphone
// are denied by Permissions-Policy unless the experiment declares them, and then only the
// participant's own browser prompt can grant them (CR-66). The entry page load opens a
// participant session attributed to project, experiment, version and channel (CR-21, CR-73)
// and carries its session token in the injected snippet.

import { Hono, type Context } from "hono";
import type { Env } from "../env";
import { resolveProfile } from "../lib/modules";
import { curriculumRuntimeAllowed } from "../lib/moderation";
import { LINK_ID, linkState, pinnedVersion } from "../lib/curriculum/venture";
import { getExperiment, getLink, getProject, getVersion } from "../lib/curriculum/store";
import { matchTestOrigin, parseTestOrigin, projectLabel } from "../lib/curriculum/test-origin";
import { openParticipantSession, participantRecord, type R2Like } from "../lib/curriculum/participant-record";
import { newSessionId, signSessionToken } from "../lib/curriculum/session-token";
import { injectSnippet } from "../lib/curriculum/participant-snippet";
import { testFileKey } from "./curriculum";

type Ctx = Context<{ Bindings: Env; Variables: { requestId: string } }>;

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
};
const typeOf = (path: string) => TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** Headers on every answer of a test origin, content or not. */
function baseHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

/**
 * The served page's policy. `connect-src 'self'` (recon §6): the page talks only to its own
 * origin; cr-gateway adds the Service origin for app capability calls. Devices: denied
 * unless declared (CR-66), and then allowed for this origin only, behind the browser prompt.
 */
export function pageHeaders(devices: readonly string[]): Record<string, string> {
  const allow = (d: string) => (devices.includes(d) ? "(self)" : "()");
  return {
    ...baseHeaders(),
    "content-security-policy": "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    "permissions-policy": `camera=${allow("camera")}, microphone=${allow("microphone")}, geolocation=(), display-capture=()`,
  };
}

const gone = () => new Response(null, { status: 410, headers: baseHeaders() });
/** What a test origin answers for anything it does not serve: an unknown path, link or file. */
export const absent = () => new Response(null, { status: 404, headers: baseHeaders() });

export const testOriginApp = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();

async function serve(c: Ctx, linkId: string, rest: string): Promise<Response> {
  const origin = parseTestOrigin(c.env.HPS_TEST_ORIGIN, c.env.ENVIRONMENT);
  if (!origin.ok) return absent();
  const match = matchTestOrigin(origin.config, new URL(c.req.url));
  if (!match || !LINK_ID.test(linkId)) return absent();
  const db = c.env.HPS_DB;
  const link = await getLink(db, linkId);
  if (!link) return absent();
  const project = await getProject(db, link.project_id);
  // A link is served only from its own project's origin (origin isolation between teams).
  if (!project || (match.project_label !== null && match.project_label !== projectLabel(project.id))) return absent();
  // The CR switch of the link's project (recon R3): off answers as an unknown path of a test
  // origin does (an empty 404), so a switched-off link and one that never existed look alike.
  const resolved = await resolveProfile(c.env, project.profile_id);
  if (!resolved || !curriculumRuntimeAllowed(resolved.profile)) return absent();
  const now = Date.now();
  if (linkState(link, now) !== "live") return gone();
  const experiment = await getExperiment(db, link.experiment_id);
  const versionId = experiment ? pinnedVersion(experiment, link.variant_id) : null;
  const version = versionId ? await getVersion(db, project.id, versionId) : null;
  if (!experiment || !version) return absent();
  if (rest === "") {
    // The entry page by its own path, so its relative references resolve.
    return new Response(null, { status: 302, headers: { ...baseHeaders(), location: `/l/${link.id}/${version.entry_html.split("/").map(encodeURIComponent).join("/")}` } });
  }
  let path: string;
  try {
    path = decodeURIComponent(rest);
  } catch {
    return absent();
  }
  if (!version.files.some((f) => f.path === path)) return absent();
  const object = await c.env.HPS_TRACES.get(testFileKey(version.id, path));
  if (!object) return absent();
  const devices = experiment.declarations?.devices ?? [];
  const headers = { ...pageHeaders(devices), "content-type": typeOf(path) };
  if (!/\.html?$/i.test(path)) return new Response(await object.arrayBuffer(), { status: 200, headers });
  const html = await object.text();
  const cfg = { link: link.id, experiment: experiment.id, repeated_use: experiment.declarations?.repeated_use === true, link_expires_at: link.expires_at };
  if (path !== version.entry_html) return new Response(injectSnippet(html, cfg), { status: 200, headers });
  // The entry page load is a new participant session (CR-21): random id, attributed on the record.
  const sessionId = newSessionId();
  const opened = await openParticipantSession(participantRecord(c.env.HPS_TRACES as unknown as R2Like, project.cohort_id, project.id), {
    link,
    experiment,
    sessionId,
    at: now,
  });
  if (!opened.ok) return absent();
  const token = await signSessionToken({ link: link.id, session: sessionId, linkExpiresAt: link.expires_at, now }, c.env.HPS_SIGNING_SECRET);
  return new Response(injectSnippet(html, { ...cfg, session_id: sessionId, session_token: token.token }), { status: 200, headers });
}

testOriginApp.get("/l/:link", (c) => serve(c, c.req.param("link"), ""));
testOriginApp.get("/l/:link/", (c) => serve(c, c.req.param("link"), ""));
testOriginApp.get("/l/:link/*", (c) => {
  const linkId = c.req.param("link");
  const prefix = `/l/${linkId}/`;
  const p = new URL(c.req.url).pathname;
  return serve(c, linkId, p.startsWith(prefix) ? p.slice(prefix.length) : "");
});
testOriginApp.all("*", () => absent());

/** Is this request for a test origin? Read before any API route (src/index.ts). */
export function isTestOriginRequest(env: Env, url: string): boolean {
  const origin = parseTestOrigin(env.HPS_TEST_ORIGIN, env.ENVIRONMENT);
  return origin.ok && matchTestOrigin(origin.config, new URL(url)) !== null;
}
