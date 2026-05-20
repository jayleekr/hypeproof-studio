// POST /v1/trace/event — persist Trial / Validation / HumanAction signals
// (#9). Auth mirrors chat.ts: same token + cohort + active session + roster
// gate. Turn metadata + body is captured by the chat.ts hook in 9c; this
// endpoint covers the *other* signals the chat call doesn't see.

import { Hono } from "hono";
import type { Env } from "../env";
import { bearer, verify, TokenError } from "../lib/tokens.ts";
import { getProfile } from "../profiles/index.ts";
import { getActiveSession, getRoster, isSessionLive } from "../lib/kv.ts";
import {
  createTrial,
  endTrial,
  recordValidation,
  recordHumanAction,
  type ValidationOutcome,
  type HumanActionKind,
} from "../lib/storage.ts";

export const trace = new Hono<{ Bindings: Env }>();

// Discriminated event union — the webview/host POSTs one of these.
export type TraceEvent =
  | { type: "trialStart"; task_label?: string }
  | { type: "trialEnd"; trial_id: string }
  | {
      type: "validationRun";
      trial_id: string;
      turn_id?: string;
      outcome: ValidationOutcome;
      errors_found?: number;
      errors_fixed?: number;
    }
  | {
      type: "humanAction";
      trial_id: string;
      turn_id?: string;
      kind: HumanActionKind;
      diff_chars?: number;
    };

const VALID_OUTCOMES: ValidationOutcome[] = ["pass", "fail", "partial", "error"];
const VALID_KINDS: HumanActionKind[] = ["accept", "reject", "edit", "replace"];

// Tiny payload validator — kept inline (no zod). Exported for direct testing.
export function parseEvent(
  j: unknown,
): { ok: true; event: TraceEvent } | { ok: false; message: string } {
  if (!j || typeof j !== "object") return { ok: false, message: "body must be a JSON object" };
  const o = j as Record<string, unknown>;
  const t = o.type;
  if (typeof t !== "string") return { ok: false, message: "missing 'type'" };

  switch (t) {
    case "trialStart": {
      if (o.task_label != null && typeof o.task_label !== "string") {
        return { ok: false, message: "task_label must be string" };
      }
      return {
        ok: true,
        event: { type: "trialStart", task_label: o.task_label as string | undefined },
      };
    }
    case "trialEnd": {
      if (typeof o.trial_id !== "string") return { ok: false, message: "trial_id required" };
      return { ok: true, event: { type: "trialEnd", trial_id: o.trial_id } };
    }
    case "validationRun": {
      if (typeof o.trial_id !== "string") return { ok: false, message: "trial_id required" };
      if (!isOutcome(o.outcome)) {
        return { ok: false, message: `outcome must be one of ${VALID_OUTCOMES.join(",")}` };
      }
      return {
        ok: true,
        event: {
          type: "validationRun",
          trial_id: o.trial_id,
          turn_id: typeof o.turn_id === "string" ? o.turn_id : undefined,
          outcome: o.outcome,
          errors_found: numOrUndef(o.errors_found),
          errors_fixed: numOrUndef(o.errors_fixed),
        },
      };
    }
    case "humanAction": {
      if (typeof o.trial_id !== "string") return { ok: false, message: "trial_id required" };
      if (!isKind(o.kind)) {
        return { ok: false, message: `kind must be one of ${VALID_KINDS.join(",")}` };
      }
      return {
        ok: true,
        event: {
          type: "humanAction",
          trial_id: o.trial_id,
          turn_id: typeof o.turn_id === "string" ? o.turn_id : undefined,
          kind: o.kind,
          diff_chars: numOrUndef(o.diff_chars),
        },
      };
    }
    default:
      return { ok: false, message: `unknown event type: ${t}` };
  }
}
function isOutcome(v: unknown): v is ValidationOutcome {
  return typeof v === "string" && (VALID_OUTCOMES as string[]).includes(v);
}
function isKind(v: unknown): v is HumanActionKind {
  return typeof v === "string" && (VALID_KINDS as string[]).includes(v);
}
function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

const BODY_MAX = 8 * 1024; // 8KB cap on event JSON (events are tiny by design)

trace.post("/event", async (c) => {
  const env = c.env;

  // 1-2. Auth (mirrors chat.ts — duplicated intentionally; factoring left as
  // a follow-up so we don't refactor the chat hot path during D-7).
  const token = bearer(c.req.header("authorization"));
  if (!token) return c.json({ error: { message: "missing bearer token", type: "auth" } }, 401);
  let payload;
  try {
    payload = await verify(token, env.HPS_SIGNING_SECRET);
  } catch (err) {
    const code = err instanceof TokenError ? err.code : "unknown";
    return c.json({ error: { message: String(err), type: "auth", code } }, 401);
  }

  // 3. Profile
  const profile = getProfile(payload.p);
  if (!profile) {
    return c.json({ error: { message: `unknown profile: ${payload.p}`, type: "config" } }, 400);
  }
  if (payload.c !== profile.session.cohort_id) {
    return c.json({ error: { message: "token cohort/profile mismatch", type: "auth" } }, 401);
  }

  // 4-5. Session + roster
  const session = await getActiveSession(env.HPS_KV, payload.c);
  if (!session) {
    return c.json({ error: { message: "no active session", type: "session_inactive" } }, 403);
  }
  if (!isSessionLive(session)) {
    return c.json({ error: { message: "session window closed", type: "session_window" } }, 403);
  }
  if (session.profile_id !== profile.id) {
    return c.json(
      { error: { message: "token is for a different profile", type: "session_profile_mismatch" } },
      403,
    );
  }
  const roster = await getRoster(env.HPS_KV, payload.c);
  if (!roster || !roster.users.includes(payload.u)) {
    return c.json({ error: { message: "not in roster", type: "not_in_roster" } }, 403);
  }

  // 6. Body size cap + parse
  const raw = await c.req.text();
  if (raw.length > BODY_MAX) {
    return c.json(
      { error: { message: `event body exceeds ${BODY_MAX} bytes`, type: "request" } },
      413,
    );
  }
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return c.json({ error: { message: "bad json body", type: "request" } }, 400);
  }
  const parsed = parseEvent(j);
  if (!parsed.ok) {
    return c.json({ error: { message: parsed.message, type: "request" } }, 400);
  }
  const ev = parsed.event;

  // 7. Dispatch. trialStart awaits the INSERT so the client gets the
  // server-assigned trial_id back. Other events are fire-and-forget via
  // waitUntil — they never block the ack.
  try {
    switch (ev.type) {
      case "trialStart": {
        const trial_id = await createTrial(env, {
          session_id: session.session_id ?? null,
          cohort_id: payload.c,
          user_id: payload.u,
          profile_id: profile.id,
          task_label: ev.task_label ?? null,
        });
        return c.json({ ok: true, trial_id });
      }
      case "trialEnd": {
        c.executionCtx.waitUntil(endTrial(env, ev.trial_id));
        return c.json({ ok: true });
      }
      case "validationRun": {
        c.executionCtx.waitUntil(recordValidation(env, ev));
        return c.json({ ok: true });
      }
      case "humanAction": {
        c.executionCtx.waitUntil(recordHumanAction(env, ev));
        return c.json({ ok: true });
      }
    }
  } catch (err) {
    return c.json({ error: { message: String(err), type: "storage" } }, 502);
  }
});
