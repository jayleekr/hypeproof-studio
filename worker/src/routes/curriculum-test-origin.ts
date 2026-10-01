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
// cache can keep serving it. No service worker can be installed on a test origin: a request
// carrying `Service-Worker: script` is answered as an absent file, so a student page that
// registers one (an offline PWA) cannot keep serving the product from its own cache after
// the link ends; a 410 also asks the browser to clear the origin's HTTP cache, and only that:
// every link of a project shares its origin, so clearing storage would end the visit sessions
// and repeated-use pseudonyms of the project's other, still-live links (CR-65, CR-73). A link
// serves only its experiment's pinned version (the variant's when it names one), never the
// project's newest (CR-22). Camera and microphone are denied by Permissions-Policy unless the
// experiment declares them, and then only the participant's own browser prompt can grant them
// (CR-66).
//
// Participant sessions (CR-21, CR-73): the entry page carries a candidate session id and its
// signed session token, and writes nothing. The injected snippet keeps the visit's session in
// sessionStorage (a reload, a back navigation or a link back to the entry page reuses it) and
// opens it once, with `POST /l/:link/__hp/session`, which records it attributed to project,
// experiment, version and channel. A fetch that runs no script (a link-preview bot) opens no
// session. The open is constant cost: one counter row in D1, one session key on R2.

import { Hono, type Context } from "hono";
import type { Env } from "../env";
import { resolveProfile } from "../lib/modules";
import { curriculumRuntimeAllowed } from "../lib/moderation";
import { LINK_ID, linkState, pinnedVersion } from "../lib/curriculum/venture";
import { admitLinkRate, getExperiment, getLink, getProject, getVersion, releaseSession, reserveSession } from "../lib/curriculum/store";
import { matchTestOrigin, parseTestOrigin, projectLabel } from "../lib/curriculum/test-origin";
import { EVIDENCE_LIMITS, PUBLISHED_HOST, appendParticipantEvents, openParticipantSession, participantEvents, participantRecord, type R2Like } from "../lib/curriculum/participant-record";
import { newSessionId, signSessionToken, verifySessionToken } from "../lib/curriculum/session-token";
import { injectSnippet } from "../lib/curriculum/participant-snippet";
import { PUBLISH_LIMITS, testFileKey } from "./curriculum";

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

/**
 * A link that ended. `Clear-Site-Data: "cache"` drops the origin's HTTP cache (CR-19 "including
 * from a cache"; no service worker can exist here, see `serve`). Never `"storage"`: the origin is
 * the project's, shared by all its links, so it would wipe a live sibling link's open session and
 * its repeated-use pseudonym, and the student app's own saved state.
 */
const gone = () => new Response(null, { status: 410, headers: { ...baseHeaders(), "clear-site-data": '"cache"' } });
/** What a test origin answers for anything it does not serve: an unknown path, link or file. */
export const absent = () => new Response(null, { status: 404, headers: baseHeaders() });

export const testOriginApp = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();

type Live = {
  link: NonNullable<Awaited<ReturnType<typeof getLink>>>;
  project: NonNullable<Awaited<ReturnType<typeof getProject>>>;
  experiment: NonNullable<Awaited<ReturnType<typeof getExperiment>>>;
  version: NonNullable<Awaited<ReturnType<typeof getVersion>>>;
  now: number;
};

/** The link as served right now, or the answer for it (absent, or gone once it ended). */
async function liveLink(c: Ctx, linkId: string): Promise<Live | Response> {
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
  return { link, project, experiment, version, now };
}

