// #1006 IC-B B1 — every participant-token cohort check, observed through the real app.
// Block 1 is production's first day after merge: authoring_openings is EMPTY, so legacy
// tokens must behave exactly as before and the class branch must not even query D1.
// Block 2 inserts class openings separately. Each route's "passed the cohort check"
// response is chosen to differ from its mismatch response, so disabling any one site
// turns a PASS into a FAIL.
import assert from 'node:assert/strict';
import { bootApp, createMockEnv, makeCtx, withMockUpstream, openAIJsonBody, TEST_SECRET, COHORT, PROFILE, USER } from './harness/index.mjs';
const { issue } = await import('../src/lib/tokens.ts');
const { getProfile } = await import('../src/profiles/index.ts');

const app = await bootApp();
const WRONG = 'wrong-cohort';
const UUID = '11111111-2222-4333-8444-555555555555';
const LESSON = { course_id: 'course-x', version: 'm2026.09.14-1', sha256: '0'.repeat(64) };
const MISMATCH = 'token cohort/profile mismatch';
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

function seat(env, cohort, profileId, users) {
  const now = Date.now();
  env._kv.set(`cohort:${cohort}:roster`, JSON.stringify({ users, updated_at: new Date(now).toISOString() }));
  env._kv.set(`cohort:${cohort}:active_session`, JSON.stringify({ session_id: `s-${cohort}`, profile_id: profileId, starts_at: new Date(now - 60000).toISOString(), ends_at: new Date(now + 3600000).toISOString() }));
}
const token = async (payload) => 'Bearer ' + (await issue(payload, 1, TEST_SECRET)).token;
async function call(env, method, path, auth, body) {
  const headers = { authorization: auth };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.fetch(new Request('https://api.test' + path, { method, headers, body }), env, makeCtx());
  const raw = await res.text(); let json; try { json = JSON.parse(raw); } catch {}
  return { status: res.status, json, raw };
}
const errText = (r) => JSON.stringify(r.json?.error ?? r.json ?? r.raw);
const chatBody = JSON.stringify({ model: 'hypeproof-default', stream: false, messages: [{ role: 'user', content: '안녕' }] });

// Per-route probes: `passed` = the response after the cohort check, `refused` = the mismatch response.
const routes = [
  { site: 'lib/chat-gate.ts', go: (env, a) => withMockUpstream(() => new Response(JSON.stringify(openAIJsonBody({ content: 'ok' })), { status: 200, headers: { 'content-type': 'application/json' } }), () => call(env, 'POST', '/v1/chat/completions', a, chatBody)),
    passed: r => r.status === 200, refused: r => r.status === 401 && errText(r).includes(MISMATCH) },
  { site: 'routes/chat.ts (lesson profile)', lesson: true, go: (env, a) => call(env, 'GET', '/v1/profile', a),
    passed: r => r.status === 409 && r.json?.error?.code === 'lesson_unavailable', refused: r => r.status === 403 && r.json?.error?.code === 'not_in_roster' },
  { site: 'routes/access.ts', go: (env, a) => call(env, 'GET', '/v1/access', a),
    passed: r => r.status === 200, refused: r => r.status === 403 && r.json?.error?.code === 'participant_unavailable' },
  { site: 'routes/classroom.ts', go: (env, a) => call(env, 'GET', '/v1/classroom/shares', a),
    passed: r => r.status === 403 && errText(r).includes('sharing unavailable'), refused: r => r.status === 403 && errText(r).includes('profile/cohort mismatch') },
  { site: 'routes/logs.ts', go: (env, a) => call(env, 'PUT', `/v1/logs/${UUID}/events.jsonl`, a, '{}'),
    // Kids profile allows uploads, so a passing token reaches later request validation (not 401, not roster).
    passed: r => r.status !== 401 && !errText(r).includes(MISMATCH) && r.json?.error?.type !== 'not_in_roster', refused: r => r.status === 401 && errText(r).includes(MISMATCH) },
  { site: 'routes/trace.ts', go: (env, a) => call(env, 'POST', '/v1/trace/event', a, '{}'),
    passed: r => r.status !== 401 && !errText(r).includes(MISMATCH) && r.json?.error?.type !== 'not_in_roster', refused: r => r.status === 401 && errText(r).includes(MISMATCH) },
];

// ---- Block 1: empty authoring_openings (production day one) ----------------
const env = createMockEnv();
seat(env, WRONG, PROFILE, [USER]); // wrong cohort has a live seat, so only the cohort check can refuse
const legacy = await token({ u: USER, c: COHORT, p: PROFILE });
const legacyLesson = await token({ u: USER, c: COHORT, p: PROFILE, lesson: LESSON });
const wrong = await token({ u: USER, c: WRONG, p: PROFILE });
const wrongLesson = await token({ u: USER, c: WRONG, p: PROFILE, lesson: LESSON });

