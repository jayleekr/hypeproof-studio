import './harness/loader.mjs';
import assert from 'node:assert/strict';
import {bootApp,createMockEnv,makeCtx,TEST_SECRET} from './harness/index.mjs';
const {issue}=await import('../src/lib/tokens.ts');
const {getProfile}=await import('../src/profiles/index.ts');
const app=await bootApp();
for(const id of ['studio-native-trial','studio-gpt-practice','homepage-practice-s1']){
 const p=getProfile(id);assert(p,id);const token=(await issue({u:'synthetic-adult',c:p.session.cohort_id,p:id},1,TEST_SECRET)).token;
 const env=createMockEnv();await env.HPS_KV.put(`cohort:${p.session.cohort_id}:roster`,JSON.stringify({users:['synthetic-adult']}));await env.HPS_KV.put(`cohort:${p.session.cohort_id}:active_session`,JSON.stringify({session_id:'entry-test',profile_id:id,starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()}));
 const res=await app.fetch(new Request('https://synthetic.test/v1/profile',{headers:{authorization:'Bearer '+token}}),env,makeCtx());assert.equal(res.status,200);const body=await res.json();
 assert.equal(body.workspace_start,id.startsWith('studio-')?'empty':undefined);
}
console.log('PASS actual /v1/profile: empty trial policy, inherited GPT and legacy web cohort');
