// 리허설을 돌리면 **증거가 생긴다** — 쓰는 경로 (#1186, RUN-01·VER-02).
//
// 고치기 전 상태: 읽는 쪽(#1152)은 있는데 `authoring_version_rehearsals` 에 행을 쓰는
// 경로가 없었다. 그래서 응답은 **항상 `not_run`** 이었다. 2026-09-20 에 이 사슬이 도는
// 것을 증명할 때 증거를 D1 에 **직접 넣어서** 확인했다 — 제품 경로가 아니었다.
//
// 이 파일이 잠그는 것:
//   1. 대조군 — 순수 판정 함수. 양성·음성 둘 다 (앱도 D1 도 없이, 밀리초)
//   2. 쓰는 경로가 실제로 행을 만들고 `readRehearsal()` 이 그것을 읽는다
//   3. 증거는 **검사한 버전에만** 붙는다 — 새 버전은 자동 `not_run` (VER-02, 무효화 코드 없이)
//   4. **자칭 불가** — 리허설 클레임 없는 좌석은 증거를 만들지 않는다
//   5. 같은 판의 `failed` 를 나중 `passed` 가 못 덮는다 / 새 판은 덮는다 (last-write-wins)
//   6. **배선** — 라우트가 정말 부른다 (「설정은 맞는데 동작이 없는」 유형 차단)
//
// Run: node --experimental-strip-types --experimental-sqlite test/rehearsal-evidence.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localAuthoring } from './harness/dental-authoring.mjs';
import { bootApp, makeCtx, withMockUpstream } from './harness/index.mjs';

const { ticketKey } = await import('../src/lib/rehearsal-ticket.ts');

const {
  deriveRehearsalStatus, recordRehearsalTurn, observeRehearsal, MIN_PASSING_TURNS,
} = await import('../src/lib/rehearsal-evidence.ts');

// ───────────────────────────────────────────────────────────────────────────
// 1. 대조군 — 계측기 자체를 먼저 검증한다 (.claude/rules/verification.md 규칙 2)
//
// 오늘까지 이 저장소의 오판은 **대부분 "너무 엄격" 쪽**이었으므로 양성 대조군이 핵심이다.
// 순수 함수라 앱 없이 돈다 — 실기기 런 전에 여기가 먼저 깨져야 한다.
// ───────────────────────────────────────────────────────────────────────────
{
  const o = (turns, error_turns) => ({ turns, error_turns, first_at: 'a', last_at: 'b' });

  // 양성 대조군 — 확실히 좋은 시료가 통과해야 한다
  assert.equal(deriveRehearsalStatus(o(3, 0)), 'passed', '오류 없이 돈 리허설은 통과다');
  assert.equal(deriveRehearsalStatus(o(MIN_PASSING_TURNS, 0)), 'passed', '임계값 경계는 통과 쪽이다');

  // 음성 대조군 — 확실히 나쁜 시료가 실패해야 한다
  assert.equal(deriveRehearsalStatus(o(3, 1)), 'failed', '오류 턴이 하나라도 있으면 실패다');
  assert.equal(deriveRehearsalStatus(o(2, 2)), 'failed', '전부 오류면 당연히 실패다');

  // 중간에 그만둔 것 = 행 없음 = not_run (Router 결정 2, 2026-09-21).
  // `'not_run'` 을 **반환하지 않는 것**이 요점이다 — 상태의 표현은 행의 부재 하나뿐이고,
  // 스키마의 CHECK 가 그것을 강제한다. 여기서 문자열이 나오기 시작하면 표현이 둘이 된다.
  assert.equal(deriveRehearsalStatus(o(0, 0)), null, '한 턴도 안 돌았으면 판정이 서지 않는다');
  assert.notEqual(deriveRehearsalStatus(o(0, 0)), 'not_run', "'not_run' 을 값으로 돌려주면 안 된다");
  assert.notEqual(deriveRehearsalStatus(o(0, 0)), 'failed', '중단은 실패가 아니다 — 안 본 것이다');
}