async function serve(c: Ctx, linkId: string, rest: string): Promise<Response> {
  // No service worker on a test origin (CR-19): its script fetch is answered as absent, so
  // registration fails and nothing can answer for the Service after the link ends.
  if (c.req.header("service-worker") !== undefined) return absent();
  const live = await liveLink(c, linkId);
  if (live instanceof Response) return live;
  const { link, experiment, version, now } = live;
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
  const rawInput = experiment.declarations?.raw_input?.fields;
  const cfg = { link: link.id, experiment: experiment.id, repeated_use: experiment.declarations?.repeated_use === true, link_expires_at: link.expires_at, ...(rawInput?.length ? { raw_input: rawInput } : {}) };
  if (path !== version.entry_html) return new Response(injectSnippet(html, cfg), { status: 200, headers });
  // The entry page offers a candidate session (random id, signed token) and records nothing:
  // the snippet keeps the visit's existing session when it has one, and opens a new one with
  // POST /l/:link/__hp/session only when it has none (CR-21: one visit, one session).
  const sessionId = newSessionId();
  const token = await signSessionToken({ link: link.id, session: sessionId, linkExpiresAt: link.expires_at, now }, c.env.HPS_SIGNING_SECRET);
  return new Response(injectSnippet(html, { ...cfg, session_id: sessionId, session_token: token.token }), { status: 200, headers });
}

/**
 * Open the participant session a served entry page offered (CR-21, CR-73). Idempotent: a
 * session already recorded answers 204 and counts once. Constant cost whatever the project
 * holds: the link's counter row (bounded per link) and one session key on R2.
 */
async function openSession(c: Ctx, linkId: string): Promise<Response> {
  const live = await liveLink(c, linkId);
  if (live instanceof Response) return live;
  const { link, project, experiment, now } = live;
  let token: unknown;
  let pseudonym: unknown;
  try {
    const raw = await c.req.text();
    if (raw.length > 2048) return absent();
    const body = JSON.parse(raw) as { token?: unknown; pseudonym?: unknown };
    token = body?.token;
    pseudonym = body?.pseudonym;
  } catch {
    return absent();
  }
  // cr-evidence (CR-65): the visit's pseudonym, random and made in the browser. Optional (a
  // page loaded before the event half shipped sends none); any other shape is refused.
  if (pseudonym !== undefined && pseudonym !== null && !(typeof pseudonym === "string" && /^pp-[0-9a-f]{32}$/.test(pseudonym))) return absent();
  const claims = await verifySessionToken(token, link.id, now, c.env.HPS_SIGNING_SECRET);
  if (!claims) return new Response(null, { status: 403, headers: baseHeaders() });
  const record = participantRecord(c.env.HPS_TRACES as unknown as R2Like, project.cohort_id, project.id);
  if ((await record.taskForSession(PUBLISHED_HOST, claims.session)) !== null) return new Response(null, { status: 204, headers: baseHeaders() });
  // cr-evidence (recon §6): opens per link and window, so a scripted client cannot fill the
  // link's session bound for real participants (cr-publish follow-up). Checked after the token,
  // so only pages the link really served count.
  if (!(await admitLinkRate(c.env.HPS_DB, link.id, "open", now, EVIDENCE_LIMITS.windowMs, EVIDENCE_LIMITS.opensPerWindow))) return new Response(null, { status: 429, headers: baseHeaders() });
  if (!(await reserveSession(c.env.HPS_DB, link.id, PUBLISH_LIMITS.maxSessionsPerLink))) return new Response(null, { status: 429, headers: baseHeaders() });
  let opened: Awaited<ReturnType<typeof openParticipantSession>>;
  try {
    opened = await openParticipantSession(record, { link, experiment, sessionId: claims.session, at: now, ...(typeof pseudonym === "string" ? { pseudonym } : {}) });
  } catch (e) {
    // Hand the reservation back only when a read confirms the session key is absent: a failure
    // after a successful write must not leave a recorded session uncounted, and when the read
    // itself fails the reservation is kept (counting one too many toward the per-link bound is
    // the safe side).
    const written = await record.taskForSession(PUBLISHED_HOST, claims.session).then(
      (task) => ({ read: true as const, task }),
      () => ({ read: false as const, task: null }),
    );
    if (written.read && written.task === null) await releaseSession(c.env.HPS_DB, link.id);
    throw e;
  }
  if (!opened.ok || !opened.created) await releaseSession(c.env.HPS_DB, link.id);
  if (!opened.ok) return absent();
  return new Response(null, { status: 204, headers: baseHeaders() });
}

