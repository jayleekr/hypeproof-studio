// @ts-ignore — bundled as text by wrangler rules.
import budgetsHtml from './ui/budgets.html';
// Chalk — the instructor surface (docs/plan/vessel-and-modules.md §1, layer
// "Surface", tag prefix c*). Its own Cloudflare Worker (plan task F).
//
// Routes:
//   GET /health                      — { ok, service, version } (c* tag via HPS_CHALK_VERSION)
//   GET /                            — instructor home (#1145): every screen, including the missing ones
//   GET /shell.css                   — the one shared stylesheet
//   GET /shell.js                    — one sessionStorage key for the instructor code (no network calls)
//   GET /readiness|/rehearsal|/environment|/requests|/access — placeholders: layout + "개발 필요" + the issue that owns it
//   GET /console                     — instructor session console (#352)
//   GET /issuer                      — self-service student-token mint page
//   GET /board                       — instructor live board page (#674)
//   GET /admin/cohorts/:id/state     — read-only cohort state (issuer Bearer)   src/routes/state.ts
//   GET /admin/cohorts/:id/board     — live board JSON (issuer Bearer)          src/routes/board.ts
//   GET /admin/cohorts/:id/logs      — studio-logs arrival + roster diff (issuer)  src/routes/logs-admin.ts
//   GET /admin/cohorts/:id/logs/:seat            — per-session rows (issuer)        src/routes/logs-admin.ts
//   GET /admin/cohorts/:id/logs/:seat/:day/:session/:file — retrieval (OPERATOR)    src/routes/logs-admin.ts
//   *   /admin/*  (instructor writes) — forwarded to the Service                  src/routes/forward.ts
//
// What is NOT here, on purpose: any write to session/roster/pause/revocation
// state, any token signing, any admin-password path, any cron. Those are the
// Service's. See chalk/src/shared.ts for the one import boundary and
// chalk/README.md for the deploy order.

import { Hono } from "hono";
import { resolveChalkVersion, type ChalkEnv } from "./env.ts";
import { makeErrorBody, requestId, signingSecretGuard } from "./middleware.ts";
import { TokenError } from "./shared.ts";
import { state } from "./routes/state.ts";
import { board } from "./routes/board.ts";
import { logsAdmin } from "./routes/logs-admin.ts";
import { forwardInstructorWrite } from "./routes/forward.ts";
// @ts-ignore — bundled as text by wrangler rules.
import consoleHtml from "./ui/console.html";
// @ts-ignore — bundled as text by wrangler rules.
import issuerHtml from "./ui/issuer.html";
// @ts-ignore — bundled as text by wrangler rules.
import boardHtml from "./ui/board.html";
// @ts-ignore — bundled as text by wrangler rules.
import authoringHtml from "./ui/authoring.html";
// @ts-ignore — bundled as text by wrangler rules.
import manageHtml from "./ui/manage.html";
// @ts-ignore — bundled as text by wrangler rules.
import sharingHtml from "./ui/sharing.html";
// @ts-ignore — bundled as text by wrangler rules.
import startHtml from "./ui/start.html";
// @ts-ignore — bundled as text by wrangler rules.
import learnHtml from './ui/learn.html';
// @ts-ignore — bundled as text by wrangler rules (see wrangler.toml Text globs).
import shellCss from './ui/shell.css';
// @ts-ignore — bundled as text by wrangler rules (Text globs include .js here).
import shellJs from './ui/shell.js';
import { SOON, homePage, placeholderPage } from './ui/screens.ts';

const app = new Hono<{ Bindings: ChalkEnv; Variables: { requestId: string } }>();

app.use("*", requestId);

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "hypeproof-chalk",
    version: resolveChalkVersion(c.env),
    env: c.env.ENVIRONMENT,
  }),
);

const page = (html: unknown) =>
  new Response(html as string, { headers: { "content-type": "text/html; charset=utf-8" } });

// `/` is the instructor HOME (#1145 A-1), not a bounce to the session console.
// It used to 302 to /console, which dropped a first-time instructor straight into
// an in-session operations screen. The home lists every screen INCLUDING the ones
// that do not exist yet — the five real-cohort incidents behind #1145 were all
// "state looked different from what it was", and a surface that hides its own
// holes is the same failure in slower motion.
//
// Home and the placeholder pages ask for no credential and call nothing. They are
// rendered from one table (src/ui/screens.ts) so the home cannot claim a screen
// exists while the screen itself says "개발 필요".
app.get("/", () => page(homePage()));
// One stylesheet for every screen that has been moved onto the shared shell.
// authoring.html is deliberately NOT on it yet (weekly demo) — see shell.css.
app.get("/shell.css", () =>
  new Response(shellCss as string, {
    headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=300" },
  }),
);
// Binds the instructor code to ONE sessionStorage key across screens (#1145 A-3).
// It sends nothing anywhere — there is no fetch in it, and chalk/test pins that.
app.get("/shell.js", () =>
  new Response(shellJs as string, {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" },
  }),
);
for (const screen of SOON) {
  if (screen.state.kind !== "soon") continue;
  const html = placeholderPage(screen);
  app.get(screen.state.path, () => page(html));
}
// Pages are public; every API call they make carries the instructor's Bearer
// issuer token and is scope-checked server-side (here for reads, in the
// Service for writes). Outside the guard so a misconfigured secret shows a
// page with a clear API error instead of a bare 503.
app.get("/console", () => page(consoleHtml));
app.get("/start", () => page(startHtml));
app.get("/issuer", () => page(issuerHtml));
app.get("/board", () => page(boardHtml));
app.get("/authoring", () => page(authoringHtml));
app.get("/manage", () => page(manageHtml));
app.get("/budgets", () => page(budgetsHtml));
app.get("/sharing", () => page(sharingHtml));
app.get('/learn', () => page(learnHtml));
app.use('/v1/profile', signingSecretGuard);
app.get('/v1/profile', forwardInstructorWrite);
app.use("/v1/classroom/*", signingSecretGuard);
app.all("/v1/classroom/*", forwardInstructorWrite);

app.use("/admin/*", signingSecretGuard);
app.route("/admin", state);
app.route("/admin", board);
// #680 — studio-logs read path. Mounted before the forwarder so these reads are
// answered here and never proxied to the Service (which has no such route).
app.route("/admin", logsAdmin);
app.all("/admin/*", forwardInstructorWrite);

app.notFound((c) =>
  c.json(makeErrorBody(c, "not_found", "endpoint not found", { path: c.req.path }), 404),
);
app.onError((err, c) => {
  const rid = c.get("requestId") ?? "no-request-id";
  console.error(`[${rid}] chalk error:`, err);
  if (err instanceof TokenError) {
    return c.json(makeErrorBody(c, "auth", err.message, { code: err.code }), 401);
  }
  return c.json(
    makeErrorBody(c, "internal", "unexpected server error — quote this request_id to the operator"),
    500,
  );
});

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<ChalkEnv>;
