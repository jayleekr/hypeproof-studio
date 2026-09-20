// 리허설을 통과하지 않은 버전은 참여 코드를 받지 못한다 (#1187, RUN-01·VER-02).
//
// 고치기 전 상태: `readRehearsal()` 이 돌려준 값은 응답에 **실리기만** 했다.
// 발급을 막는 조건은 넷이었고(강사 스코프 · 확정된 버전 · 열린 세션 · 로스터
// 멤버십) 리허설은 그 넷에 없었다. 그래서 제품이 하던 말이 "이 강의는 리허설을
// 안 했습니다. 그런데 학생을 들여보내세요" 였다. 경고를 띄우고 통과시키는 것은
// 점검표이고, 관문은 막는 것이다.
//
// 이 파일이 잠그는 것:
//   1. `not_run` → 거부. **무엇을 하면 풀리는지**가 응답 안에 있다
//   2. `failed`  → 거부. `not_run` 과 **구분되는 말**을 한다 (다음 행동이 다르다)
//   3. `passed`  → 발급된다                                    (양성 대조군)
//   4. 내용을 한 글자 고치면 새 버전이고 → **다시 거부** (VER-02, 무효화 코드 없이)
//   5. 모르는 상태 → 거부. 새 상태가 조용히 통과하지 않는다     (실패 방향)
//   6. 증거 테이블이 없으면 → 거부. 관문은 닫히는 쪽으로 진다   (실패 방향)
//   7. **리허설 교환권 경로(#1164)는 이 차단에 걸리지 않는다.** 강사가 리허설을
//      하러 가는 길까지 막으면 아무도 영원히 풀 수 없다 — 관문이 자기 입구를
//      잠그는 셈이다. 이 시험이 그 자물쇠를 막는다
//   8. 앞선 거부 넷은 그대로다 — 리허설을 통과해도 로스터 밖 학생은 여전히 막힌다
//
// 증거를 **쓰는** 경로(#1186)는 이 변경의 범위가 아니다. 여기서는 증거를 직접
// 심어 **막는 쪽**만 판정한다. 쓰는 경로가 붙어도 이 시험은 그대로 성립한다.
//
// Run: node --experimental-strip-types --experimental-sqlite test/authoring-rehearsal-gate.test.mjs

import assert from 'node:assert/strict';
import { localAuthoring } from './harness/dental-authoring.mjs';
const { setRoster, startSession } = await import('../src/lib/kv.ts');

