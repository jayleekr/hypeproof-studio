import './harness/loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {bootApp,createMockEnv,makeCtx,TEST_SECRET} from './harness/index.mjs';
const {activityIdentity}=await import('../src/lib/activity-identity.ts');
const {issue}=await import('../src/lib/tokens.ts');
test('activity identity survives reissue but separates principals, cohorts, profiles and pinned lessons',async()=>{
 const base={u:'synthetic-a',c:'cohort-a',p:'studio-native-trial',account:'synthetic-account'};
 const identity=await activityIdentity(base);
 assert.match(identity,/^[a-f0-9]{64}$/);
 assert.equal(await activityIdentity({...base,iat:1,exp:2,jti:'new'}),identity);
 for(const change of [{u:'synthetic-b'},{c:'cohort-b'},{p:'other'},{account:'other'},{native_trial:true},{lesson:{course_id:'lesson',version:1,sha256:'a'.repeat(64)}}])
  assert.notEqual(await activityIdentity({...base,...change}),identity);
 const lesson={course_id:'lesson',version:1,sha256:'a'.repeat(64)};
 assert.notEqual(await activityIdentity({...base,lesson}),await activityIdentity({...base,lesson:{...lesson,version:2}}));
});
test('activity preflight uses the live execution gate, no model request, and distinguishes 401/403',async()=>{
 const env=createMockEnv({withSession:false,withRoster:false}),id='studio-native-trial';
 await env.HPS_KV.put(`cohort:${id}:active_session`,JSON.stringify({session_id:'synthetic-session',profile_id:id,starts_at:new Date(Date.now()-60000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()}));
 await env.HPS_KV.put(`cohort:${id}:roster`,JSON.stringify({users:['synthetic-a'],updated_at:new Date().toISOString()}));
 const {token}=await issue({u:'synthetic-a',c:id,p:id},1,TEST_SECRET),app=await bootApp();
 const request=(route,credential=token)=>app.fetch(new Request('https://test/v1/'+route,{headers:{authorization:'Bearer '+credential}}),env,makeCtx());
 const p=await request('profile'),live=await request('activity');
 assert.equal(live.status,200);assert.equal(live.headers.get('cache-control'),'no-store');
 assert.equal((await p.json()).activity_id,(await live.json()).activity_id);
 assert.equal((await request('activity','invalid')).status,401);
 const outsider=await issue({u:'synthetic-b',c:id,p:id},1,TEST_SECRET);
 assert.equal((await request('activity',outsider.token)).status,403);
 await env.HPS_KV.delete(`cohort:${id}:active_session`);
 assert.equal((await request('activity')).status,403);
});
