// Automatic deletion of participant test data (cr-evidence #1394; Jay's decision 6, CR-69, CR-70).
//
// Decision 6 (2026-10-01): participant records (minors included) keep anonymous ids only, no
// raw input by default, and are deleted automatically 30 days after the experiment ends, with
// a per-cohort override (`cr_cohort_controls.retention_days_after_end`). An experiment ends at
// the later of its last link's end (revoked, or past its expiry) and its last manual record,
// draft or draft review (store.ts `experimentsDueForDeletion`): a note written after the link
// ended keeps the data for the full period from that note.
//
// An experiment that ran with participants (it had a link) then goes exactly the way the
// student's delete action takes it (`deleteExperimentData`: links revoked, counters reset and
// the Experiment record closed with `data_deleted_at` FIRST, so nothing can write while the
// record is scanned; then `deleteTask` and its tombstone). One that never had a link and
// holds only manual records (interview notes and quotes about outside people) has those
// records deleted, and its status is left alone: it never ran, so it is not closed, and the
// student can still publish a link for it (the links route re-creates its record task). Its
// last-record row is forgotten only when nothing was written while the sweep ran. One with no
// link and no record holds nothing and is never due, so an experiment planned for a later
// week is not touched. A deletion that failed half-way stays pending and is due on the next tick.
//
// Runs on the daily tick, gated on the tables being there, not on a test origin: projects,
// experiments and notes need no test origin, so a Service without one can still hold manual
// records. Where migrations 0032/0033 are not applied (production today) one read of the
// schema answers and nothing else runs. At most `limit` experiments per tick, the longest
// ended first; one that fails is logged and the rest still run, and the next tick takes
// what is left.

import type { Env } from "../../env";
import type { LocalRecord } from "../measurement-core/local-record";
import { allCohortControls, closeExperimentAfterDeletion, curriculumTablesPresent, DEFAULT_RETENTION_DAYS, experimentsDueForDeletion, finishExperimentDeletion, forgetExperimentRecords } from "./store";
import { participantRecord, type R2Like } from "./participant-record";
import type { Experiment } from "./venture";

type DB = D1Database;
const DAY = 24 * 3600_000;

/** `deleteTask`, where a record that never had the task (or already lost it) is not an error. */
async function deleteTaskIfAny(record: LocalRecord, id: string, at: number): Promise<Awaited<ReturnType<LocalRecord["deleteTask"]>> | null> {
  try {
    return await record.deleteTask(id, { by: "user", at });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "unknown_task") throw e;
    return null;
  }
}

/**
 * Delete an experiment's test data (CR-69, decision 6), for the student's delete action and
 * the sweep alike. The experiment is closed first (links revoked, `data_deleted_at` set, the
 * deletion pending), so a session cannot open, a note, draft or review is refused or removes
 * itself, and only then is the record scanned. The pending mark is cleared last: a failure in
 * between leaves the experiment due again on the next sweep.
 */
export async function deleteExperimentData(db: DB, record: LocalRecord, experiment: Experiment, now: number): Promise<{ experiment: Experiment; report: Awaited<ReturnType<LocalRecord["deleteTask"]>> | null }> {
  const closed = await closeExperimentAfterDeletion(db, experiment, now);
  const report = await deleteTaskIfAny(record, experiment.id, now);
  return { experiment: await finishExperimentDeletion(db, closed, now), report };
}

export async function runCurriculumRetention(env: Env, now: number, limit = 25): Promise<{ ran: boolean; deleted: string[] }> {
  if (!(await curriculumTablesPresent(env.HPS_DB))) return { ran: false, deleted: [] };
  const controls = await allCohortControls(env.HPS_DB);
  const due = await experimentsDueForDeletion(env.HPS_DB, now, (cohort) => (controls.get(cohort)?.retention_days_after_end ?? DEFAULT_RETENTION_DAYS) * DAY);
  const deleted: string[] = [];
  let failed = 0;
  for (const { experiment, project, had_links, ended_at } of due.slice(0, limit)) {
    try {
      const record = participantRecord(env.HPS_TRACES as unknown as R2Like, project.cohort_id, project.id);
      if (had_links || experiment.data_deletion_pending === true) await deleteExperimentData(env.HPS_DB, record, experiment, now);
      else {
        await deleteTaskIfAny(record, experiment.id, now);
        await forgetExperimentRecords(env.HPS_DB, experiment.id, ended_at);
      }
      deleted.push(experiment.id);
    } catch (e) {
      failed++;
      console.error(JSON.stringify({ event: "curriculum_retention_failed", experiment: experiment.id, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  const left = Math.max(0, due.length - limit) + failed;
  if (left > 0) console.warn(JSON.stringify({ event: "curriculum_retention_left", due: due.length, deleted: deleted.length, left }));
  return { ran: true, deleted };
}
