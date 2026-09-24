// Shared CAS write logic for authoring_drafts.
// Extracted from authoring.ts (R1 exception 2, #1295) so chalk-courses.ts
// can use the same request_id idempotency and expected_revision semantics
// without duplicating the logic.

export interface Draft {
  cohort_id: string;
  course_id: string;
  owner_id: string;
  profile_id: string;
  revision: number;
  content_json: string;
  request_id: string;
  request_hash: string;
  updated_at: string;
  independent?: number;
}

export async function readDraft(db: D1Database, cohort: string, course: string): Promise<Draft | null> {
  return db.prepare(
    `SELECT d.*, EXISTS(SELECT 1 FROM authoring_independent_courses m WHERE m.cohort_id=d.cohort_id AND m.course_id=d.course_id) AS independent
     FROM authoring_drafts d WHERE d.cohort_id=? AND d.course_id=?`
  ).bind(cohort, course).first<Draft>();
}

export function owns(d: Draft, owner_id: string, profile_scope: string[]): boolean {
  return d.owner_id === owner_id && (d.profile_id === '' || profile_scope.includes(d.profile_id));
}

export type WriteDraftResult =
  | { kind: 'ok'; draft: Draft }
  | { kind: 'idempotent'; draft: Draft }
  | { kind: 'request_id_reused' }
  | { kind: 'conflict' };

export interface WriteDraftParams {
  cohort: string;
  course: string;
  owner_id: string;
  expected_revision: number;
  request_id: string;
  profile_id: string;
  content_json: string;
  hash: string;
  now: string;
  independent: boolean;
  // for IC-02 batch (authoring.ts independent course creation)
  independent_marker_stmt?: D1PreparedStatement;
  // for /plan route: run atomically with the UPDATE
  extra_batch_stmts?: D1PreparedStatement[];
}

export async function writeDraft(
  db: D1Database,
  prior: Draft | null,
  params: WriteDraftParams,
): Promise<WriteDraftResult> {
  const { cohort, course, owner_id, expected_revision, request_id, profile_id,
          content_json, hash, now, independent,
          independent_marker_stmt, extra_batch_stmts } = params;

  // Request_id idempotency: same id + same hash → return existing.
  if (prior && prior.request_id === request_id) {
    if (prior.request_hash !== hash) return { kind: 'request_id_reused' };
    return { kind: 'idempotent', draft: prior };
  }

  let d: Draft | null = null;

  if (expected_revision === 0) {
    const insertStmt = db.prepare(
      `INSERT INTO authoring_drafts (cohort_id,course_id,owner_id,profile_id,revision,content_json,request_id,request_hash,updated_at)
       VALUES (?,?,?,?,1,?,?,?,?) ON CONFLICT(cohort_id,course_id) DO NOTHING RETURNING *`
    ).bind(cohort, course, owner_id, profile_id, content_json, request_id, hash, now);

    const hasExtra = (extra_batch_stmts ?? []).length > 0;
    if (independent && independent_marker_stmt) {
      // Draft and marker commit together; the marker SELECT matches only the row this
      // request created, so a lost create race never marks another course.
      const batch: D1PreparedStatement[] = [insertStmt, independent_marker_stmt, ...(extra_batch_stmts ?? [])];
      await db.batch(batch);
      const created = await readDraft(db, cohort, course);
      d = created && created.independent && created.revision === 1
          && created.request_id === request_id && created.request_hash === hash
        ? created : null;
    } else if (hasExtra) {
      // Atomic batch: INSERT authoring_drafts + extra writes (e.g. chalk_course_inputs upsert).
      await db.batch([insertStmt, ...extra_batch_stmts!]);
      const created = await readDraft(db, cohort, course);
      d = created && created.revision === 1
          && created.request_id === request_id && created.request_hash === hash
        ? created : null;
    } else {
      d = await insertStmt.first<Draft>();
    }
  } else {
    const updateStmt = db.prepare(
      `UPDATE authoring_drafts SET profile_id=?,revision=revision+1,content_json=?,request_id=?,request_hash=?,updated_at=?
       WHERE cohort_id=? AND course_id=? AND owner_id=? AND revision=? RETURNING *`
    ).bind(profile_id, content_json, request_id, hash, now, cohort, course, owner_id, expected_revision);

    if (extra_batch_stmts && extra_batch_stmts.length > 0) {
      // Atomic batch: UPDATE authoring_drafts + extra writes (e.g. chalk_plan_files INSERT).
      // RETURNING does not reliably surface in D1 batch results, so re-read after.
      await db.batch([updateStmt, ...extra_batch_stmts]);
      const updated = await readDraft(db, cohort, course);
      d = updated && updated.revision === expected_revision + 1
          && updated.request_id === request_id && updated.request_hash === hash
        ? updated : null;
    } else {
      d = await updateStmt.first<Draft>();
    }
  }

  if (d) return { kind: 'ok', draft: { ...d, independent: independent ? 1 : 0 } };

  // Concurrent retry may have won the conditional write after our first read.
  const latest = await readDraft(db, cohort, course);
  if (latest && owns(latest, owner_id, [latest.profile_id])
      && latest.request_id === request_id && latest.request_hash === hash) {
    return { kind: 'idempotent', draft: latest };
  }
  return { kind: 'conflict' };
}
