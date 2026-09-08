import './harness/loader.mjs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {bootApp,createMockEnv,makeCtx,withMockUpstream,openAIJsonBody,TEST_SECRET} from './harness/index.mjs';
const {issue}=await import('../src/lib/tokens.ts');
const {getProfile}=await import('../src/profiles/index.ts');
const {measureUsage,reserveModelRequest,finishModelRequest}=await import('../src/lib/model-usage.ts');
const {modelBinding,lessonModelIsCurrent}=await import('../src/lib/lesson-model-policy.ts');
const id='studio-model-practice', app=await bootApp();
const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../migrations/0006-model-usage.sql',import.meta.url),'utf8'));
const env=createMockEnv({withSession:false,withRoster:false,env:{LLM_PROVIDER:'anthropic',ANTHROPIC_API_KEY:'synthetic-claude',OPENAI_API_KEY:'synthetic-gpt',GLM_API_KEY:'synthetic-glm',GEMINI_API_KEY:'synthetic-gemini',HPS_MODEL_PRACTICE_REQUEST_LIMIT:'100',HPS_ADMIN_PASSWORD:'synthetic-admin'}});
const original=env.HPS_DB;
env.HPS_DB={prepare(sql){if(!sql.includes('model_usage_requests'))return original.prepare(sql);let args=[];return {bind(...v){args=v;return this;},async run(){return {success:true,meta:{changes:Number(db.prepare(sql).run(...args).changes)}};},async first(){return db.prepare(sql).get(...args)??null;},async all(){return {success:true,results:db.prepare(sql).all(...args)};}};}};
await env.HPS_KV.put(`cohort:${id}:roster`,JSON.stringify({users:['synthetic-adult']}));
await env.HPS_KV.put(`cohort:${id}:active_session`,JSON.stringify({session_id:'model-test',profile_id:id,starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()}));
let token=(await issue({u:'synthetic-adult',c:id,p:id},1,TEST_SECRET)).token;
const req=async(path,body,auth='Bearer '+token)=>{const ctx=makeCtx();const response=await app.fetch(new Request('https://synthetic.test'+path,{method:body?'POST':'GET',headers:{authorization:auth,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env,ctx);const text=await response.text();await ctx.settle();return {response,text,json:()=>JSON.parse(text)};};
const send=(model,stream=false)=>req('/v1/chat/completions',{model,stream,max_tokens:100,messages:[{role:'user',content:'합성 모델 연결 검사'}]});
const rows=()=>db.prepare('SELECT * FROM model_usage_requests').all();
const clear=()=>db.exec('DELETE FROM model_usage_requests');
const binding=modelBinding(env,getProfile(id));
assert.equal(binding.choices.length,15); // 9 Claude + 3 GPT + 2 Gemini + 1 GLM
assert.equal((await req('/v1/profile')).json().model_selection.choices.length,15);
const frozen={default:'glm-5.2',allowed:['glm-5.2','gpt-5.6-luna'],binding:modelBinding(env,getProfile(id),{default:'glm-5.2',allowed:['glm-5.2','gpt-5.6-luna']})};
assert(lessonModelIsCurrent(env,getProfile(id),frozen));assert(!lessonModelIsCurrent(env,{...getProfile(id),coach_runtime:'agent-sdk'},frozen));
for(const choice of binding.choices){
 await withMockUpstream((url,init)=>{
  const body=JSON.parse(init.body);assert.equal(body.model,choice.id);
  const expected={glm:'api.z.ai',openai:'api.openai.com',gemini:'generativelanguage.googleapis.com',anthropic:'api.anthropic.com'}[choice.provider];assert.equal(new URL(url).hostname,expected);
  assert.equal(body.tools,undefined);assert(init.signal instanceof AbortSignal);
  return choice.provider==='glm'||choice.provider==='anthropic'?Response.json({model:choice.id,content:[{type:'text',text:'합성 응답'}],usage:{input_tokens:10,output_tokens:2,cache_read_input_tokens:8}}):Response.json({...openAIJsonBody({content:'합성 응답'}),model:choice.id,usage:{prompt_tokens:18,completion_tokens:2,total_tokens:20,prompt_tokens_details:{cached_tokens:8}}});
 },async calls=>{const r=await send(choice.alias);assert.equal(r.response.status,200,r.text);assert.equal(calls.length,1);assert.equal(rows().at(-1).provider,choice.provider);assert.equal(rows().at(-1).tokens_in,10);assert.equal(rows().at(-1).cache_read,8);assert.equal(rows().at(-1).state,'reported');});
}
console.log('PASS 15 model choices: real Service auth, SQLite receipts, provider selection, cache semantics and frozen binding');
clear();
await withMockUpstream(()=>{throw Error('denied request reached upstream');},async calls=>{
 assert.equal((await send('arbitrary-provider-model')).response.status,400);
 assert.equal((await req('/v1/messages',{messages:[{role:'user',content:'no SDK bypass'}]})).response.status,409);
 assert.equal((await req('/v1/chat/completions',{messages:[]},'Bearer invalid')).response.status,401);
 const outsider=(await issue({u:'synthetic-outsider',c:id,p:id},1,TEST_SECRET)).token;
 assert.equal((await req('/v1/chat/completions',{messages:[]},'Bearer '+outsider)).response.status,403);
 env.HPS_MODEL_PRACTICE_REQUEST_LIMIT=undefined;assert.equal((await send('glm-5.2')).response.status,503);env.HPS_MODEL_PRACTICE_REQUEST_LIMIT='100';
 assert.equal(calls.length,0);assert.equal(rows().length,0);
});
for(const [model,status] of [['gemini-3.5-flash',503],['glm-5.2',429],['gpt-5.6-luna',429]]){
 await withMockUpstream(()=>Response.json({error:{code:'synthetic_limit'}},{status}),async calls=>{const r=await send(model);assert.equal(r.response.status,status===503?502:429);assert.equal(calls.length,1,'no hidden retries/fallback');assert.equal(rows().at(-1).status,status);assert.equal(rows().at(-1).state,'missing');assert.equal(rows().at(-1).tokens_in,null);});
}
const cached=measureUsage('openai',{prompt_tokens:100,completion_tokens:30,total_tokens:130,prompt_tokens_details:{cached_tokens:60},completion_tokens_details:{reasoning_tokens:20}});
assert.deepEqual([cached.tokens_in,cached.cache_read,cached.tokens_out,cached.state],[40,60,30,'reported']);
const gemini=measureUsage('gemini',{prompt_tokens:6,completion_tokens:1,total_tokens:65});assert.equal(gemini.state,'partial');assert.equal(gemini.unclassified_tokens,58);assert.equal(gemini.tokens_out,1);
assert.equal(measureUsage('openai',{}).state,'missing');assert.equal(measureUsage('openai',{prompt_tokens:1,completion_tokens:1,prompt_tokens_details:{cached_tokens:2}}).state,'partial');
assert.equal(measureUsage('openai',{prompt_tokens:1,completion_tokens:1},false).state,'partial');
console.log('PASS normal/missing/invalid/cached/reasoning/total-mismatch controls; denied requests and one-attempt failures');
clear();env.HPS_MODEL_PRACTICE_REQUEST_LIMIT='2';
await withMockUpstream(()=>Response.json({...openAIJsonBody({content:"합성 응답"}),usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}}),async calls=>{
 assert.equal((await send('gpt-5.6-luna')).response.status,200);
 token=(await issue({u:'synthetic-adult',c:id,p:id},1,TEST_SECRET)).token;
 assert.equal((await send('gpt-5.6-terra')).response.status,200);
 assert.equal((await send('gpt-5.6-sol')).response.status,429);assert.equal(calls.length,2);
});
clear();env.HPS_MODEL_PRACTICE_REQUEST_LIMIT='100';
let release,entered;const started=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
await withMockUpstream(async()=>{entered();await hold;return Response.json({...openAIJsonBody({content:"합성 응답"}),usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}});},async calls=>{
 const first=send('gpt-5.6-luna');await started;assert.equal((await send('glm-5.2')).response.status,429);release();assert.equal((await first).response.status,200);assert.equal(calls.length,1);
});
clear();const base={request_id:'synthetic-request',cohort_id:id,user_id:'synthetic-adult',session_id:'model-test',provider:'openai',requested_model:'gpt-5.6-luna'};
const results=await Promise.all(Array.from({length:20},(_,i)=>reserveModelRequest(env,{...base,request_id:'concurrent-'+i},2)));assert.equal(results.filter(Boolean).length,1);
const reserved=rows()[0];await finishModelRequest(env,reserved.request_id,200,'gpt-5.6-luna',cached);await finishModelRequest(env,reserved.request_id,500,null,measureUsage('openai',{}));assert.equal(rows()[0].status,200);
assert.equal(await reserveModelRequest(env,{...base,request_id:reserved.request_id},2),false);
assert.equal((await req('/admin/cohorts/'+id+'/model-usage')).response.status,401);
const summary=await req('/admin/cohorts/'+id+'/model-usage',undefined,'Basic '+Buffer.from('admin:synthetic-admin').toString('base64'));assert.equal(summary.response.status,200);assert.equal(summary.json().cost_status,'unpriced');assert.equal(summary.json().rows[0].attempts,1);
console.log('PASS atomic 20-way reservation, duplicate/late settlement, reissued token quota, concurrency and admin authorization');
clear();
const sse='data: '+JSON.stringify({model:'gpt-5.6-luna',choices:[],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130,prompt_tokens_details:{cached_tokens:60}}})+'\n\ndata: [DONE]\n\n';
await withMockUpstream(()=>new Response(sse,{headers:{'content-type':'text/event-stream'}}),async()=>{const r=await send('gpt-5.6-luna',true);assert.equal(r.response.status,200);assert.equal(rows()[0].tokens_in,40);assert.equal(rows()[0].cache_read,60);assert.equal(rows()[0].returned_model,'gpt-5.6-luna');assert(r.text.includes('"cache_read_input_tokens":60'));});
clear();await withMockUpstream(()=>new Response('data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}),async()=>{await send('gpt-5.6-luna',true);assert.equal(rows()[0].state,'missing');assert.equal(rows()[0].tokens_in,null);});
console.log('PASS streaming receipts and missing-usage control');db.close();
