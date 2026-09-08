import './harness/loader.mjs';
import assert from 'node:assert/strict';
import {bootApp,createMockEnv,makeCtx,withMockUpstream,openAIJsonBody,TEST_SECRET} from './harness/index.mjs';
const {issue}=await import('../src/lib/tokens.ts');
const {getProfile}=await import('../src/profiles/index.ts');
const {modelIdFor}=await import('../src/profiles/types.ts');
const {modelBinding,validateLessonModel,validateModelSubset,lessonModelIsCurrent}=await import('../src/lib/lesson-model-policy.ts');
const {openAIWireRequest}=await import('../src/lib/openai.ts');
const id='studio-gpt-practice',profile=getProfile(id),app=await bootApp();
const env=createMockEnv({withSession:false,withRoster:false,env:{LLM_PROVIDER:'anthropic',ANTHROPIC_API_KEY:'synthetic-anthropic',OPENAI_API_KEY:'synthetic-openai'}});
await env.HPS_KV.put(`cohort:${id}:roster`,JSON.stringify({users:['synthetic-adult']}));
await env.HPS_KV.put(`cohort:${id}:active_session`,JSON.stringify({session_id:'test',profile_id:id,starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+60000).toISOString()}));
const {token}=await issue({u:'synthetic-adult',c:id,p:id},1,TEST_SECRET);
const request=(path,body,auth=token)=>app.fetch(new Request('https://synthetic.test'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+auth,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env,makeCtx());
const view=await request('/v1/profile');assert.equal(view.status,200);
const delivered=await view.json();assert.equal(delivered.model_selection.provider,'openai');assert.equal(delivered.model_selection.runtime,'proxy');assert.equal(delivered.model_selection.choices.length,3);
assert.equal((await request('/v1/profile',undefined,'invalid')).status,401);
const outsider=await issue({u:'synthetic-outsider',c:id,p:id},1,TEST_SECRET);
assert.equal((await request('/v1/profile',undefined,outsider.token)).status,403);
for(const model of ['gpt-5.6-luna','gpt-5.6-terra','gpt-5.6-sol','gpt-unknown','claude-opus-5']){
 const expected=profile.model.allowed.includes(model)?model:'gpt-5.6-luna';
 await withMockUpstream((url,init)=>{
  assert.equal(url,'https://api.openai.com/v1/chat/completions');const sent=JSON.parse(init.body);
  assert.equal(sent.model,expected);assert.equal(sent.max_tokens,undefined);assert(sent.max_completion_tokens>0);assert(sent.max_completion_tokens<=16384);assert.equal(sent.temperature,undefined);assert.equal(sent.tools,undefined);
  return Response.json(openAIJsonBody({content:'합성 응답'}));
 },async calls=>{
  const response=await request('/v1/chat/completions',{model,max_tokens:90000,temperature:0.7,messages:[{role:'user',content:'표를 보여줘'}],stream:false});
  assert.equal(response.status,200,await response.text());assert.equal(response.headers.get('x-hps-model'),expected);assert.equal(calls.length,1);
 });
}
const policy={default:'gpt-5.6-luna',allowed:['gpt-5.6-luna','gpt-5.6-terra']};
assert.equal(validateLessonModel(policy),null);assert.equal(validateModelSubset(policy,profile),null);
const frozen={...policy,binding:modelBinding(env,profile,policy)};assert(lessonModelIsCurrent(env,profile,frozen));
assert.equal(lessonModelIsCurrent(env,{...profile,coach_runtime:'agent-sdk'},frozen),false);
assert(validateModelSubset(policy,getProfile('studio-native-trial')));
for(const provider of ['anthropic','gemini','glm'])assert.throws(()=>modelIdFor('gpt-5.6-luna',provider),/unavailable/);
assert.equal(modelIdFor('hypeproof-fast','openai'),'gpt-4o-mini');
assert.deepEqual(openAIWireRequest({model:'gpt-4o-mini',max_tokens:100,temperature:0.3,messages:[]}),{model:'gpt-4o-mini',max_tokens:100,temperature:0.3,messages:[]});
const native=await request('/v1/messages',{model:'gpt-5.6-luna',max_tokens:32,messages:[{role:'user',content:'안녕'}]});assert.equal(native.status,409);
console.log('PASS GPT profile: authenticated actual routes with mock upstream; selected model, clamp, frozen policy, cross-provider and legacy controls');
