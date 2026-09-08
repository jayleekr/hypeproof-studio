import './harness/loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET } from './harness/index.mjs';
const { issue } = await import('../src/lib/tokens.ts');
const { gateChatRequest } = await import('../src/lib/chat-gate.ts');
const { getProfile } = await import('../src/profiles/index.ts');

const id = 'studio-native-trial';
const gate = new Hono();
gate.post('/check', async c => {
  const result = await gateChatRequest(c);
  return result.ok ? c.json({ profile: result.profile.id }) : result.response;
});
async function fixture() {
  const env = createMockEnv({ withSession: false, withRoster: false });
  await env.HPS_KV.put(`cohort:${id}:active_session`, JSON.stringify({
    session_id: 'synthetic-trial', profile_id: id,
    starts_at: new Date(Date.now() - 60000).toISOString(),
    ends_at: new Date(Date.now() + 3600000).toISOString(),
  }));
  await env.HPS_KV.put(`cohort:${id}:roster`, JSON.stringify({ users: ['synthetic-adult'], updated_at: new Date().toISOString() }));
  const { token } = await issue({ u: 'synthetic-adult', c: id, p: id }, 1, TEST_SECRET);
  return { env, token };
}
function check(env, token) {
  return gate.fetch(new Request('https://test/check', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} }), env, makeCtx());
}

test('native trial resolves through the existing app profile API with real tool capability declarations', async () => {
  const { env, token } = await fixture();
  const app = await bootApp();
  const response = await app.fetch(new Request('https://test/v1/profile', { headers: { authorization: `Bearer ${token}` } }), env, makeCtx());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.profile_id, id);
  assert.equal(body.coach_runtime, 'agent-sdk');
  assert.equal(body.sdk_tools.write, true);
  assert.equal(body.sdk_tools.read, true);
  assert.equal(body.sdk_tools.browser, true);
  assert.equal(body.analytics.upload_session_logs, false);
  assert.equal(body.assets_focus.length, 7);
  assert.equal(body.workspace_root, '~/HypeProofTrial');
  // A returned capability is not proof that an Electron tool actually ran.
});

test('registered participant can pass the same gate used by both model API routes', async () => {
  const { env, token } = await fixture();
  assert.equal((await check(env, token)).status, 200);
});
test('no active session remains blocked: the new profile is not a public auth bypass', async () => {
  const { env, token } = await fixture();
  await env.HPS_KV.delete(`cohort:${id}:active_session`);
  assert.equal((await check(env, token)).status, 403);
});
test('a signed but unregistered participant remains blocked', async () => {
  const { env } = await fixture();
  const { token } = await issue({ u: 'outsider', c: id, p: id }, 1, TEST_SECRET);
  assert.equal((await check(env, token)).status, 403);
});
test('another cohort token cannot select the trial profile', async () => {
  const { env } = await fixture();
  const { token } = await issue({ u: 'synthetic-adult', c: 'other', p: id }, 1, TEST_SECRET);
  assert.equal((await check(env, token)).status, 401);
});
test('unsigned access is rejected', async () => {
  const { env } = await fixture();
  assert.equal((await check(env)).status, 401);
});
test('trial configuration is isolated from existing practice program', () => {
  const trial = getProfile(id), practice = getProfile('homepage-practice-s1');
  assert.notEqual(trial.session.cohort_id, practice.session.cohort_id);
  assert.notEqual(trial.sandbox.workspace_root, practice.sandbox.workspace_root);
  assert.equal(trial.dashboard_hidden, true);
  assert.equal(trial.analytics.log_user_messages, false);
  assert.notEqual(trial.ux, practice.ux);
});
