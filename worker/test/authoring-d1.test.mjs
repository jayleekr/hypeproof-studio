// Production SQL on local workerd/D1, alongside SQLite race/negative controls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMiniflare } from './harness/miniflare.mjs';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET } from './harness/index.mjs';
import { plantRehearsalD1 } from './harness/rehearsal-evidence.mjs';
const compatibilityDate = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
assert.ok(compatibilityDate, 'use the production Worker compatibility date');
const mf = createMiniflare({modules:true,script:'export default {fetch(){return new Response("local test")}}',compatibilityDate,d1Databases:['HPS_DB']});
try {
 const app=await bootApp();const db=await mf.getD1Database('HPS_DB');
 // 0011 은 0002 가 만든 authoring_versions 를 참조하므로 순서대로 적용한다.
 const migrations=['0002-chalk-authoring.sql','0011-rehearsal-evidence.sql']
   .map(f=>readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8').replace(/^--.*$/gm,''));
 // Both first deployment and repeat deployment must preserve course storage.
 // 배포는 모든 마이그레이션 파일을 **매번** 다시 실행한다. 두 바퀴가 그 회귀를 잡는다 —
 // `ALTER TABLE ... ADD COLUMN` 이었다면 두 번째 바퀴에서 duplicate column 으로 죽는다.
 for(let pass=0;pass<2;pass++)for(const migration of migrations)
   for(const statement of migration.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
 const workflow=readFileSync(new URL('../../.github/workflows/deploy-worker.yml',import.meta.url),'utf8');
 const freeze=workflow.indexOf('id: freeze');
 const authoring=workflow.indexOf('--file=migrations/0002-chalk-authoring.sql');
 const sharing=workflow.indexOf('--file=migrations/0003-classroom-sharing.sql');
 const deploy=workflow.indexOf('- name: Deploy Worker');
 // 리허설 증거 테이블은 **배포보다 먼저** 만들어져야 한다 — 새 코드가 그것을 읽는다.
 // 순서가 뒤집히면 배포 직후 잠깐 동안 모든 버전이 증거 없음으로 보인다.
 const rehearsal=workflow.indexOf('--file=migrations/0011-rehearsal-evidence.sql');
 assert.ok(freeze>=0&&authoring>freeze&&sharing>authoring&&deploy>sharing,'freeze → authoring → sharing → deploy');
 assert.ok(rehearsal>freeze&&deploy>rehearsal,'rehearsal evidence schema is applied before the Worker deploy');
 const env=createMockEnv({env:{HPS_DB:db}});
 const {issueIssuer}=await import('../src/lib/tokens.ts');
 const {listProfiles}=await import('../src/profiles/index.ts');
 const p=listProfiles().find(p=>p.session.cohort_id==='boah-dental-2026-a');
 const {token}=await issueIssuer({issuer:'d1-test',scopes:[{cohort:p.session.cohort_id,profiles:[p.id]}]},48,TEST_SECRET);
 const path=`/admin/cohorts/${p.session.cohort_id}/authoring/d1-course`;
 const content={schema:'hps-session-design/1',title:'Website',audience:'Adults',duration_minutes:120,objective:'Edit',prerequisites:'No coding experience required',starter:'Static site',steps:[{id:'one',title:'Edit',instructions:'Edit hours',hint:'',acceptance:'Check mobile'}]};
 async function call(suffix='',method='GET',body){
  const r=await app.fetch(new Request('https://local.test'+path+suffix,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined}),env,makeCtx());
  return {status:r.status,body:await r.json()};
 }
 const save=(n,id)=>({expected_revision:n,request_id:id,profile_id:p.id,content});
 assert.equal((await call('','PUT',save(0,'create'))).status,200);
 const rs=await Promise.all([call('','PUT',save(1,'a')),call('','PUT',save(1,'b'))]);
 assert.deepEqual(rs.map(r=>r.status).sort(),[200,409]);
 const frozen=await call('/versions/m2026.09.06-1','PUT',{expected_revision:2});assert.equal(frozen.status,200);assert.equal(frozen.body.activated,false);
 assert.equal((await call('','PUT',save(2,'next'))).status,200);
 // `pedagogy`는 확정 시점의 판정이며 저장된 버전의 일부가 아니다 — D1에 들어가지 않으므로
 // read-back 응답에 없는 것이 맞다 (#1114). 빠뜨린 필드가 아니다. 나머지는 그대로 대조한다.
 const {pedagogy:_frozenVerdict,...frozenStored}=frozen.body;
 assert.deepEqual((await call('/versions/m2026.09.06-1')).body,frozenStored);
 assert.equal((await call('/versions/m2026.09.06-1','PUT',{expected_revision:3})).status,409);
 const {setRoster,startSession}=await import('../src/lib/kv.ts');
 await setRoster(env.HPS_KV,p.session.cohort_id,['synthetic-d1-student']);
 await startSession(env.HPS_KV,p.session.cohort_id,{session_id:'synthetic-d1',profile_id:p.id,starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()});
 // 실제 D1 위에서도 관문이 같이 선다 — 증거가 없으면 발급이 막히고(#1187), 심으면 나간다.
 assert.equal((await call('/versions/m2026.09.06-1/participants','POST',{user:'synthetic-d1-student',hours:1})).status,403,'리허설 증거 없이는 D1 에서도 발급되지 않는다');
 await plantRehearsalD1(db,p.session.cohort_id,'d1-course','m2026.09.06-1');
 const delivered=await call('/versions/m2026.09.06-1/participants','POST',{user:'synthetic-d1-student',hours:1});assert.equal(delivered.status,200);
 const response=await app.fetch(new Request('https://local.test/v1/profile',{headers:{authorization:'Bearer '+delivered.body.token}}),env,makeCtx());assert.equal(response.status,200);assert.deepEqual((await response.json()).lesson.content,content);
 console.log('PASS local workerd/D1: migration, create, concurrent CAS, immutable version, reopen, overwrite rejection');
} finally { await mf.dispose(); }
