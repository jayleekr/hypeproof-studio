// Automatic deletion of participant test data (cr-evidence #1394; Jay's decision 6, CR-69, CR-70).
//
// Decision 6 (2026-10-01): participant records (minors included) keep anonymous ids only, no
// raw input by default, and are deleted automatically 30 days after the experiment ends, with
// a per-cohort override (`cr_cohort_controls.retention_days_after_end`). An experiment ends
// when its last link ended (revoked, or past its expiry); its test data then goes exactly the
// way the student's delete action takes it (`deleteTask` and its tombstone; links revoked,
// counters reset, the Experiment record closed with `data_deleted_at`).
//
// An experiment with no link ends at its last manual record or draft (store.ts
// `experimentsDueForDeletion`): interview notes and quotes about outside people go too.
//
// Runs on the daily tick, gated on the tables being there, not on a test origin: projects,
// experiments and notes need no test origin, so a Service without one can still hold manual
// records. Where migrations 0032/0033 are not applied (production today) one read of the
// schema answers and nothing else runs.

import type { Env } from "../../env";
import { allCohortControls, closeExperimentAfterDeletion, curriculumTablesPresent, DEFAULT_RETENTION_DAYS, experimentsDueForDeletion } from "./store";
import { participantRecord, type R2Like } from "./participant-record";

const DAY = 24 * 3600_000;

export async function runCurriculumRetention(env: Env, now: number, limit = 25): Promise<{ ran: boolean; deleted: string[] }> {
  if (!(await curriculumTablesPresent(env.HPS_DB))) return { ran: false, deleted: [] };
  const controls = await allCohortControls(env.HPS_DB);
  const due = await experimentsDueForDeletion(env.HPS_DB, now, (cohort) => (controls.get(cohort)?.retention_days_after_end ?? DEFAULT_RETENTION_DAYS) * DAY);
  const deleted: string[] = [];
  for (const { experiment, project } of due.slice(0, limit)) {
    const record = participantRecord(env.HPS_TRACES as unknown as R2Like, project.cohort_id, project.id);
    try {
      await record.deleteTask(experiment.id, { by: "user", at: now });
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "unknown_task") throw e;
    }
    await closeExperimentAfterDeletion(env.HPS_DB, experiment, now);
    deleted.push(experiment.id);
  }
  return { ran: true, deleted };
}
