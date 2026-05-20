import { Hono } from "hono";
import type { Env } from "./env";
import { chat } from "./routes/chat";
import { trace } from "./routes/trace";
import { admin } from "./routes/admin";
import { runHeartbeat } from "./cron/heartbeat.ts";
// @ts-ignore — bundled as text by wrangler rules.
import adminHtml from "./ui/admin.html";

const app = new Hono<{ Bindings: Env }>();

// Friendly root → redirect to admin UI (which itself is access-gated)
app.get("/", () => {
  return new Response(adminHtml as unknown as string, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});

app.route("/v1", chat);
app.route("/v1/trace", trace);
app.route("/admin", admin);

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));
app.onError((err, c) => {
  console.error("Worker error:", err);
  return c.json({ error: { message: String(err), type: "internal" } }, 500);
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
    // Run-to-completion is important for KV writes; waitUntil keeps the
    // isolate alive past the scheduled() return.
    ctx.waitUntil(
      runHeartbeat(env)
        .then((r) => {
          // Cheap operational log — visible in `wrangler tail`.
          console.log("heartbeat", JSON.stringify(r));
        })
        .catch((err) => {
          console.error("heartbeat crashed:", err);
        }),
    );
    // controller.cron will be "*/15 * * * *" today; left here for future dispatch.
    void controller;
  },
} satisfies ExportedHandler<Env>;
