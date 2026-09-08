import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { bootApp, createMockEnv, makeCtx, COHORT, PROFILE } from './index.mjs';

export async function localUsageObservation() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8'));
  db.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(COHORT, 'Synthetic class');
  db.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)')
    .run('synthetic-session', COHORT, PROFILE, '2026-09-08', '2026-09-09');
  const insert = db.prepare(`INSERT INTO usage_log
    (cohort_id,user_id,session_id,profile_id,model,tokens_in,tokens_out,cache_read,cache_write,status)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insert.run(COHORT, 'synthetic-one', 'synthetic-session', PROFILE, 'claude-sonnet-4-6', 100, 20, 300, 50, 200);
  insert.run(COHORT, 'synthetic-two', 'synthetic-session', PROFILE, 'claude-opus-5', 7, 3, 40, 4, 502);
  insert.run(COHORT, 'synthetic-three', null, PROFILE, 'claude-sonnet-4-6', 0, 0, 0, 0, 429);
  insert.run(COHORT, '<img src=x onerror="window.usageInjected=true">', null, PROFILE, 'gpt-5.6-luna', 500, 4, 0, 0, 200);
  insert.run('other-cohort', 'private-other-student', null, PROFILE, 'other-model', 999999, 999999, 999999, 999999, 200);
  const app = await bootApp();
  const env = createMockEnv({ adminPassword: 'synthetic-password' });
  const state = { failReads: false, queries: [] };
  env.HPS_DB = { prepare(sql) {
    let args = [];
    return { bind(...values) { args = values; return this; }, async all() {
      state.queries.push(sql);
      if (state.failReads) throw Error('synthetic D1 failure');
      return { success: true, results: db.prepare(sql).all(...args) };
    } };
  } };
  return { db, app, env, state, cohort: COHORT,
    auth: 'Basic ' + Buffer.from('synthetic:synthetic-password').toString('base64'),
    fetch(request) { return app.fetch(request, env, makeCtx()); },
    close() { db.close(); } };
}
