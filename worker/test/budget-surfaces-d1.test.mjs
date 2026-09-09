import './harness/loader.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {budgetHarness} from './harness/budgets.mjs';
import {syntheticEvidence,nativeRaw} from './harness/usage-costs.mjs';
const {budgetSubjectKey,createBudgetChild,readBudgetAccount,updateBudgetAccount,budgetBalances}=await import('../src/lib/budgets.ts');
const {publishBudgetDelegation,delegatedBudgetMutation}=await import('../src/lib/budget-views.ts');
const {reserveBudgetAttempt}=await import('../src/lib/budget-admission.ts');
const {recordCostEvidence,normalizeCostUsage}=await import('../src/lib/usage-costs.ts');
const compatibilityDate=readFileSync(new URL('../wrangler.toml',import.meta.url),'utf8').match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
const mf=new Miniflare({modules:true,compatibilityDate,d1Databases:['HPS_DB'],script:'export default {fetch(){return new Response("local budget surface test")}}'});
try{
 const db=await mf.getD1Database('HPS_DB');
 for(const file of ['0006-model-usage.sql','0007-access-contracts.sql','0008-usage-costs.sql','0009-budget-admission.sql','0010-budget-surfaces.sql'])for(const sql of readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8').replace(/--[^\n]*/g,'').split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
 const h=await budgetHarness(db),root=h.root.account_id,a=await reserveBudgetAttempt(h.env,await h.access(),h.input('prior-period-use'));
 await recordCostEvidence(h.env,syntheticEvidence(a,normalizeCostUsage(a.protocol,nativeRaw)));
 const input={id:'later-cap',parent_id:root,expected_parent_revision:1,kind:'cap',scope_kind:'subject',scope_id:await budgetSubjectKey(h.env,h.payload()),max_concurrent:1,limits:{'currency:USD:micro':50}};
 await createBudgetChild(h.env,input,'operator');assert.equal((await budgetBalances(h.env,input.id))[0].available,18);
 const d={account_id:root,issuer_id:'synthetic-teacher',cohort_id:h.cohort,expected_revision:0,active:true,max_concurrent:2,limits:{'currency:USD:micro':1000}};
 const changes=await Promise.allSettled(Array.from({length:8},()=>publishBudgetDelegation(h.env,d)));assert.equal(changes.filter(r=>r.status==='fulfilled').length,1);
 const target=await readBudgetAccount(h.env,input.id),update={expected_revision:target.revision,paused:true,max_concurrent:1,limits:input.limits};
 const guard=await delegatedBudgetMutation(h.env,h.cohort,d.issuer_id,target,update);
 await publishBudgetDelegation(h.env,{...d,expected_revision:1,active:false});
 await assert.rejects(updateBudgetAccount(h.env,target.id,update,d.issuer_id,guard));assert.equal((await readBudgetAccount(h.env,target.id)).paused,0);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM budget_changes WHERE json_extract(document,'$.kind')='delegation'").first()).n,2,'only successful grant/revoke are audited');
 console.log('PASS actual D1: historical cap backfill, 8-way delegation CAS, audit cardinality and revoked-authority mutation rollback');
}finally{await mf.dispose();}
