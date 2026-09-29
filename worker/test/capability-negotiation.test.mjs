// An installed Studio must keep getting findings it can read.
// Run: node --experimental-strip-types --test test/capability-negotiation.test.mjs
//
// ## The failure this pins
//
// Moving assessments to the six-capability model made the worker answer every
// `/v1/observations/assess` with six keys. Every Studio already installed bundles
// a validator that hardcodes seven:
//
//   v0.1.56 nativeObservationContract.ts:194
//     check(Array.isArray(value) && value.length === 7, "invalid_findings")
//   v0.1.56 chatPanelProvider.ts:1736
//     validateFindings(result.findings, snapshot)        // no model argument
//
// so that seat spends the provider call, throws `invalid_findings`, shows
// "관찰 결과를 확인하지 못했습니다" and never stores the result — it does not recover
// on retry. Worker and app ship independently (`worker/DEPLOY.md` vs `gh release`),
// so that skew is the normal state.
//
// This repo already treats the identical hazard as first-class for the batch
// format: `servedObservationFormat` downgrades /2 to /1 off
// `x-hps-observation-format` because "an older app that only knows /1 would reject
// a /2 batch outright". The findings model now negotiates the same way.
//
// The old-client case is the one that matters. It is written FIRST and asserts on
// the count the released validator checks, not on a constant of our choosing.

import './harness/loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET } from './harness/index.mjs';

const { issue } = await import('../src/lib/tokens.ts');

const id = 'studio-native-trial';
const SEVEN = ['TASTE', 'INTENT', 'CONTEXT', 'VERIFY', 'DELEGATE', 'ITERATE', 'OWNERSHIP'];
const SIX = ['FRAMING', 'JUDGMENT', 'ORCHESTRATE', 'VERIFY', 'ADAPT', 'OWNERSHIP'];

async function fixture() {
  const env = createMockEnv({ withSession: false, withRoster: false });
  await env.HPS_KV.put(`cohort:${id}:active_session`, JSON.stringify({
    session_id: 'synthetic-trial', profile_id: id,
    starts_at: new Date(Date.now() - 60000).toISOString(),
    ends_at: new Date(Date.now() + 3600000).toISOString(),
  }));
  await env.HPS_KV.put(`cohort:${id}:roster`, JSON.stringify({
    users: ['synthetic-adult'], updated_at: new Date().toISOString(),
  }));
  const { token } = await issue({ u: 'synthetic-adult', c: id, p: id }, 1, TEST_SECRET);
  return { env, token };
}

/**
 * Ask `/assess` the way one client generation does, and report what the provider
 * was TOLD as well as what came back — the prompt is half the contract.
 */
async function assessAs(clientHeaders) {
  const { env, token } = await fixture();
  const app = await bootApp();
  env.ANTHROPIC_API_KEY = 'synthetic-provider-key';
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...clientHeaders };

  const ctx = await app.fetch(new Request('https://test/v1/observations/context', { headers }), env, makeCtx());
  const batch = {
    ...(await ctx.json()),
    events: [{
      id: 'u1', seq: 1, task: 't1', at: 1, kind: 'user',
      text: '새 직원이 주문을 확인할 문서가 필요해', assistance: 'unknown',
    }],
  };

  const original = globalThis.fetch;
  let sentSystem = '';
  let sentSchema = null;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(init.body);
    sentSystem = body.system.map((b) => b.text).join('\n');
    sentSchema = JSON.stringify(body);
    // Answer with whatever keys the prompt asked for, the way a compliant
    // provider would. Echoing the request is what makes this a test of the
    // NEGOTIATION rather than of a constant we picked.
    const keys = sentSystem.includes('FRAMING') ? SIX : SEVEN;
    return new Response(JSON.stringify({
      content: [{
        type: 'text',
        text: JSON.stringify({
          findings: keys.map((asset) => ({
            asset, status: 'unobserved', interpretation: '잠정 관찰', next: '다음 과제에서 확인',
          })),
        }),
      }],
    }), { status: 200, headers: { 'request-id': 'synthetic-provider-request' } });
  };
  try {
    const res = await app.fetch(
      new Request('https://test/v1/observations/assess', { method: 'POST', headers, body: JSON.stringify(batch) }),
      env, makeCtx(),
    );
    return { status: res.status, body: await res.json(), sentSystem, sentSchema };
  } finally {
    globalThis.fetch = original;
  }
}

test('an installed Studio (no capability header) still gets seven Assets', async () => {
  const r = await assessAs({});

  assert.equal(r.status, 200, `설치된 앱의 좌석이 ${r.status} 를 받았다`);
  assert.equal(
    r.body.findings.length, 7,
    'v0.1.56 validateFindings 는 length === 7 을 검사한다 — 이 숫자가 곧 그 앱의 성패다',
  );
  assert.deepEqual([...r.body.findings.map((f) => f.asset)].sort(), [...SEVEN].sort());
  assert.equal(r.body.capability_model, 'legacy-seven-assets');
  assert.equal(r.body.rubric.version, 'm2026.09.08-4', '옛 클라이언트는 옛 루브릭으로 평가돼야 한다');

  // The prompt is the other half. A worker that sent the six-key prompt and then
  // validated against seven would fail at the provider, not here.
  assert.match(r.sentSystem, /7개 항목의 asset은/);
  assert.ok(!r.sentSystem.includes('FRAMING'), '옛 좌석에 새 모델 프롬프트가 나갔다');
});

test('a build that declares the candidate model gets six capabilities', async () => {
  const r = await assessAs({ 'x-hps-capability-model': 'candidate-capability-v1' });

  assert.equal(r.status, 200);
  assert.equal(r.body.findings.length, 6);
  assert.deepEqual([...r.body.findings.map((f) => f.asset)].sort(), [...SIX].sort());
  assert.equal(r.body.capability_model, 'candidate-capability-v1');
  assert.equal(r.body.rubric.version, 'm2026.09.21-1');
  assert.match(r.sentSystem, /6개 항목의 asset은/);
});

test('an unrecognized declaration is not permission', async () => {
  // A future or garbled value must not be read as "this client can parse the new
  // model" — the cost of guessing wrong is the broken seat above.
  for (const value of ['candidate-capability-v2', 'legacy-seven-assets', '', 'true']) {
    const r = await assessAs({ 'x-hps-capability-model': value });
    assert.equal(r.body.capability_model, 'legacy-seven-assets', `${JSON.stringify(value)} 를 허가로 읽었다`);
    assert.equal(r.body.findings.length, 7);
  }
});

test('the schema sent to the provider names the negotiated keys', async () => {
  // Not just the prose. `asset: {enum: [...]}` is what actually constrains the
  // structured output, and it is built from the same negotiated model.
  const old = await assessAs({});
  const fresh = await assessAs({ 'x-hps-capability-model': 'candidate-capability-v1' });

  assert.ok(old.sentSchema.includes('TASTE'), '옛 좌석 스키마에 7자산 키가 없다');
  assert.ok(!old.sentSchema.includes('FRAMING'), '옛 좌석 스키마에 새 키가 섞였다');
  assert.ok(fresh.sentSchema.includes('FRAMING'), '새 좌석 스키마에 6역량 키가 없다');
  assert.ok(!fresh.sentSchema.includes('TASTE'), '새 좌석 스키마에 옛 키가 섞였다');
});
