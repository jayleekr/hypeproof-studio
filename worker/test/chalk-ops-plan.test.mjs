// #1467 (E3-1) — ops plan brief, skeleton, parser, and PUT /plan tests.
// OP-01~OP-17: time_spec blocks, break_min, family session, parser, violations.
import './harness/loader.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET, COHORT } from './harness/index.mjs';

const { issueIssuer } = await import('../src/lib/tokens.ts');
const { listProfiles } = await import('../src/profiles/index.ts');
const { parsePlan } = await import('../src/lib/chalk-plan/parser.ts');

const app = await bootApp();

// ── Schema ────────────────────────────────────────────────────────────────────
const KB_SCHEMA = `
CREATE TABLE IF NOT EXISTS chalk_knowledge_versions (
  version INTEGER PRIMARY KEY, parent_version INTEGER,
  origin TEXT NOT NULL, source_repo TEXT, source_commit TEXT,
  note TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  doc_count INTEGER NOT NULL, digest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chalk_knowledge_docs (
  version INTEGER NOT NULL REFERENCES chalk_knowledge_versions(version),
  doc_id TEXT NOT NULL, kind TEXT NOT NULL, fields_json TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '', source_path TEXT,
  PRIMARY KEY (version, doc_id)
);
`;
const AUTHORING_SCHEMA = readFileSync(new URL('../migrations/0002-chalk-authoring.sql', import.meta.url), 'utf8');
const PLAN_SCHEMA = readFileSync(new URL('../migrations/0031-chalk-plan-files.sql', import.meta.url), 'utf8');
const TIER_DURATION_SCHEMA = readFileSync(new URL('../migrations/0035-chalk-course-inputs-tier-duration.sql', import.meta.url), 'utf8');

const GOAL_VOCAB = ['inquiry-skills', 'observation', 'creative-thinking'];
const COND_VOCAB = ['single-session', 'novice-learners'];
const PRIOR_VOCAB = ['novice', 'intermediate', 'any'];
const BASE_METHODS = [
  { id: 'm-discovery', best_for: ['inquiry-skills', 'observation'], weak_for: [], avoid_when: [], prior_knowledge: 'any', requires_guidance: false },
];

const profileId = listProfiles().find(p => p.session.cohort_id === COHORT)?.id;
assert.ok(profileId, 'profile not found for COHORT');

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(KB_SCHEMA);
  db.exec(AUTHORING_SCHEMA);
  db.exec(PLAN_SCHEMA);
  db.exec(TIER_DURATION_SCHEMA);
  db.prepare(`INSERT INTO chalk_knowledge_versions VALUES(1,NULL,'vault-import',NULL,NULL,'test','tester',0,${BASE_METHODS.length + 3},'digest0')`).run();
  db.prepare('INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)').run(1, 'vocab:goal', 'vocab', JSON.stringify({ keys: GOAL_VOCAB.map(k => ({ key: k, label: k })) }), '', null);
  db.prepare('INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)').run(1, 'vocab:condition', 'vocab', JSON.stringify({ keys: COND_VOCAB.map(k => ({ key: k, label: k })) }), '', null);
  db.prepare('INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)').run(1, 'vocab:prior', 'vocab', JSON.stringify({ keys: PRIOR_VOCAB.map(k => ({ key: k, label: k })) }), '', null);
  for (const m of BASE_METHODS) {
    db.prepare('INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)').run(1, `method:${m.id}`, 'method', JSON.stringify(m), '', null);
  }
  return db;
}

function makeEnv(db) {
  const env = createMockEnv({ withSession: false });
  function makeStmt(sql) {
    let bindings = [];
    const stmt = {
      get _sql() { return sql; },
      get _bindings() { return bindings; },
      bind(...args) { bindings = [...args]; return stmt; },
      async first() { return db.prepare(sql).get(...bindings) ?? null; },
      async run() { const r = db.prepare(sql).run(...bindings); return { success: true, meta: { changes: Number(r.changes) } }; },
      async all() { return { success: true, results: db.prepare(sql).all(...bindings) }; },
    };
    return stmt;
  }
  env.HPS_DB = {
    prepare(sql) { return makeStmt(sql); },
    async batch(stmts) {
      const results = [];
      for (const stmt of stmts) {
        try {
          const r = db.prepare(stmt._sql).run(...stmt._bindings);
          results.push({ success: true, results: [], meta: { changes: Number(r.changes) } });
        } catch (e) {
          results.push({ success: false, error: String(e) });
        }
      }
      return results;
    },
  };
  return env;
}

