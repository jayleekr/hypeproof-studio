// #416 — typing during a coach turn, and what Enter means while one is running.
//
// The textarea used to be `disabled={streaming}`. That was survivable when a
// proxy turn was 20–30s; an agent-sdk turn measures 5–10 minutes (one real
// lecture turn: 9 min), so the participant sat blocked and could not even write
// down the thing they had just thought of. A thought you cannot record is a
// thought you lose — that is iteration_reflex, blocked by the UI.
//
// The decisions live here, apart from React, because the failure modes are
// logical, not visual: sending a second turn on top of a live one, dropping a
// parked message, or firing the parked message while the stream is still open
// (submit() would silently swallow it). All three are unit-testable; none of
// them need a DOM.
//
// DOM-free and vscode-free on purpose — imported by ChatPanel.tsx and by
// test/send-queue.smoke.mjs alike.

/** What pressing Enter should do right now. */
export type EnterDecision =
  /** Nothing to send (blank input) — swallow the keystroke. */
  | { action: "ignore" }
  /** Idle: send immediately, exactly as before. */
  | { action: "send" }
  /** A turn is running: park this text and auto-send it when the turn ends. */
  | { action: "queue"; queued: string };

export interface EnterArgs {
  draft: string;
  streaming: boolean;
  /** The already-parked message, if any. */
  queued: string | null;
  /** Pasted images waiting to ride along with the next turn. */
  hasImages?: boolean;
}

/**
 * Exactly ONE message is ever parked — a growing queue makes it impossible to
 * predict what the coach will receive next. Pressing Enter again does NOT
 * replace (that would discard what was already typed) and does NOT stack: the
 * new line is appended to the parked message, so "one pending message" holds
 * while nothing the user typed is ever thrown away.
 */
export function decideEnter(args: EnterArgs): EnterDecision {
  const text = args.draft.trim();
  if (!args.streaming) {
    // Images alone are a valid turn (a screenshot with no words).
    return text || args.hasImages ? { action: "send" } : { action: "ignore" };
  }
  // Mid-turn there is nothing to attach an image to yet, so a blank draft has
  // nothing to park.
  if (!text) return { action: "ignore" };
  const prev = args.queued?.trim();
  return { action: "queue", queued: prev ? `${prev}\n${text}` : text };
}

/**
 * The draft to restore when the turn is cancelled (Stop) or the reservation is
 * cancelled by hand. Never destructive: whatever was parked comes back, and
 * anything typed AFTER parking is kept below it, in the order it was written.
 */
export function draftAfterStop(draft: string, queued: string | null): string {
  const parked = queued?.trim() ?? "";
  if (!parked) return draft;
  const typedSince = draft.trim();
  return typedSince ? `${parked}\n${typedSince}` : parked;
}

/**
 * May the parked message fire now? Only on the streaming → idle EDGE.
 *
 * The guard is not cosmetic: submit() refuses to send while `streaming` is
 * true, so flushing one tick early makes the message vanish with no error —
 * the exact class of silent loss this feature exists to prevent. Equally, it
 * must not re-fire on unrelated re-renders while already idle.
 */
export function shouldFlushQueue(
  prevStreaming: boolean,
  streaming: boolean,
  queued: string | null,
): boolean {
  return prevStreaming && !streaming && !!queued?.trim();
}
