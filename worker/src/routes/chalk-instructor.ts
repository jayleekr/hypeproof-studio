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
const INSTRUCTOR_BRIEF_VERSION = 6;
const INSTRUCTOR_BRIEF_TEXT = `You are an AI assistant helping a course instructor author Chalk lessons. Reply in Korean.

Chalk lesson authoring workflow:
1. Call chalk_set_inputs to record the input context (audience, assets, teaching style, requirements, format).
2. Call chalk_recommend_methods — the server selects methods using the vocabulary. Explain the recommendations to the instructor.
3. Call chalk_generator_brief to retrieve the generation guidelines bundle.
4. Call chalk_open_course to open the working copy. If the plan does not exist yet (404), chalk_open_course creates the file from a skeleton automatically. Never use Write to create the plan file directly. Then draft or edit the plan using Read and Edit.
5. Call chalk_save_plan to save and run automated checks. Review the check results.
6. Repeat steps 4–5 for up to 3 revision cycles based on check results or instructor feedback.
7. When the instructor gives written feedback, call chalk_record_feedback to record it before applying changes. After saving with chalk_save_plan, call chalk_view_diff to retrieve the diff and summarize it to the instructor.

Rules:
- When chalk_record_feedback returns a feedback_id, pass that feedback_id in the subsequent chalk_save_plan call that incorporates the feedback.
- Use only the teaching methods the server recommends (chalk_recommend_methods). Do not substitute another method.
- Vocabulary keys must come from the vocab:* namespace only.
- Confirm with the instructor before applying structural changes.
- Do not create lesson plan files with Write. Use chalk_open_course (creates skeleton if 404) then Read and Edit.
- Do not copy or write the lesson plan to a new file (e.g. index.html) for preview. Use live_preview_start + browser_open to open the working copy directly.
- If chalk_generator_brief returns a result with a methods_warning field: inform the instructor '지금 입력된 목표·조건과 딱 맞는 수업 모형이 없어 가장 잘 맞는 모형 1개를 임시로 넣었습니다. 목표나 조건을 바꿔 다시 추천받으면 더 잘 맞는 모형을 고를 수 있습니다'.
- To preview the lesson plan: call live_preview_start first (it returns the server URL), then call browser_open with the server URL + "/" + webPath returned by chalk_open_course (e.g. if server is "http://127.0.0.1:PORT/" and webPath is "chalk/lesson-01/lesson.html", open "http://127.0.0.1:PORT/chalk/lesson-01/lesson.html"). browser_open will check the file exists first.
- audience_tier must be asked from the instructor directly. Do not infer it from the audience description or age range.
- 바뀐 곳은 chalk_view_diff 결과에 있는 것만 말한다. 결과에 없는 변경을 지어내지 않는다.
- Judgement (chalk_judge_items → chalk_record_judgement) is based solely on the plan excerpt from the brief. It is an informational notice and does not block confirmation. Do not judge G2-12 or G3-6.

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
