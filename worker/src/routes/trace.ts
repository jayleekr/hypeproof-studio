// POST /v1/trace/event — persist Trial / Validation / HumanAction signals
// (#9). Auth mirrors chat.ts: same token + cohort + active session + roster
// gate. Turn metadata + body is captured by the chat.ts hook in 9c; this
// endpoint covers the *other* signals the chat call doesn't see.

import { Hono } from "hono";
import type { Env } from "../env";
import { bearer, verify, TokenError } from "../lib/tokens.ts";
import { getProfile } from "../profiles/index.ts";
import { getActiveSession, getRoster, isSessionLive, bumpRateCounter } from "../lib/kv.ts";
import {
  createTrial,
  endTrial,
  recordValidation,
  recordHumanAction,
  verifyTrialOwnership,
  isUuid,
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
      // Cap task_label length so a single field can't fill the 8KB body cap
      // (security review F#8).
      const tl = typeof o.task_label === "string" ? o.task_label : undefined;
      if (tl && tl.length > 256) return { ok: false, message: "task_label too long (max 256)" };
      return {
        ok: true,
        event: { type: "trialStart", task_label: tl },
      };
    }
    case "trialEnd": {
      if (typeof o.trial_id !== "string" || !isUuid(o.trial_id))
        return { ok: false, message: "trial_id must be a uuid" };
      return { ok: true, event: { type: "trialEnd", trial_id: o.trial_id } };
    }
    case "validationRun": {
      if (typeof o.trial_id !== "string" || !isUuid(o.trial_id))
        return { ok: false, message: "trial_id must be a uuid" };
      if (o.turn_id != null && (typeof o.turn_id !== "string" || !isUuid(o.turn_id)))
        return { ok: false, message: "turn_id must be a uuid when provided" };
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
      if (typeof o.trial_id !== "string" || !isUuid(o.trial_id))
        return { ok: false, message: "trial_id must be a uuid" };
      if (o.turn_id != null && (typeof o.turn_id !== "string" || !isUuid(o.turn_id)))
        return { ok: false, message: "turn_id must be a uuid when provided" };
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
// F#6 (#33): coarse per-user event cap. Generous — trace events are tiny and
// can burst during active work; this only stops a runaway loop / abuse.
const TRACE_RATE_LIMIT = 600;
const TRACE_RATE_WINDOW_SEC = 60;

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

  // 5b. F#6 (#33): coarse per-user rate limit on top of the session+roster gate.
  const rl = await bumpRateCounter(
    env.HPS_KV,
    `rate:trace:${payload.c}:${payload.u}`,
    TRACE_RATE_LIMIT,
    TRACE_RATE_WINDOW_SEC,
  );
  if (!rl.allowed) {
    return c.json({ error: { message: "too many trace events", type: "rate_limit" } }, 429);
  }

  // 6. Body size cap + parse. F#7 (#33): early-reject via Content-Length
  // BEFORE reading the whole body into memory — a cheap guard against
  // oversized payloads. The post-read length check below stays as the
  // authoritative cap for when the header is absent or understated (chunked).
  const declaredLen = Number(c.req.header("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > BODY_MAX) {
    return c.json(
      { error: { message: `event body exceeds ${BODY_MAX} bytes`, type: "request" } },
      413,
    );
  }
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
  // server-assigned trial_id back. Other events ownership-verify (security
  // F#1) — block on a small SELECT, then fire-and-forget the actual write
  // via waitUntil. Verify failures are 403 with a generic message
  // (no SQL/secret leak per F#5).
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
      case "trialEnd":
      case "validationRun":
      case "humanAction": {
        const owned = await verifyTrialOwnership(env, ev.trial_id, payload.u, payload.c);
        if (!owned) {
          return c.json(
            { error: { message: "trial not owned by this user/cohort", type: "trial_ownership" } },
            403,
          );
        }
        if (ev.type === "trialEnd") c.executionCtx.waitUntil(endTrial(env, ev.trial_id));
        else if (ev.type === "validationRun") c.executionCtx.waitUntil(recordValidation(env, ev));
        else c.executionCtx.waitUntil(recordHumanAction(env, ev));
        return c.json({ ok: true });
      }
    }
  } catch (err) {
    console.error("trace dispatch failed:", err);
    return c.json({ error: { message: "storage failed", type: "storage" } }, 502);
  }
});
