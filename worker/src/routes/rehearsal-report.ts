// #1012 · #751 G2 — the learner-condition rehearsal's App report. Sent by the Studio App with the rehearsal code (a
// learner credential), never by the instructor. The Service judges it once against the candidate and its OWN records of
// the requests made with that code (lesson-rehearsal.ts), and stores the verdict write-once.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '../env';
import { bearer, verify, TokenError } from '../lib/tokens';
import { getProfile } from '../profiles';
import { getRoster, isTokenRevoked } from '../lib/kv';
import { readLesson } from '../lib/lesson-delivery';
import { sha256Hex } from '../lib/modules';
import { judgeRehearsal, parseReport, REHEARSAL_REPORT_MAX } from '../lib/lesson-rehearsal';
import { rehearsalTurns, type RehearsalRow } from '../lib/lesson-rehearsal-store';

export const rehearsalReport = new Hono<{ Bindings: Env }>();
rehearsalReport.use('*', bodyLimit({ maxSize: REHEARSAL_REPORT_MAX, onError: (c) => c.json({ error: 'report too large' }, 413) }));

rehearsalReport.post('/report', async (c) => {
  c.header('cache-control', 'no-store');
  const token = bearer(c.req.header('authorization'));
  if (!token) return c.json({ error: 'rehearsal code required' }, 401);
  let p;
  try { p = await verify(token, c.env.HPS_SIGNING_SECRET); } catch (err) { return c.json({ error: err instanceof TokenError ? err.message : 'invalid code' }, 401); }
  if (p.role === 'issuer' || !p.rehearsal || !p.jti || !p.lesson) return c.json({ error: 'this code is not a rehearsal code', reason: 'not_rehearsal' }, 403);
  if (await isTokenRevoked(c.env.HPS_KV, p.jti)) return c.json({ error: 'code revoked' }, 401);
  if (!(await getRoster(c.env.HPS_KV, p.c))?.users.includes(p.u)) return c.json({ error: 'not in roster', reason: 'not_in_roster' }, 403);
  const row = await c.env.HPS_DB.prepare('SELECT * FROM authoring_rehearsals WHERE rehearsal_id=? AND token_jti=?').bind(p.rehearsal, p.jti).first<RehearsalRow>().catch(() => null);
  if (!row || row.cohort_id !== p.c || row.lesson_sha256 !== p.lesson.sha256) return c.json({ error: 'rehearsal not found', reason: 'rehearsal_unknown' }, 404);
  const body = await c.req.json().catch(() => null);
  const report = parseReport(body);
  if (typeof report === 'string') return c.json({ error: report, reason: 'invalid_report' }, 400);
  const hash = await sha256Hex(JSON.stringify(report));
  if (row.verdict) return row.report_hash === hash ? c.json({ rehearsal_id: row.rehearsal_id, ...JSON.parse(row.verdict_json!) })
    : c.json({ error: 'this rehearsal was already judged; ask the instructor for a new rehearsal code', reason: 'already_judged' }, 409);
  if (row.expires_at <= Date.now()) return c.json({ error: 'this rehearsal expired; ask the instructor for a new rehearsal code', reason: 'rehearsal_expired' }, 410);
  const turns = await rehearsalTurns(c.env.HPS_DB, row.rehearsal_id);
  // Nothing was asked yet: the report would only say "not executed". Keep the rehearsal open instead of burning it.
  if (!turns.length) return c.json({ error: 'ask the AI at least once in this rehearsal before sending the result', reason: 'no_request_yet' }, 409);
  const lesson = await readLesson(c.env, row.cohort_id, row.course_id, row.version, row.profile_id), profile = getProfile(row.profile_id);
  if (!lesson || !profile || lesson.sha256 !== row.lesson_sha256) return c.json({ error: 'the candidate cannot be opened under the current profile', reason: 'lesson_unavailable' }, 409);
  const verdict = judgeRehearsal({ content: lesson.content, lessonSha: lesson.sha256, profile, report, turns });
  const now = Date.now();
  await c.env.HPS_DB.prepare('UPDATE authoring_rehearsals SET report_json=?,report_hash=?,reported_at=?,verdict=?,verdict_json=?,judged_at=? WHERE rehearsal_id=? AND token_jti=? AND verdict IS NULL')
    .bind(JSON.stringify(report), hash, now, verdict.verdict, JSON.stringify(verdict), now, row.rehearsal_id, p.jti).run();
  const stored = await c.env.HPS_DB.prepare('SELECT report_hash,verdict_json FROM authoring_rehearsals WHERE rehearsal_id=?').bind(row.rehearsal_id).first<{ report_hash: string; verdict_json: string }>();
  if (!stored || stored.report_hash !== hash) return c.json({ error: 'this rehearsal was already judged', reason: 'already_judged' }, 409);
  return c.json({ rehearsal_id: row.rehearsal_id, ...JSON.parse(stored.verdict_json) });
});
