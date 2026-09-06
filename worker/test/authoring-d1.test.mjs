// Production SQL on local workerd/D1, alongside SQLite race/negative controls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET } from './harness/index.mjs';
const compatibilityDate = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
assert.ok(compatibilityDate, 'use the production Worker compatibility date');
const mf = new Miniflare({modules:true,script:'export default {fetch(){return new Response("local test")}}',compatibilityDate,d1Databases:['HPS_DB']});
try {
 const app=await bootApp();const db=await mf.getD1Database('HPS_DB');
 const migration=readFileSync(new URL('../migrations/0002-chalk-authoring.sql',import.meta.url),'utf8').replace(/^--.*$/gm,'');
 for(const statement of migration.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
 const env=createMockEnv({env:{HPS_DB:db}});
 const {issueIssuer}=await import('../src/lib/tokens.ts');
 const {listProfiles}=await import('../src/profiles/index.ts');
 const p=listProfiles().find(p=>p.session.cohort_id==='boah-dental-2026-a');
 const {token}=await issueIssuer({issuer:'d1-test',scopes:[{cohort:p.session.cohort_id,profiles:[p.id]}]},1,TEST_SECRET);
 const path=`/admin/cohorts/${p.session.cohort_id}/authoring/d1-course`;
 const content={schema:'hps-session-design/1',title:'Website',audience:'Adults',duration_minutes:120,objective:'Edit',prerequisites:'',starter:'Static site',steps:[{id:'one',title:'Edit',instructions:'Edit hours',hint:'',acceptance:'Check mobile'}]};
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
 assert.deepEqual((await call('/versions/m2026.09.06-1')).body,frozen.body);
 assert.equal((await call('/versions/m2026.09.06-1','PUT',{expected_revision:3})).status,409);
 console.log('PASS local workerd/D1: migration, create, concurrent CAS, immutable version, reopen, overwrite rejection');
} finally { await mf.dispose(); }
