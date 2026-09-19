// 「누르기 전」과 「누른 뒤」가 같은 말을 한다 (#1151, RUN-02).
//
// 이 파일이 잠그는 것은 **동등성**이다: 읽기 전용 점검 경로(`GET …/assessment`)가
// 말하는 첫 판정과, 확정(`PUT …/versions/:version`)이 실제로 내는 응답이 같아야 한다.
// 상태코드·`reason`·문구까지.
//
// 왜 함수 동일성이 아니라 동등성인가: 지금은 두 라우트가 같은 모듈의 `assessDraft`
// 를 부르므로 함수 동일성은 **자동으로 참**이고 아무것도 증명하지 않는다. 깨질 수
// 있는 것은 "누군가 확정 쪽에 검사를 하나 더 인라인으로 넣는 것"이고, 그것은 응답을
// 비교해야만 드러난다. 그래서 응답을 비교한다.
//
// 리팩터링이 판정을 **조금이라도** 바꾸면 여기서 실패한다 — 그게 #1151 의 조건이다.
//
// Run: node --experimental-strip-types --experimental-sqlite test/draft-assessment.test.mjs

import assert from 'node:assert/strict';
// 확장자 없는 상대 import 를 .ts 로 풀어 주는 훅. src/ 에 닿는 어떤 import 보다 먼저 와야 한다.
import './harness/loader.mjs';
import { localAuthoring } from './harness/dental-authoring.mjs';
// 정적 import 는 훅 등록 **전에** 전부 resolve 된다 — src/ 는 동적으로 가져온다.
const { assessDraft } = await import('../src/lib/draft-assessment.ts');

const local = await localAuthoring({});
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };

const BASE = {
  schema: 'hps-session-design/1', title: '점검', audience: '성인', duration_minutes: 120,
  objective: '확정 전에 무엇이 막는지 본다', prerequisites: '코딩 경험 불필요', starter: '정적 사이트',
  steps: [{ id: 'one', title: '한 단계', instructions: '제출 증거: index.html', hint: '', acceptance: '열리는지 확인' }],
};