for (const r of routes) {
  await check(`empty openings: legacy token passes the cohort check — ${r.site}`, async () => {
    const res = await r.go(env, r.lesson ? legacyLesson : legacy);
    assert.ok(r.passed(res), `${r.site}: ${res.status} ${res.raw.slice(0, 200)}`);
  });
  await check(`empty openings: legacy token on a wrong cohort is refused — ${r.site}`, async () => {
    const res = await r.go(env, r.lesson ? wrongLesson : wrong);
    assert.ok(r.refused(res), `${r.site}: ${res.status} ${res.raw.slice(0, 200)}`);
  });
}
await check('empty openings: legacy requests never query authoring_openings', async () => {
  assert.equal(env._dbCalls.filter(c => /authoring_openings/.test(c.sql)).length, 0);
});

// ---- Block 2: class openings on one reviewed template (no profile copy) ------
const template = getProfile('studio-native-trial');
template.execution_template = true;
const now = Date.now();
const openings = {
  'class-a': { class_cohort: 'class-a', template_cohort: template.session.cohort_id, profile_id: template.id, course_id: 'course-a', version: 'm2026.09.14-1', starts_at: now - 60000, ends_at: now + 3600000, revoked: 0 },
  'class-b': { class_cohort: 'class-b', template_cohort: template.session.cohort_id, profile_id: template.id, course_id: 'course-b', version: 'm2026.09.14-1', starts_at: now - 60000, ends_at: now + 3600000, revoked: 0 },
  'class-old': { class_cohort: 'class-old', template_cohort: template.session.cohort_id, profile_id: template.id, course_id: 'course-a', version: 'm2026.09.14-1', starts_at: now - 7200000, ends_at: now - 3600000, revoked: 0 },
};
const classEnv = createMockEnv();
const basePrepare = classEnv.HPS_DB.prepare.bind(classEnv.HPS_DB);
classEnv.HPS_DB.prepare = (sql) => {
  if (!/FROM authoring_openings/.test(sql)) return basePrepare(sql);
  let args = [];
  return { bind(...a) { args = a; return this; }, async first() { classEnv._dbCalls.push({ sql, bindings: args }); return openings[args[0]] ?? null; } };
};
for (const cohort of ['class-a', 'class-b', 'class-old', 'class-', 'class-none']) seat(classEnv, cohort, template.id, [`learner-${cohort}`]);
const classRoutes = routes.filter(r => ['routes/access.ts', 'routes/trace.ts'].includes(r.site));
const classToken = (cohort, user = `learner-${cohort}`) => token({ u: user, c: cohort, p: template.id });

for (const r of classRoutes) {
  await check(`one template, two openings: each class token passes on its own cohort — ${r.site}`, async () => {
    for (const cohort of ['class-a', 'class-b']) {
      const res = await r.go(classEnv, await classToken(cohort));
      assert.ok(r.passed(res), `${cohort} ${r.site}: ${res.status} ${res.raw.slice(0, 200)}`);
    }
  });
  await check(`class negatives: missing row, bare prefix, expired opening are refused — ${r.site}`, async () => {
    for (const cohort of ['class-none', 'class-', 'class-old']) {
      const res = await r.go(classEnv, await classToken(cohort));
      assert.ok(r.refused(res), `${cohort} ${r.site}: ${res.status} ${res.raw.slice(0, 200)}`);
    }
  });
}
await check('rosters stay per opening: a class-a learner is not admitted to class-b', async () => {
  const res = await call(classEnv, 'GET', '/v1/access', await classToken('class-b', 'learner-class-a'));
  assert.equal(res.status, 403, res.raw);
});
await check('template flag loss closes the class runtime path', async () => {
  template.execution_template = false;
  try {
    const res = await call(classEnv, 'POST', '/v1/trace/event', await classToken('class-a'), '{}');
    assert.equal(res.status, 401, res.raw);
    assert.equal(res.json?.error?.code, 'template_not_reviewed');
  } finally { template.execution_template = true; }
});
await check('no profile copy: both openings resolve to the same compiled template id', async () => {
  assert.equal(openings['class-a'].profile_id, openings['class-b'].profile_id);
  assert.equal(getProfile(openings['class-a'].profile_id), template);
});

delete template.execution_template;
console.log(`${passed} cohort-route checks passed`);
