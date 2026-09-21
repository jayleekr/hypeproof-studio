// Source envelope for observed events (#1042; MC-09, MC-13).
//
// hps-observation/1 predates the common core, so several MC-09 fields simply do
// not exist in it. They are reported as "unknown" — never guessed from nearby
// values. In particular `at` is the host-reported observation time; there is no
// separate receive time in this format, and host session is not a task.
import { OBSERVATION_FORMAT_V2, type ObservationBatch } from "./legacy-observation.ts";
import type { Unknown } from "./interpretation.ts";

export interface EventEnvelope {
  source_namespace: string;
  host_session: string;
  task: string;
  event_id: string;
  /** Known order inside one host session only; never a cross-host causal order. */
  sequence: number;
  observed_at: number;
  received_at: number | Unknown;
  schema: string;
  adapter_version: string | Unknown;
  parent_event_id: string | Unknown;
  raw_ref: { scope: string; program: string; event_id: string };
}

export const LEGACY_SOURCE_NAMESPACE = "studio/hps-observation/1";
/** /2 events come from the same host but a different schema; the namespace says which (MC-13). */
export const LEARNING_SOURCE_NAMESPACE = "studio/hps-observation/2";

export function describeLegacySource(batch: ObservationBatch): EventEnvelope[] {
  const source_namespace = batch.format === OBSERVATION_FORMAT_V2 ? LEARNING_SOURCE_NAMESPACE : LEGACY_SOURCE_NAMESPACE;
  return batch.events.map((e) => ({
    source_namespace,
    host_session: batch.session,
    task: e.task,
    event_id: e.id,
    sequence: e.seq,
    observed_at: e.at,
    received_at: "unknown",
    schema: batch.format,
    adapter_version: "unknown",
    parent_event_id: "unknown",
    raw_ref: { scope: batch.scope, program: batch.program, event_id: e.id },
  }));
}
