import { randomUUID } from "node:crypto";
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
