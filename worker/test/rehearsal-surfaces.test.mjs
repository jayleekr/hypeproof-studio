// 리허설 좌석이 **학생이 쓰는 표면**에서 학생과 같은 조건인가 (#1210).
//
// `#1209`(C-2)가 연 것은 채팅과 진입 둘뿐이었다. 참가자 자격이 지나가는 로스터 검사는
// **일곱 군데**이고, 나머지에서 좌석이 막히면 그 리허설은 `RUN-01` 이 말하는 "학생 조건"이
// 아니다 — 강사가 "돌아간다" 고 보고 들어갔는데 당일 학생만 막히는 모양이 된다.
//
// ── 이 파일이 잠그는 것은 **여는 것과 안 여는 것 둘 다**다 ───────────────────────
// 열지 않기로 한 표면(`classroom`)도 단언으로 고정한다. 안 여는 결정이 근거 없이 남으면
// 다음 사람이 "빠뜨렸나" 하고 연다. 여기서 실패하면 **먼저 왜 안 열었는지 읽게** 된다.
//
// ── 표면마다 따로 잰다 ────────────────────────────────────────────────────────
// `#1209` 에서 채팅 한 표면만 재고 `/v1/profile` 도 될 것이라 **짐작해서** 403 을 놓쳤다.
// 표면은 각자 자기 게이트를 갖고 있다. 하나를 고쳤다고 옆이 열리지 않는다.
//
// Run: node --experimental-strip-types --experimental-sqlite test/rehearsal-surfaces.test.mjs

import assert from 'node:assert/strict';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET } from './harness/index.mjs';

const { issue } = await import('../src/lib/tokens.ts');
const { listProfiles } = await import('../src/profiles/index.ts');

const app = await bootApp();
// ── 시료 고르기 — 표면이 **닿는** 코호트여야 한다 ────────────────────────────
// 처음에 성인 코호트(`boah-dental`)로 재다가 `logs` 가 `upload_disabled` 로 막히는 것을 봤다.
// 그 코호트는 기록 업로드가 꺼져 있어 **로스터 효과가 아예 안 보인다** — 거기서 얻은 403 을
// 로스터 탓으로 읽었으면 또 원인을 잘못 적을 뻔했다(같은 날 `classroom` 에서 한 번 그랬다).
// 그래서 **업로드가 켜져 있고 미성년이 아닌** 프로필을 고른다. 조건을 코드로 고르지 말고
// 레지스트리에서 **찾게** 한다 — 프로필이 바뀌면 시험이 따라 움직이거나 큰 소리로 실패한다.
const profile = listProfiles().find(p => p.analytics?.upload_session_logs === true && p.minor_cohort !== true);
assert.ok(profile,
  '업로드가 켜져 있고 미성년이 아닌 프로필이 없다 — 이 시험은 그런 시료가 있어야 네 표면을 다 잰다');
const cohort = profile.session.cohort_id;

const lesson = { course_id: 'c', version: 'm2026.09.21-1', sha256: '0'.repeat(64) };
const tokens = {
  rostered: (await issue({ u: 'kid01', c: cohort, p: profile.id }, 4, TEST_SECRET)).token,
  outside: (await issue({ u: 'nobody', c: cohort, p: profile.id }, 4, TEST_SECRET)).token,
  seat: (await issue({ u: 'rehearsal-t-x', c: cohort, p: profile.id, lesson, rehearsal: true }, 4, TEST_SECRET)).token,
};

function env() {
  const e = createMockEnv({ env: { HPS_ACCESS_CONTRACTS: 'enabled' } });
  return e;
}
async function seeded({ roster = true, session = true } = {}) {
  const e = env();
  if (roster) await e.HPS_KV.put(`cohort:${cohort}:roster`, JSON.stringify({ users: ['kid01'], updated_at: new Date().toISOString() }));
  if (session) await e.HPS_KV.put(`cohort:${cohort}:active_session`, JSON.stringify({
    session_id: 's1', profile_id: profile.id,
    starts_at: new Date(Date.now() - 60_000).toISOString(),
    ends_at: new Date(Date.now() + 3600_000).toISOString(),
  }));
  return e;
}

/** 각 표면을 "학생이 실제로 치는 모양" 그대로 부른다. */
const SURFACE = {
  logs: { method: 'PUT', path: '/v1/logs/sess-1/events.jsonl?day=2026-09-21', body: '{}', type: 'application/x-ndjson' },
  trace: { method: 'POST', path: '/v1/trace/event', body: JSON.stringify({ event: 'heartbeat' }) },
  classroom: { method: 'GET', path: '/v1/classroom/shares' },
  access: { method: 'GET', path: '/v1/access' },
};
async function call(name, cred, e) {
  const s = SURFACE[name];
  const res = await app.fetch(new Request('https://service.test' + s.path, {
    method: s.method,
    headers: { authorization: `Bearer ${cred}`, 'content-type': s.type ?? 'application/json' },
    body: s.body,
  }), e, makeCtx());
  const raw = await res.text();
  let json; try { json = JSON.parse(raw); } catch {}
  return { status: res.status, json, raw };
}
/** 로스터에서 막힌 것인가. 다른 이유의 403 과 구분한다 — 그 구분이 없으면 원인을 오해한다. */
const blockedByRoster = (r) =>
  r.status === 403 && /not_in_roster|not in roster|participant_unavailable/.test(r.raw);

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