const issuerTok = async () =>
  (await issueIssuer({ issuer: 'tester', scopes: [{ cohort: COHORT, profiles: [profileId] }] }, 4, TEST_SECRET)).token;

const base = `/admin/chalk/cohorts/${COHORT}/courses/test-course`;

async function req(method, path, body, credential, db) {
  const env = makeEnv(db ?? makeDb());
  const headers = { authorization: `Bearer ${credential}`, 'content-type': 'application/json' };
  const init = body !== null ? { method, headers, body: JSON.stringify(body) } : { method, headers };
  const res = await app.fetch(
    new Request('https://service.test' + path, init),
    env, makeCtx(),
  );
  let json; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

function seedDraft(db) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO authoring_drafts (cohort_id,course_id,owner_id,profile_id,revision,content_json,request_id,request_hash,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    COHORT, 'test-course', 'tester', '', 1,
    '{"schema":"hps-session-design/1","title":"","audience":"","duration_minutes":120,"objective":"","prerequisites":"","starter":"","steps":[]}',
    'req-seed-initial', 'hash-seed-initial', now,
  );
}

const VALID_INPUTS_WORKSHOP = {
  audience: '초등학교 3-4학년',
  assets: ['INTENT', 'VERIFY'],
  teaching_style: '탐구 기반',
  requirements: '',
  format: 'workshop',
  family_session: false,
  vocab: {
    goals: ['inquiry-skills', 'observation'],
    conditions: ['single-session'],
    learner_level: 'novice',
    has_guidance: false,
  },
  expected_revision: 1,
  request_id: 'req-inputs-workshop',
  profile_id: '',
};

const VALID_INPUTS_TRACK = {
  ...VALID_INPUTS_WORKSHOP,
  format: 'track',
  request_id: 'req-inputs-track',
};

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

// ── OP-01 / OP-17: workshop brief without duration_min → blocks 5개, total_min=240 ──
await check('OP-01/OP-17 workshop brief no duration_min → 5 blocks in time_spec, total_min=240', async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  const putR = await req('PUT', `${base}/inputs`, { ...VALID_INPUTS_WORKSHOP, request_id: 'req-op01-inputs' }, tok, db);
  assert.equal(putR.status, 200, JSON.stringify(putR.json));

  const briefR = await req('GET', `${base}/brief?file=ops`, null, tok, db);
  assert.equal(briefR.status, 200, JSON.stringify(briefR.json));
  const ts = briefR.json.time_spec;
  assert.equal(ts.format, 'workshop', 'time_spec.format must be workshop');
  assert.equal(ts.total_min, 240, 'total_min must be 240 (default)');
  assert.ok(Array.isArray(ts.blocks) && ts.blocks.length === 5, `must have 5 blocks, got: ${JSON.stringify(ts.blocks)}`);
  assert.ok(Array.isArray(ts.core) && ts.core.length === 5, 'workshop core must have 5 entries');
  // Verify core and blocks have same keys
  const coreKeys = ts.core;
  const blockKeys = ts.blocks.map(b => b.key);
  assert.deepEqual(coreKeys, blockKeys, 'core keys must match blocks keys');
});

