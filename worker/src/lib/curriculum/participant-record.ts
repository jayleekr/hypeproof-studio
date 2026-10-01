// The participant session record on the Service (recon R6; CR-21, CR-22, CR-73).
//
// Participant evidence lives in the one measurement-core record (`LocalRecord`), on the
// Service host, over the existing R2 binding `HPS_TRACES` under `curriculum/<cohort>/<project>/`.
// No new KV namespace, no traffic table, no validator copy (SX-48). One Experiment is one
// record task (same id, `project` = the project id), created when the student starts the
// test, so opening a link never races to create it. Opening a link creates the participant
// session: `linkSession(experiment, {host: "published", session_id, attribution})`.
//
// This port is the minimum cr-publish needs. cr-evidence owns the rest of R6 (recon §7):
// it confirms R2's atomic `ifAbsent` semantics, serialises writers per experiment (today's
// `linkSession` read-modify-writes `task.sessions`; the per-session key, which every read
// here uses, is written once), and gives the port a `usageBytes` that does not scan.

import { LocalRecord, type SessionAttribution, type StoragePort } from "../measurement-core/local-record.ts";
import type { Experiment, TestLink } from "./venture.ts";
import { pinnedVersion } from "./venture.ts";

export const PUBLISHED_HOST = "published";

/** The minimal R2 surface this port uses (the binding's own types in the Worker). */
export interface R2Like {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string, options?: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list(options: { prefix: string; cursor?: string }): Promise<{ objects: Array<{ key: string }>; truncated?: boolean; cursor?: string }>;
}

const safe = (s: string) => encodeURIComponent(s);

export function participantPrefix(cohortId: string, projectId: string): string {
  return `curriculum/${safe(cohortId)}/${safe(projectId)}/`;
}

export function r2RecordPort(bucket: R2Like, prefix: string): StoragePort {
  return {
    async read(key) {
      const o = await bucket.get(prefix + key);
      return o ? o.text() : null;
    },
    async write(key, value, options) {
      if (options?.ifAbsent) {
        // Conditional put: the object must not exist. cr-evidence confirms R2's semantics
        // for concurrent writers (recon §7); the read before it keeps a sequential retry honest.
        if ((await bucket.get(prefix + key)) !== null) throw new Error("exists");
        const r = await bucket.put(prefix + key, value, { onlyIf: { etagDoesNotMatch: "*" } });
        if (r === null) throw new Error("exists");
        return;
      }
      await bucket.put(prefix + key, value);
    },
    async list(p) {
      const out: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix: prefix + p, ...(cursor ? { cursor } : {}) });
        for (const o of page.objects) out.push(o.key.slice(prefix.length));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
    async remove(key) {
      await bucket.delete(prefix + key);
    },
  };
}

export function participantRecord(bucket: R2Like, cohortId: string, projectId: string): LocalRecord {
  return new LocalRecord(r2RecordPort(bucket, participantPrefix(cohortId, projectId)));
}

/** The record task of an experiment; created once, when the student starts the test. */
export async function ensureExperimentTask(record: LocalRecord, experiment: Pick<Experiment, "id" | "project_id" | "question">, at: number): Promise<void> {
  try {
    await record.getTask(experiment.id);
    return;
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "unknown_task") throw e;
  }
  try {
    await record.createTask({ id: experiment.id, project: experiment.project_id, at, purpose: { text: experiment.question, source: "user" } });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "task_exists") throw e;
  }
}

export type SessionRefusal = "session_experiment_mismatch" | "session_version_mismatch" | "session_project_mismatch";

/**
 * Open a participant session for a served link (CR-21, CR-73). The attribution is derived
 * from the link and its experiment. A caller that also CLAIMS an experiment or version (the
 * participant snippet's later events, cr-evidence) is refused when the claim is not the
 * link's: a session claiming another experiment, or a version that is not what the
 * experiment pins for this link, writes nothing.
 */
export async function openParticipantSession(
  record: LocalRecord,
  input: {
    link: Pick<TestLink, "id" | "experiment_id" | "project_id" | "channel" | "variant_id">;
    experiment: Pick<Experiment, "id" | "project_id" | "product_version_id" | "declarations">;
    sessionId: string;
    at: number;
    claimed?: { experiment?: string; product_version?: string; project?: string };
  },
): Promise<{ ok: true; attribution: SessionAttribution } | { ok: false; code: SessionRefusal }> {
  const { link, experiment } = input;
  if (link.experiment_id !== experiment.id || (input.claimed?.experiment !== undefined && input.claimed.experiment !== link.experiment_id)) return { ok: false, code: "session_experiment_mismatch" };
  if (link.project_id !== experiment.project_id || (input.claimed?.project !== undefined && input.claimed.project !== link.project_id)) return { ok: false, code: "session_project_mismatch" };
  const version = pinnedVersion(experiment, link.variant_id);
  if (!version || (input.claimed?.product_version !== undefined && input.claimed.product_version !== version)) return { ok: false, code: "session_version_mismatch" };
  const attribution: SessionAttribution = {
    project: link.project_id,
    experiment: experiment.id,
    product_version: version,
    link: link.id,
    ...(link.channel ? { channel: link.channel } : {}),
    ...(link.variant_id ? { variant: link.variant_id } : {}),
  };
  await record.linkSession(experiment.id, { host: PUBLISHED_HOST, session_id: input.sessionId, by: "adapter_explicit", at: input.at, attribution });
  return { ok: true, attribution };
}

/**
 * Where a session is counted (CR-73): under its link's channel label, as "unlabelled" when its
 * link has none, and as "unknown channel" when no link is recorded. Never assigned by guess.
 */
export type ChannelOf = { kind: "channel"; label: string } | { kind: "unlabelled" } | { kind: "unknown" };
export function channelOf(attribution: SessionAttribution | null): ChannelOf {
  if (!attribution?.link) return { kind: "unknown" };
  return attribution.channel ? { kind: "channel", label: attribution.channel } : { kind: "unlabelled" };
}

export interface ChannelCounts {
  channels: Record<string, number>;
  unlabelled: number;
  unknown: number;
}

/**
 * Sessions opened per channel for one experiment. A usage observation, never a demand claim
 * (SX-58): it counts link opens, not people or interest.
 */
export async function sessionsByChannel(record: LocalRecord, experimentId: string): Promise<ChannelCounts> {
  const out: ChannelCounts = { channels: {}, unlabelled: 0, unknown: 0 };
  for (const s of await record.sessionLinks(PUBLISHED_HOST)) {
    if (s.task !== experimentId) continue;
    const ch = channelOf(s.attribution);
    if (ch.kind === "channel") out.channels[ch.label] = (out.channels[ch.label] ?? 0) + 1;
    else out[ch.kind]++;
  }
  return out;
}
