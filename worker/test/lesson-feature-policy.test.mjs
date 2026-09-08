// #748 (E2) — a frozen lesson narrows the features of its seat.
// Contract: docs/adr/0007-lesson-feature-binding.md, implementation notes in
// src/lib/lesson-feature-policy.ts.
//
// The point of this file is to separate the two halves of the claim, because
// they are NOT the same strength:
//
//   - on /v1/chat/completions the Service composes the upstream tool array, so
//     a narrowed web_search/browser is genuinely absent from the provider
//     request. Asserted against the real upstream body.
//   - on /v1/messages the Service does not touch `tools`, so the narrowing
//     holds only for a client that honours /v1/profile. A NEGATIVE CONTROL
//     pins today's passthrough, so this file fails the day that changes rather
//     than letting the ADR quietly go stale.
//
// Every narrowed assertion is paired with an un-narrowed control on the same
// profile. Without those, a bug that served nothing to everyone would pass.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localAuthoring } from './harness/dental-authoring.mjs';
import { withMockUpstream } from './harness/index.mjs';
const { getProfile } = await import('../src/profiles/index.ts');
const {
  FEATURE_KEYS, applyLessonFeatures, featureBinding,
  lessonFeaturesAreCurrent, permittedFeatureKeys, FEATURE_LABELS,
} = await import('../src/lib/lesson-feature-policy.ts');
const { setRoster, startSession } = await import('../src/lib/kv.ts');

const local = await localAuthoring({ profileId: 'homepage-practice-s1' });
local.env.LLM_PROVIDER = 'anthropic';
local.env.ANTHROPIC_API_KEY = 'synthetic-provider-key';
local.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
local.db.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(local.cohort, 'Synthetic feature narrowing');
local.db.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)')
  .run('features', local.cohort, local.profileId, new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 3600000).toISOString());

const profile = getProfile(local.profileId);
const originalRuntime = profile.coach_runtime;
const originalSdkTools = structuredClone(profile.sdk_tools);
const originalTools = structuredClone(profile.tools);
const originalBrowserControl = structuredClone(profile.browser_control);

const content = {
  schema: 'hps-session-design/1', title: '가상 꽃집', audience: '합성 사용자',
  duration_minutes: 60, objective: '영업시간 검토', prerequisites: '', starter: '연습 폴더',
  steps: [{ id: 'one', title: '확인', instructions: '영업시간 확인', hint: '', acceptance: '수정 이유 설명' }],
};
const base = '/admin/cohorts/' + local.cohort + '/authoring/';
const request = async (path, method = 'GET', body, token = local.token) => {
  const r = await local.fetcher(local.origin + path, {
    method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: await r.json(), headers: r.headers };
};
const save = (features, revision = 0) => ({
  profile_id: local.profileId, request_id: crypto.randomUUID(), expected_revision: revision,
  content: features ? { ...content, features } : { ...content },
});
const upstreamToolNames = init => (JSON.parse(init.body).tools ?? []).map(t => t.name ?? t.type);
const answer = model => Response.json({
  id: 'synthetic-message', type: 'message', role: 'assistant', model,
  content: [{ type: 'text', text: '확인했습니다.' }], stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 2 },
});

