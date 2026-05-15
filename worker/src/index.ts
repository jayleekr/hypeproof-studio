import { Hono } from "hono";
import type { Env } from "./env";
import { chat } from "./routes/chat";
import { admin } from "./routes/admin";
// @ts-ignore — bundled as text by wrangler rules.
import adminHtml from "./ui/admin.html";

const app = new Hono<{ Bindings: Env }>();

// Friendly root → redirect to admin UI (which itself is access-gated)
app.get("/", (c) => {
  return new Response(adminHtml as unknown as string, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});

app.route("/v1", chat);
app.route("/admin", admin);

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));
app.onError((err, c) => {
  console.error("Worker error:", err);
  return c.json({ error: { message: String(err), type: "internal" } }, 500);
});

export default app;
