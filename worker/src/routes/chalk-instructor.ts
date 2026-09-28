// #1298 — instructor-mode routes for Chalk lesson authoring.
// Mounted at admin.route('/', chalkInstructor); paths are under /chalk/.
import { Hono } from "hono";
import type { Env } from "../env";
import { authorizeIssuer } from "../lib/instructor-auth";

export const chalkInstructor = new Hono<{ Bindings: Env }>();

// #1298 — instructor-mode identity check. Any valid, un-revoked issuer token
// returns 200 + scopes. A student token or an absent Bearer → 401/403.
// The Studio extension calls this after token entry to decide whether to open
// the instructor chat panel. No cohort is required: the token itself carries
// the scopes, and the client is only asking "am I an instructor?".
chalkInstructor.get("/chalk/whoami", async (c) => {
  const result = await authorizeIssuer({ env: c.env, req: { header: (k) => c.req.header(k) } });
  if (result === null) return c.json({ error: "no bearer token" }, 401);
  if (result instanceof Response) return result;
  const { payload } = result;
  return c.json({
    role: payload.role,
    cohorts: (payload.scopes ?? []).map((s) => s.cohort),
  });
});

// #1298 — versioned instructor system prompt. The client fetches this once at
// instructor-mode activation and uses it as the system prompt for instructor
// chat turns. Stored server-side so updates reach all clients without a build.
// Version is a monotonic integer; the client may cache and skip re-fetch when
// the cached version matches.
const INSTRUCTOR_BRIEF_VERSION = 2;
const INSTRUCTOR_BRIEF_TEXT = `You are an AI assistant helping a course instructor author Chalk lessons. Reply in Korean.

Chalk lesson authoring workflow:
1. Call chalk_set_inputs to record the input context (audience, assets, teaching style, requirements, format).
2. Call chalk_recommend_methods — the server selects methods using the vocabulary. Explain the recommendations to the instructor.
3. Call chalk_generator_brief to retrieve the generation guidelines bundle.
4. Open the lesson plan working copy in the editor (chalk/<course>/ folder) and draft the lesson plan using Read, Edit, and Write.
5. Call chalk_save_plan to save and run automated checks. Review the check results.
6. Repeat steps 4–5 for up to 3 revision cycles based on check results or instructor feedback.

Rules:
- Use only the teaching methods the server recommends (chalk_recommend_methods). Do not substitute another method.
- Vocabulary keys must come from the vocab:* namespace only.
- Confirm with the instructor before applying structural changes.

Student coach prompts do not apply here.`;

chalkInstructor.get("/chalk/instructor-brief", async (c) => {
  const result = await authorizeIssuer({ env: c.env, req: { header: (k) => c.req.header(k) } });
  if (result === null) return c.json({ error: "no bearer token" }, 401);
  if (result instanceof Response) return result;
  const requestedVersion = Number(c.req.query("version") ?? 0);
  if (requestedVersion === INSTRUCTOR_BRIEF_VERSION) {
    return c.json({ id: "chalk-instructor-brief", version: INSTRUCTOR_BRIEF_VERSION, text: null, up_to_date: true });
  }
  return c.json({ id: "chalk-instructor-brief", version: INSTRUCTOR_BRIEF_VERSION, text: INSTRUCTOR_BRIEF_TEXT });
});