const local = await localAuthoring({});
const COURSE = 'gate-course';
const STUDENT = 'synthetic-student';
const path = `/admin/cohorts/${local.cohort}/authoring/${COURSE}`;
const content = {
  schema: 'hps-session-design/1', title: '리허설 관문', audience: '성인',
  duration_minutes: 120, objective: '리허설을 안 한 수업에 학생이 들어가지 않는다',
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
const deliver = (version, user = STUDENT) => call(`/versions/${version}/participants`, 'POST', { user, hours: 1 });

// 교환권 경로는 **강사 issuer Bearer 하나로** 부른다 — 실제 강사가 가진 것이 그것뿐이다.
// (처음 썼을 때 이 호출이 503 `admin not configured` 를 냈다: `isIssuerAllowedEndpoint`
// 허용 목록에 이 경로가 빠져 있었다. 그건 같은 스택의 앞선 커밋에서 고쳤고,
// rehearsal-ticket.test.mjs 6번 절이 HTTP 로 직접 잠근다.)
const ticket = version => call(`/versions/${version}/rehearsal-tickets`, 'POST', { hours: 1 });

// 증거는 직접 심는다 — 쓰는 경로(#1186)는 아직 없고, 있어도 이 시험이 재는 것은
// "저장된 증거가 발급을 막는가" 하나다.
const plant = (version, status, ranAt = '2026-09-21T00:00:00Z') =>
  local.db.prepare(
    'INSERT OR REPLACE INTO authoring_version_rehearsals (cohort_id,course_id,version,status,ran_at,evidence_json) VALUES (?,?,?,?,?,?)',
  ).run(local.cohort, COURSE, version, status, ranAt, JSON.stringify({ checks: [] }));
const unplant = version =>
  local.db.prepare('DELETE FROM authoring_version_rehearsals WHERE cohort_id=? AND course_id=? AND version=?')
    .run(local.cohort, COURSE, version);

const freeze = async (version, revision) => {
  const frozen = await call('/versions/' + version, 'PUT', { expected_revision: revision });
  assert.equal(frozen.status, 200, '확정이 성공해야 이 시험이 의미가 있다: ' + JSON.stringify(frozen.body));
  assert.equal(frozen.body.rehearsal, 'not_run', '방금 확정한 버전에 증거가 있을 수 없다');
  return frozen;
};

try {
  // ── 준비 ────────────────────────────────────────────────────────────────
  // 앞선 거부 넷 중 셋(열린 세션 · 로스터 · 확정된 버전)을 **미리 통과시킨다.**
  // 그래야 이 시험이 재는 실패가 리허설 때문이라는 것이 확실해진다 — 세션이
  // 안 열려서 막힌 것을 리허설이 막았다고 읽으면 계측기가 거짓을 말한다.
  await setRoster(local.env.HPS_KV, local.cohort, [STUDENT]);
  await startSession(local.env.HPS_KV, local.cohort, {
    session_id: 'gate', profile_id: local.profileId,
    starts_at: new Date(Date.now() - 1000).toISOString(),
    ends_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  assert.equal((await call('', 'PUT', { expected_revision: 0, request_id: 'create', profile_id: local.profileId, content })).status, 200);
  const V1 = 'm2026.09.21-1';
  await freeze(V1, 1);

  // ── 1. not_run → 거부. 무엇을 하면 풀리는지 말한다 ────────────────────────
  const notRun = await deliver(V1);
  assert.equal(notRun.status, 403, '리허설을 안 했으면 참여 코드가 나가면 안 된다');
  assert.equal(notRun.body.token, undefined, '거부 응답에 자격이 실려 나가면 막은 것이 아니다');
  assert.equal(notRun.body.reason, 'rehearsal_not_run');
  assert.equal(notRun.body.rehearsal, 'not_run');
  // 문구는 강사가 읽는다. "안 됩니다" 만 있고 "무엇을 하면 되는지" 가 없으면
  // 관문이 아니라 벽이다. 앞선 거부들과 같은 결인지 함께 본다.
  assert.match(notRun.body.error, /rehears/i, '거부 문구가 리허설을 가리켜야 한다');

  // ── 2. failed → 거부하되 not_run 과 **다른 말**을 한다 ────────────────────
  // 다음 행동이 다르다: 안 돌렸으면 돌리면 되고, 실패했으면 수업을 고쳐 **새
  // 버전**을 확정해야 한다(확정 버전은 불변이라 같은 버전을 다시 통과시킬 수 없다).
  // 둘이 같은 문구를 내면 강사는 실패한 버전을 계속 다시 돌린다.
  plant(V1, 'failed');
  const failed = await deliver(V1);
  assert.equal(failed.status, 403, '실패한 리허설도 막는다');
  assert.equal(failed.body.token, undefined);
  assert.equal(failed.body.reason, 'rehearsal_failed');
  assert.equal(failed.body.rehearsal, 'failed');
  assert.notEqual(failed.body.error, notRun.body.error, 'failed 와 not_run 이 같은 말을 하면 안 된다');
  assert.notEqual(failed.body.reason, notRun.body.reason, '기계가 읽는 구분도 달라야 한다');
  // 실패했을 때의 다음 행동은 "다시 돌려라" 가 아니라 "고쳐서 새 버전" 이다.
  assert.match(failed.body.error, /new version/i, '실패 문구는 새 버전을 가리켜야 한다');

  // ── 5. 모르는 상태 → 거부 (실패 방향) ────────────────────────────────────
  // 쓰는 경로(#1186)가 나중에 상태를 늘려도 새 값이 **조용히 통과하지 않는다.**
  // 막히고 문구에 그 값이 그대로 보이는 쪽이 고치기 쉽다.
  plant(V1, 'inconclusive');
  const unknown = await deliver(V1);
  assert.equal(unknown.status, 403, 'passed 가 아닌 값은 전부 막는다');
  assert.equal(unknown.body.reason, 'rehearsal_not_passed');
  assert.equal(unknown.body.rehearsal, 'inconclusive');
  assert.match(unknown.body.error, /inconclusive/, '모르는 상태는 문구에 그대로 보여야 고칠 수 있다');

  // ── 3. passed → 발급된다 (양성 대조군) ───────────────────────────────────
  // 이게 없으면 "전부 막는 관문" 도 위의 시험을 전부 통과한다.
  plant(V1, 'passed');
  const passed = await deliver(V1);
  assert.equal(passed.status, 200, '리허설을 통과한 버전은 참여 코드가 나가야 한다: ' + JSON.stringify(passed.body));
  assert.equal(typeof passed.body.token, 'string');
  assert.ok(passed.body.token.length > 0, '통과했는데 빈 코드가 나오면 통과가 아니다');
  assert.equal(passed.body.rehearsal, 'passed', '발급 응답은 읽은 상태를 그대로 실어야 한다');
  assert.equal(passed.body.lesson.version, V1);

  // ── 8. 앞선 거부 넷은 그대로다 ───────────────────────────────────────────
  // 다섯 번째를 **더한** 것이지 앞의 넷을 느슨하게 만든 것이 아니다.
  const outsider = await deliver(V1, 'not-on-the-roster');
  assert.equal(outsider.status, 403, '리허설을 통과해도 로스터 밖 학생은 여전히 막힌다');
  assert.match(outsider.body.error, /roster|session console/i);
  assert.equal(outsider.body.reason, undefined, '로스터 거부가 리허설 거부로 바뀌면 안 된다');

  // ── 4. 내용을 한 글자 고치면 새 버전이고, 다시 거부된다 (VER-02) ─────────
  // 무효화하는 코드는 없다. 증거가 (cohort, course, version) 에 매달리고 확정
  // 버전은 불변이므로, 고친 내용은 **새 버전**이고 새 버전에는 증거 행이 없다.
  assert.equal((await call('', 'PUT', {
    expected_revision: 1, request_id: 'edit', profile_id: local.profileId,
    content: { ...content, objective: '한 글자 고쳤다' },
  })).status, 200);
  const V2 = 'm2026.09.21-2';
  await freeze(V2, 2);
  const changed = await deliver(V2);
  assert.equal(changed.status, 403, '내용이 바뀐 새 버전은 옛 증거로 통과할 수 없다');
  assert.equal(changed.body.reason, 'rehearsal_not_run');
  // 옛 버전의 합격은 그대로 살아 있다 — 새 버전이 막히는 것은 증거가 **없어서**이지
  // 누가 지워서가 아니다.
  assert.equal((await deliver(V1)).status, 200, '옛 버전의 증거는 그대로 유효하다');

  // ── 7. 리허설 교환권 경로는 이 차단에 걸리지 않는다 (#1164) ──────────────
  // 🔴 이 시험이 없으면 관문이 자기 입구를 잠근다. 강사가 리허설을 하려면 학생
  // 조건 자격이 필요한데, 그 자격을 받는 길이 "리허설을 통과했을 것" 을 요구하면
  // 아무도 첫 리허설을 돌릴 수 없다 — 영원히 못 푸는 매듭이다.
  //
  // 구조상 다른 라우트라서 안 걸린다고 **짐작하지 않는다.** 실제로 막혀 있는
  // 버전(V2, not_run)에 대고 교환권을 요청해서 응답으로 확인한다.
  assert.equal((await deliver(V2)).status, 403, '대조: 같은 버전의 참여 코드는 막혀 있다');
  const rehearsalTicket = await ticket(V2);
  assert.equal(rehearsalTicket.status, 200, '리허설을 하러 가는 길까지 막으면 아무도 풀 수 없다: ' + JSON.stringify(rehearsalTicket.body));
  assert.equal(typeof rehearsalTicket.body.ticket, 'string');
  assert.ok(rehearsalTicket.body.ticket.length > 0);
  assert.equal(rehearsalTicket.body.lesson.version, V2);
  assert.equal(rehearsalTicket.body.reason, undefined, '교환권 경로가 리허설 관문에 걸리면 안 된다');
  // 실패한 버전에서도 같다 — "해봤는데 실패했다" 는 다시 해야 하는 상태이므로,
  // 다시 하러 가는 길이 그때 잠기면 더 나쁘다.
  plant(V1, 'failed');
  assert.equal((await deliver(V1)).status, 403, '대조: failed 버전의 참여 코드는 막혀 있다');
  assert.equal((await ticket(V1)).status, 200, 'failed 버전도 다시 리허설하러 갈 수 있어야 한다');

  // ── 6. 증거 테이블이 없으면 거부 — 관문은 닫히는 쪽으로 진다 ──────────────
  // `readRehearsal()` 은 읽지 못하면 `not_run` 으로 떨어진다(저작 API 전체가
  // 500 이 되는 것보다 낫다). 그 결정이 관문과 만나면 **발급이 멈춘다.** 이쪽이
  // 맞다: 저장소가 흔들릴 때 리허설 안 한 수업에 학생이 들어가는 것보다, 코드가
  // 안 나가고 강사가 바로 알아차리는 쪽이 싸다.
  unplant(V1);
  local.db.exec('DROP TABLE authoring_version_rehearsals');
  const degraded = await deliver(V1);
  assert.equal(degraded.status, 403, '증거를 읽을 수 없으면 통과시키지 않는다');
  assert.equal(degraded.body.reason, 'rehearsal_not_run');
  assert.equal(degraded.body.token, undefined);
  // 그래도 리허설을 하러 가는 길은 열려 있다 — 나가는 문까지 잠그지 않는다.
  assert.equal((await ticket(V1)).status, 200, '저장소가 흔들려도 리허설 경로는 열려 있다');

  console.log('authoring-rehearsal-gate: OK (not_run · failed · 모르는 상태 · passed 통과 · 앞선 거부 보존 · 새 버전 재차단 · 교환권 면제 · 테이블 부재)');
} finally {
  local.close();
}