/**
 * A refusal on the events route: a status, and its code in a header, with no body. A test origin
 * serves no JSON API, and an empty body leaves nothing for a `keepalive` fetch to hold open.
 */
const refused = (status: 400 | 403 | 409 | 413 | 429, code: string) => new Response(null, { status, headers: { ...baseHeaders(), "x-hp-refusal": code } });

/**
 * Participant events (cr-evidence #1394; recon §6 `POST <test-origin>/l/:link/events`; CR-21,
 * CR-23, CR-65, CR-67, CR-74). The link's state is read on every request: a revoked or expired
 * link answers 410 and writes nothing, whatever the session token's own expiry (CR-19). Then:
 * a valid session token of this link (403 otherwise), the session opened on the Service for
 * this link and experiment (409 until the snippet's open landed), the session's version still
 * the one the link serves (an unpublished or replaced version is refused), the link's rate
 * window (429), and the events themselves (`participantEvents`: no identity field, a variant in
 * a comparison experiment, a typed value only for a declared field). Stored in the
 * experiment's measurement-core record, nowhere else (SX-48).
 */
async function recordEvents(c: Ctx, linkId: string): Promise<Response> {
  const live = await liveLink(c, linkId);
  if (live instanceof Response) return live;
  const { link, project, experiment, version, now } = live;
  let body: { token?: unknown; events?: unknown };
  try {
    const raw = await c.req.text();
    if (raw.length > 65_536) return refused(413, "too_large");
    body = JSON.parse(raw);
  } catch {
    return refused(400, "invalid_json");
  }
  const claims = await verifySessionToken(body?.token, link.id, now, c.env.HPS_SIGNING_SECRET);
  if (!claims) return refused(403, "invalid_session_token");
  const record = participantRecord(c.env.HPS_TRACES as unknown as R2Like, project.cohort_id, project.id);
  const session = await record.sessionLink(PUBLISHED_HOST, claims.session);
  // An erased session (CR-69) is gone for good: a permanent refusal, so the page stops sending.
  if (!session && (await record.sessionDeleted(PUBLISHED_HOST, claims.session))) return refused(409, "session_deleted");
  if (!session || session.task !== experiment.id || !session.attribution || session.attribution.link !== link.id) return refused(409, "session_not_open");
  if (session.attribution.product_version !== version.id) return refused(409, "session_version_mismatch");
  // The session's own window first (per-session isolation on this path): one session re-sending
  // cannot spend the link's shared window that other participants' events need.
  if (!(await admitLinkRate(c.env.HPS_DB, link.id, `session:${claims.session}`, now, EVIDENCE_LIMITS.windowMs, EVIDENCE_LIMITS.eventBatchesPerSessionWindow))) return refused(429, "rate_limited");
  if (!(await admitLinkRate(c.env.HPS_DB, link.id, "event", now, EVIDENCE_LIMITS.windowMs, EVIDENCE_LIMITS.eventBatchesPerWindow))) return refused(429, "rate_limited");
  const built = participantEvents({ experiment, sessionId: claims.session, link: { attribution: session.attribution, ...(session.pseudonym ? { pseudonym: session.pseudonym } : {}) }, linkId: link.id, events: body?.events, now, pagePaths: new Set(version.files.map((f) => f.path)) });
  if (!built.ok) return refused(built.code === "session_event_limit" || built.code === "too_many_events" ? 413 : 400, built.code);
  try {
    await appendParticipantEvents(record, experiment.id, claims.session, built.events);
  } catch (e) {
    const code = e instanceof Error ? e.message : "";
    if (code === "conflicting_event" || code === "conflicting_sequence" || code === "session_deleted" || code === "session_not_open") return refused(409, code);
    if (/^(invalid_|missing_|identity_field|unsupported_)/.test(code)) return refused(400, code);
    throw e;
  }
  return new Response(null, { status: 204, headers: baseHeaders() });
}

testOriginApp.post("/l/:link/__hp/session", (c) => openSession(c, c.req.param("link")));
testOriginApp.post("/l/:link/__hp/events", (c) => recordEvents(c, c.req.param("link")));
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
