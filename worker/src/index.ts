import { Hono } from "hono";
import type { Env } from "./env";
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
// @ts-ignore — bundled as text by wrangler rules.
import issuerHtml from "./ui/issuer.html";
// @ts-ignore — bundled as text by wrangler rules.
import consoleHtml from "./ui/console.html";

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
app.use("/admin/*", signingSecretGuard);

// Friendly root → redirect to admin UI (which itself is access-gated)
app.get("/", () => {
  return new Response(adminHtml as unknown as string, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});

// Self-service issuer UI — instructor pastes their issuer token, mints
// student tokens. NOT under /admin/* because the form needs to be reachable
// without admin Basic auth; the POST it submits IS still authed (Bearer
// issuer-token, scope-checked by the endpoint).
app.get("/issuer", () => {
  return new Response(issuerHtml as unknown as string, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});

// #352 — instructor session console: open/close the cohort session on the
// right track and bulk-mint student tokens, lecture-day proof. Same auth
// model as /issuer: page is public, every API call it makes carries the
// instructor's Bearer issuer token and is scope-checked server-side.
app.get("/console", () => {
  return new Response(consoleHtml as unknown as string, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});

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