// ─── §0 계측기 — 대조군이 없으면 403 이 왜 403 인지 모른다 ─────────────────────
await check('§0 계측기 — 로스터 안 학생은 네 표면 전부에서 로스터에 막히지 않는다', async () => {
  const e = await seeded();
  const wrong = [];
  for (const name of Object.keys(SURFACE)) {
    const r = await call(name, tokens.rostered, e);
    if (blockedByRoster(r)) wrong.push(`${name}: ${r.raw.slice(0, 80)}`);
  }
  assert.deepEqual(wrong, [],
    `로스터 안 학생이 막혔다 — 시료가 틀렸으므로 아래 판정이 전부 무의미해진다:\n  ${wrong.join('\n  ')}`);
});

await check('§0 계측기 — 로스터 밖 학생은 네 표면 전부에서 로스터에 막힌다', async () => {
  const e = await seeded();
  const leaked = [];
  for (const name of Object.keys(SURFACE)) {
    const r = await call(name, tokens.outside, e);
    if (!blockedByRoster(r)) leaked.push(`${name}: ${r.status} ${r.raw.slice(0, 80)}`);
  }
  assert.deepEqual(leaked, [], `로스터 밖 학생이 지나갔다:\n  ${leaked.join('\n  ')}`);
});

// ─── §1 여는 표면 셋 — 리허설 좌석이 **로스터도 열린 세션도 없이** 통과한다 ─────
for (const name of ['logs', 'trace', 'access']) {
  await check(`§1 통함 — ${name}: 리허설 좌석이 로스터·세션 없이 통과한다`, async () => {
    const e = await seeded({ roster: false, session: false });
    const r = await call(name, tokens.seat, e);
    assert.ok(!blockedByRoster(r),
      `${name} 에서 리허설 좌석이 로스터에 막혔다 — 그 리허설은 학생 조건이 아니다(RUN-01): ${r.status} ${r.raw.slice(0, 160)}`);
    // 400(본문 오류)은 **관문을 지난 뒤**의 응답이라 통과로 센다. 내용 판정은 각 표면의 몫이다.
    assert.ok(r.status < 500, `${name} 이 5xx 를 냈다: ${r.raw.slice(0, 160)}`);
  });
}

await check('§1 통함 — access 는 좌석에게 학생과 **같은 내용**을 준다 (형식만 통과가 아니다)', async () => {
  const e = await seeded();
  const a = await call('access', tokens.rostered, e);
  const b = await call('access', tokens.seat, e);
  assert.equal(a.status, 200, a.raw);
  assert.equal(b.status, 200, b.raw);
  const strip = (x) => x.replace(/"as_of":"[^"]*"/, '');
  assert.equal(strip(b.raw), strip(a.raw),
    '좌석이 학생과 다른 이용권 화면을 받는다 — 참가자 화면은 계정이 아니라 코호트에서 나와야 한다');
});

// ─── §2 안 여는 표면 — classroom. **결정을 단언으로 남긴다** ────────────────────
// 근거 셋(#1210):
//   ① 학생 앱에 호출부가 **0건**이다 — 공유는 Chalk 경유 웹 경로이고 리허설이 도는 앱에서는
//      닿지도 않는다
//   ② **미성년 코호트에서는 아무도 못 쓴다** — 보호자 동의 계약 가드가 먼저 막는다.
//      학생도 못 쓰는 표면을 리허설에 열면 **리허설이 학생 조건보다 넓어진다**
//   ③ 공유는 **다른 사람에게 보이는 것**이다. 리허설이 진짜 학생들 사이에 나타나면 안 된다
await check('§2 안 연다 — classroom: 리허설 좌석은 여기서 계속 막힌다 (의도된 결정)', async () => {
  const e = await seeded();
  const r = await call('classroom', tokens.seat, e);
  assert.ok(blockedByRoster(r),
    `classroom 이 리허설 좌석에게 열렸다 — 이것은 **의도된 차단**이다. 열기 전에 #1210 의 근거 셋을 읽어라:\n` +
    `  ① 학생 앱에 호출부가 0건이다 ② 미성년 코호트에서는 학생도 못 쓴다 ③ 공유는 남에게 보인다.\n` +
    `  받은 응답: ${r.status} ${r.raw.slice(0, 160)}`);
});

await check('§2 근거 확인 — 미성년 코호트에서는 classroom 이 로스터 이전에 막힌다', async () => {
  const minor = listProfiles().find(p => p.minor_cohort === true);
  assert.ok(minor, '미성년 프로필을 못 찾았다 — 위 근거 ②를 확인할 수 없다');
  const e = createMockEnv();
  await e.HPS_KV.put(`cohort:${minor.session.cohort_id}:roster`, JSON.stringify({ users: ['kid01'] }));
  const inRoster = (await issue({ u: 'kid01', c: minor.session.cohort_id, p: minor.id }, 4, TEST_SECRET)).token;
  const res = await app.fetch(new Request('https://service.test/v1/classroom/shares', { headers: { authorization: `Bearer ${inRoster}` } }), e, makeCtx());
  const raw = await res.text();
  assert.equal(res.status, 403, raw);
  assert.match(raw, /sharing unavailable/,
    '미성년 코호트의 차단 사유가 보호자 동의 가드가 아니다 — 근거 ②가 더 이상 참이 아닐 수 있다');
});

console.log(`\nrehearsal-surfaces: ${passed} checks passed — 연 표면 3(logs·trace·access) · 안 연 표면 1(classroom)`);
console.log('  표면마다 따로 잰다. 하나를 고쳤다고 옆이 열리지 않는다 (#1209 에서 배운 것)');