// ── OP-02: track brief → blocks=[block-1(110), break(20,kind:break), block-2(110)], total_min=240 ──
await check('OP-02 track brief → 3 blocks with correct min values, total_min=240', async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  const putR = await req('PUT', `${base}/inputs`, { ...VALID_INPUTS_TRACK, request_id: 'req-op02-inputs' }, tok, db);
  assert.equal(putR.status, 200, JSON.stringify(putR.json));

  const briefR = await req('GET', `${base}/brief?file=ops`, null, tok, db);
  assert.equal(briefR.status, 200, JSON.stringify(briefR.json));
  const ts = briefR.json.time_spec;
  assert.equal(ts.format, 'track');
  assert.equal(ts.total_min, 240);
  assert.equal(ts.blocks.length, 3, `must have 3 blocks: ${JSON.stringify(ts.blocks)}`);
  assert.equal(ts.blocks[0].key, 'block-1');
  assert.equal(ts.blocks[0].min, 110);
  assert.equal(ts.blocks[1].key, 'break');
  assert.equal(ts.blocks[1].min, 20);
  assert.equal(ts.blocks[1].kind, 'break');
  assert.equal(ts.blocks[2].key, 'block-2');
  assert.equal(ts.blocks[2].min, 110);
});

// ── OP-03: track + break_min=30 → break.min=30, total_min=250 ──
await check('OP-03 track brief with break_min=30 → break block min=30, total_min=250', async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  const putR = await req('PUT', `${base}/inputs`, { ...VALID_INPUTS_TRACK, request_id: 'req-op03-inputs' }, tok, db);
  assert.equal(putR.status, 200, JSON.stringify(putR.json));

  const briefR = await req('GET', `${base}/brief?file=ops&break_min=30`, null, tok, db);
  assert.equal(briefR.status, 200, JSON.stringify(briefR.json));
  const ts = briefR.json.time_spec;
  assert.equal(ts.blocks[1].min, 30, 'break block min must be 30');
  assert.equal(ts.total_min, 250, 'total_min must be 110+30+110=250');
});

// ── OP-04: break_min=4 → 400 ─────────────────────────────────────────────────
await check('OP-04 track brief with break_min=4 → 400 invalid_request', async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  await req('PUT', `${base}/inputs`, { ...VALID_INPUTS_TRACK, request_id: 'req-op04-inputs' }, tok, db);

  const r = await req('GET', `${base}/brief?file=ops&break_min=4`, null, tok, db);
  assert.equal(r.status, 400, `must be 400, got ${r.status}: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.code, 'invalid_request');
});

// ── OP-05: break_min=61 → 400 ────────────────────────────────────────────────
await check('OP-05 track brief with break_min=61 → 400 invalid_request', async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  await req('PUT', `${base}/inputs`, { ...VALID_INPUTS_TRACK, request_id: 'req-op05-inputs' }, tok, db);

  const r = await req('GET', `${base}/brief?file=ops&break_min=61`, null, tok, db);
  assert.equal(r.status, 400, `must be 400: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.code, 'invalid_request');
});

