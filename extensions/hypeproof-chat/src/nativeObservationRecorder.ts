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
  /**
   * 학습 이벤트 하나를 붙인다 (SX-44·45, P1-B).
   *
   * `record()` 와 나눠 둔 이유가 규칙 자체다. `record()` 는 코치 스트림 콜백이
   * 부르는 자리이고, 그 자리에서 학습 kind 가 만들어질 수 있으면 SX-45 규칙 2가
   * 무의미해진다. 이 메서드는 **웹뷰 폼 제출을 받은 호스트 핸들러만** 부른다.
   *
   * `draft` 는 이미 `learningEventRequest()` 를 통과한 것이다 — 여기서 actor 나
   * context 를 다시 정하지 않는다. 한 곳에서만 정해야 두 곳이 갈라지지 않는다.
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
      // 학습 이벤트의 본문은 `student_text` 다. `/1` 의 `text` 칸은 비워 두되
      // 키 자체는 남긴다 — 검증기가 모든 이벤트에 `text` 를 요구한다.
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
