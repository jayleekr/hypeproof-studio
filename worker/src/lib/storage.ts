// Trace storage (#9). Trial → Turn → Validation / HumanAction.
// D1 holds queryable metadata; R2 holds optional turn-body dumps (gated by
// the cohort profile's `analytics.log_user_messages` flag — default false,
// children-safe; opt-in per cohort after parent/guardian consent + retention
// policy).
//
// All writes are intended to be fire-and-forget via ctx.waitUntil at the
// caller; they must never block the chat response. Failures are surfaced as
// rejected promises — the caller decides whether to log + swallow.

import type { Env } from "../env";

export interface TrialInput {
  session_id: string | null;
  cohort_id: string;
  user_id: string;
  profile_id: string;
  task_label?: string | null;
}

export interface TurnInput {
  trial_id: string;
  turn_idx: number;
  prompt_chars: number;
  response_chars: number;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number | null;
  model: string;
}

export interface TurnBody {
  prompt: string;
  response: string;
  // free for future extension; serialized verbatim into R2
  [k: string]: unknown;
}

export type ValidationOutcome = "pass" | "fail" | "partial" | "error";

export interface ValidationInput {
  trial_id: string;
  turn_id?: string | null;
  outcome: ValidationOutcome;
  errors_found?: number;
  errors_fixed?: number;
}

export type HumanActionKind = "accept" | "reject" | "edit" | "replace";

export interface HumanActionInput {
  trial_id: string;
  turn_id?: string | null;
  kind: HumanActionKind;
  diff_chars?: number | null;
}

// ----- ids ------------------------------------------------------------------
// Workers runtime ships globalThis.crypto.randomUUID(). Wrapped so tests can
// substitute when mocking.
export function newId(): string {
  return crypto.randomUUID();
}

// ----- R2 key shape (single source of truth) --------------------------------
export function turnBodyKey(trial_id: string, turn_idx: number): string {
  return `turns/${trial_id}/${turn_idx}.json`;
}

// ----- writes ---------------------------------------------------------------

export async function createTrial(env: Env, t: TrialInput): Promise<string> {
  const id = newId();
  await env.HPS_DB
    .prepare(
      `INSERT INTO trials (id, session_id, cohort_id, user_id, profile_id, task_label)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, t.session_id, t.cohort_id, t.user_id, t.profile_id, t.task_label ?? null)
    .run();
  return id;
}

export async function endTrial(env: Env, trial_id: string): Promise<void> {
  await env.HPS_DB
    .prepare(`UPDATE trials SET ended_at = datetime('now') WHERE id = ? AND ended_at IS NULL`)
    .bind(trial_id)
    .run();
}

/**
 * Record a turn. If `persistBody` is true and `body` is provided, the body
 * JSON is written to R2 at `turns/{trial_id}/{turn_idx}.json` and the D1
 * row carries `body_ref` pointing at that key. Otherwise `body_ref` is NULL
 * (metadata-only, no PII at rest).
 */
export async function recordTurn(
  env: Env,
  fields: TurnInput,
  opts: { persistBody?: boolean; body?: TurnBody } = {},
): Promise<string> {
  const id = newId();
  let body_ref: string | null = null;
  if (opts.persistBody && opts.body) {
    body_ref = turnBodyKey(fields.trial_id, fields.turn_idx);
    await env.HPS_TRACES.put(body_ref, JSON.stringify(opts.body), {
      httpMetadata: { contentType: "application/json" },
    });
  }
  await env.HPS_DB
    .prepare(
      `INSERT INTO turns
        (id, trial_id, turn_idx, prompt_chars, response_chars,
         tokens_in, tokens_out, latency_ms, model, body_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      fields.trial_id,
      fields.turn_idx,
      fields.prompt_chars,
      fields.response_chars,
      fields.tokens_in,
      fields.tokens_out,
      fields.latency_ms,
      fields.model,
      body_ref,
    )
    .run();
  return id;
}

export async function recordValidation(env: Env, v: ValidationInput): Promise<void> {
  const id = newId();
  await env.HPS_DB
    .prepare(
      `INSERT INTO validations
        (id, trial_id, turn_id, outcome, errors_found, errors_fixed)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      v.trial_id,
      v.turn_id ?? null,
      v.outcome,
      v.errors_found ?? 0,
      v.errors_fixed ?? 0,
    )
    .run();
}

// ----- chat-hook helpers (#9c) ----------------------------------------------
// Pure functions kept here so they can be unit-tested without booting the
// chat router. Used by routes/chat.ts to decide whether to persist a turn
// and what its char counts are.

export interface TrialHeaders {
  trial_id: string;
  turn_idx: number;
}

/**
 * Read `x-hps-trial-id` + `x-hps-turn-idx` headers from the chat request.
 * Returns null when either is missing/invalid — chat continues to work
 * normally, just without turn persistence (graceful opt-in for clients that
 * have called POST /v1/trace/event {trialStart} first).
 */
export function extractTrialHeaders(
  getHeader: (name: string) => string | null | undefined,
): TrialHeaders | null {
  const id = (getHeader("x-hps-trial-id") ?? "").trim();
  const idxRaw = (getHeader("x-hps-turn-idx") ?? "").trim();
  if (!id || !idxRaw) return null;
  const turn_idx = Number.parseInt(idxRaw, 10);
  if (!Number.isFinite(turn_idx) || turn_idx < 0) return null;
  // Cheap shape sanity (uuid-ish or any non-empty token-safe string).
  if (id.length > 64) return null;
  return { trial_id: id, turn_idx };
}

/**
 * Extract the text of the *last user message* in an OpenAI-shape body. Used
 * by routes/chat.ts (#9c) to derive `turns.prompt_chars` and the optional
 * R2 body's `prompt` field. Returns "" when the body is malformed or has
 * no user turn.
 *
 * OpenAI content can be a string OR an array of parts; the text parts are
 * concatenated, non-text parts contribute nothing.
 */
export function lastUserMessageText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const msgs = (body as { messages?: unknown }).messages;
  if (!Array.isArray(msgs)) return "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: unknown; content?: unknown };
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      let s = "";
      for (const part of m.content) {
        const t = (part as { text?: unknown })?.text;
        if (typeof t === "string") s += t;
      }
      return s;
    }
    return "";
  }
  return "";
}

export async function recordHumanAction(env: Env, h: HumanActionInput): Promise<void> {
  const id = newId();
  await env.HPS_DB
    .prepare(
      `INSERT INTO human_actions
        (id, trial_id, turn_id, kind, diff_chars)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      h.trial_id,
      h.turn_id ?? null,
      h.kind,
      h.diff_chars ?? null,
    )
    .run();
}
