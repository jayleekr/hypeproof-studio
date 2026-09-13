// #1006 IC-01/IC-02 (IC-T01/IC-T02 slice 1): a new course drafts without a
// customer profile, selects only an admin-scoped execution template, and two
// synthetic institutions cannot read, overwrite or freeze each other's course.
// Real Service routing + signed tokens + SQLite running the production migration.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET } from './harness/index.mjs';
const { issueIssuer, issue } = await import('../src/lib/tokens.ts');
const { listProfiles, getProfile } = await import('../src/profiles/index.ts');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

await check('IC-02 no execution template is activated in the shipped registry', async () => {
  // Activation is a separate admin decision (#1006). Flip this deliberately with that decision.
  assert.deepEqual(listProfiles().filter(p => p.execution_template).map(p => p.id), []);
});

// Synthetic template: flag a neutral adult profile in-process only.
const template = getProfile('studio-native-trial');
assert.ok(template && template.minor_cohort !== true && !(template.audience.age_range?.[1] < 18));
template.execution_template = true;
const cohort = template.session.cohort_id;
const customer = listProfiles().find(p => p.id.includes('boah-dental-director-copyclone'));
assert.ok(customer && customer.session.cohort_id !== cohort);

const app = await bootApp();
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
db.exec(readFileSync(new URL('../migrations/0002-chalk-authoring.sql', import.meta.url), 'utf8'));
const env = createMockEnv();
env.HPS_DB = { prepare(sql) { let args = []; return {
  bind(...a) { args = a; return this; },
  async first() { return db.prepare(sql).get(...args) ?? null; },
  async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
  async all() { return { success: true, results: db.prepare(sql).all(...args) }; },
}; } };

const issuer = async (name, scopes) => (await issueIssuer({ issuer: name, scopes }, 48, TEST_SECRET)).token;
const orgA = await issuer('org-a-lead', [{ cohort, profiles: [template.id] }]);
const orgB = await issuer('org-b-lead', [{ cohort, profiles: [template.id] }]);
const noTemplate = await issuer('org-c-lead', [{ cohort, profiles: [] }]);
const otherCohort = await issuer('org-d-lead', [{ cohort: customer.session.cohort_id, profiles: [customer.id] }]);
const student = (await issue({ u: 'learner', c: cohort, p: template.id }, 1, TEST_SECRET)).token;

const course = 'c-5b0f2a0e-1d7e-4c1e-9d55-0a1b2c3d4e5f';
const base = `/admin/cohorts/${cohort}/authoring/${course}`;
const content = { schema: 'hps-session-design/1', title: '첫 창업 아이디어 검증', audience: '예비 창업자', duration_minutes: 90,
  objective: '고객 문제 가설을 세우고 인터뷰 질문을 만든다', prerequisites: '', starter: '빈 작업 폴더',
  steps: [{ id: 'problem', title: '문제 가설', instructions: '해결하고 싶은 고객 문제를 한 문장으로 쓰세요', hint: '', acceptance: '문제·대상·상황이 모두 있다' }] };
const save = (revision, id, profile_id = '', data = content) => ({ expected_revision: revision, request_id: id, profile_id, content: data });
async function call(path, method = 'GET', body, credential = orgA) {
  const headers = { authorization: `Bearer ${credential}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.fetch(new Request('https://service.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, makeCtx());
  const raw = await res.text(); let json; try { json = JSON.parse(raw); } catch {}
  return { status: res.status, json, raw };
}
const row = () => db.prepare('SELECT profile_id, revision, content_json, owner_id FROM authoring_drafts WHERE course_id=?').get(course);
const versions = () => db.prepare('SELECT count(*) n FROM authoring_versions').get().n;

await check('IC-T01 draft saves and reopens with no customer profile or template', async () => {
  const r = await call(base, 'PUT', save(0, 'create'));
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.json.profile_id, null);
  assert.deepEqual(r.json.opening_blocked_by, ['template_required']);
  const again = await call(base);
  assert.equal(again.status, 200, again.raw);
  assert.deepEqual(again.json.content, content);
  assert.deepEqual(again.json.opening_blocked_by, ['template_required']);
});

await check('IC-T01 exact retry is idempotent; reused request id with other content is 409 and original unchanged', async () => {
  assert.equal((await call(base, 'PUT', save(0, 'create'))).json.revision, 1);
  const before = row();
  assert.equal((await call(base, 'PUT', save(0, 'create', '', { ...content, title: 'different' }))).status, 409);
  assert.deepEqual(row(), before);
});

await check('IC-02 template-less draft cannot freeze, deliver, or narrow model/features', async () => {
  const f = await call(base + '/versions/m2026.09.13-1', 'PUT', { expected_revision: 1 });
  assert.equal(f.status, 409, f.raw);
  assert.equal(f.json.reason, 'template_required');
  assert.equal(versions(), 0);
  assert.equal((await call(base + '/versions/m2026.09.13-1/participants', 'POST', { user: 'learner', hours: 1 })).status, 409);
  assert.equal((await call(base, 'PUT', save(1, 'model', '', { ...content, model: { allowed: ['hypeproof-default'] } }))).status, 400);
  assert.equal(row().revision, 1);
});

await check('IC-T02 other institution in the same template scope cannot read, overwrite or freeze', async () => {
  assert.equal((await call(base, 'GET', undefined, orgB)).status, 404);
  assert.equal((await call(base, 'PUT', save(1, 'steal', template.id), orgB)).status, 404);
  // A create attempt on someone else's existing course id is hidden, never an overwrite.
  assert.equal((await call(base, 'PUT', save(0, 'steal-new', template.id), orgB)).status, 404);
  assert.equal((await call(base + '/versions/m2026.09.13-1', 'PUT', { expected_revision: 1 }, orgB)).status, 404);
  assert.equal(row().owner_id, 'org-a-lead');
  assert.equal(row().profile_id, '');
});

await check('IC-T02 direct API rejects student, other cohort, unscoped and forged templates, customer profile from elsewhere', async () => {
  const before = row();
  assert.equal((await call(base, 'PUT', save(1, 's', template.id), student)).status, 403);
  assert.equal((await call(base, 'PUT', save(1, 'o', template.id), otherCohort)).status, 403);
  // Scope check precedes the owner lookup, so an unscoped template is refused before any draft is read.
  assert.equal((await call(base, 'PUT', save(1, 'u', template.id), noTemplate)).status, 403);
  assert.equal((await call(base, 'PUT', save(1, 'f', 'forged-template'))).status, 403);
  assert.equal((await call(base, 'PUT', save(1, 'x', customer.id))).status, 403);
  assert.deepEqual(row(), before);
});

await check('IC-01 selecting the scoped template makes the draft freezable; version binds the template', async () => {
  const r = await call(base, 'PUT', save(1, 'pick', template.id));
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(r.json.opening_blocked_by, []);
  const f = await call(base + '/versions/m2026.09.13-1', 'PUT', { expected_revision: 2 });
  assert.equal(f.status, 200, f.raw);
  assert.equal(f.json.module.profile_id, template.id);
  assert.equal(f.json.activated, false);
  assert.equal((await call(base + '/versions/m2026.09.13-1', 'GET', undefined, orgB)).status, 404);
});

console.log(`${passed} independent-course checks passed`);
