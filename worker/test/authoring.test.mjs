// Real Service routing + signed issuer tokens + real SQLite executing production SQL.
// No provider, production data, or external network required.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET } from './harness/index.mjs';
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
const token = async (issuer, scopes=[{cohort,profiles:[profileId]}]) => (await issueIssuer({issuer,scopes},1,TEST_SECRET)).token;
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
 const revoked=await issueIssuer({issuer:'author-a',scopes:[{cohort,profiles:[profileId]}]},1,TEST_SECRET);
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
