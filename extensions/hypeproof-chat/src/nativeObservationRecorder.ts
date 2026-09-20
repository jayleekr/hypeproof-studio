import { randomUUID } from "node:crypto";
import { isLearningEventKind } from "../../../worker/src/lib/measurement-core/learning-events.ts";
import {
  OBSERVATION_FORMAT,
  validateObservation,
  type ObservationBatch,
  type ObservationEvent,
} from "./nativeObservationContract.ts";
import { scrubSecrets } from "./shellPolicy.ts";

/** Uses the existing workspaceState persistence, scoped by Service identity/session.
 * No network upload occurs here. Captures host callbacks, never webview-supplied roles.
 */
export class NativeObservationRecorder {
  readonly batch: ObservationBatch;
  readonly missing: number[];
  private readonly toolRequests = new Set<string>();
  constructor(context: Omit<ObservationBatch, "events">, saved?: unknown) {
    const checked = validateObservation(saved ?? { ...context, events: [] });
    if (
      checked.batch.scope !== context.scope ||
      checked.batch.session !== context.session ||
      checked.batch.program !== context.program
    )
      throw Error("observation_scope_changed");
    this.batch = structuredClone(checked.batch);
    this.missing = checked.missing;
    for (const e of this.batch.events)
      if (e.kind === "tool_request")
        this.toolRequests.add(e.task + ":" + e.tool_id);
  }
  record(
    task: string,
    kind: ObservationEvent["kind"],
    text: string,
    extra: Partial<ObservationEvent> = {},
  ) {
    // SX-45 rule 2 — learning kinds are made by the webview-form handler and by
    // nothing else. Splitting `recordLearningEvent()` out was necessary but NOT
    // sufficient: this signature still accepts every /2 kind, and `extra` is
    // spread BEFORE the fixed fields, so a coach-stream caller passing
    // `{actor:"user", student_text}` would write AI prose as the student's own.
    // Today no caller does that — but "no caller does" is a convention, and the
    // requirement asks for a rule. So it is a rule.
    if (isLearningEventKind(kind)) throw Error("learning_kind_needs_form");
    if (this.batch.events.length >= 500) {
      this.batch.incomplete = true;
      throw Error("observation_capacity");
    }
    const safe = scrubSecrets(text);
    if (safe.length > 20000) this.batch.incomplete = true;
    const event: ObservationEvent = {
      ...extra,
      id: randomUUID(),
      seq: (this.batch.events.at(-1)?.seq ?? 0) + 1,
      task,
      at: Date.now(),
      kind,
      text: safe.slice(0, 20000),
      assistance: "unknown",
    };
    this.batch.events.push(event);
    return event;
  }
  /**
   * Appends one learning event (SX-44·45, P1-B).
   *
   * Being split from `record()` IS the rule. `record()` is where the coach stream
   * callbacks call in, and if a learning kind can be made from that seat, SX-45
   * rule 2 means nothing. This method is called by **the host handler that received
   * a webview form submission, and by nothing else**.
   *
   * `draft` has already passed `learningEventRequest()` — actor and context are not
   * decided again here. They must be decided in one place so the two cannot diverge.
   */
  recordLearningEvent(draft: { kind: string } & Record<string, unknown>) {
    if (this.batch.format !== "hps-observation/2") throw Error("observation_format");
    if (this.batch.events.length >= 500) {
      this.batch.incomplete = true;
      throw Error("observation_capacity");
    }
    const { kind, student_text, ...rest } = draft;
    const safe = typeof student_text === "string" ? scrubSecrets(student_text).slice(0, 2000) : undefined;
    const event = {
      ...rest,
      ...(safe === undefined ? {} : { student_text: safe }),
      id: randomUUID(),
      seq: (this.batch.events.at(-1)?.seq ?? 0) + 1,
      task: String((draft.context as { task?: unknown } | undefined)?.task ?? ""),
      at: Date.now(),
      kind,
      // The body of a learning event is `student_text`. Leave `/1`'s `text` slot
      // empty but keep the key itself — the validator requires `text` on every event.
      text: safe ?? "",
      assistance: "unknown",
    } as unknown as ObservationEvent;
    this.batch.events.push(event);
    return event;
  }
  toolRequest(task: string, id: string, text: string) {
    const key = task + ":" + id;
    if (this.toolRequests.has(key)) return;
    this.toolRequests.add(key);
    this.record(task, "tool_request", text, { tool_id: id });
  }
  snapshot() {
    return structuredClone(this.batch);
  }
}
