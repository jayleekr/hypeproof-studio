import { Hono } from "hono";
import { resolveChalkOrigin, resolveWorkerVersion, type Env } from "./env";
import { chat } from "./routes/chat";
import { messages } from "./routes/messages";
import { trace } from "./routes/trace";
import { logs } from "./routes/logs";
import { admin } from "./routes/admin";
import { report } from "./routes/report";
import { runHeartbeat } from "./cron/heartbeat.ts";
import { runD1Backup } from "./cron/d1-backup.ts";
import { requestId, makeErrorBody } from "./middleware/request-id.ts";
import { signingSecretGuard } from "./middleware/signing-secret.ts";
import { TokenError } from "./lib/tokens.ts";
// @ts-ignore — bundled as text by wrangler rules.
import adminHtml from "./ui/admin.html";

const app = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();

// S-07 (#49): stamp request_id on every request. Echoed in x-request-id
// header + structured error body so operators can correlate user reports
// with wrangler tail logs.
app.use("*", requestId);

// #258 — fail closed (503 in production) on token-authenticated routes when
// the signing secret is missing/weak/placeholder. /v1/report is deliberately
// exempt (REQ-H6: anonymous bug reporting survives config breakage), as is
// /v1/health (no token involved).
app.use("/v1/chat/*", signingSecretGuard);
app.use("/v1/messages", signingSecretGuard);
// The exact-path line above does NOT cover subpaths — /v1/messages/count_tokens
// (#282 count_tokens passthrough) needs its own wildcard mount.
app.use("/v1/messages/*", signingSecretGuard);
app.use("/v1/profile", signingSecretGuard);
app.use("/v1/trace/*", signingSecretGuard);
app.use("/v1/logs/*", signingSecretGuard);
app.use("/admin/*", signingSecretGuard);

// Friendly root → redirect to admin UI (which itself is access-gated).
// The canonical health payload is GET /v1/health (routes/chat.ts), whose
// JSON `version` field reports the worker version (task C). This route
// carries the same value as an x-hps-worker-version response header too —
// a `curl -I /` answer for free — without touching the existing HTML body
// or its guard-exemption contract (route-order.test.mjs asserts `/` stays
// a 200 text/html page).
app.get("/", (c) => {
  return new Response(adminHtml as unknown as string, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-hps-worker-version": resolveWorkerVersion(c.env),
    },
  });
});

// Instructor pages moved to Chalk (plan task F, docs/plan/vessel-and-modules.md
// §2): /issuer (self-service student-token mint, PR #61) and /console (#352
// session console) are Surface-layer, c* train — an instructor-facing edit
// must not ship inside this participant-runtime artifact. Bookmarked links
// and KakaoTalk `#t=<issuer token>` links keep working: a 302 whose Location
// carries no fragment makes the browser re-attach the original fragment
// (RFC 7231 §7.1.2), so the token reaches Chalk's page without ever crossing
// the wire. 302, not 301/308 — a cached permanent redirect would outlive a
// future hostname change. Still guard-exempt (route-order.test.mjs).
for (const page of ["/issuer", "/console"] as const) {
  app.get(page, (c) => c.redirect(`${resolveChalkOrigin(c.env)}${page}`, 302));
}

app.route("/v1", chat);
// #282 — Anthropic-native Agent SDK gateway (POST /v1/messages). Own router,
// same /v1 base; the chat router doesn't define /messages so no shadowing.
app.route("/v1", messages);
app.route("/v1/trace", trace);
app.route("/v1/logs", logs);
app.route("/v1/report", report);
app.route("/admin", admin);

app.notFound((c) =>
  c.json(makeErrorBody(c, "not_found", "endpoint not found", { path: c.req.path }), 404),
);
app.onError((err, c) => {
  const rid = c.get("requestId") ?? "no-request-id";
  // Full detail (message + stack) to logs ONLY — never to the client (#257).
  // Operator pastes the request_id and Jay greps Workers Logs
  // (`wrangler tail | grep <rid>`).
  console.error(`[${rid}] worker error:`, err);
  // Whitelist: TokenError carries curated, user-facing prose (auth UX must
  // not regress to "unexpected server error"). Everything else gets a
  // generic message — raw err.message can leak internals (dependency
  // errors, binding names, data shapes).
  if (err instanceof TokenError) {
    return c.json(makeErrorBody(c, "auth", err.message, { code: err.code }), 401);
  }
  return c.json(
    makeErrorBody(c, "internal", "unexpected server error — quote this request_id to the operator"),
    500,
  );
});

// Default export is { fetch, scheduled }. Hono's app exposes .fetch directly;
// scheduled is our cron entry point — currently just the 15-min heartbeat,
// but S-06 (D1 backup) will add a daily cron and dispatch by event.cron.
export default {
  fetch: app.fetch,
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Dispatch by cron pattern. Currently:
    //   "*/15 * * * *" → 15-min heartbeat (#45 / S-02)
    //   "0 17 * * *"   → D1 nightly backup to R2 at 17:00 UTC = 02:00 KST (#52 / S-06)
    if (controller.cron === "0 17 * * *") {
      ctx.waitUntil(
        runD1Backup(env)
          .then((r) => console.log("d1-backup", JSON.stringify({
            ok: r.ok, object_key: r.object_key, total_rows: r.total_rows,
            total_bytes: r.total_bytes, retain_deleted: r.retain_deleted.length,
            error: r.error,
          })))
          .catch((err) => console.error("d1-backup crashed:", err)),
      );
      return;
    }
    // Default: 15-min heartbeat.
    ctx.waitUntil(
      runHeartbeat(env)
        .then((r) => console.log("heartbeat", JSON.stringify(r)))
        .catch((err) => console.error("heartbeat crashed:", err)),
    );
  },
} satisfies ExportedHandler<Env>;
