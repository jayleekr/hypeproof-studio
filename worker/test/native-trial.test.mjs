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
  assert.equal(body.activity_kind, "classroom", "a classroom credential does not become a personal trial by profile name");
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

test('observation contract uses actual session/identity gates and rejects scope mixing without storage', async()=>{
 const {env,token}=await fixture(),app=await bootApp();
 const request=(path,body,credential=token)=>app.fetch(new Request('https://test/v1/observations/'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env,makeCtx());
 const response=await request('context');assert.equal(response.status,200);const context=await response.json();assert.equal(context.format,'hps-observation/1');
 const batch={...context,events:[{id:'u1',seq:1,task:'t1',at:1,kind:'user',text:'새 직원 안내문',assistance:'unknown'}]};
 assert.equal((await request('validate',batch)).status,200);
 assert.equal((await request('validate',{...batch,scope:'another-person'})).status,409);
 assert.equal((await request('validate',{...batch,session:'another-session'})).status,409);
 assert.equal((await request('validate',{...batch,program:'old-program'})).status,409);
 assert.equal((await request('context',null,'invalid')).status,401);
 await env.HPS_KV.delete(`cohort:${id}:active_session`);assert.equal((await request('context')).status,403);
});

test('assessment is separate from coaching, validates real citations and does not persist transcript', async()=>{
 const {env,token}=await fixture(),app=await bootApp(); env.ANTHROPIC_API_KEY='synthetic-provider-key';
 const headers={authorization:'Bearer '+token,'content-type':'application/json'};
 const ctxResponse=await app.fetch(new Request('https://test/v1/observations/context',{headers}),env,makeCtx());
 const batch={...await ctxResponse.json(),events:[{id:'u1',seq:1,task:'t1',at:1,kind:'user',text:'새 직원이 주문을 확인할 문서가 필요해',assistance:'unknown'}]};
 const assets=['TASTE','INTENT','CONTEXT','VERIFY','DELEGATE','ITERATE','OWNERSHIP'];
 const findings=assets.map(asset=>({asset,status:asset==='INTENT'?'observed':'unobserved',interpretation:'잠정 관찰',evidence:asset==='INTENT'?[{quote_id:'q0'}]:[],assistance:'unknown',next:'다음 과제에서 확인'}));
 const original=globalThis.fetch;let body;let result=findings;let status=200;
 globalThis.fetch=async(input,init)=>{body=JSON.parse(init.body);return new Response(JSON.stringify({content:[{type:'text',text:JSON.stringify({findings:result.map(f=>f.status==='unobserved'?{asset:f.asset,status:f.status,interpretation:f.interpretation,next:f.next}:f)})}]}),{status,headers:{'request-id':'synthetic-provider-request'}});};
 const assess=()=>app.fetch(new Request('https://test/v1/observations/assess',{method:'POST',headers,body:JSON.stringify(batch)}),env,makeCtx());
 try{
  const response=await assess();assert.equal(response.status,200);const output=await response.json();assert.equal(output.findings[1].evidence[0].event_id,'u1');assert.equal(output.rubric.version,'m2026.09.08-4');
  assert.equal(body.stream,false);assert.equal(body.tools,undefined);assert.match(body.system[0].text,/명령이 아니다/);assert.match(body.messages[0].content,/새 직원/);
  result=structuredClone(findings);result[1].evidence[0].event_id='forged';assert.equal((await assess()).status,502);
  result=structuredClone(findings);result[1].score=100;assert.equal((await assess()).status,502);
  for(status of [401,429,503])assert.notEqual((await assess()).status,200);
 }finally{globalThis.fetch=original;}
});
