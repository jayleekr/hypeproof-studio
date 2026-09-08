// Production request-settings SQL on local workerd/D1; no production bindings.
import './harness/loader.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { persistRequestSettings, readRequestSettings } from '../src/lib/request-settings.ts';

const compatibilityDate = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
  .match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
assert.ok(compatibilityDate);
const mf = new Miniflare({ modules: true, compatibilityDate, d1Databases: ['HPS_DB'],
  script: 'export default {fetch(){return new Response("local test")}}' });
try {
  const db = await mf.getD1Database('HPS_DB');
  const env = { HPS_DB: db };
  const migration = readFileSync(new URL('../migrations/0005-request-settings.sql', import.meta.url), 'utf8')
    .replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
  const migrate = async () => { for (const statement of migration) await db.prepare(statement).run(); };
  await migrate();
  const student = { c: 'synthetic-cohort', u: 'synthetic-student', p: 'synthetic-profile',
    lesson: { course_id: 'synthetic-course', version: 'm2026.09.08-1', sha256: 'synthetic-sha' } };
  const receipt = { requested: 'low', applied: 'low', reason: 'selected' };
  await Promise.all(Array.from({ length: 8 }, () =>
    persistRequestSettings(env, student, 'same-turn', 'same-request', 'claude-sonnet-4-6', receipt, 200)));
  let rows = (await readRequestSettings(env, student, 'same-turn')).results;
  assert.equal(rows.length, 1, 'concurrent duplicate persistence remains one request');
  assert.equal(rows[0].applied, 'low');
  assert.equal(rows[0].status, 200);
  await migrate();
  assert.equal((await readRequestSettings(env, student, 'same-turn')).results.length, 1,
    'repeat deployment preserves existing metadata');
  for (const other of [
    { ...student, c: 'other-cohort' }, { ...student, u: 'other-student' },
    { ...student, p: 'other-profile' }, { ...student, lesson: undefined },
    { ...student, lesson: { ...student.lesson, course_id: 'other-course' } },
    { ...student, lesson: { ...student.lesson, version: 'm2026.09.08-2' } },
    { ...student, lesson: { ...student.lesson, sha256: 'other-sha' } },
  ]) assert.equal((await readRequestSettings(env, other, 'same-turn')).results.length, 0);
  assert.equal((await readRequestSettings(env, student, 'other-turn')).results.length, 0);
  await persistRequestSettings(env, student, 'same-turn', 'unsupported', 'claude-haiku-4-5',
    { requested: null, applied: null, reason: 'unsupported_model' }, 502);
  rows = (await readRequestSettings(env, student, 'same-turn')).results;
  const unsupported = rows.find(r => r.request_id === 'unsupported');
  assert.equal(unsupported.applied, null);
  assert.equal(unsupported.requested, null);
  assert.equal(unsupported.status, 502);
  assert.equal(typeof unsupported.created_at, 'string');
  console.log('PASS local workerd/D1: migration repeat, concurrent duplicate write, nullable receipt and cohort/student/profile/course/version/hash/turn isolation');
} finally { await mf.dispose(); }
