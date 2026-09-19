// 확정 응답의 리허설 상태는 **저장된 증거**에서 나온다 (#1012 RUN-01·VER-02).
//
// 고치기 전 상태: `authoring.ts` 네 곳이 각각 `rehearsal: "not_run"` 을 상수로
// 실어 보냈고, worker/src 어디에도 그 값을 읽어 무언가를 막는 코드가 없었다.
// 실제로 리허설을 돌려도 응답은 한 글자도 바뀌지 않았다 — 확정이 리허설을
// 기다리지 않았고, 서버가 사실이 아닌 것을 사실처럼 말하고 있었다.
//
// 이 파일이 잠그는 것:
//   1. 증거가 없으면 `not_run`                        (양성 대조군)
//   2. 증거가 있으면 **그 상태**                        (상수였다면 여기서 깨진다)
//   3. 증거는 **검사한 버전에만** 붙는다 — 새 버전에는 안 따라간다 (VER-02)
//   4. 테이블이 없으면 `not_run` 으로 떨어진다 — 500 이 아니다 (실패 방향)
//   5. `not_run` 은 저장할 수 없다 — "안 돌렸다" 의 표현은 **행이 없는 것** 하나뿐
//
// 쓰는 경로(리허설을 실제로 돌려 증거를 남기는 것)는 이 변경의 범위가 아니다.
// 여기서는 증거를 직접 심어 **읽는 쪽**만 판정한다.
//
// Run: node --experimental-strip-types --experimental-sqlite test/authoring-rehearsal.test.mjs

import assert from 'node:assert/strict';
import { localAuthoring } from './harness/dental-authoring.mjs';

const local = await localAuthoring({});
const path = `/admin/cohorts/${local.cohort}/authoring/rehearsal-course`;
const content = {
  schema: 'hps-session-design/1', title: '리허설 증거', audience: '성인',
  duration_minutes: 120, objective: '확정 응답이 사실을 말한다',
  prerequisites: '코딩 경험 불필요', starter: '정적 사이트',
  steps: [{ id: 'one', title: '한 단계', instructions: '제출 증거: index.html', hint: '', acceptance: '열리는지 확인' }],
};

const call = async (suffix = '', method = 'GET', body) => {
  const r = await local.fetcher(local.origin + path + suffix, {
    method,
    headers: { authorization: `Bearer ${local.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

const plant = (version, status, ranAt = '2026-09-19T00:00:00Z') =>
  local.db.prepare(
    'INSERT INTO authoring_version_rehearsals (cohort_id,course_id,version,status,ran_at,evidence_json) VALUES (?,?,?,?,?,?)',
  ).run(local.cohort, 'rehearsal-course', version, status, ranAt, JSON.stringify({ checks: [] }));

try {
  // ── 준비: 초안 → 버전 하나 확정
  assert.equal((await call('', 'PUT', { expected_revision: 0, request_id: 'create', profile_id: local.profileId, content })).status, 200);
  const V1 = 'm2026.09.19-1';
  const frozen = await call('/versions/' + V1, 'PUT', { expected_revision: 1 });
  assert.equal(frozen.status, 200, '확정이 성공해야 이 시험이 의미가 있다');

  // ── 1. 증거가 없으면 not_run (양성 대조군)
  // 방금 확정한 응답도, 다시 읽은 응답도 같은 말을 해야 한다.
  assert.equal(frozen.body.rehearsal, 'not_run', '확정 직후에는 증거가 있을 수 없다');
  assert.equal((await call('/versions/' + V1)).body.rehearsal, 'not_run', '다시 읽어도 not_run');

  // ── 2. 증거가 있으면 그 상태 (상수였다면 여기서 깨진다)
  plant(V1, 'passed');
  assert.equal((await call('/versions/' + V1)).body.rehearsal, 'passed', '저장된 상태를 그대로 읽는다');
  // 이미 확정된 버전에 다시 PUT 하는 멱등 경로도 같은 값을 봐야 한다.
  const again = await call('/versions/' + V1, 'PUT', { expected_revision: 1 });
  assert.equal(again.status, 200);
  assert.equal(again.body.rehearsal, 'passed', '멱등 확정 응답도 저장된 증거를 읽는다');

  // 합격만 읽는 게 아니다 — 불합격도 그대로 나와야 한다. 상태를 '통과/미실행'
  // 둘로만 읽으면 실패한 리허설이 미실행으로 둔갑한다.
  local.db.prepare('UPDATE authoring_version_rehearsals SET status=? WHERE version=?').run('failed', V1);
  assert.equal((await call('/versions/' + V1)).body.rehearsal, 'failed', '불합격도 그대로 읽는다');

  // ── 3. VER-02 — 증거는 검사한 버전에만 붙는다
  // 내용을 고치면 그것은 새 버전이고, 새 버전에는 증거 행이 없다. 무효화하는
  // 코드는 없다 — 스키마 모양으로 성립한다. 그 성립을 여기서 못 박는다.
  assert.equal((await call('', 'PUT', {
    expected_revision: 1, request_id: 'edit', profile_id: local.profileId,
    content: { ...content, objective: '내용이 바뀌었다' },
  })).status, 200);
  const V2 = 'm2026.09.19-2';
  const frozen2 = await call('/versions/' + V2, 'PUT', { expected_revision: 2 });
  assert.equal(frozen2.status, 200);
  assert.equal(frozen2.body.rehearsal, 'not_run', '새 버전에는 옛 버전의 증거가 따라가지 않는다');
  assert.equal((await call('/versions/' + V1)).body.rehearsal, 'failed', '옛 버전의 증거는 그대로 남는다');

  // ── 5. not_run 은 저장할 수 없다 (표현이 둘이면 읽는 쪽이 틀린 질문을 하게 된다)
  assert.throws(() => plant(V2, 'not_run'), /CHECK|constraint/i, "'not_run' 은 행으로 저장되지 않는다");
  assert.throws(() => plant(V2, ''), /CHECK|constraint/i, '빈 상태도 저장되지 않는다');

  // ── 4. 테이블이 없으면 not_run 으로 떨어진다 — 500 이 아니다
  // 마이그레이션이 배포보다 먼저 도는 정상 경로에서는 일어나지 않는다. 그래도
  // 실패 방향을 고정한다: 수업 중 저작 API 전체가 500 이 되는 것보다 "증거 없음"
  // 이 낫고, 그것은 오보도 아니다(증거가 실제로 없다).
  local.db.exec('DROP TABLE authoring_version_rehearsals');
  const degraded = await call('/versions/' + V1);
  assert.equal(degraded.status, 200, '테이블이 없다고 응답이 깨지면 안 된다');
  assert.equal(degraded.body.rehearsal, 'not_run', '읽을 수 없으면 증거 없음으로 답한다');

  console.log('authoring-rehearsal: OK (증거 없음 · 있음 · 버전 귀속 · 저장 금지값 · 테이블 부재)');
} finally {
  local.close();
}
