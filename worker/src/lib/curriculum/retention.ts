// Automatic deletion of participant test data (cr-evidence #1394; Jay's decision 6, CR-69, CR-70).
//
// Decision 6 (2026-10-01): participant records (minors included) keep anonymous ids only, no
// raw input by default, and are deleted automatically 30 days after the experiment ends, with
// a per-cohort override (`cr_cohort_controls.retention_days_after_end`). An experiment ends
// when its last link ended (revoked, or past its expiry); its test data then goes exactly the
// way the student's delete action takes it (`deleteTask` and its tombstone; links revoked,
// counters reset, the Experiment record closed with `data_deleted_at`).
//
// Runs on the daily tick. A Service with no test origin configured (`HPS_TEST_ORIGIN` unset,
// the default) can hold no participant data, and the tick does nothing there, not even a
// query, so it never touches tables a production that has not applied migration 0032/0033
// does not have.

import type { Env } from "../../env";
import { parseTestOrigin } from "./test-origin";
import { allCohortControls, closeExperimentAfterDeletion, DEFAULT_RETENTION_DAYS, experimentsDueForDeletion } from "./store";
import { participantRecord, type R2Like } from "./participant-record";

const DAY = 24 * 3600_000;

export async function runCurriculumRetention(env: Env, now: number, limit = 25): Promise<{ ran: boolean; deleted: string[] }> {
  if (!parseTestOrigin(env.HPS_TEST_ORIGIN, env.ENVIRONMENT).ok) return { ran: false, deleted: [] };
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