// ───────────────────────────────────────────────────────────────────────────
// 준비 — 저작 하네스에 초안 하나 + 확정 버전 둘
// ───────────────────────────────────────────────────────────────────────────
const local = await localAuthoring({});
const COURSE = 'rehearsal-write';
const path = `/admin/cohorts/${local.cohort}/authoring/${COURSE}`;
const content = {
  schema: 'hps-session-design/1', title: '리허설 증거 쓰기', audience: '성인',
  duration_minutes: 120, objective: '돌리면 증거가 남는다',
  prerequisites: '없음', starter: '정적 사이트',
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

// `usage_log` 는 마이그레이션이 아니라 `schema.sql` 이 만든다(마이그레이션에는 ALTER 만 있다).
// 그래서 **schema.sql 에서 그대로 떼어 쓴다** — 여기 DDL 을 손으로 베껴 두면 본문이 바뀌어도
// 시험은 옛 모양으로 돌면서 통과한다. 초록인데 아무것도 안 본 상태가 그렇게 생긴다.
// `usage_log.session_id` 가 `sessions` 를, `sessions` 가 `cohorts` 를 참조하고 D1 은 FK 를
// 항상 켜 두므로 그 둘도 같이 떼어 온다.
const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
function createTables(db, names) {
  for (const name of names) {
    const start = SCHEMA.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
    if (start < 0) throw new Error(`schema.sql 에 ${name} 이 없다 — 시험이 옛 가정을 들고 있다`);
    db.exec(SCHEMA.slice(start, SCHEMA.indexOf(');', start) + 2));
  }
}
const USAGE_TABLES = ['cohorts', 'sessions', 'usage_log'];
createTables(local.db, USAGE_TABLES);

/** Service 가 한 턴을 기록한 것과 같은 모양. 판정의 입력은 **이것뿐**이다. */
let clock = 0;
const seatTurn = (seat, status) =>
  local.db.prepare('INSERT INTO usage_log (cohort_id,user_id,profile_id,model,status,created_at) VALUES (?,?,?,?,?,?)')
    .run(local.cohort, seat, local.profileId, 'test-model', status, `2026-09-21T00:00:${String(++clock).padStart(2, '0')}Z`);

const rehearsalPayload = seat => ({ rehearsal: true, u: seat, c: local.cohort });
const coords = version => ({ cohort: local.cohort, course_id: COURSE, version });
const storedStatus = version => local.db
  .prepare('SELECT status, evidence_json FROM authoring_version_rehearsals WHERE cohort_id=? AND course_id=? AND version=?')
  .get(local.cohort, COURSE, version);

try {
  assert.equal((await call('', 'PUT', { expected_revision: 0, request_id: 'create', profile_id: local.profileId, content })).status, 200);
  const V1 = 'm2026.09.21-1';
  const frozen = await call('/versions/' + V1, 'PUT', { expected_revision: 1 });
  assert.equal(frozen.status, 200, '확정이 성공해야 이 시험이 의미가 있다');
  assert.equal(frozen.body.rehearsal, 'not_run', '확정 직후에는 증거가 있을 수 없다');

  // ── 2. 쓰는 경로가 행을 만들고, 읽는 쪽이 그것을 읽는다
  // 이 시험의 심장이다. 고치기 전에는 여기가 영원히 not_run 이었다.
  const SEAT1 = 'rehearsal-seoyeon-aaa111';
  seatTurn(SEAT1, 200);
  assert.equal(await recordRehearsalTurn(local.env, rehearsalPayload(SEAT1), coords(V1)), 'passed');
  assert.equal((await call('/versions/' + V1)).body.rehearsal, 'passed',
    '리허설을 돌렸으면 읽는 쪽이 passed 를 본다 — 상수였다면 여기서 깨진다');

  // 관측 사실이 전부 남아야 한다. 나중에 **스키마를 안 고치고** 기준을 올릴 수 있어야 하므로,
  // 임계값 하나가 아니라 센 것 전부를 담는다(Router 결정 4).
  const ev = JSON.parse(storedStatus(V1).evidence_json);
  assert.equal(ev.run, SEAT1, '한 판의 식별자는 좌석이다');
  assert.equal(ev.turns, 1);
  assert.equal(ev.error_turns, 0);
  assert.equal(ev.source, 'usage_log', '무엇을 보고 판정했는지 행 자체가 말한다');
  assert.equal(ev.min_passing_turns, MIN_PASSING_TURNS, '판정 당시의 임계값이 남는다');
  assert.ok(ev.first_at && ev.last_at, '처음·마지막 시각이 남는다');

  // 오류 턴이 하나 끼면 같은 판이 failed 로 내려간다 — 초록이 박제되지 않는다.
  seatTurn(SEAT1, 500);
  assert.equal(await recordRehearsalTurn(local.env, rehearsalPayload(SEAT1), coords(V1)), 'failed');
  assert.equal((await call('/versions/' + V1)).body.rehearsal, 'failed', '오류 턴을 본 리허설은 실패다');

  // ── 5. 같은 판의 failed 를 나중 성공이 덮지 못한다
  // 집계는 좌석 전체를 다시 세므로 오류가 사라질 수는 없지만, **동시 턴이면 옛 집계가
  // 나중에 착지**할 수 있다. 그러면 실패한 리허설에 초록이 뜬다 — verification.md 규칙 6 이
  // 말하는 **못 잡는 방향**이다. 순서와 무관하게 닫히는지 본다.
  //
  // 그 순서 뒤집힘을 **제품 경로로** 재현한다: 오류 행을 잠시 치우면 집계가 「오류 없음」을
  // 보고 passed 를 도출한다 — 늦게 착지한 옛 집계와 같은 상태다. 시험이 SQL 을 베껴 쓰면
  // 제품의 SQL 이 망가져도 안 걸린다(실제로 한 번 그렇게 썼고 결함을 못 잡았다).
  const errorRow = local.db.prepare('SELECT id FROM usage_log WHERE user_id=? AND status>=400').get(SEAT1);
  local.db.prepare('DELETE FROM usage_log WHERE id=?').run(errorRow.id);
  assert.equal(await recordRehearsalTurn(local.env, rehearsalPayload(SEAT1), coords(V1)), 'passed',
    '대조군: 오류가 안 보이면 판정 자체는 passed 로 선다 — 아래가 막히는 게 쓰기 쪽 때문임을 고정한다');
  assert.equal(storedStatus(V1).status, 'failed', '같은 판의 실패를 나중 성공이 덮으면 안 된다');
  local.db.prepare('INSERT INTO usage_log (id,cohort_id,user_id,profile_id,model,status,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(errorRow.id, local.cohort, SEAT1, local.profileId, 'test-model', 500, '2026-09-21T00:00:02Z');

  // 새 판(새 좌석)은 덮는다 — 마지막 판이 진실이다(Router 결정 5).
  // 「하나라도 통과면 통과」였다면 강사가 통과할 때까지 돌린 초록이 박제된다.
  const SEAT2 = 'rehearsal-seoyeon-bbb222';
  seatTurn(SEAT2, 200);
  assert.equal(await recordRehearsalTurn(local.env, rehearsalPayload(SEAT2), coords(V1)), 'passed');
  assert.equal((await call('/versions/' + V1)).body.rehearsal, 'passed', '새 판의 결과가 옛 판을 덮는다');
  assert.equal(JSON.parse(storedStatus(V1).evidence_json).run, SEAT2, '증거도 새 판의 것이다');

  // ── 3. VER-02 — 증거는 검사한 버전에만 붙는다. 무효화하는 코드는 없다
  // 내용을 고치면 그것은 새 버전이고, 새 버전에는 증거 행이 없다 → 자동 not_run.
  assert.equal((await call('', 'PUT', {
    expected_revision: 1, request_id: 'edit', profile_id: local.profileId,
    content: { ...content, objective: '내용이 바뀌었다' },
  })).status, 200);
  const V2 = 'm2026.09.21-2';
  const frozen2 = await call('/versions/' + V2, 'PUT', { expected_revision: 2 });
  assert.equal(frozen2.status, 200);
  assert.equal(frozen2.body.rehearsal, 'not_run',
    '내용이 바뀌면 새 버전이고, 새 버전에는 증거가 없다 — 무효화 코드 없이');
  assert.equal((await call('/versions/' + V1)).body.rehearsal, 'passed', '옛 버전의 증거는 그대로 남는다 (T-07)');
  assert.equal(storedStatus(V2), undefined, '새 버전에는 행 자체가 없다');

  // ── 4. 자칭 불가 — 리허설 좌석이 아니면 증거를 만들지 않는다
  // 실제 학생 트래픽이 증거가 되면 관문이 스스로 열린다. 판정은 문자열 접두사가 아니라
  // **토큰 클레임**으로 한다: 접두사만 흉내 낸 좌석도 통과하면 안 된다.
  const STUDENT = 'student-minji';
  seatTurn(STUDENT, 200);
  assert.equal(await recordRehearsalTurn(local.env, { u: STUDENT, c: local.cohort }, coords(V2)), null);
  assert.equal(storedStatus(V2), undefined, '학생 트래픽은 증거를 만들지 않는다');
  const IMPOSTOR = 'rehearsal-looks-like-one';
  seatTurn(IMPOSTOR, 200);
  assert.equal(await recordRehearsalTurn(local.env, { u: IMPOSTOR, c: local.cohort }, coords(V2)), null,
    '접두사만 리허설인 좌석은 증거를 만들지 못한다 — 권한은 클레임이 답한다');
  assert.equal(storedStatus(V2), undefined);
  // 수업에 연결되지 않은 좌석(lesson 없음)도 마찬가지로 아무것도 안 쓴다.
  assert.equal(await recordRehearsalTurn(local.env, rehearsalPayload(SEAT2), null), null);

  // 관측 자체는 좌석별로 갈려 있어야 한다 — 남의 턴을 내 판으로 세면 판정이 새어 나간다.
  const isolated = await observeRehearsal(local.env, { ...coords(V1), seat: STUDENT, seatCohort: local.cohort });
  assert.equal(isolated.turns, 1, '집계는 그 좌석의 턴만 센다');

  console.log('rehearsal-evidence: OK (대조군 · 쓰는 경로 · 버전 귀속 · 자칭 불가 · 판 경계)');
} finally {
  local.close();
}

// ───────────────────────────────────────────────────────────────────────────
// 6. 배선 — 라우트가 **정말** 부르는가
//
// 위까지는 전부 함수를 직접 불렀다. 그것만으로는 「설정은 맞는데 동작이 없는」 유형을
// 못 잡는다 — 이 저장소가 첫 완주에서 실기기로만 잡은 결함 7건 중 둘이 그 형태였다.
// 그래서 **전체 앱으로 턴 하나를 돌려** 증거가 생기는지 본다.
//
// 업스트림을 **실패**시킨다. 성공 본문 모양은 provider 마다 다르고, 여기서 재려는 것은
// 응답 모양이 아니라 **증거가 도는가** 이기 때문이다. 실패 턴도 usage_log 에 앉는다(#684) —
// 그리고 실패 턴이 `failed` 로 남는 것 자체가 배선의 증거다.
// ───────────────────────────────────────────────────────────────────────────
{
  const wired = await localAuthoring({});
  try {
    createTables(wired.db, USAGE_TABLES);

    const wPath = `/admin/cohorts/${wired.cohort}/authoring/wired-course`;
    const wCall = async (suffix, method, body) => {
      const r = await wired.fetcher(wired.origin + wPath + suffix, {
        method, headers: { authorization: `Bearer ${wired.token}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: await r.json() };
    };
    assert.equal((await wCall('', 'PUT', { expected_revision: 0, request_id: 'create', profile_id: wired.profileId, content })).status, 200);
    const V = 'm2026.09.21-9';
    assert.equal((await wCall('/versions/' + V, 'PUT', { expected_revision: 1 })).status, 200);

    // 리허설 좌석을 **제품 경로로** 받는다 — 손으로 토큰을 조립하면 좌석 표시 두 겹
    // (접두사 + 클레임)이 갈릴 수 있고, 갈린 것을 시험이 못 본다.
    const ticket = await wCall('/versions/' + V + '/rehearsal-tickets', 'POST', { hours: 2 });
    assert.equal(ticket.status, 200, '리허설 교환권이 나와야 한다: ' + JSON.stringify(ticket.body));
    const seat = ticket.body.seat;
    // 교환권에 붙어 있는 것은 토큰 하나뿐이고, KV 키는 교환권의 sha256 이다.
    const seatToken = JSON.parse(await wired.env.HPS_KV.get(await ticketKey(ticket.body.ticket))).token;

    // ⚠️ 오늘 리허설 좌석은 **로스터 없이는 채팅을 못 한다.** chat-gate 의 로스터 검사에
    // 리허설 예외가 없기 때문이다(`payload.rehearsal` 을 읽는 곳을 세어 봤다: 발급과
    // 직렬화 두 곳뿐, 게이트에는 없다). 그 예외는 **교환(C-2)** 의 몫이고 이 이슈가 아니다.
    // 그래서 아래의 세션·로스터 심기는 **시험용 고정**이다 — 제품이 이미 그렇다는 뜻이
    // **아니다.** 그 사실 자체를 아래에서 시험으로 박아 둔다(로스터 없는 턴은 안 돈다).
    const now = Date.now();
    await wired.env.HPS_KV.put(`cohort:${wired.cohort}:active_session`, JSON.stringify({
      session_id: 'sess-rehearsal', profile_id: wired.profileId,
      starts_at: new Date(now - 60_000).toISOString(), ends_at: new Date(now + 3_600_000).toISOString(),
    }));
    // `usage_log.session_id` 가 `sessions` 를 참조하고 D1 은 FK 를 항상 켜 둔다. 행이 없어도
    // persistUsage 가 session_id=NULL 로 되살리지만(운영 장애 후 넣은 경로), 여기서는 그
    // 되살림이 아니라 **정상 경로**를 재려는 것이므로 부모 행을 만들어 둔다.
    wired.db.prepare('INSERT INTO cohorts (id,display_name) VALUES (?,?)').run(wired.cohort, 'fixture');
    wired.db.prepare('INSERT INTO sessions (id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)')
      .run('sess-rehearsal', wired.cohort, wired.profileId, new Date(now - 60_000).toISOString(), new Date(now + 3_600_000).toISOString());

    const app = await bootApp();
    // 두 라우트가 **각자** 증거를 써야 한다. 한쪽만 배선해도 나머지 한쪽은 조용히 죽는다 —
    // proxy 좌석은 증거를 남기고 SDK 좌석은 안 남기면, 같은 리허설이 경로에 따라 다른 답을 낸다.
    const turn = async (path = '/v1/chat/completions') => {
      const ctx = makeCtx();
      await withMockUpstream(
        async () => new Response(JSON.stringify({ error: { message: 'upstream down' } }), { status: 500, headers: { 'content-type': 'application/json' } }),
        async () => {
          await app.fetch(new Request('https://api.test' + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${seatToken}` },
            body: JSON.stringify({ model: 'hypeproof-default', max_tokens: 64, messages: [{ role: 'user', content: '리허설' }] }),
          }), wired.env, ctx);
        },
      );
      await ctx.settle();
    };

    // 로스터에 없으면 막힌다 — 이 사실을 고정해 둔다. C-2 가 붙으면 여기가 깨지고,
    // 깨지는 것이 맞다(그때 이 주석과 함께 고쳐야 한다).
    await turn();
    assert.equal(
      wired.db.prepare('SELECT COUNT(*) AS n FROM usage_log').get().n, 0,
      '로스터에 없는 리허설 좌석은 턴 자체가 안 돈다 — C-2(교환) 가 아직 없다',
    );

    // 이제 좌석을 로스터에 넣고 같은 턴을 돌린다. 여기서부터가 배선 검사다.
    await wired.env.HPS_KV.put(`cohort:${wired.cohort}:roster`, JSON.stringify({ users: [seat], updated_at: new Date().toISOString() }));
    await turn();

    assert.ok(wired.db.prepare('SELECT COUNT(*) AS n FROM usage_log').get().n > 0, '턴이 usage_log 에 앉아야 한다');
    const row = wired.db.prepare('SELECT status FROM authoring_version_rehearsals WHERE version=?').get(V);
    assert.ok(row, '라우트가 증거 쓰기를 부르지 않으면 여기서 깨진다 — 배선이 이 시험의 전부다');
    assert.equal(row.status, 'failed', '업스트림이 죽은 턴은 실패로 남는다');
    assert.equal((await wCall('/versions/' + V)).body.rehearsal, 'failed', '읽는 쪽도 같은 것을 본다');

    // SDK 경로(`/v1/messages`)도 같은 한 줄로 배선돼 있다. **행을 지우고 다시 돌려서**
    // 그 경로 혼자 증거를 만드는지 본다 — 안 지우면 위 턴이 남긴 행을 보고 통과한다.
    wired.db.prepare('DELETE FROM authoring_version_rehearsals').run();
    await turn('/v1/messages');
    const sdkRow = wired.db.prepare('SELECT status FROM authoring_version_rehearsals WHERE version=?').get(V);
    assert.ok(sdkRow, 'SDK 경로(/v1/messages)도 증거를 써야 한다 — 한쪽만 배선하면 여기서 깨진다');
    assert.equal(sdkRow.status, 'failed');

    console.log('rehearsal-evidence(wiring): OK (proxy·SDK 두 라우트가 실제로 증거를 쓴다)');
  } finally {
    wired.close();
  }
}