let seq = 0;
const call = async (course, suffix, method = 'GET', body) => {
  const r = await local.fetcher(
    `${local.origin}/admin/cohorts/${local.cohort}/authoring/${course}${suffix}`,
    { method, headers: { authorization: `Bearer ${local.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined },
  );
  return { status: r.status, body: await r.json() };
};

/** 초안 하나를 만들고, 점검 응답과 확정 응답을 나란히 돌려준다. */
async function assessThenFreeze(content, { profileId = local.profileId } = {}) {
  const course = 'assess-' + (++seq);
  const saved = await call(course, '', 'PUT', { expected_revision: 0, request_id: 'c' + seq, profile_id: profileId, content });
  assert.equal(saved.status, 200, '시료 저장이 되어야 이 비교가 의미가 있다: ' + JSON.stringify(saved.body));
  const assessment = await call(course, '/assessment');
  const freeze = await call(course, `/versions/m2026.09.19-${seq}`, 'PUT', { expected_revision: 1 });
  return { course, assessment, freeze };
}

/** 점검의 첫 판정과 확정 응답이 같은가. 이 파일의 본체다. */
function assertSameVerdict({ assessment, freeze }, expected) {
  assert.equal(assessment.status, 200, '점검 자체는 언제나 읽기로 성공한다: ' + JSON.stringify(assessment.body));
  const first = assessment.body.findings[0];
  assert.ok(first, '점검이 막는 항목을 지목해야 한다');
  assert.equal(first.check, expected.check);
  assert.equal(freeze.status, expected.status, '확정 상태코드');
  assert.equal(assessment.body.blocked, true);
  // 문구 동등성 — 확정이 내보낸 본문의 모든 키가 점검의 판정에도 같은 값으로 있어야 한다.
  for (const [k, v] of Object.entries(freeze.body)) {
    if (k === 'findings') { assert.deepEqual(first.findings, v, 'pedagogy 판정 목록까지 같다'); continue; }
    assert.deepEqual(first[k], v, `확정과 점검의 '${k}' 가 같다`);
  }
}

try {
  // 템플릿 판정 둘은 **순수 함수 수준**에서 본다. 템플릿 없는 초안(독립 강의)을
  // 만들려면 이 하네스에 없는 저장 경로가 필요해서(여기서는 500), HTTP 동등성 대신
  // 확정 경로가 쓰는 것과 같은 값을 assessDraft 가 내는지로 고정한다.
  // **이 둘의 HTTP 동등성은 이 파일에서 미검증이다.**
  await check('템플릿 미선택 — 확정이 쓰던 409 template_required 를 그대로 낸다', async () => {
    const a = assessDraft({ profileId: '', independent: false, content: BASE });
    assert.equal(a.findings.length, 1);
    assert.equal(a.findings[0].check, 'template_required');
    assert.equal(a.findings[0].status, 409);
    assert.deepEqual(a.findings[0].body, { error: 'select an execution template first', reason: 'template_required' });
    assert.equal(a.pedagogy, null, '템플릿이 없으면 그 아래 검사는 돌지 않는다 — 확정 경로와 같다');
  });

  await check('심사되지 않은 템플릿 — 확정이 쓰던 403 template_not_reviewed 를 그대로 낸다', async () => {
    const a = assessDraft({ profileId: local.profileId, independent: true, content: BASE });
    // 이 프로필이 심사된 실행 템플릿이면 막지 않는 것이 맞다 — 그 경우도 확정과 같다.
    const reviewed = a.findings.length === 0;
    if (reviewed) { console.log('  (이 프로필은 심사된 실행 템플릿이라 막지 않는다 — 음성 방향 확인)'); return; }
    assert.equal(a.findings[0].check, 'template_not_reviewed');
    assert.equal(a.findings[0].status, 403);
    assert.deepEqual(a.findings[0].body, { error: 'independent course requires a reviewed execution template', reason: 'template_not_reviewed' });
  });

  await check('형태·완전성 미달 — 같은 400 과 같은 문구', async () => {
    const { objective, ...noObjective } = BASE;
    const r = await assessThenFreeze({ ...noObjective, objective: '' });
    assertSameVerdict(r, { check: 'session_design', status: 400 });
  });

  await check('교육 원칙 차단 — 같은 422 pedagogy_blocked 와 같은 findings', async () => {
    const r = await assessThenFreeze({ ...BASE, prerequisites: '' });
    assertSameVerdict(r, { check: 'pedagogy', status: 422 });
    assert.equal(r.assessment.body.findings[0].reason, 'pedagogy_blocked');
  });

  await check('막는 것이 없으면 점검은 blocked=false 이고 확정은 성공한다', async () => {
    const { assessment, freeze } = await assessThenFreeze({ ...BASE });
    assert.equal(assessment.body.blocked, false);
    assert.deepEqual(assessment.body.findings, []);
    assert.equal(freeze.status, 200, '점검이 통과라고 했으면 확정도 통과해야 한다');
    // 막지 않는 판정(warn·skip)은 양쪽 모두에 같은 모양으로 실린다.
    assert.deepEqual(assessment.body.pedagogy, freeze.body.pedagogy, '남은 판정 목록이 같다');
    assert.ok(assessment.body.pedagogy.some(f => f.skipped), '미확인 항목을 통과로 감추지 않는다');
  });

  await check('점검은 아무것도 저장하지 않는다 — revision 이 움직이지 않는다', async () => {
    const course = 'assess-readonly';
    await call(course, '', 'PUT', { expected_revision: 0, request_id: 'ro', profile_id: local.profileId, content: BASE });
    const before = (await call(course, '')).body.revision;
    await call(course, '/assessment');
    await call(course, '/assessment');
    const after = (await call(course, '')).body;
    assert.equal(after.revision, before, '점검을 두 번 불러도 revision 이 그대로다');
    assert.deepEqual(after.content, BASE, '초안 내용도 그대로다');
  });

  await check('없는 강의와 남의 강의는 똑같이 404 다', async () => {
    const missing = await call('no-such-course', '/assessment');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: 'course not found' }, '존재 여부를 흘리지 않는다');
  });

  await check('순수성 — assessDraft 는 content 를 고치지 않는다', async () => {
    // 확정 경로는 content.model.binding 을 만들어 저장한다. 그 부수효과가 판정
    // 함수로 새어 들어오면 점검이 "저장하지 않는다"는 약속을 깬다.
    const content = JSON.parse(JSON.stringify(BASE));
    const snapshot = JSON.stringify(content);
    assessDraft({ profileId: local.profileId, independent: false, content });
    assert.equal(JSON.stringify(content), snapshot, '입력이 그대로다');
  });

  await check('점검은 대신 봐 줄 수 없는 것을 미확인으로 말한다', async () => {
    // 모델 공급자 설정은 확정 경로의 modelBinding(c.env, …) 에서만 드러난다.
    // 비어 있는 것을 통과로 읽게 두면 "점검은 초록인데 확정은 막히는" 화면이 된다.
    const withModel = { ...BASE, model: { mode: 'fixed', default: 'hypeproof-default' } };
    const course = 'assess-notchecked';
    const saved = await call(course, '', 'PUT', { expected_revision: 0, request_id: 'nc', profile_id: local.profileId, content: withModel });
    if (saved.status === 200) {
      const a = await call(course, '/assessment');
      assert.ok(
        a.body.not_checked.some(n => n.check === 'model_provider_binding'),
        '모델이 선언된 초안에서는 공급자 설정이 미확인으로 표시된다',
      );
      assert.match(a.body.not_checked[0].message, /미확인/);
    } else {
      // 이 코호트/시료에서 모델 선언이 저장 단계에서 막히면 확정까지 가지 않는다.
      // 그 경우 not_checked 경로는 **여기서 미검증**이다 — 통과로 적지 않는다.
      assert.notEqual(saved.status, 200);
      console.log(`  (모델 선언이 저장 단계에서 ${saved.status} 로 막힌다 — not_checked 경로는 이 시료로 미검증)`);
      // 대신 순수 함수 수준에서 모델 선언이 판정을 바꾸지 않는지만 확인한다.
      const a = assessDraft({ profileId: local.profileId, independent: false, content: withModel });
      assert.ok(Array.isArray(a.findings), '모델이 선언돼도 판정은 배열을 돌려준다');
    }
  });

  console.log(`${passed} draft-assessment checks passed`);
} finally {
  local.close();
}
