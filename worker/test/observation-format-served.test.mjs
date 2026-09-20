// SX-44~48 · P1 F-1 — `/v1/profile` 과 `/observations/context` 가 **프로필이 선언한**
// 관측 포맷을 서빙한다.
//
// Run: node --experimental-strip-types --experimental-sqlite test/observation-format-served.test.mjs
//
// ## 이 파일이 왜 뒤늦게 생겼나
//
// P1 이 `hps-observation/2` 검증기·학습 이벤트 8종·게이트 둘·Evidence drawer 를 전부
// 만들고 스위트를 초록으로 만든 뒤, **독립 평가자가 그 화면이 어떤 빌드에서도 렌더되지
// 않는다**는 것을 찾았다. 이유는 한 줄이었다:
//
//   worker/src/routes/chat.ts  →  observation: { format: 'hps-observation/1', … }
//
// 하드코딩이라 `/2` 를 내보낼 방법이 없었고, 그래서 확장의
// `prepareObservation()` 이 `/2` 레코더를 만들지 못하고, `learningState` 가 내려가지
// 않고, `{learning && <section …>}` 이 **한 번도 참이 아니었다.**
//
// 그 하드코딩 **세 줄 위**에 이 저장소가 직접 써 둔 경고가 있었다:
//
//   "A gate-only change would pass every gate test and ship INERT on every SDK
//    seat, because the client's tool policy is built from what THIS response says."
//
// `.claude/rules/verification.md` 의 "CI 초록은 아무것도 보장하지 않는다" 1번 항목과
// 같은 유형·같은 파일이다. 단위 테스트는 순수 함수와 컴포넌트만 부르고 **라우트 응답을
// 지나가지 않기 때문에** 끝까지 초록이었다.
//
// 그래서 이 검사는 **라우트 응답을 직접 읽는다.** 그것이 클라이언트가 실제로 보는 것이다.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// **정적** import 여야 한다. 이 모듈이 `.md` 로더와 확장자 없는 상대 경로 해석 훅을
// 등록하고, 그 훅이 등록된 **뒤에야** 프로필 레지스트리를 import 할 수 있다
// (`scripts/dump-profiles.ts` 머리 주석). 순서를 뒤집으면 registry import 가
// `ERR_MODULE_NOT_FOUND` 로 죽는다 — 처음에 그렇게 썼다.
import { localAuthoring } from './harness/dental-authoring.mjs';
import { TEST_SECRET } from './harness/index.mjs';

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n      ${String(e && e.message).replace(/\s*\n\s*/g, ' | ')}`); }
};

// ─── 1. 레지스트리 규칙 — 선언한 포맷만 서빙될 수 있다 ──────────────────────
// 라우트를 띄우기 전에, 프로필 층에서 먼저 센다. 어느 코호트가 무엇을 선언했는지가
// **사람이 읽고 결정할 표**이므로 그 표 자체를 단언한다.

const { listProfiles } = await import('../src/profiles/index.ts');
const profiles = listProfiles();
const { OBSERVATION_FORMATS, OBSERVATION_FORMAT } = await import('../src/lib/measurement-core/legacy-observation.ts');

await check('선언된 관측 포맷은 전부 코어가 아는 값이다', () => {
  for (const p of profiles) {
    const declared = p.observation?.format;
    if (declared === undefined) continue;
    assert.ok(
      OBSERVATION_FORMATS.includes(declared),
      `${p.id} 가 코어가 모르는 포맷을 선언했다: ${declared}`,
    );
  }
});

await check('포맷을 선언하지 않은 코호트는 오늘과 같다 — 기본값은 /1 이다', () => {
  // 불변 대조. `format` 칸을 추가한 것이 기존 코호트의 서빙을 바꾸지 않았다는 증거다.
  const enabled = profiles.filter((p) => p.observation?.enabled);
  assert.ok(enabled.length > 0, '관측을 켠 코호트가 하나도 없다 — 시료가 없다');
  for (const p of enabled) {
    if (p.observation?.format !== undefined) continue;
    assert.equal(OBSERVATION_FORMAT, 'hps-observation/1', '기본값이 /1 이 아니다');
  }
});

await check('적어도 한 코호트가 /2 를 선언한다 — 아니면 P1 은 도달 불가다', () => {
  const two = profiles.filter((p) => p.observation?.format === 'hps-observation/2');
  assert.ok(
    two.length > 0,
    '`/2` 를 선언한 코호트가 없다. 학습 이벤트·완료 게이트·Evidence drawer 가 ' +
    '전부 만들어져 있어도 도달할 수 없다(평가자 F-1). 프로필 한 줄이 그 기능의 스위치다.',
  );
  for (const p of two) {
    assert.equal(p.observation?.enabled, true, `${p.id} 가 /2 를 선언했는데 observation 이 꺼져 있다`);
  }
});

// ─── 2. 실측 — 라우트가 실제로 무엇을 돌려주나 ──────────────────────────────
// 여기가 이 파일의 본진이다. 위의 레지스트리 단언은 전부 통과하면서도 라우트가
// 하드코딩을 유지하면 기능은 여전히 죽어 있다. 그게 정확히 P1 에서 벌어진 일이다.

const { setRoster, startSession } = await import('../src/lib/kv.ts');
const { issue } = await import('../src/lib/tokens.ts');

/** 한 코호트에 좌석을 하나 내고 `/v1/profile` 과 `/observations/context` 를 읽는다. */
async function servedFor(profileId, clientFormat = 'hps-observation/2') {
  const local = await localAuthoring({ profileId });
  local.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  local.db.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(local.cohort, 'format probe');
  local.db.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)')
    .run('fmt', local.cohort, local.profileId, new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 3600000).toISOString());
  await setRoster(local.env.HPS_KV, local.cohort, ['student']);
  await startSession(local.env.HPS_KV, local.cohort, {
    session_id: 'fmt', profile_id: local.profileId,
    starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(),
  });

  const request = async (path, method = 'GET', body, token = local.token, declares) => {
    const r = await local.fetcher(local.origin + path, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        ...(declares ? { 'x-hps-observation-format': declares } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  // 수업(session design)이 없는 코호트도 재야 하므로 authoring 의 participants 경로가
  // 아니라 좌석 토큰을 직접 발급한다. `/v1/profile` 은 수업 없이도 답한다.
  const { token } = await issue({ u: 'student', c: local.cohort, p: local.profileId }, 1, TEST_SECRET);

  const view = await request('/v1/profile', 'GET', undefined, token, clientFormat);
  const ctx = await request('/v1/observations/context', 'GET', undefined, token, clientFormat);
  return { local, token, view, ctx };
}

// `/2` 를 선언한 코호트를 레지스트리에서 **찾아서** 쓴다. 이름을 여기 박아 두면
// 나중에 그 코호트가 바뀌었을 때 검사가 조용히 다른 것을 재게 된다.
const twoProfile = profiles.find((p) => p.observation?.format === 'hps-observation/2');
const oneProfile = profiles.find(
  (p) => p.observation?.enabled && p.observation?.format === undefined,
);

await check('실측: /2 를 선언한 좌석의 /v1/profile 이 /2 를 돌려준다', async () => {
  assert.ok(twoProfile, '/2 를 선언한 코호트가 없다');
  const { view } = await servedFor(twoProfile.id);
  assert.equal(view.status, 200, JSON.stringify(view.json));
  assert.equal(
    view.json.observation?.format,
    'hps-observation/2',
    '라우트가 프로필 선언을 무시하고 하드코딩된 값을 돌려준다 — 이것이 P1 을 죽였다',
  );
});

await check('실측: /observations/context 가 /v1/profile 과 같은 포맷을 말한다', async () => {
  // 두 응답이 갈라지면 확장은 `/2` 레코더를 만들고 `/observations/context` 는 `/1`
  // 컨텍스트를 주어 `recordLearningEvent()` 가 `observation_format` 으로 던진다.
  // **두 군데를 같이 고쳐야 한다**(평가자 F-1).
  assert.ok(twoProfile, '/2 를 선언한 코호트가 없다');
  const { view, ctx } = await servedFor(twoProfile.id);
  assert.equal(ctx.status, 200, JSON.stringify(ctx.json));
  assert.equal(
    ctx.json?.format,
    view.json.observation?.format,
    `두 라우트가 다른 포맷을 말한다: profile=${view.json.observation?.format} context=${ctx.json?.format}`,
  );
});

await check('불변 대조: 포맷을 선언하지 않은 좌석은 여전히 /1 을 받는다', async () => {
  // 양성 대조군. `/2` 를 내보내는 분기가 **무조건** 켜졌다면 위 두 단언은 통과하고
  // 여기서만 빨개진다. 기존 코호트를 건드리지 않았다는 증거다.
  assert.ok(oneProfile, '포맷 미선언 + 관측 켠 코호트가 없다 — 불변 대조를 세울 수 없다');
  const { view } = await servedFor(oneProfile.id);
  assert.equal(view.status, 200, JSON.stringify(view.json));
  assert.equal(view.json.observation?.format, 'hps-observation/1', '기존 좌석의 포맷이 바뀌었다');
});

// ─── 3. 협상 — 코호트 선언은 천장이지 명령이 아니다 ────────────────────────

await check('구버전 앱(/1 만 파싱)에는 /2 코호트라도 /1 을 준다', async () => {
  // `x-hps-observation-format` 은 앱이 **자기가 읽을 수 있는 것**을 말하는 칸이다.
  // 여기서 /2 를 내려보내면 구버전의 번들된 검증기가 배치를 통째로 거절해서
  // 그 좌석은 관찰이 **아예** 죽는다. 그러니 못 읽는 앱에는 내리지 않는다.
  assert.ok(twoProfile, '/2 를 선언한 코호트가 없다');
  const { view, ctx } = await servedFor(twoProfile.id, 'hps-observation/1');
  assert.equal(view.json.observation?.format, 'hps-observation/1', '구버전 앱에 /2 를 내려보냈다');
  assert.equal(ctx.json?.format, 'hps-observation/1', '두 라우트가 다른 협상 결과를 냈다');
});

await check('포맷을 아예 말하지 않는 클라이언트에도 /1 을 준다', async () => {
  assert.ok(twoProfile, '/2 를 선언한 코호트가 없다');
  // `null` 은 "헤더를 아예 보내지 않는다" 는 뜻이다. `undefined` 를 넘기면 기본
  // 매개변수가 살아나 /2 를 보내게 된다 — 처음에 그렇게 써서 이 단언이 빨갰다.
  const { view } = await servedFor(twoProfile.id, null);
  assert.equal(view.json.observation?.format, 'hps-observation/1', '말하지 않은 클라이언트에 /2 를 내려보냈다');
});

await check('/1 코호트는 신버전 앱에도 /1 이다 — 클라이언트가 포맷을 정하지 못한다', async () => {
  // 음성 대조군. 협상이 **클라이언트 쪽만** 보게 구현됐다면 여기서만 빨개진다.
  assert.ok(oneProfile, '포맷 미선언 코호트가 없다');
  const { view } = await servedFor(oneProfile.id, 'hps-observation/2');
  assert.equal(view.json.observation?.format, 'hps-observation/1', '클라이언트 헤더만으로 /2 가 열렸다');
});

// ─── 4. **클라이언트가 실제로 보내는 헤더**로 두 라우트를 부른다 ──────────────
//
// 위의 "두 라우트가 같은 포맷을 말한다" 단언은 **같은 헤더를 양쪽에 보내서** 재고
// 있었다. 실제 클라이언트는 그렇게 부르지 않는다 — `/v1/profile` 은 `fetchProfile`
// 이, `/observations/context` 는 `prepareObservation` 이 부르고, 둘이 서로 다른
// 헤더를 만들면 서버가 아무리 같은 함수로 협상해도 **답이 갈라진다.**
//
// 실제로 그렇게 갈라졌다: 첫 수리가 `/v1/profile` 에만 헤더를 붙였고
// `/observations/context` 는 헤더 없이 나가 `/1` 컨텍스트를 받았다. 레코더가 `/1`
// 로 만들어져 `currentLearningRecorder()` 가 계속 null 이었고 **서랍은 여전히 죽어
// 있었다.** 단언은 초록이었다.
//
// 그래서 여기서는 **확장이 쓰는 헤더 빌더를 직접 import 해서** 그것으로 부른다.
// 클라이언트가 헤더를 빠뜨리면 이 검사가 빨개진다.

const { observationHeaders } = await import('../../extensions/hypeproof-chat/src/proxyClientHelpers.ts');

await check('실측: 확장이 쓰는 헤더로 두 라우트를 부르면 같은 포맷이 나온다', async () => {
  assert.ok(twoProfile, '/2 를 선언한 코호트가 없다');
  const local = await localAuthoring({ profileId: twoProfile.id });
  local.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  local.db.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(local.cohort, 'client header probe');
  local.db.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)')
    .run('hdr', local.cohort, local.profileId, new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 3600000).toISOString());
  await setRoster(local.env.HPS_KV, local.cohort, ['student']);
  await startSession(local.env.HPS_KV, local.cohort, {
    session_id: 'hdr', profile_id: local.profileId,
    starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(),
  });
  const { token } = await issue({ u: 'student', c: local.cohort, p: local.profileId }, 1, TEST_SECRET);

  // **확장의 빌더**로 만든 헤더. 손으로 다시 적지 않는다 — 다시 적으면 이 검사가
  // 클라이언트가 아니라 나 자신을 재게 된다.
  const headers = observationHeaders(token);
  const call = async (path) => {
    const r = await local.fetcher(local.origin + path, { method: 'GET', headers });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  const view = await call('/v1/profile');
  const ctx = await call('/v1/observations/context');
  assert.equal(view.status, 200, JSON.stringify(view.json));
  assert.equal(ctx.status, 200, JSON.stringify(ctx.json));
  assert.equal(view.json.observation?.format, 'hps-observation/2', '프로필 응답이 /2 가 아니다');
  assert.equal(ctx.json?.format, 'hps-observation/2', '컨텍스트 응답이 /2 가 아니다 — 레코더가 /1 로 만들어진다');
});

await check('실측: 신버전 앱이 /1 코호트에서 "업데이트하세요" 배너를 받지 않는다', async () => {
  // 첫 수리가 만든 회귀. 클라이언트 헤더를 `/2` 로 올렸는데 배너 조건이
  // `!== "hps-observation/1"` 로 남아 있어서, **관측이 켜진 모든 좌석**이
  // "이 앱 버전은 작업 관찰 화면을 지원하지 않습니다" 를 받았다.
  assert.ok(oneProfile, '포맷 미선언 코호트가 없다');
  const local = await localAuthoring({ profileId: oneProfile.id });
  local.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  local.db.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(local.cohort, 'banner probe');
  local.db.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)')
    .run('ban', local.cohort, local.profileId, new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 3600000).toISOString());
  await setRoster(local.env.HPS_KV, local.cohort, ['student']);
  await startSession(local.env.HPS_KV, local.cohort, {
    session_id: 'ban', profile_id: local.profileId,
    starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(),
  });
  const { token } = await issue({ u: 'student', c: local.cohort, p: local.profileId }, 1, TEST_SECRET);

  const withNew = await local.fetcher(local.origin + '/v1/profile', { method: 'GET', headers: observationHeaders(token) });
  const json = await withNew.json();
  assert.ok(
    !String(json.welcome?.greeting_md ?? '').includes('지원하지 않습니다'),
    '신버전 앱이 "업데이트하세요" 배너를 받는다 — 첫 수리가 만든 회귀다',
  );

  // 양성 대조군 — 포맷을 **모르는** 클라이언트에는 배너가 그대로 나가야 한다.
  // 이 줄이 없으면 배너를 통째로 없애 버려도 위 단언이 통과한다.
  const withNone = await local.fetcher(local.origin + '/v1/profile', {
    method: 'GET', headers: { authorization: 'Bearer ' + token },
  });
  const legacy = await withNone.json();
  assert.ok(
    String(legacy.welcome?.greeting_md ?? '').includes('지원하지 않습니다'),
    '포맷을 말하지 않는 앱에도 안내가 사라졌다 — 배너를 없애 버린 것이다',
  );
});

// 구버전 앱(`/1` 선언)도 배너를 받지 않아야 한다 — 그 앱은 관찰을 **지원한다**.
await check('실측: /1 만 아는 구버전 앱도 배너를 받지 않는다', async () => {
  assert.ok(oneProfile, '포맷 미선언 코호트가 없다');
  const { view } = await servedFor(oneProfile.id, 'hps-observation/1');
  assert.ok(
    !String(view.json.welcome?.greeting_md ?? '').includes('지원하지 않습니다'),
    '관찰을 지원하는 구버전 앱에 업데이트 안내가 나갔다',
  );
});

console.log(`\nobservation-format-served: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
