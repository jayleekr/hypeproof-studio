import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {localAuthoring} from './harness/dental-authoring.mjs';
import {withMockUpstream, makeCtx, bootApp} from './harness/index.mjs';
const {getProfile}=await import('../src/profiles/index.ts');
const {setRoster,startSession}=await import('../src/lib/kv.ts');
const {ANTHROPIC_MODELS}=await import('../src/profiles/types.ts');
const {validateEffortPolicy,applyRequestEffort}=await import('../src/lib/model-effort.ts');
const {modelBinding}=await import('../src/lib/lesson-model-policy.ts');
const {verify,issue}=await import('../src/lib/tokens.ts');
const local=await localAuthoring({profileId:'homepage-practice-s1'}),app=await bootApp();
local.env.LLM_PROVIDER='anthropic';local.env.ANTHROPIC_API_KEY='synthetic-key';
local.db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
// Additive migration is safe both on the baseline snapshot and on repeated deploys.
for(let i=0;i<2;i++)local.db.exec(readFileSync(new URL('../migrations/0005-request-settings.sql',import.meta.url),'utf8'));
local.db.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(local.cohort,'Synthetic effort');
local.db.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)').run('effort',local.cohort,local.profileId,new Date(Date.now()-1000).toISOString(),new Date(Date.now()+3600000).toISOString());
const profile=getProfile(local.profileId),originalModel=profile.model,originalRuntime=profile.coach_runtime;
const base='/admin/cohorts/'+local.cohort+'/authoring/';
const content={schema:'hps-session-design/1',title:'가상 꽃집',audience:'합성 사용자',duration_minutes:60,objective:'영업시간 확인',prerequisites:'',starter:'연습',steps:[{id:'one',title:'확인',instructions:'영업시간 비교',hint:'',acceptance:'수정 이유'}]};
const call=async(path,method='GET',body,token=local.token,headers={})=>{
  const ctx=makeCtx();const response=await app.fetch(new Request(local.origin+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})}),local.env,ctx);
  const json=await response.json();await ctx.settle();return {status:response.status,json};
};
const save=model=>({profile_id:local.profileId,request_id:crypto.randomUUID(),expected_revision:0,content:{...content,model}});
try {
  await setRoster(local.env.HPS_KV,local.cohort,['student','other']);
  await startSession(local.env.HPS_KV,local.cohort,{session_id:'effort',profile_id:local.profileId,starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()});
  for(const bad of [null,{}, {default:'max',allowed:['max']},{default:'low',allowed:[]},{default:'high',allowed:['low']},{default:'low',allowed:['low','low']},{default:'low',allowed:['low'],ceiling:'high'}])assert.ok(validateEffortPolicy(bad));
  const legacy=modelBinding(local.env,profile);assert.equal('effort' in legacy,false);
  const raw={output_config:{effort:'high'}};
  assert.equal(applyRequestEffort(raw,profile,'claude-sonnet-4-6').body,raw,'non-opted-in profile remains unchanged');
  assert.throws(()=>applyRequestEffort(raw,profile,'claude-sonnet-4-6','low'));
  profile.model={...originalModel,provider:'anthropic',allowed:['hypeproof-default','hypeproof-fast',...Object.keys(ANTHROPIC_MODELS)],effort:{default:'medium',allowed:['low','medium','high']}};
  for(const runtime of ['proxy','agent-sdk']) {
    profile.coach_runtime=runtime;
    const catalog=await call(base+'catalog/models/'+local.profileId);
    assert.equal(catalog.status,200);
    assert.equal(catalog.json.choices.find(c=>c.id==='claude-haiku-4-5').effort,undefined);
    assert.equal(catalog.json.choices.find(c=>c.id==='claude-sonnet-4-5-20250929').effort,undefined);
    assert.deepEqual(catalog.json.choices.find(c=>c.id==='claude-opus-5').effort.allowed,['low','medium','high']);
    const allowed=catalog.json.choices.map(c=>c.alias);
    const policy={default:'hypeproof-default',allowed,effort:{default:'low',allowed:['low','medium']}};
    const path=base+runtime;
    assert.equal((await call(path,'PUT',save(policy))).status,200);
    const frozen=await call(path+'/versions/m2026.09.08-1','PUT',{expected_revision:1});assert.equal(frozen.status,200);
    assert.equal(frozen.json.module.content.model.binding.effort.revision,'hps-effort/1');
    const delivery=await call(path+'/versions/m2026.09.08-1/participants','POST',{user:'student',hours:1});assert.equal(delivery.status,200);
    const token=delivery.json.token,endpoint=runtime==='proxy'?'/v1/chat/completions':'/v1/messages';
    const view=await call('/v1/profile','GET',undefined,token);
    assert.deepEqual(view.json.model_selection.choices[0].effort,policy.effort);
    const request={model:'hypeproof-default',max_tokens:32,messages:[{role:'user',content:'hello',output_config:{effort:'max'}}],output_config:{effort:'max',format:{type:'json_schema',schema:{type:'object'}}},stream:false};
    for(const choice of catalog.json.choices)for(const requested of [undefined,'low','medium']) {
      const turn=crypto.randomUUID();
      const supported=!!choice.effort,expected=supported?(requested??'low'):null;
      await withMockUpstream((_url,init)=>{
        const sent=JSON.parse(init.body);
        assert.equal(sent.model,choice.id);
        assert.equal(sent.output_config?.effort??null,expected);
        assert.ok(sent.messages.every(m=>m.output_config===undefined));
        if(runtime==='agent-sdk')assert.equal(sent.output_config.format.type,'json_schema');
        return Response.json({id:crypto.randomUUID(),type:'message',role:'assistant',model:sent.model,content:[{type:'text',text:'확인'}],stop_reason:'end_turn',usage:{input_tokens:3,output_tokens:2}});
      },async calls=>{
        const result=await call(endpoint,'POST',{...request,model:choice.alias},token,{'x-hps-turn-id':turn,...(requested?{'x-hps-effort':requested}:{})});
        assert.equal(result.status,200,JSON.stringify(result.json));assert.equal(calls.length,1);
      });
      const result=await call('/v1/request-settings/'+turn,'GET',undefined,token);
      assert.equal(result.status,200);assert.equal(result.json.requests.length,1);
      assert.equal(result.json.requests[0].applied,expected);assert.equal(result.json.requests[0].model,choice.id);
      assert.equal(result.json.requests[0].reason,!supported?'unsupported_model':requested?'selected':'course_default');
      const payload=await verify(token,local.env.HPS_SIGNING_SECRET);
      const other=(await issue({u:'other',c:payload.c,p:payload.p,lesson:payload.lesson},1,local.env.HPS_SIGNING_SECRET)).token;
      assert.deepEqual((await call('/v1/request-settings/'+turn,'GET',undefined,other)).json.requests,[]);
      assert.equal((await call('/v1/request-settings/'+turn,'GET',undefined,local.token)).status,401);
    }
    for(const invalid of ['high','max','xhigh','garbage']) await withMockUpstream(()=>{throw Error('forbidden request reached provider');},async calls=>{
      const result=await call(endpoint,'POST',request,token,{'x-hps-effort':invalid});assert.equal(result.status,403);assert.equal(calls.length,0);
    });
    const originalEffort=profile.model.effort;
    profile.model.effort={default:'low',allowed:['low']};
    assert.equal((await call('/v1/profile','GET',undefined,token)).status,409,'cohort shrink invalidates wider frozen effort');
    profile.model.effort=originalEffort;
  }
  console.log('PASS effort: 9 models × 2 runtimes × default/low/medium; immutable subset, gateway payload, receipts, cross-user auth, old-client and migration controls');
} finally {profile.model=originalModel;profile.coach_runtime=originalRuntime;local.close();}