// ── OP-06: workshop + break_min → 400 break_min_track_only (correction #2) ──
await check('OP-06 workshop brief with break_min → 400 break_min_track_only', async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  await req('PUT', `${base}/inputs`, { ...VALID_INPUTS_WORKSHOP, request_id: 'req-op06-inputs' }, tok, db);

  const r = await req('GET', `${base}/brief?file=ops&break_min=20`, null, tok, db);
  assert.equal(r.status, 400, `must be 400: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.code, 'break_min_track_only', `must be break_min_track_only: ${JSON.stringify(r.json)}`);
});

// ── OP-07: file=ops brief → data-chalk-kind="ops", 5 sections, 3 block rows (track) ──
await check('OP-07 ops brief skeleton_html: data-chalk-kind=ops, 5 sections, 3 blocks (track)', async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  await req('PUT', `${base}/inputs`, { ...VALID_INPUTS_TRACK, request_id: 'req-op07-inputs' }, tok, db);

  const briefR = await req('GET', `${base}/brief?file=ops`, null, tok, db);
  assert.equal(briefR.status, 200, JSON.stringify(briefR.json));
  const html = briefR.json.skeleton_html;
  assert.ok(html.includes('data-chalk-kind="ops"'), 'skeleton must have data-chalk-kind="ops"');
  const sectionMatches = [...html.matchAll(/data-chalk-section="/g)];
  assert.equal(sectionMatches.length, 5, `must have 5 sections, got ${sectionMatches.length}`);
  const blockMatches = [...html.matchAll(/data-chalk-block="/g)];
  assert.equal(blockMatches.length, 3, `track must have 3 block rows, got ${blockMatches.length}`);
});

// ── OP-08~OP-14: parsePlan direct tests (no DB/HTTP) ─────────────────────────

// Shared ops HTML samples
const OPS_TRACK_HTML = `<!DOCTYPE html>
<html lang="ko" data-chalk-plan="1" data-chalk-kind="ops">
<head>
  <meta charset="utf-8">
  <meta name="chalk:course" content="test-course">
  <meta name="chalk:knowledge-version" content="1">
  <meta name="chalk:format" content="track">
  <meta name="chalk:audience-tier" content="lv1">
  <meta name="chalk:family-session" content="false">
  <meta name="chalk:duration-min" content="240">
</head>
<body>
  <section data-chalk-section="schedule">
    <table>
      <tr data-chalk-block="block-1" data-chalk-step-ref="s-1 s-2" data-start="09:00" data-duration-min="110">
        <td data-chalk-field="activity">탐구</td>
        <td data-chalk-field="asset">키트</td>
        <td data-chalk-field="artifact">노트</td>
        <td data-chalk-role="facilitator">진행</td>
        <td data-chalk-role="learner">활동</td>
        <td data-chalk-field="exit-criteria">완료</td>
        <td data-chalk-field="if-stuck">힌트</td>
      </tr>
      <tr data-chalk-block="break" data-chalk-block-kind="break" data-start="10:50" data-duration-min="20">
        <td data-chalk-field="activity">휴식</td>
      </tr>
      <tr data-chalk-block="block-2" data-chalk-step-ref="s-3" data-start="11:10" data-duration-min="110">
        <td data-chalk-field="activity">심화</td>
        <td data-chalk-field="asset">카드</td>
        <td data-chalk-field="artifact">발표지</td>
        <td data-chalk-role="facilitator">심화 진행</td>
        <td data-chalk-role="learner">심화 활동</td>
        <td data-chalk-field="exit-criteria">발표</td>
        <td data-chalk-field="if-stuck">질문</td>
      </tr>
    </table>
  </section>
  <section data-chalk-section="materials"><ul></ul></section>
  <section data-chalk-section="risks">
    <ul>
      <li data-chalk-risk="ai-latency"><span data-chalk-field="first-line">AI 응답 지연 시 대처</span></li>
      <li data-chalk-risk="content-guard"><span data-chalk-field="first-line">부적절 콘텐츠 차단</span></li>
      <li data-chalk-risk="pace-gap"><span data-chalk-field="first-line">속도 차이 대처</span></li>
      <li data-chalk-risk="parent-overreach"><span data-chalk-field="first-line">부모 과잉 개입 대처</span></li>
      <li data-chalk-risk="overtime"><span data-chalk-field="first-line">시간 초과 대처</span></li>
    </ul>
  </section>
  <section data-chalk-section="consent"><ul></ul></section>
  <section data-chalk-section="post-deliverables"><ul></ul></section>
</body>
</html>`;

// ops HTML with family_session=true (parent cells added)
const OPS_FAMILY_HTML = OPS_TRACK_HTML
  .replace('data-chalk-kind="ops"', 'data-chalk-kind="ops"')
  .replace('<meta name="chalk:family-session" content="false">', '<meta name="chalk:family-session" content="true">')
  .replace(
    /<tr data-chalk-block="block-1"[\s\S]*?<\/tr>/,
    `<tr data-chalk-block="block-1" data-chalk-step-ref="s-1" data-start="" data-duration-min="110">
        <td data-chalk-field="activity">탐구</td>
        <td data-chalk-field="asset">키트</td>
        <td data-chalk-field="artifact">노트</td>
        <td data-chalk-role="facilitator">진행</td>
        <td data-chalk-role="learner">활동</td>
        <td data-chalk-role="parent" data-chalk-parent-role="관찰자"></td>
        <td data-chalk-field="exit-criteria">완료</td>
        <td data-chalk-field="if-stuck">힌트</td>
      </tr>`,
  );

// ── OP-08: parsePlan ops HTML → blocks[] 3개, risks[] 5개 ────────────────────
await check('OP-08 parsePlan(ops) → blocks.length=3, risks.length=5', () => {
  const result = parsePlan(OPS_TRACK_HTML, 'ops');
  assert.ok(Array.isArray(result.blocks), 'blocks must be array');
  assert.equal(result.blocks.length, 3, `blocks must have 3 items: ${JSON.stringify(result.blocks?.map(b => b.key))}`);
  assert.ok(Array.isArray(result.risks), 'risks must be array');
  assert.equal(result.risks.length, 5, `risks must have 5 items: ${JSON.stringify(result.risks?.map(r => r.key))}`);
});

// ── OP-09: blocks 구조 — key/kind/durationMin/stepRefs/roles 확인 ─────────────
await check('OP-09 parsePlan(ops) block fields: key, kind, durationMin, stepRefs, roles', () => {
  const result = parsePlan(OPS_TRACK_HTML, 'ops');
  const b1 = result.blocks?.find(b => b.key === 'block-1');
  const brk = result.blocks?.find(b => b.key === 'break');
  const b2 = result.blocks?.find(b => b.key === 'block-2');

  assert.ok(b1, 'block-1 must exist');
  assert.equal(b1.kind, 'normal', 'block-1 kind must be normal');
  assert.equal(b1.durationMin, 110, 'block-1 durationMin must be 110');
  assert.deepEqual(b1.stepRefs, ['s-1', 's-2'], 'block-1 stepRefs must be [s-1, s-2]');
  assert.ok(b1.roles.facilitator !== undefined, 'block-1 must have facilitator');
  assert.ok(b1.roles.learner !== undefined, 'block-1 must have learner');

  assert.ok(brk, 'break block must exist');
  assert.equal(brk.kind, 'break', 'break kind must be break');
  assert.equal(brk.durationMin, 20, 'break durationMin must be 20');

  assert.ok(b2, 'block-2 must exist');
  assert.deepEqual(b2.stepRefs, ['s-3'], 'block-2 stepRefs must be [s-3]');
});

// ── OP-10: risks — 5 keys, firstLine 추출 ────────────────────────────────────
await check('OP-10 parsePlan(ops) risks: 5 keys, firstLine extracted', () => {
  const result = parsePlan(OPS_TRACK_HTML, 'ops');
  const riskKeys = result.risks?.map(r => r.key) ?? [];
  assert.deepEqual(
    riskKeys.sort(),
    ['ai-latency', 'content-guard', 'overtime', 'pace-gap', 'parent-overreach'],
    `risk keys mismatch: ${JSON.stringify(riskKeys)}`,
  );
  const aiRisk = result.risks?.find(r => r.key === 'ai-latency');
  assert.ok(aiRisk?.firstLine && aiRisk.firstLine.length > 0, 'ai-latency risk firstLine must be extracted');
});

// ── OP-11: missing risk key → spec.risk_missing ───────────────────────────────
await check('OP-11 parsePlan(ops) missing risk key → spec.risk_missing violation', () => {
  const htmlMissingRisk = OPS_TRACK_HTML.replace(
    '<li data-chalk-risk="overtime"><span data-chalk-field="first-line">시간 초과 대처</span></li>',
    '',
  );
  const result = parsePlan(htmlMissingRisk, 'ops');
  const v = result.violations.find(v => v.item === 'spec.risk_missing');
  assert.ok(v, `spec.risk_missing must be emitted, violations: ${JSON.stringify(result.violations.map(v => v.item))}`);
  assert.ok(v?.at?.field === 'overtime', `violation must point to overtime key, got: ${v?.at?.field}`);
});

// ── OP-12: no buffer block → spec.buffer_missing ──────────────────────────────
await check('OP-12 parsePlan(ops) no buffer block → spec.buffer_missing; adding buffer clears it', () => {
  // No buffer → violation
  const result = parsePlan(OPS_TRACK_HTML, 'ops');
  const v = result.violations.find(v => v.item === 'spec.buffer_missing');
  assert.ok(v, `spec.buffer_missing must be emitted when no buffer block, violations: ${JSON.stringify(result.violations.map(v => v.item))}`);

  // Adding a buffer block → no spec.buffer_missing
  const htmlWithBuffer = OPS_TRACK_HTML.replace(
    '</table>',
    `  <tr data-chalk-block="buffer" data-chalk-block-kind="buffer" data-start="" data-duration-min="10">
        <td data-chalk-field="activity">여유</td>
        <td data-chalk-role="facilitator"></td>
      </tr>
    </table>`,
  );
  const result2 = parsePlan(htmlWithBuffer, 'ops');
  const v2 = result2.violations.find(v => v.item === 'spec.buffer_missing');
  assert.ok(!v2, 'spec.buffer_missing must NOT be emitted when buffer block exists');
});

// ── OP-13: normal block with empty step-ref → spec.block_step_unlinked ────────
await check('OP-13 parsePlan(ops) normal block empty step-ref → spec.block_step_unlinked', () => {
  const htmlEmptyRef = OPS_TRACK_HTML
    .replace('data-chalk-step-ref="s-1 s-2"', 'data-chalk-step-ref=""')
    .replace('data-chalk-step-ref="s-3"', 'data-chalk-step-ref=""');
  const result = parsePlan(htmlEmptyRef, 'ops');
  const vs = result.violations.filter(v => v.item === 'spec.block_step_unlinked');
  assert.ok(vs.length >= 2, `both normal blocks with empty step-ref must emit spec.block_step_unlinked, got ${vs.length}: ${JSON.stringify(vs.map(v => v.at))}`);
});

// ── OP-14: family session skeleton has parent cell; non-family does not ────────
// (correction #4) — verified via parsePlan: parent role present ↔ family_session=true
await check('OP-14 family_session=true → parent role in blocks; false → no parent role', () => {
  // family = true → parent present in block-1
  const familyResult = parsePlan(OPS_FAMILY_HTML, 'ops');
  const fb1 = familyResult.blocks?.find(b => b.key === 'block-1');
  assert.ok(fb1?.roles.parent !== undefined, 'family session block must have parent role');

  // family = false → no parent in block
  const nonFamilyResult = parsePlan(OPS_TRACK_HTML, 'ops');
  const nfb1 = nonFamilyResult.blocks?.find(b => b.key === 'block-1');
  assert.ok(nfb1?.roles.parent === undefined, 'non-family block must NOT have parent role');
});

// ── OP-15: PUT /plan file=ops → no spec.section_missing in findings ───────────
// ops files don't have lesson sections (flow/support/etc.) — parser must not flag them
await check('OP-15 PUT /plan file=ops → no spec.section_missing in findings', async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  const inputsR = await req('PUT', `${base}/inputs`, { ...VALID_INPUTS_TRACK, request_id: 'req-op15-inputs' }, tok, db);
  assert.equal(inputsR.status, 200, `PUT /inputs must succeed: ${JSON.stringify(inputsR.json)}`);
  const revision = inputsR.json.revision;

  const putR = await req('PUT', `${base}/plan`, {
    html: OPS_TRACK_HTML,
    file: 'ops',
    knowledge_version: 1,
    expected_revision: revision,
    request_id: 'req-op15-plan',
  }, tok, db);
  assert.equal(putR.status, 200, `PUT /plan must succeed: ${JSON.stringify(putR.json)}`);
  const findings = putR.json.findings ?? [];
  const sectionMissing = findings.filter(f => f.item === 'spec.section_missing');
  assert.equal(sectionMissing.length, 0, `ops plan must not have spec.section_missing violations, got: ${JSON.stringify(sectionMissing)}`);
});

// ── OP-16: PUT /plan file=ops, no lesson row → skipped finding (correction #5) ──
await check('OP-16 PUT /plan file=ops with no lesson → skipped info finding emitted', async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  const inputsR = await req('PUT', `${base}/inputs`, { ...VALID_INPUTS_TRACK, request_id: 'req-op16-inputs' }, tok, db);
  assert.equal(inputsR.status, 200, `PUT /inputs must succeed: ${JSON.stringify(inputsR.json)}`);
  const revision = inputsR.json.revision;

  const putR = await req('PUT', `${base}/plan`, {
    html: OPS_TRACK_HTML,
    file: 'ops',
    knowledge_version: 1,
    expected_revision: revision,
    request_id: 'req-op16-plan',
  }, tok, db);
  assert.equal(putR.status, 200, `PUT /plan must succeed: ${JSON.stringify(putR.json)}`);
  const findings = putR.json.findings ?? [];
  const skipped = findings.find(f => f.skipped === true);
  assert.ok(skipped, `must include a skipped finding when no lesson exists, findings: ${JSON.stringify(findings)}`);
});

// ── OP-17: brief(file=ops) no profile_id → auto_materials=[] ─────────────────
await check('OP-17 brief(file=ops) no profile_id → auto_materials empty array', async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  await req('PUT', `${base}/inputs`, { ...VALID_INPUTS_TRACK, profile_id: '', request_id: 'req-op17-inputs' }, tok, db);

  const briefR = await req('GET', `${base}/brief?file=ops`, null, tok, db);
  assert.equal(briefR.status, 200, JSON.stringify(briefR.json));
  assert.ok(Array.isArray(briefR.json.auto_materials), 'auto_materials must be array');
  assert.equal(briefR.json.auto_materials.length, 0, `no profile → auto_materials must be empty, got: ${JSON.stringify(briefR.json.auto_materials)}`);
});

// ── OP-18: brief(file=ops) with profile_id → auto_materials has auto-token + auto-studio ──
await check('OP-18 brief(file=ops) with profile_id → auto_materials includes auto-token and auto-studio', async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  await req('PUT', `${base}/inputs`, { ...VALID_INPUTS_TRACK, profile_id: profileId, request_id: 'req-op18-inputs' }, tok, db);

  const briefR = await req('GET', `${base}/brief?file=ops`, null, tok, db);
  assert.equal(briefR.status, 200, JSON.stringify(briefR.json));
  const ams = briefR.json.auto_materials;
  assert.ok(Array.isArray(ams) && ams.length > 0, `auto_materials must be non-empty with a profile, got: ${JSON.stringify(ams)}`);
  assert.ok(ams.some(m => m.id === 'auto-token'), `auto-token must be present, got ids: ${JSON.stringify(ams.map(m => m.id))}`);
  assert.ok(ams.some(m => m.id === 'auto-studio'), `auto-studio must be present, got ids: ${JSON.stringify(ams.map(m => m.id))}`);
});

// ── OP-19: brief(file=ops) no profile_id → all 4 keys in consent_pending ────
await check('OP-19 brief(file=ops) no profile_id → consent_pending has all 4 keys', async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  await req('PUT', `${base}/inputs`, { ...VALID_INPUTS_TRACK, profile_id: '', request_id: 'req-op19-inputs' }, tok, db);

  const briefR = await req('GET', `${base}/brief?file=ops`, null, tok, db);
  assert.equal(briefR.status, 200, JSON.stringify(briefR.json));
  const pending = briefR.json.consent_pending;
  assert.ok(Array.isArray(pending), 'consent_pending must be array');
  const REQUIRED = ['model', 'account', 'log-collection', 'publishing'];
  for (const key of REQUIRED) {
    assert.ok(pending.includes(key), `consent_pending must include ${key}, got: ${JSON.stringify(pending)}`);
  }
});

// ── OP-20: PUT /plan ops with stale auto materials → spec.auto_material_stale warn ──
await check('OP-20 PUT /plan ops stale auto materials → spec.auto_material_stale warning', async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  const inputsR = await req('PUT', `${base}/inputs`, { ...VALID_INPUTS_TRACK, profile_id: profileId, request_id: 'req-op20-inputs' }, tok, db);
  assert.equal(inputsR.status, 200, `PUT /inputs must succeed: ${JSON.stringify(inputsR.json)}`);
  const revision = inputsR.json.revision;

  // Replace the empty materials section with a stale set: extra auto-skill-quiz
  // that the real profile (no skills) would not produce → diffAutoMaterials returns true.
  const staleHtml = OPS_TRACK_HTML.replace(
    '<section data-chalk-section="materials"><ul></ul></section>',
    `<section data-chalk-section="materials"><ul>
      <li data-chalk-material="auto-token" data-kind="account" data-owner="instructor" data-auto="true">학생 토큰</li>
      <li data-chalk-material="auto-skill-quiz" data-kind="digital" data-owner="instructor" data-auto="true">스킬 quiz</li>
      <li data-chalk-material="auto-studio" data-kind="account" data-owner="learner" data-auto="true">Studio 설치</li>
    </ul></section>`,
  );

  const putR = await req('PUT', `${base}/plan`, {
    html: staleHtml,
    file: 'ops',
    knowledge_version: 1,
    expected_revision: revision,
    request_id: 'req-op20-plan',
  }, tok, db);
  assert.equal(putR.status, 200, `PUT /plan must succeed: ${JSON.stringify(putR.json)}`);
  const findings = putR.json.findings ?? [];
  const stale = findings.find(f => f.item === 'spec.auto_material_stale');
  assert.ok(stale, `spec.auto_material_stale must be emitted when stored auto ids differ from live, findings: ${JSON.stringify(findings.map(f => f.item))}`);
  assert.equal(stale.severity, 'warn', 'spec.auto_material_stale must be warn severity');
});

// ── OP-21: parsePlan material missing kind/owner → violations ─────────────────
await check('OP-21 parsePlan ops material missing kind/owner → spec.material_kind_missing + spec.material_owner_missing', () => {
  const htmlBadMaterial = OPS_TRACK_HTML.replace(
    '<section data-chalk-section="materials"><ul></ul></section>',
    `<section data-chalk-section="materials"><ul>
      <li data-chalk-material="m-bad">준비물 (kind/owner 없음)</li>
    </ul></section>`,
  );
  const result = parsePlan(htmlBadMaterial, 'ops');
  const kindV = result.violations.find(v => v.item === 'spec.material_kind_missing');
  const ownerV = result.violations.find(v => v.item === 'spec.material_owner_missing');
  assert.ok(kindV, `spec.material_kind_missing must be emitted, violations: ${JSON.stringify(result.violations.map(v => v.item))}`);
  assert.ok(ownerV, `spec.material_owner_missing must be emitted, violations: ${JSON.stringify(result.violations.map(v => v.item))}`);
});

// ── OP-22: parsePlan consent section missing model+account → 2x spec.consent_missing ──
await check('OP-22 parsePlan ops consent missing model/account → spec.consent_missing x2', () => {
  const htmlMissingConsent = OPS_TRACK_HTML.replace(
    '<section data-chalk-section="consent"><ul></ul></section>',
    `<section data-chalk-section="consent"><ul>
      <li data-chalk-consent="log-collection">대화 본문을 저장하지 않습니다</li>
      <li data-chalk-consent="publishing">결과물을 공개하지 않습니다</li>
    </ul></section>`,
  );
  const result = parsePlan(htmlMissingConsent, 'ops');
  const consentViolations = result.violations.filter(v => v.item === 'spec.consent_missing');
  assert.ok(consentViolations.length >= 2, `must emit 2 spec.consent_missing violations for model+account, got ${consentViolations.length}: ${JSON.stringify(consentViolations.map(v => v.at))}`);
  const missingKeys = consentViolations.map(v => v.at?.field);
  assert.ok(missingKeys.includes('model'), `model must be in missing keys, got: ${JSON.stringify(missingKeys)}`);
  assert.ok(missingKeys.includes('account'), `account must be in missing keys, got: ${JSON.stringify(missingKeys)}`);
});

console.log(`\n${passed} tests passed`);
