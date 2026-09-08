// Real Service routing + signed issuer tokens + real SQLite executing production SQL.
// No provider, production data, or external network required.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET, withMockUpstream, openAIJsonBody, COHORT as KIDS_COHORT, PROFILE as KIDS_PROFILE, USER as KID } from './harness/index.mjs';
const { issueIssuer, issue } = await import('../src/lib/tokens.ts');
const { validateModuleDoc } = await import('../src/lib/modules.ts');
const app = await bootApp();
const cohort = 'boah-dental-2026-a';
const { listProfiles } = await import('../src/profiles/index.ts');
const profileId = listProfiles().find(p => p.session.cohort_id === cohort)?.id;
assert.ok(profileId);
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
const migration = readFileSync(new URL('../migrations/0002-chalk-authoring.sql',import.meta.url),'utf8');
db.exec(migration);
db.exec(migration); // additive migration is safe to retry
const env = createMockEnv();
let failDatabase = false;
let beforeWrite;
env.HPS_DB = { prepare(sql) {
  let bindings=[];
  const query = () => { if(failDatabase) throw new Error('injected database unavailable'); return db.prepare(sql); };
  const gate = async () => { if (/^(UPDATE|INSERT)/.test(sql) && beforeWrite) { const f=beforeWrite; beforeWrite=undefined; await f(); } };
  return {
    bind(...args){bindings=args;return this;},
    async first(){await gate();return query().get(...bindings) ?? null;},
    async run(){await gate();const r=query().run(...bindings);return {success:true,meta:{changes:Number(r.changes)}};},
    async all(){return {success:true,results:query().all(...bindings)};},
  };
}};
const token = async (issuer, scopes=[{cohort,profiles:[profileId]}]) => (await issueIssuer({issuer,scopes},48,TEST_SECRET)).token;
const alice = await token('author-a'), bob=await token('author-b');
const outsider=await token('outsider',[{cohort:'other',profiles:[profileId]}]);
const student=(await issue({u:'student',c:cohort,p:profileId},1,TEST_SECRET)).token;
const base=`/admin/cohorts/${cohort}/authoring/site-1`;
const content={schema:'hps-session-design/1',title:'진료시간 수정',audience:'치과의사',duration_minutes:120,objective:'진료시간을 수정하고 검수한다',prerequisites:'',starter:'정적 홈페이지 예제',steps:[{id:'edit',title:'시간 변경',instructions:'진료시간을 변경하세요',hint:'',acceptance:'모바일에서 확인'}]};
const save=(revision,id,data=content)=>({expected_revision:revision,request_id:id,profile_id:profileId,content:data});
async function request(path=base,method='GET',body,credential=alice) {
 const headers={authorization:`Bearer ${credential}`};
 if(body!==undefined)headers['content-type']='application/json';
 const res=await app.fetch(new Request('https://service.test'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),env,makeCtx());
 const raw=await res.text();let json;try{json=JSON.parse(raw);}catch{}
 return {status:res.status,json,raw,headers:res.headers};
}
let passed=0;
async function check(name,fn){await fn();passed++;console.log(`PASS ${name}`);}
await check('T-01 student and unrelated cohort denied before writes',async()=>{
 for(const credential of [student,outsider])assert.equal((await request(base,'PUT',save(0,'create'),credential)).status,403);
 assert.equal(db.prepare('SELECT count(*) n FROM authoring_drafts').get().n,0);
});
await check('T-01 no Bearer and malformed Bearer denied',async()=>{
 assert.equal((await request(base,'GET',undefined,'bad')).status,401);
 const r=await app.fetch(new Request('https://service.test'+base),env,makeCtx());assert.notEqual(r.status,200);
});
await check('T-02 create and reopen with ordered steps preserved',async()=>{
 const r=await request(base,'PUT',save(0,'create'));assert.equal(r.status,200,r.raw);assert.equal(r.json.revision,1);
 const read=await request();assert.deepEqual(read.json.content,content);assert.equal(read.headers.get('cache-control'),'no-store');
});
await check('T-10 exact response-loss retry does not add revision',async()=>{
 assert.equal((await request(base,'PUT',save(0,'create'))).json.revision,1);
 assert.equal((await request(base,'PUT',save(0,'create',{...content,title:'different'}))).status,409);
});
await check('T-01 same-cohort different instructor cannot read or overwrite',async()=>{
 assert.equal((await request(base,'GET',undefined,bob)).status,404);
 assert.equal((await request(base,'PUT',save(1,'steal'),bob)).status,404);
});
await check('T-01 profile outside issuer scope rejected',async()=>{
 assert.equal((await request(base,'PUT',{...save(1,'scope'),profile_id:'missing'})).status,403);
});
await check('T-04 draft can be incomplete; frozen version cannot',async()=>{
 assert.equal((await request(base,'PUT',save(1,'partial',{...content,steps:[]}))).status,200);
 assert.equal((await request(base+'/versions/m2026.09.06-1','PUT',{expected_revision:2})).status,400);
});
await check('T-11 stale revision conflicts without clobbering',async()=>{
 assert.equal((await request(base,'PUT',save(1,'stale'))).status,409);
 assert.equal((await request()).json.revision,2);
});
await check('T-11 concurrent writers have exactly one winner',async()=>{
 const rs=await Promise.all([request(base,'PUT',save(2,'a')),request(base,'PUT',save(2,'b',{...content,title:'other'}))]);
 assert.deepEqual(rs.map(r=>r.status).sort(),[200,409]);assert.equal((await request()).json.revision,3);
});
await check('T-10 concurrent identical retries share one revision',async()=>{
 const rs=await Promise.all([request(base,'PUT',save(3,'same')),request(base,'PUT',save(3,'same'))]);
 assert.deepEqual(rs.map(r=>r.status),[200,200]);assert.equal((await request()).json.revision,4);
});
let frozen;
await check('T-08 frozen document uses existing hps-module envelope; never activates',async()=>{
 const r=await request(base+'/versions/m2026.09.06-1','PUT',{expected_revision:4});assert.equal(r.status,200,r.raw);
 assert.equal(r.json.activated,false);assert.equal(r.json.rehearsal,'not_run');
 frozen=r.json.module;assert.equal((await validateModuleDoc(frozen,{kind:'session-design',profileId})).ok,true);
 assert.equal(env._kv.has(`module:session-design:${profileId}:pin`),false);
});
await check('T-08 later draft edit preserves frozen bytes; overwrite denied',async()=>{
 assert.equal((await request(base,'PUT',save(4,'later',{...content,title:'new'}))).status,200);
 assert.deepEqual((await request(base+'/versions/m2026.09.06-1')).json.module,frozen);
 assert.equal((await request(base+'/versions/m2026.09.06-1','PUT',{expected_revision:5})).status,409);
 assert.deepEqual((await request(base+'/versions/m2026.09.06-1','PUT',{expected_revision:4})).json.module,frozen);
});
await check('T-08/T-09 deliver immutable lesson only to registered students in a matching session',async()=>{
 const {setRoster,startSession,revokeToken}=await import('../src/lib/kv.ts');
 const delivery=base+'/versions/m2026.09.06-1/participants';
 const body={user:'student',hours:1};
 assert.equal((await request(delivery,'POST',body)).status,403);
 await setRoster(env.HPS_KV,cohort,['student']);
 await startSession(env.HPS_KV,cohort,{session_id:'synthetic-lesson',profile_id:profileId,starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()});
 assert.equal((await request(delivery,'POST',body,bob)).status,404);
 assert.equal((await request(delivery,'POST',body,student)).status,403);
 assert.equal((await request(delivery,'POST',{...body,user:'not-registered'})).status,403);
 assert.equal((await request(delivery,'POST',{...body,hours:25})).status,400);
 const r=await request(delivery,'POST',body);assert.equal(r.status,200,r.raw);
 const received=await request('/v1/profile','GET',undefined,r.json.token);assert.equal(received.status,200,received.raw);
 assert.deepEqual(received.json.lesson.content,frozen.content);assert.equal(received.json.lesson.version,frozen.version);
 assert.equal(received.json.lesson.content.title,content.title); // draft already changed to new
 const legacy=await request('/v1/profile','GET',undefined,student);assert.equal(legacy.status,200);assert.equal(legacy.json.lesson,undefined);
 assert.deepEqual(received.json.sdk_tools,legacy.json.sdk_tools);
 assert.equal(received.json.display_name,content.title);assert.match(received.json.welcome.greeting_md,/진료시간 수정/);
 const {verify}=await import('../src/lib/tokens.ts');const claim=await verify(r.json.token,TEST_SECRET);
 const bad=(await issue({u:'student',c:cohort,p:profileId,lesson:{...claim.lesson,sha256:'0'.repeat(64)}},1,TEST_SECRET)).token;
 assert.equal((await request('/v1/profile','GET',undefined,bad)).status,409);
 const {gateChatRequest}=await import('../src/lib/chat-gate.ts');
 const gate=credential=>gateChatRequest({env,req:{header:()=> 'Bearer '+credential},header(){},json:(body,status)=>Response.json(body,{status})});
 const goodGate=await gate(r.json.token);assert.equal(goodGate.ok,true);assert.ok(goodGate.profile.system_prompt.includes(JSON.stringify(frozen.content)));
 const plainGate=await gate(student);assert.equal(plainGate.ok,true);assert.deepEqual(goodGate.profile.sdk_tools,plainGate.profile.sdk_tools);
 const badGate=await gate(bad);assert.equal(badGate.ok,false);assert.equal(badGate.response.status,409);

 await revokeToken(env.HPS_KV,claim.jti,'synthetic revoke');
 assert.equal((await request('/v1/profile','GET',undefined,r.json.token)).status,401);
 assert.equal((await request(base+'/versions/m2099.01.01-1/participants','POST',body)).status,409);
});
// ─── #747 feature A — lesson-level fixed AI display name ─────────────────────
// Contract: hps-session-design/1 gains optional `assistant: { display_name }`.
// GET /v1/profile projects it onto ux.coach (naming_mode fixed + fallback_name),
// the model is told the name in the gate on both runtimes, and nothing else in
// the served profile changes. Old-schema lessons (no block) behave as before.
await check('AE-07 lesson assistant name: draft → frozen → student profile shows fixed name',async()=>{
 const {setRoster,startSession}=await import('../src/lib/kv.ts');
 const named={...content,assistant:{display_name:'제작 파트너'}};
 // Reset roster/session for this cohort (previous check revoked its token, session still open).
 await setRoster(env.HPS_KV,cohort,['student','student-b']);
 await startSession(env.HPS_KV,cohort,{session_id:'synthetic-lesson-a',profile_id:profileId,starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()});
 const a=`/admin/cohorts/${cohort}/authoring/site-named`;
 assert.equal((await request(a,'PUT',save(0,'named-create',named))).status,200);
 assert.deepEqual((await request(a)).json.content.assistant,{display_name:'제작 파트너'});
 const f=await request(a+'/versions/m2026.09.08-1','PUT',{expected_revision:1});assert.equal(f.status,200,f.raw);
 assert.equal(f.json.module.content.assistant.display_name,'제작 파트너');
 // Draft renamed AFTER freezing: the frozen version keeps its name.
 assert.equal((await request(a,'PUT',save(1,'named-edit',{...named,assistant:{display_name:'검토 도우미'}}))).status,200);
 const d=await request(a+'/versions/m2026.09.08-1/participants','POST',{user:'student',hours:1});assert.equal(d.status,200,d.raw);
 const p=await request('/v1/profile','GET',undefined,d.json.token);assert.equal(p.status,200,p.raw);
 assert.equal(p.json.ux.coach.naming_mode,'fixed');
 assert.equal(p.json.ux.coach.fallback_name,'제작 파트너');
 assert.equal(p.json.lesson.content.assistant.display_name,'제작 파트너');
 // Only the coach identity is projected; every other ux and policy field is the compiled profile's.
 const {getProfile}=await import('../src/profiles/index.ts');const compiled=getProfile(profileId);
 assert.deepEqual({...p.json.ux.coach,naming_mode:compiled.ux.coach.naming_mode,fallback_name:compiled.ux.coach.fallback_name},compiled.ux.coach);
 assert.deepEqual(p.json.ux.suggestions,compiled.ux.suggestions);
 assert.deepEqual(p.json.sdk_tools,(await request('/v1/profile','GET',undefined,student)).json.sdk_tools);
 // The model is told the name in the shared gate (proxy and Agent SDK routes both go through it).
 const {gateChatRequest}=await import('../src/lib/chat-gate.ts');
 const g=await gateChatRequest({env,req:{header:()=> 'Bearer '+d.json.token},header(){},json:(body,status)=>Response.json(body,{status})});
 assert.equal(g.ok,true);assert.match(g.profile.system_prompt,/당신의 이름은 '제작 파트너'입니다/);
 assert.deepEqual(g.profile.sdk_tools,compiled.sdk_tools);
});
await check('AE-08 two lessons keep separate names; old-schema lesson leaves ux.coach untouched',async()=>{
 const {getProfile}=await import('../src/profiles/index.ts');const compiled=getProfile(profileId);
 const b=`/admin/cohorts/${cohort}/authoring/site-review`;
 assert.equal((await request(b,'PUT',save(0,'review-create',{...content,title:'검수 수업',assistant:{display_name:'검토 도우미'}}))).status,200);
 assert.equal((await request(b+'/versions/m2026.09.08-1','PUT',{expected_revision:1})).status,200);
 const db_=await request(b+'/versions/m2026.09.08-1/participants','POST',{user:'student-b',hours:1});assert.equal(db_.status,200,db_.raw);
 const pb=await request('/v1/profile','GET',undefined,db_.json.token);
 assert.equal(pb.json.ux.coach.fallback_name,'검토 도우미');
 // Lesson A's seat, re-read, still says 제작 파트너 (no cross-lesson leak on the Service side).
 const da=await request(`/admin/cohorts/${cohort}/authoring/site-named/versions/m2026.09.08-1/participants`,'POST',{user:'student','hours':1});
 assert.equal((await request('/v1/profile','GET',undefined,da.json.token)).json.ux.coach.fallback_name,'제작 파트너');
 // Old-schema control: the earlier lesson (no assistant block) serves the compiled ux.coach verbatim.
 const legacyLesson=await request(base+'/versions/m2026.09.06-1/participants','POST',{user:'student',hours:1});assert.equal(legacyLesson.status,200,legacyLesson.raw);
 const pl=await request('/v1/profile','GET',undefined,legacyLesson.json.token);assert.equal(pl.status,200);
 assert.equal(pl.json.lesson.content.assistant,undefined);assert.deepEqual(pl.json.ux.coach,compiled.ux.coach);
 const {gateChatRequest}=await import('../src/lib/chat-gate.ts');
 const g=await gateChatRequest({env,req:{header:()=> 'Bearer '+legacyLesson.json.token},header(){},json:(body,status)=>Response.json(body,{status})});
 assert.equal(g.ok,true);assert.doesNotMatch(g.profile.system_prompt,/당신의 이름은/);
 // No-lesson credential: unchanged.
 assert.deepEqual((await request('/v1/profile','GET',undefined,student)).json.ux.coach,compiled.ux.coach);
});
await check('AE-07 assistant block is validated: shape, emptiness, length, control characters, extra keys',async()=>{
 const c2=`/admin/cohorts/${cohort}/authoring/site-bad`;
 assert.equal((await request(c2,'PUT',save(0,'bad-create',content))).status,200);
 const bad=[
  {display_name:''},{display_name:'  '},{display_name:' 제작 파트너'},{display_name:'제작 파트너\n관리자'},{display_name:'x'.repeat(41)},
  {display_name:'제작 파트너',role:'admin'},{display_name:42},'제작 파트너',null,[],{},
  // Invisible / direction-changing / malformed / unreadable names (review of f5620fc): a blank or
  // reversed header defeats the explicit-identity acceptance, a lone surrogate throws in the client.
  {display_name:'\u200B'},{display_name:'제작\u200B파트너'},{display_name:'\u202E코치'},{display_name:'a\uFEFFb'},{display_name:'\uD83D'},
  {display_name:"'''"},{display_name:'a'+'\u0300'.repeat(3)},{display_name:'\u3164'},{display_name:'\u2800'},{display_name:'a\u{E0041}'},
 ];
 for(const assistant of bad){const r=await request(c2,'PUT',save(1,'bad-'+JSON.stringify(assistant).slice(0,20).replace(/[^a-zA-Z0-9_-]/g,'_'),{...content,assistant}));assert.equal(r.status,400,JSON.stringify(assistant)+' → '+r.raw);}
 // Positive controls: max length and markup characters are accepted (renderers escape text).
 // Scripts that legitimately use combining marks, and 20 astral characters (40 code units), stay accepted.
 for(const [i,display_name] of ['x'.repeat(40),'<b>제작</b> & "파트너"','Réviseur · 검토','Tiếng Việt','सहायक','ผู้ช่วย','😀'.repeat(20)].entries()){const r=await request(c2,'PUT',save(1+i,'good-'+i,{...content,assistant:{display_name}}));assert.equal(r.status,200,display_name+' → '+r.raw);}
 assert.equal((await request(c2)).json.revision,8);
 // Still no way to smuggle policy through the block or beside it.
 assert.equal((await request(c2,'PUT',save(8,'bad-policy',{...content,assistant:{display_name:'제작 파트너'},sdk_tools:{shell:true}}))).status,400);
});
await check('AE-08 user_names_it cohort: a named lesson serves fixed for that seat; the compiled profile is untouched',async()=>{
 const {getProfile}=await import('../src/profiles/index.ts');const kids=getProfile(KIDS_PROFILE);
 assert.equal(kids.ux.coach.naming_mode,'user_names_it','control: the kids profile lets students name the coach');
 const kenv=createMockEnv(); kenv.HPS_DB=env.HPS_DB; // harness seeds an open session + roster for KIDS_COHORT/KID
 const kidsIssuer=(await issueIssuer({issuer:'kids-author',scopes:[{cohort:KIDS_COHORT,profiles:[KIDS_PROFILE]}]},48,TEST_SECRET)).token;
 const k=`/admin/cohorts/${KIDS_COHORT}/authoring/kids-named`;
 const kreq=(path,method='GET',body,credential=kidsIssuer)=>app.fetch(new Request('https://service.test'+path,{method,headers:{authorization:`Bearer ${credential}`,...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)}),kenv,makeCtx()).then(async r=>({status:r.status,json:await r.json().catch(()=>null)}));
 assert.equal((await kreq(k,'PUT',{expected_revision:0,request_id:'kids-create',profile_id:KIDS_PROFILE,content:{...content,assistant:{display_name:'별똥별 코치'}}})).status,200);
 assert.equal((await kreq(k+'/versions/m2026.09.08-1','PUT',{expected_revision:1})).status,200);
 const d=await kreq(k+'/versions/m2026.09.08-1/participants','POST',{user:KID,hours:1});assert.equal(d.status,200,JSON.stringify(d.json));
 const p=await kreq('/v1/profile','GET',undefined,d.json.token);assert.equal(p.status,200);
 assert.deepEqual({naming_mode:p.json.ux.coach.naming_mode,fallback_name:p.json.ux.coach.fallback_name},{naming_mode:'fixed',fallback_name:'별똥별 코치'});
 assert.equal(p.json.ux.coach.naming_prompt_md,kids.ux.coach.naming_prompt_md,'other coach fields are the compiled profile\'s');
 assert.equal(getProfile(KIDS_PROFILE).ux.coach.naming_mode,'user_names_it','the compiled profile is not mutated by the projection');
 // Same student without a lesson claim: still names the coach.
 const plain=(await issue({u:KID,c:KIDS_COHORT,p:KIDS_PROFILE},1,TEST_SECRET)).token;
 assert.equal((await kreq('/v1/profile','GET',undefined,plain)).json.ux.coach.naming_mode,'user_names_it');
});
await check('AE-08 proxy route ignores a participant\'s coach headers on a lesson-fixed seat; legacy seat still honors them',async()=>{
 const {setRoster,startSession}=await import('../src/lib/kv.ts');
 await setRoster(env.HPS_KV,cohort,['student','student-b']);
 await startSession(env.HPS_KV,cohort,{session_id:'synthetic-lesson-c',profile_id:profileId,starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()});
 const named=await request(`/admin/cohorts/${cohort}/authoring/site-named/versions/m2026.09.08-1/participants`,'POST',{user:'student',hours:1});assert.equal(named.status,200,named.raw);
 const legacy=await request(base+'/versions/m2026.09.06-1/participants','POST',{user:'student',hours:1});assert.equal(legacy.status,200,legacy.raw);
 const turn=(credential)=>new Request('https://service.test/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${credential}`,'x-hps-coach-name':encodeURIComponent('별이'),'x-hps-coach-personality':encodeURIComponent('장난꾸러기')},body:JSON.stringify({model:'hypeproof-default',messages:[{role:'user',content:'안녕'}]})});
 await withMockUpstream(()=>Response.json(openAIJsonBody({content:'네'})),async calls=>{
  const r1=await app.fetch(turn(named.json.token),env,makeCtx());assert.equal(r1.status,200,await r1.text());
  const sys1=JSON.parse(calls.at(-1).init.body).messages[0].content;
  assert.match(sys1,/당신의 이름은 '제작 파트너'입니다/);assert.doesNotMatch(sys1,/별이|장난꾸러기|자녀가 직접 정한/);
  const r2=await app.fetch(turn(legacy.json.token),env,makeCtx());assert.equal(r2.status,200,await r2.text());
  const sys2=JSON.parse(calls.at(-1).init.body).messages[0].content;
  assert.match(sys2,/별이/);assert.doesNotMatch(sys2,/당신의 이름은/);
 });
});
// ─── #755 (ADR-0006) — a lesson narrows the models it allows ─────────────────
// The contract is narrowing-only: every alias a lesson names must already be the
// profile's default or fallback, so the block needs no new authority. Enforcement
// is by rewriting the served profile, which makes BOTH existing clamps apply with
// no clamp edit.
await check('AE-25/26 lesson model policy: narrowing is accepted, widening is refused at save and at freeze',async()=>{
 const {getProfile}=await import('../src/profiles/index.ts');const compiled=getProfile(profileId);
 assert.deepEqual({d:compiled.model.default,f:compiled.model.fallback},{d:'hypeproof-default',f:'hypeproof-fast'},'control: the profile grants exactly these two');
 const m=`/admin/cohorts/${cohort}/authoring/site-model`;
 const withModel=(model)=>({...content,...(model?{model}:{})});
 // Positive: narrowing to one of the granted aliases.
 assert.equal((await request(m,'PUT',save(0,'model-create',withModel({default:'hypeproof-fast',allowed:['hypeproof-fast']})))).status,200);
 assert.deepEqual((await request(m)).json.content.model,{default:'hypeproof-fast',allowed:['hypeproof-fast']});
 // Negative: an alias the profile never granted, even though it is a real alias.
 for(const [label,model] of [
   ['strong is outside the grant',{default:'hypeproof-strong',allowed:['hypeproof-strong']}],
   ['widening past the grant',{default:'hypeproof-default',allowed:['hypeproof-default','hypeproof-strong']}],
   ['default not in allowed',{default:'hypeproof-fast',allowed:['hypeproof-default']}],
   ['unknown alias',{default:'gpt-4o',allowed:['gpt-4o']}],
   ['empty allowed',{default:'hypeproof-fast',allowed:[]}],
   ['duplicate alias',{default:'hypeproof-fast',allowed:['hypeproof-fast','hypeproof-fast']}],
   ['three aliases',{default:'hypeproof-fast',allowed:['hypeproof-fast','hypeproof-default','hypeproof-strong']}],
   ['extra key',{default:'hypeproof-fast',allowed:['hypeproof-fast'],provider:'openai'}],
 ]){
  const r=await request(m,'PUT',save(1,'bad-model-'+label.replace(/[^a-z]/gi,''),withModel(model)));
  assert.equal(r.status,400,label+' → '+r.raw);
 }
 // The draft still holds the accepted narrowing; nothing above was stored.
 assert.deepEqual((await request(m)).json.content.model,{default:'hypeproof-fast',allowed:['hypeproof-fast']});
 assert.equal((await request(m+'/versions/m2026.09.09-1','PUT',{expected_revision:1})).status,200);
});
await check('AE-25 both clamps enforce the lesson set, and the SDK route exception is served rather than hidden',async()=>{
 const {setRoster,startSession}=await import('../src/lib/kv.ts');
 await setRoster(env.HPS_KV,cohort,['student','student-b']);
 await startSession(env.HPS_KV,cohort,{session_id:'synthetic-model',profile_id:profileId,starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()});
 const d=await request(`/admin/cohorts/${cohort}/authoring/site-model/versions/m2026.09.09-1/participants`,'POST',{user:'student',hours:1});
 assert.equal(d.status,200,d.raw);
 const p=await request('/v1/profile','GET',undefined,d.json.token);assert.equal(p.status,200,p.raw);
 assert.equal(p.json.model.source,'lesson');
 assert.equal(p.json.model.current.alias,'hypeproof-fast');
 assert.deepEqual(p.json.model.allowed.map(a=>a.alias),['hypeproof-fast'],'a proxy seat serves exactly the lesson set');
 assert.equal(p.json.model.route_exception,null);
 // The gate narrows the profile, so both clamps follow with no clamp edit.
 const {gateChatRequest}=await import('../src/lib/chat-gate.ts');
 const g=await gateChatRequest({env,req:{header:()=> 'Bearer '+d.json.token},header(){},json:(body,status)=>Response.json(body,{status})});
 assert.equal(g.ok,true);
 assert.deepEqual({d:g.profile.model.default,f:g.profile.model.fallback},{d:'hypeproof-fast',f:undefined});
 const {translate}=await import('../src/lib/translate.ts');
 const {resolveMessagesModel}=await import('../src/routes/messages.ts');
 const {modelIdFor}=await import('../src/profiles/types.ts');
 const FAST=modelIdFor('hypeproof-fast','anthropic'),DEFAULT=modelIdFor('hypeproof-default','anthropic');
 const routeA=(requested)=>translate({model:requested,messages:[{role:'user',content:'hi'}]},g.profile,{name:null,personality:null}).model;
 for(const requested of [undefined,'hypeproof-default','hypeproof-strong',DEFAULT,'gpt-4o'])
  assert.equal(routeA(requested),FAST,'/v1/chat clamps '+requested+' to the lesson set');
 for(const requested of ['hypeproof-default','hypeproof-strong',DEFAULT])
  assert.equal(resolveMessagesModel(requested,g.profile),FAST,'/v1/messages clamps '+requested);
 // Baseline control: a seat WITHOUT a lesson model block is untouched.
 const legacy=await request(base+'/versions/m2026.09.06-1/participants','POST',{user:'student',hours:1});
 assert.equal(legacy.status,200,legacy.raw);
 const lp=await request('/v1/profile','GET',undefined,legacy.json.token);
 assert.equal(lp.json.model.source,'profile');
 assert.deepEqual(lp.json.model.allowed.map(a=>a.alias),['hypeproof-default','hypeproof-fast']);
 const lg=await gateChatRequest({env,req:{header:()=> 'Bearer '+legacy.json.token},header(){},json:(body,status)=>Response.json(body,{status})});
 assert.equal(translate({model:'hypeproof-default',messages:[{role:'user',content:'hi'}]},lg.profile,{name:null,personality:null}).model,DEFAULT);
});
await check('AE-25 the {default} counterexample: /v1/messages still admits fast, and the served block says so',async()=>{
 // ADR-0006's corrected claim. A {fast} narrowing hides this because fast is inside
 // the set; {default} is the narrowing that exposes it. The route has no trusted
 // request-purpose marker, so this is NOT an auxiliary-only channel.
 const {gateChatRequest}=await import('../src/lib/chat-gate.ts');
 const {resolveMessagesModel}=await import('../src/routes/messages.ts');
 const {translate}=await import('../src/lib/translate.ts');
 const {modelIdFor}=await import('../src/profiles/types.ts');
 const FAST=modelIdFor('hypeproof-fast','anthropic'),DEFAULT=modelIdFor('hypeproof-default','anthropic');
 const m2=`/admin/cohorts/${cohort}/authoring/site-model-default`;
 assert.equal((await request(m2,'PUT',save(0,'default-only',{...content,model:{default:'hypeproof-default',allowed:['hypeproof-default']}}))).status,200);
 assert.equal((await request(m2+'/versions/m2026.09.09-2','PUT',{expected_revision:1})).status,200);
 const d=await request(m2+'/versions/m2026.09.09-2/participants','POST',{user:'student-b',hours:1});assert.equal(d.status,200,d.raw);
 const g=await gateChatRequest({env,req:{header:()=> 'Bearer '+d.json.token},header(){},json:(body,status)=>Response.json(body,{status})});
 assert.equal(resolveMessagesModel('hypeproof-default',g.profile),DEFAULT);
 assert.equal(resolveMessagesModel('hypeproof-strong',g.profile),DEFAULT,'strong is clamped');
 assert.equal(resolveMessagesModel('hypeproof-fast',g.profile),FAST,'fast ESCAPES the lesson set on /v1/messages — the documented exception');
 assert.equal(resolveMessagesModel('claude-3-5-haiku-20241022',g.profile),FAST,'any claude-*haiku* string escapes too');
 assert.equal(translate({model:'hypeproof-fast',messages:[{role:'user',content:'hi'}]},g.profile,{name:null,personality:null}).model,DEFAULT,'/v1/chat has no such exception');
});
await check('T-08 concurrent draft edit prevents freezing stale read',async()=>{
 beforeWrite=async()=>{db.prepare('UPDATE authoring_drafts SET revision=revision+1 WHERE course_id=?').run('site-1');};
 assert.equal((await request(base+'/versions/m2026.09.06-2','PUT',{expected_revision:5})).status,409);
 assert.equal((await request(base+'/versions/m2026.09.06-2')).status,404);
});
await check('content schema rejects injected policy, unknown schema and duplicate step IDs',async()=>{
 for(const data of [{...content,sdk_tools:{shell:true}},{...content,schema:'future'},{...content,steps:[content.steps[0],content.steps[0]]}]) {
  assert.equal((await request(base,'PUT',save(6,'bad-content',data))).status,400);
 }
 assert.equal((await request()).json.revision,6);
});
await check('bounded body and malformed JSON fail without storing',async()=>{
 assert.equal((await request(base,'PUT',save(6,'big',{...content,title:'x'.repeat(150000)}))).status,413);
 const r=await app.fetch(new Request('https://service.test'+base,{method:'PUT',headers:{authorization:`Bearer ${alice}`,'content-type':'application/json'},body:'{' }),env,makeCtx());assert.equal(r.status,400);
});
await check('T-01 revoked issuer cannot retrieve frozen content',async()=>{
 const revoked=await issueIssuer({issuer:'author-a',scopes:[{cohort,profiles:[profileId]}]},48,TEST_SECRET);
 const { revokeToken }=await import('../src/lib/kv.ts');await revokeToken(env.HPS_KV,revoked.jti,'test');
 assert.equal((await request(base+'/versions/m2026.09.06-1','GET',undefined,revoked.token)).status,401);
});
await check('T-21 existing admin route remains reachable; no broad middleware capture',async()=>{
 const e=createMockEnv({adminPassword:'test-password'});
 const r=await app.fetch(new Request('https://service.test/admin/cohorts',{headers:{authorization:'Basic '+btoa('admin:test-password')}}),e,makeCtx());assert.equal(r.status,200);
});
await check('database outage returns failure, never a successful save',async()=>{
 failDatabase=true;const r=await request(base,'PUT',save(6,'outage'));failDatabase=false;assert.equal(r.status,500);
 assert.equal((await request()).json.revision,6);
});
await check('fresh schema and migration have identical authoring tables',async()=>{
 const fresh=new DatabaseSync(':memory:');fresh.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const sql="SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE 'authoring_%' ORDER BY name";
 assert.deepEqual(fresh.prepare(sql).all(),db.prepare(sql).all());fresh.close();
});
db.close();
console.log(`${passed} authoring integration checks passed`);
