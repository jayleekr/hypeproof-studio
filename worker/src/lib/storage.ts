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
