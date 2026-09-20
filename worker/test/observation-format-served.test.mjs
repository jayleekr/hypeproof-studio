// SX-44~48 · P1 F-1 — `/v1/profile` and `/observations/context` serve the observation
// format **the profile declares**.
//
// Run: node --experimental-strip-types --experimental-sqlite test/observation-format-served.test.mjs
//
// ## Why this file showed up so late
//
// P1 built the whole `hps-observation/2` validator, the 8 learning events, the two gates and
// the Evidence drawer, turned the suite green — and then **an independent evaluator found that
// that screen renders on no build at all.** The reason was one line:
//
//   worker/src/routes/chat.ts  →  observation: { format: 'hps-observation/1', … }
//
// It was hardcoded, so there was no way to emit `/2`; the extension's
// `prepareObservation()` therefore could not build a `/2` recorder, `learningState` never
// came down, and `{learning && <section …>}` was **never once true.**
//
// **Three lines above** that hardcoding sat a warning this repo had written itself:
//
//   "A gate-only change would pass every gate test and ship INERT on every SDK
//    seat, because the client's tool policy is built from what THIS response says."
//
// Same type, same file as item 1 of "CI 초록은 아무것도 보장하지 않는다" in
// `.claude/rules/verification.md`. The unit tests stayed green to the end because they call
// only pure functions and components and **never pass through a route response.**
//
// So this check **reads the route response directly.** That is what the client actually sees.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Must be a **static** import. This module registers a `.md` loader and an extensionless
// relative-path resolution hook, and the profile registry can only be imported **after** that
// hook is registered (head comment of `scripts/dump-profiles.ts`). Flip the order and the
// registry import dies with `ERR_MODULE_NOT_FOUND` — that is how it was written the first time.
import { localAuthoring } from './harness/dental-authoring.mjs';
import { TEST_SECRET } from './harness/index.mjs';

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n      ${String(e && e.message).replace(/\s*\n\s*/g, ' | ')}`); }
};

// ─── 1. Registry rule — only a declared format can be served ───────────────
// Count at the profile layer first, before bringing a route up. Which cohort declared what is
// **a table a human reads and decides from**, so assert the table itself.

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
  // Invariant control. Evidence that adding the `format` field did not change what existing cohorts are served.
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

// ─── 2. Measured — what the route actually returns ─────────────────────────
// This is the heart of this file. The registry assertions above can all pass while the route
// keeps its hardcoding, and the feature is still dead. That is exactly what happened in P1.

const { setRoster, startSession } = await import('../src/lib/kv.ts');
const { issue } = await import('../src/lib/tokens.ts');

/** Issue one seat in one cohort and read `/v1/profile` and `/observations/context`. */
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

  // A cohort with no lesson (session design) has to be measured too, so issue the seat token
  // directly instead of going through authoring's participants path. `/v1/profile` answers
  // even without a lesson.
  const { token } = await issue({ u: 'student', c: local.cohort, p: local.profileId }, 1, TEST_SECRET);

  const view = await request('/v1/profile', 'GET', undefined, token, clientFormat);
  const ctx = await request('/v1/observations/context', 'GET', undefined, token, clientFormat);
  return { local, token, view, ctx };
}

// **Find** the cohort that declares `/2` in the registry and use that. Pinning the name here
// means that when that cohort changes later, the check quietly measures something else.
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
  // If the two responses diverge, the extension builds a `/2` recorder while
  // `/observations/context` hands it a `/1` context, and `recordLearningEvent()` throws on
  // `observation_format`. **Both places have to be fixed together** (evaluator F-1).
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
  // Positive control. If the branch that emits `/2` got turned on **unconditionally**, the two
  // assertions above pass and only this one goes red. Evidence that existing cohorts were untouched.
  assert.ok(oneProfile, '포맷 미선언 + 관측 켠 코호트가 없다 — 불변 대조를 세울 수 없다');
  const { view } = await servedFor(oneProfile.id);
  assert.equal(view.status, 200, JSON.stringify(view.json));
  assert.equal(view.json.observation?.format, 'hps-observation/1', '기존 좌석의 포맷이 바뀌었다');
});

// ─── 3. Negotiation — a cohort declaration is a ceiling, not an order ──────

await check('구버전 앱(/1 만 파싱)에는 /2 코호트라도 /1 을 준다', async () => {
  // `x-hps-observation-format` is the field where the app says **what it can read**.
  // Sending /2 here makes the old version's bundled validator reject the whole batch, so
  // observation on that seat dies **entirely**. So don't send it to an app that can't read it.
  assert.ok(twoProfile, '/2 를 선언한 코호트가 없다');
  const { view, ctx } = await servedFor(twoProfile.id, 'hps-observation/1');
  assert.equal(view.json.observation?.format, 'hps-observation/1', '구버전 앱에 /2 를 내려보냈다');
  assert.equal(ctx.json?.format, 'hps-observation/1', '두 라우트가 다른 협상 결과를 냈다');
});

await check('포맷을 아예 말하지 않는 클라이언트에도 /1 을 준다', async () => {
  assert.ok(twoProfile, '/2 를 선언한 코호트가 없다');
  // `null` means "send no header at all". Passing `undefined` revives the default parameter
  // and sends /2 — that is how it was written first, and this assertion went red.
  const { view } = await servedFor(twoProfile.id, null);
  assert.equal(view.json.observation?.format, 'hps-observation/1', '말하지 않은 클라이언트에 /2 를 내려보냈다');
});

await check('/1 코호트는 신버전 앱에도 /1 이다 — 클라이언트가 포맷을 정하지 못한다', async () => {
  // Negative control. If negotiation was implemented looking at **the client side only**, only this goes red.
  assert.ok(oneProfile, '포맷 미선언 코호트가 없다');
  const { view } = await servedFor(oneProfile.id, 'hps-observation/2');
  assert.equal(view.json.observation?.format, 'hps-observation/1', '클라이언트 헤더만으로 /2 가 열렸다');
});

// ─── 4. Call both routes with **the header the client actually sends** ─────
//
// The "두 라우트가 같은 포맷을 말한다" assertion above was measuring by **sending the same
// header to both sides**. A real client does not call them that way — `/v1/profile` is called
// by `fetchProfile` and `/observations/context` by `prepareObservation`, and if those two
// build different headers the **answers diverge** no matter how identically the server negotiates.
//
// And they did diverge: the first repair attached the header only to `/v1/profile`, and
// `/observations/context` went out with no header and got a `/1` context. The recorder was
// built as `/1`, `currentLearningRecorder()` kept returning null, and **the drawer was still
// dead.** The assertions were green.
//
// So here we **import the extension's own header builder** and call with that. If the client
// drops a header, this check goes red.

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

  // Headers built by **the extension's builder**. Do not retype them by hand — retyping makes
  // this check measure myself instead of the client.
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
  // A regression the first repair created. The client header was raised to `/2` but the banner
  // condition stayed `!== "hps-observation/1"`, so **every seat with observation on** got
  // "이 앱 버전은 작업 관찰 화면을 지원하지 않습니다".
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

  // Positive control — a client that does **not** know the format must still get the banner.
  // Without this line, deleting the banner entirely would still pass the assertion above.
  const withNone = await local.fetcher(local.origin + '/v1/profile', {
    method: 'GET', headers: { authorization: 'Bearer ' + token },
  });
  const legacy = await withNone.json();
  assert.ok(
    String(legacy.welcome?.greeting_md ?? '').includes('지원하지 않습니다'),
    '포맷을 말하지 않는 앱에도 안내가 사라졌다 — 배너를 없애 버린 것이다',
  );
});

// An old app (declaring `/1`) must not get the banner either — that app **does support** observation.
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