try {
  await setRoster(local.env.HPS_KV, local.cohort, ['student']);
  await startSession(local.env.HPS_KV, local.cohort, {
    session_id: 'features', profile_id: local.profileId,
    starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(),
  });

  // ── The catalogue is DERIVED from the compiled profile ────────────────────
  // Not a second list to keep in sync. This fixture grants everything except
  // subagents, which makes it the useful negative case below.
  assert.deepEqual(permittedFeatureKeys(profile), ['read', 'write', 'shell', 'browser', 'web_search']);
  assert.ok(!permittedFeatureKeys(profile).includes('subagents'), 'the fixture must withhold one key to test the refusal');

  // ── 강사에게 서빙되는 카탈로그는 같은 파생에서 나온다 ──────────────────
  // 강사 화면이 고르는 목록과 Service 가 검증하는 목록이 다른 출처면, 화면에서
  // 고를 수 있는데 저장이 403 나는 조합이 생긴다.
  {
    const cat = await request(base + 'catalog/features/' + local.profileId);
    assert.equal(cat.status, 200, JSON.stringify(cat.json));
    assert.deepEqual(cat.json.choices.map(c => c.key), permittedFeatureKeys(profile));
    // 강사는 키가 아니라 이름을 본다. `subagents` 같은 날것이 화면에 뜨면 안 된다.
    for (const choice of cat.json.choices) {
      assert.equal(typeof choice.label, 'string');
      assert.ok(choice.label.length > 0, `${choice.key} 에 이름이 없다`);
      assert.notEqual(choice.label, choice.key, `${choice.key} 가 키 그대로 나간다`);
    }
    // 코호트가 안 준 기능은 목록에 아예 없다 — 고를 수 없는 것을 보여주지 않는다.
    assert.ok(!cat.json.choices.some(c => c.key === 'subagents'));
    // 없는 프로필은 403. 그런데 이것만으로는 범위 검사를 잰 것이 아니다 —
    // `!profile` 한 줄만 있어도 통과한다. 그래서 **실재하지만 다른 코호트에 속한**
    // 프로필로 한 번 더 묻는다. 이 좌석이 남의 반 카탈로그를 못 읽는다는 것이
    // 재려던 성질이고, 앞의 단언만으로는 그게 사라져도 알 수 없다.
    assert.equal((await request(base + 'catalog/features/missing')).status, 403);
    // `canary-sdk-contract` 를 고른 것은 임의가 아니다. 범위 검사를 지웠을 때
    // **실제로 200 이 나오는** 프로필이라 이 단언이 그 검사를 잰다. 처음에 고른
    // `sk-biopharm-kids-s1` 은 다른 이유로 이미 막혀서, 검사를 지워도 403 이
    // 그대로 나왔다 — 통과 쪽으로 틀린 계측기였다(변이로 잡았다).
    assert.equal(
      (await request(base + 'catalog/features/canary-sdk-contract')).status, 403,
      '실재하는 다른 코호트의 프로필도 거절한다',
    );
  }

  // ── 이름표는 카탈로그가 늘어나도 따라온다 ────────────────────────────────
  // 위 단언들은 이 코호트가 **가진** 키만 본다. 그래서 카탈로그에 새 키가 생기고
  // 이름표를 빠뜨려도 이 픽스처에서는 보이지 않는다. 목록 자체를 직접 잰다.
  for (const key of FEATURE_KEYS) {
    const label = FEATURE_LABELS[key];
    assert.equal(typeof label, 'string', `${key} 에 이름표가 없다`);
    assert.ok(label.trim().length > 0, `${key} 의 이름표가 비었다`);
    assert.notEqual(label, key, `${key} 가 키 그대로 강사에게 나간다`);
  }

  // ── A lesson may only narrow ──────────────────────────────────────────────
  // Asking for a key outside the catalogue is refused at save. This is the
  // AE-09 property: authored content cannot widen what the profile granted.
  assert.equal((await request(base + 'invalid', 'PUT', save({ allowed: ['read', 'subagents'] }))).status, 403);
  assert.equal((await request(base + 'invalid', 'PUT', save({ allowed: FEATURE_KEYS.slice() }))).status, 403);

  // Malformed selections are rejected before any policy question is asked.
  for (const features of [
    { allowed: ['read'], binding: {} },          // Service produces the binding, never the draft
    { allowed: ['read', 'read'] },               // duplicates
    { allowed: ['read'], surprise: true },       // unknown key
    { allowed: 'read' },                         // not an array
    { allowed: ['screen_share'] },               // not a feature key
    {},                                          // allowed is required
  ]) assert.equal((await request(base + 'invalid', 'PUT', save(features))).status, 400, JSON.stringify(features));

  // ── Freeze records a binding the Service can re-derive ────────────────────
  const policy = { allowed: ['read', 'write'] };
  const path = base + 'narrowed';
  assert.equal((await request(path, 'PUT', save(policy))).status, 200);
  const frozen = await request(path + '/versions/m2026.09.08-1', 'PUT', { expected_revision: 1 });
  assert.equal(frozen.status, 200, JSON.stringify(frozen.json));
  const frozenPolicy = frozen.json.module.content.features;
  assert.deepEqual(frozenPolicy.binding, featureBinding(profile, policy));

  // The binding says WHERE the removal is enforced, and says it honestly. This
  // fixture runs agent-sdk, where the Service enforces none of it.
  assert.equal(frozenPolicy.binding.runtime, 'agent-sdk');
  assert.deepEqual(frozenPolicy.binding.catalogue, ['read', 'write', 'shell', 'browser', 'web_search']);
  assert.deepEqual(frozenPolicy.binding.removed_enforced, []);
  assert.deepEqual(frozenPolicy.binding.removed_client_only, ['shell', 'browser', 'web_search']);

  // The same narrowing on a proxy cohort moves two of those keys across the
  // line, because there the Service builds the tool array itself.
  profile.coach_runtime = 'proxy';
  const proxyBinding = featureBinding(profile, policy);
  assert.equal(proxyBinding.runtime, 'proxy');
  assert.deepEqual(proxyBinding.removed_enforced, ['browser', 'web_search']);
  assert.deepEqual(proxyBinding.removed_client_only, ['shell']);
  profile.coach_runtime = originalRuntime;

  // ── An un-narrowed control lesson on the SAME profile ─────────────────────
  const openPath = base + 'open';
  assert.equal((await request(openPath, 'PUT', save(null))).status, 200);
  assert.equal((await request(openPath + '/versions/m2026.09.08-1', 'PUT', { expected_revision: 1 })).status, 200);

  const seat = async p => (await request(p + '/versions/m2026.09.08-1/participants', 'POST', { user: 'student', hours: 1 })).json.token;
  const narrowedToken = await seat(path);
  const openToken = await seat(openPath);

  // ── /v1/profile carries the narrowing ─────────────────────────────────────
  // This route does NOT run the chat gate for an ordinary lesson seat, so a
  // gate-only implementation would ship inert here. The client builds its whole
  // tool policy from this response.
  const narrowedView = await request('/v1/profile', 'GET', undefined, narrowedToken);
  assert.equal(narrowedView.status, 200, JSON.stringify(narrowedView.json));
  assert.deepEqual(narrowedView.json.sdk_tools, { read: true, write: true, browser: false, subagents: false, shell: false });
  assert.equal(narrowedView.json.tools.web_search, false);
  assert.equal(narrowedView.json.browser_control.enabled, false);
  // One instructor-facing key, both runtime spellings. Turning the browser off
  // must not leave the proxy loop on just because it has a different name.
  assert.equal(narrowedView.json.sdk_tools.browser, narrowedView.json.browser_control.enabled);

  // POSITIVE CONTROL — without a features policy the same profile still serves
  // everything. A narrowing that fired unconditionally would pass every
  // assertion above and fail only here.
  const openView = await request('/v1/profile', 'GET', undefined, openToken);
  assert.equal(openView.status, 200);
  assert.deepEqual(openView.json.sdk_tools, { read: true, write: true, browser: true, subagents: false, shell: true });
  assert.equal(openView.json.tools.web_search, true);
  assert.equal(openView.json.browser_control.enabled, true);

  // Narrowing changes no identity or runtime field.
  assert.equal(narrowedView.json.coach_runtime, openView.json.coach_runtime);
  assert.equal(narrowedView.json.profile_id, openView.json.profile_id);

  // ── /v1/chat/completions — here the narrowing IS a Service boundary ───────
  profile.coach_runtime = 'proxy';
  try {
    const proxyPath = base + 'proxy-narrowed', proxyOpen = base + 'proxy-open';
    assert.equal((await request(proxyPath, 'PUT', save(policy))).status, 200);
    assert.equal((await request(proxyPath + '/versions/m2026.09.08-1', 'PUT', { expected_revision: 1 })).status, 200);
    assert.equal((await request(proxyOpen, 'PUT', save(null))).status, 200);
    assert.equal((await request(proxyOpen + '/versions/m2026.09.08-1', 'PUT', { expected_revision: 1 })).status, 200);
    const proxyNarrowed = await seat(proxyPath), proxyOpenToken = await seat(proxyOpen);
    const ask = { max_tokens: 32, messages: [{ role: 'user', content: '영업시간을 확인해 주세요.' }], stream: false };

    let narrowedTools;
    await withMockUpstream((_u, init) => { narrowedTools = upstreamToolNames(init); return answer('claude-sonnet-4-6'); },
      async () => assert.equal((await request('/v1/chat/completions', 'POST', ask, proxyNarrowed)).status, 200));

    let openTools;
    await withMockUpstream((_u, init) => { openTools = upstreamToolNames(init); return answer('claude-sonnet-4-6'); },
      async () => assert.equal((await request('/v1/chat/completions', 'POST', ask, proxyOpenToken)).status, 200));

    // The control first: the un-narrowed seat proves these tools are reachable
    // at all, so their absence above means something.
    // The hosted search tool is `{type:'web_search_20250305', name:'web_search'}`
    // — asserted by the name the worker actually sends, read off the body
    // rather than assumed. Guessing the type here cost one false FAIL.
    assert.ok(openTools.includes('web_search'), 'control seat must receive the hosted web_search tool');
    assert.ok(openTools.includes('browser_navigate'), 'control seat must receive the browser loop tools');

    assert.ok(!narrowedTools.includes('web_search'), 'narrowed seat must not reach the provider with web_search');
    assert.ok(!narrowedTools.some(n => String(n).startsWith('browser_')), 'narrowed seat must not reach the provider with browser tools');
  } finally {
    profile.coach_runtime = originalRuntime;
  }

  // ── /v1/messages — NEGATIVE CONTROL, today's documented passthrough ───────
  // The route spreads the client body and never overrides `tools`, so a client
  // that declares Bash on a shell-narrowed seat still reaches the upstream with
  // it. That is a deliberate, recorded deferral (the route's own header comment
  // says server-side tool policy is Phase 2), NOT something this slice claims
  // to have closed. This assertion pins the current behaviour so the ADR cannot
  // silently become wrong: when Phase 2 lands, THIS test fails and the
  // requirement row moves with it.
  {
    let sawShell = null;
    await withMockUpstream((_u, init) => { sawShell = upstreamToolNames(init).includes('Bash'); return answer('claude-sonnet-4-6'); },
      async () => {
        const r = await request('/v1/messages', 'POST', {
          model: 'hypeproof-default', max_tokens: 32,
          messages: [{ role: 'user', content: '영업시간을 확인해 주세요.' }],
          tools: [{ name: 'Bash', description: 'run a shell command', input_schema: { type: 'object', properties: {} } }],
        }, narrowedToken);
        assert.equal(r.status, 200, JSON.stringify(r.json));
      });
    assert.equal(sawShell, true,
      'TODAY the agent-sdk route passes client tools through; if this fails, Phase 2 landed — update ADR-0007 and the requirement row');
  }

  // ── The binding is rechecked on every read ───────────────────────────────
  // A profile whose grants shrink after the freeze must close the lesson, not
  // serve the wider set the instructor last saw.
  assert.equal(lessonFeaturesAreCurrent(profile, frozenPolicy), true);
  profile.sdk_tools = { ...originalSdkTools, write: false };
  try {
    assert.equal(lessonFeaturesAreCurrent(profile, frozenPolicy), false, 'a shrunken grant invalidates the binding');
    assert.equal((await request('/v1/profile', 'GET', undefined, narrowedToken)).status, 409);
  } finally {
    profile.sdk_tools = structuredClone(originalSdkTools);
  }
  assert.equal((await request('/v1/profile', 'GET', undefined, narrowedToken)).status, 200, 'restoring the grant reopens the lesson');

  // A tampered binding is refused even though the selection itself is legal.
  const altered = structuredClone(frozenPolicy);
  altered.binding.removed_client_only = [];
  assert.equal(lessonFeaturesAreCurrent(profile, altered), false);

  // ── The pure projection can only take away ───────────────────────────────
  {
    const bare = { ...profile, tools: {}, sdk_tools: {}, browser_control: { enabled: false } };
    const widened = applyLessonFeatures(bare, { allowed: FEATURE_KEYS.slice() });
    assert.equal(widened.tools.web_search, false, 'a lesson cannot grant web_search the profile withholds');
    assert.deepEqual(widened.sdk_tools, { read: false, write: false, shell: false, subagents: false, browser: false });
    assert.equal(widened.browser_control.enabled, false);

    // Absent sub-objects stay absent rather than becoming all-false noise.
    const empty = applyLessonFeatures({ ...profile, sdk_tools: undefined, browser_control: undefined }, { allowed: [] });
    assert.equal(empty.sdk_tools, undefined);
    assert.equal(empty.browser_control, undefined);

    // Narrowing to nothing is a legal, meaningful selection: a chat-only lesson
    // on a cohort that otherwise grants tools.
    const chatOnly = applyLessonFeatures(profile, { allowed: [] });
    assert.deepEqual(chatOnly.sdk_tools, { read: false, write: false, shell: false, subagents: false, browser: false });
    assert.equal(chatOnly.tools.web_search, false);
    assert.equal(chatOnly.browser_control.enabled, false);
  }

  console.log('lesson-feature-policy: narrowing, binding, both call sites, and the /v1/messages passthrough control — OK');
} finally {
  profile.coach_runtime = originalRuntime;
  profile.sdk_tools = originalSdkTools;
  profile.tools = originalTools;
  profile.browser_control = originalBrowserControl;
}
