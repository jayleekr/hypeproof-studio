// Chat-request extraction helpers (#255 A#10).
//
// These are HTTP concerns of the chat.ts trace hook (#9c) — parsing trial
// headers and pulling the last user message out of an OpenAI-shape body.
// They used to live in lib/storage.ts, but storage is the D1/R2 persistence
// layer; extraction belongs with the request-parsing code. Pure functions,
// no bindings — unit-testable without booting the chat router.

import { isUuid } from "./storage";

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
  // Strict UUID — defends against R2 path traversal (`../`) and key
  // collision on shared prefixes (security review F#3).
  if (!isUuid(id)) return null;
  const turn_idx = Number.parseInt(idxRaw, 10);
  if (!Number.isFinite(turn_idx) || turn_idx < 0 || turn_idx > 9999) return null;
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
