import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { localAuthoring } from './harness/dental-authoring.mjs';
import { withMockUpstream } from './harness/index.mjs';
const { MODEL_MAP } = await import('../src/profiles/types.ts');
const { getProfile } = await import('../src/profiles/index.ts');
const { modelBinding, lessonModelIsCurrent, applyLessonModel } = await import('../src/lib/lesson-model-policy.ts');
const { resolveMessagesModel } = await import('../src/routes/messages.ts');
const { setRoster, startSession } = await import('../src/lib/kv.ts');
const local = await localAuthoring({profileId:'homepage-practice-s1'});
local.env.LLM_PROVIDER='anthropic';local.env.ANTHROPIC_API_KEY='synthetic-provider-key';
local.db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
local.db.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(local.cohort,'Synthetic model selection');
local.db.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)').run('models',local.cohort,local.profileId,new Date(Date.now()-1000).toISOString(),new Date(Date.now()+3600000).toISOString());
const profile=getProfile(local.profileId);
const originalRuntime=profile.coach_runtime;
const content={schema:'hps-session-design/1',title:'가상 꽃집',audience:'합성 사용자',duration_minutes:60,objective:'영업시간 검토',prerequisites:'',starter:'연습 폴더',steps:[{id:'one',title:'확인',instructions:'영업시간 확인',hint:'',acceptance:'수정 이유 설명'}]};
const base='/admin/cohorts/'+local.cohort+'/authoring/';
const request=async(path,method='GET',body,token=local.token)=>{
  const r=await local.fetcher(local.origin+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:r.status,json:await r.json(),headers:r.headers};
};
const save=(model,revision=0)=>({profile_id:local.profileId,request_id:crypto.randomUUID(),expected_revision:revision,content:{...content,model}});
try {
  await setRoster(local.env.HPS_KV,local.cohort,['student']);
  await startSession(local.env.HPS_KV,local.cohort,{session_id:'models',profile_id:local.profileId,starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()});
  const cat=await request(base+'catalog/models/'+local.profileId);assert.equal(cat.status,200);assert.equal(cat.json.choices.length,2);
  assert.equal((await request(base+'catalog/models/missing')).status,403);
  for(const model of [
    {default:'hypeproof-strong',allowed:['hypeproof-strong']},
    {default:'hypeproof-default',allowed:['hypeproof-default','hypeproof-strong']},
  ])assert.equal((await request(base+'invalid','PUT',save(model))).status,403);
  for(const model of [
    {default:'claude-sonnet-4-6',allowed:['claude-sonnet-4-6']},
    {default:'hypeproof-default',allowed:['hypeproof-fast']},
    {default:'hypeproof-default',allowed:['hypeproof-default'],binding:{}},
    {default:'hypeproof-default',allowed:['hypeproof-default','hypeproof-default']},
  ])assert.equal((await request(base+'invalid','PUT',save(model))).status,400);
  for(const runtime of ['proxy','agent-sdk']) {
    profile.coach_runtime=runtime; // isolated fixture only; never changes the compiled file
    for(const mode of ['fixed','choice']) {
      const path=base+runtime+'-'+mode,policy={default:'hypeproof-default',allowed:mode==='fixed'?['hypeproof-default']:['hypeproof-default','hypeproof-fast']};
      assert.equal((await request(path,'PUT',save(policy))).status,200);
      const frozen=await request(path+'/versions/m2026.09.08-1','PUT',{expected_revision:1});assert.equal(frozen.status,200);
      const frozenPolicy=frozen.json.module.content.model;
      assert.deepEqual(frozenPolicy.binding,modelBinding(local.env,profile,policy));
      const delivered=await request(path+'/versions/m2026.09.08-1/participants','POST',{user:'student',hours:1});assert.equal(delivered.status,200);
      const token=delivered.json.token;
      assert.equal((await request(path,'PUT',save(policy,1),token)).status,403);
      assert.equal((await request(path+'/models/'+local.profileId,'GET',undefined,token)).status,403);
      const view=await request('/v1/profile','GET',undefined,token);assert.equal(view.status,200);
      assert.equal(view.json.model_selection.source,'lesson');assert.equal(view.json.model_selection.choices.length,mode==='fixed'?1:2);
      const endpoint=runtime==='proxy'?'/v1/chat/completions':'/v1/messages';
      const narrowed=applyLessonModel(profile,frozenPolicy);
      assert.equal(resolveMessagesModel('claude-any-haiku-example',narrowed),'claude-sonnet-4-6');
      for(const requested of ['hypeproof-default','hypeproof-fast','hypeproof-strong']) {
        const expected=requested==='hypeproof-fast'&&mode==='choice'?'claude-haiku-4-5':'claude-sonnet-4-6';
        await withMockUpstream((_url,init)=>{
          const sent=JSON.parse(init.body);assert.equal(sent.model,expected);
          if(runtime==='agent-sdk')assert.deepEqual(sent.thinking,expected==='claude-haiku-4-5'?undefined:{type:'adaptive'});
          return Response.json({id:'synthetic-message',type:'message',role:'assistant',model:sent.model,content:[{type:'text',text:'확인했습니다.'}],stop_reason:'end_turn',usage:{input_tokens:3,output_tokens:2}});
        },async calls=>{
          const response=await request(endpoint,'POST',{model:requested,...(runtime==='agent-sdk'?{thinking:{type:'adaptive'}}:{}),max_tokens:32,messages:[{role:'user',content:'영업시간을 확인해 주세요.'}],stream:false},token);
          assert.equal(response.status,200,JSON.stringify(response.json));assert.equal(response.headers.get('x-hps-model'),expected);assert.equal(calls.length,1);
        });
      }
      const wrong=await request(runtime==='proxy'?'/v1/messages':'/v1/chat/completions','POST',{messages:[{role:'user',content:'hello'}],max_tokens:32},token);
      assert.equal(wrong.status,409);
      assert.equal((await request(path,'PUT',save({default:'hypeproof-fast',allowed:['hypeproof-fast']},1))).status,200);
      assert.equal((await request('/v1/profile','GET',undefined,token)).json.model_selection.default,'hypeproof-default');
      const altered=structuredClone(frozenPolicy);altered.binding.choices[0].id='another-model';assert.equal(lessonModelIsCurrent(local.env,profile,altered),false);
      const originalPin=MODEL_MAP['hypeproof-default'];
      try {MODEL_MAP['hypeproof-default']='synthetic-pin-drift';assert.equal((await request('/v1/profile','GET',undefined,token)).status,409);}
      finally {MODEL_MAP['hypeproof-default']=originalPin;}
      if(runtime==='proxy'){
        const provider=profile.model.provider;
        try {profile.model.provider='gemini';assert.equal((await request('/v1/profile','GET',undefined,token)).status,409);}
        finally {profile.model.provider=provider;}
      }
      profile.coach_runtime=runtime==='proxy'?'agent-sdk':'proxy';
      assert.equal((await request('/v1/profile','GET',undefined,token)).status,409);
      profile.coach_runtime=runtime;
      assert.equal((await request('/v1/profile','GET',undefined,token)).status,200);
    }
  }
  assert.equal(resolveMessagesModel('hypeproof-fast',{...profile,model:{default:'hypeproof-default'}}),'claude-haiku-4-5','legacy fast exception preserved');
  console.log('PASS lesson model policy: scoped authoring, frozen bindings, actual routes with mock upstream, fixed/choice, runtime drift, legacy control');
} finally {profile.coach_runtime=originalRuntime;local.close();}
