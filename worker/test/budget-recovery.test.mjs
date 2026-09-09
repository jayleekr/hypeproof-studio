import './harness/loader.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {budgetHarness} from './harness/budgets.mjs';
import {syntheticEvidence,nativeRaw} from './harness/usage-costs.mjs';
const {applyAccessEvent,accountForToken,accessDigest}=await import('../src/lib/access-contracts.ts');
const {reserveBudgetAttempt:reserve,dispatchBudgetAttempt:dispatch}=await import('../src/lib/budget-admission.ts');
const {budgetBalances,initializeBudget,budgetSubjectKey,readBudgetAccount,updateBudgetAccount}=await import('../src/lib/budgets.ts');
const {recordCostEvidence,normalizeCostUsage}=await import('../src/lib/usage-costs.ts');
const {publishBudgetDelegation,delegatedBudgetMutation}=await import('../src/lib/budget-views.ts');
async function exercise(binding,label){
 const h=await budgetHarness(binding,{subjectSlots:1}),realNow=Date.now;
 try{
  const put=(p,b)=>h.request(p,{method:'PUT',body:b});
  const account={user_id:'global-user',profile_id:'studio-model-practice',active:true};
  assert.equal((await put('/admin/access/accounts/linked',account)).status,200);
  // Existing budget subject cannot be replaced by linking a different identity.
  const link={cohort_id:h.cohort,user_id:'kid01'};
  assert.equal((await put('/admin/access/accounts/linked/seats',link)).json.error.code,'seat_link_requires_budget_migration');
  assert.equal(await h.env.HPS_DB.prepare('SELECT * FROM access_seats WHERE cohort_id=?').bind(h.cohort).first(),null);
  await h.env.HPS_KV.put('cohort:future-class:roster',JSON.stringify({users:['future-seat']}));
  const future={cohort_id:'future-class',user_id:'future-seat'};
  assert.equal((await put('/admin/access/accounts/linked/seats',future)).status,200);
  assert.equal((await put('/admin/access/accounts/linked/seats',future)).status,200);
  const payload={...h.payload(),c:future.cohort_id,u:future.user_id};
  const key=await budgetSubjectKey(h.env,payload);assert.equal(key,'subject:'+await accessDigest({account:'linked'}));
  assert.equal((await put('/admin/access/accounts/linked',{...account,active:false})).status,200);
  await assert.rejects(accountForToken(h.env,payload),/account_unavailable/,'disabled linked account never falls back to fresh seat');
  await put('/admin/access/accounts/linked',account);assert.equal(await budgetSubjectKey(h.env,payload),key);
  const oldAccess=await h.access(),a=await reserve(h.env,oldAccess,h.input('old-unknown','kid01',{turn_id:'old-turn'}));
  await dispatch(h.env,a.request_id);
  await recordCostEvidence(h.env,{id:'partial-old',request_id:a.request_id,version:1,source:'provider-response',source_ref:'synthetic-cut-stream',execution:'unknown',returned_model:a.requested_model,service_tier:'standard',region:'global',complete:false,meters:{'tokens:input':4},issues:['stream-interrupted']});
  const before=(await budgetBalances(h.env,h.root.account_id))[0];assert(before.held>0);assert.equal(before.unresolved,1);
  await publishBudgetDelegation(h.env,{account_id:h.root.account_id,issuer_id:'synthetic-teacher',cohort_id:h.cohort,expected_revision:0,active:true,max_concurrent:100,limits:{'currency:USD:micro':1000}});
  const root=await readBudgetAccount(h.env,h.root.account_id),update={expected_revision:root.revision,paused:true,max_concurrent:root.max_concurrent,limits:{'currency:USD:micro':1000}};
  const authority=await delegatedBudgetMutation(h.env,h.cohort,'synthetic-teacher',root,update);
  await applyAccessEvent(h.env,{...h.contract,event_id:'cancel-v2',source_version:2,state:'ended'});
  await assert.rejects(reserve(h.env,oldAccess,h.input('stale-after-cancel')),/admission_denied/);
  await assert.rejects(updateBudgetAccount(h.env,root.id,update,'synthetic-teacher',authority),'cancellation closes teacher mutations even with a preflight delegation');
  const advanced=h.contract.period.ends_at+1;Date.now=()=>advanced;
  const renewal={...h.contract,event_id:'renewal-v3',source_version:3,period:{id:'renewed-period',starts_at:h.contract.period.ends_at,ends_at:advanced+3600000}};
  await applyAccessEvent(h.env,renewal);
  const input={period_id:renewal.period.id,max_concurrent:10,subject_concurrency:1,price_revisions:[h.price.revision],exposure_ref:'synthetic-renewal'};
  const roots=await Promise.all(Array.from({length:8},()=>initializeBudget(h.env,input)));
  assert.equal(new Set(roots.map(r=>r.account_id)).size,1);const renewedRoot=roots[0];
  assert.equal((await budgetBalances(h.env,renewedRoot.account_id))[0].granted,1000);
  await applyAccessEvent(h.env,h.contract); // delayed pre-renewal event cannot move period backwards
  const next=await h.access();assert.equal(next.root.account_id,renewedRoot.account_id);
  await assert.rejects(reserve(h.env,next,h.input('same-job-new-period','kid01',{turn_id:'old-turn'})),/job_funding_locked/);
  const b=await reserve(h.env,next,h.input('new-period-turn','kid01',{turn_id:'new-turn'}));await dispatch(h.env,b.request_id);
  const currentBefore=(await budgetBalances(h.env,renewedRoot.account_id))[0];
  const receipt=syntheticEvidence(a,normalizeCostUsage(a.protocol,nativeRaw),2);
  await Promise.all(Array.from({length:8},()=>recordCostEvidence(h.env,receipt)));
  assert.equal((await budgetBalances(h.env,h.root.account_id))[0].spent,32);
  assert.equal((await budgetBalances(h.env,h.root.account_id))[0].held,0);
  assert.deepEqual((await budgetBalances(h.env,renewedRoot.account_id))[0],currentBefore,'late old cost never charges the renewed allowance');
  assert.equal((await h.env.HPS_DB.prepare('SELECT COUNT(*) n FROM usage_cost_evidence WHERE request_id=? AND version=2').bind(a.request_id).first()).n,1);
  console.log('PASS',label,'identity lifecycle, cancel+delegation race, interrupted hold, 8-way renewal/reconciliation, old-job/new-period isolation');
 }finally{Date.now=realNow;h.close();}
}
if(!process.argv.includes('--d1'))await exercise(undefined,'SQLite/Hono');
else{
 const date=readFileSync(new URL('../wrangler.toml',import.meta.url),'utf8').match(/^compatibility_date\s*=\s*"([^"]+)"/m)[1];
 const mf=new Miniflare({modules:true,compatibilityDate:date,d1Databases:['HPS_DB'],script:'export default {fetch(){return new Response("local recovery")}}'});
 try{const db=await mf.getD1Database('HPS_DB');for(const f of ['0006-model-usage.sql','0007-access-contracts.sql','0008-usage-costs.sql','0009-budget-admission.sql','0010-budget-surfaces.sql'])for(const sql of readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();await exercise(db,'actual local D1');}
 finally{await mf.dispose();}
}
