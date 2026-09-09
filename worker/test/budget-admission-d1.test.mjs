import './harness/loader.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {budgetHarness} from './harness/budgets.mjs';
import {syntheticEvidence,nativeRaw} from './harness/usage-costs.mjs';
const {reserveBudgetAttempt:reserve,dispatchBudgetAttempt:dispatch}=await import('../src/lib/budget-admission.ts');
const {budgetBalances,createBudgetChild,readBudgetAccount,updateBudgetAccount}=await import('../src/lib/budgets.ts');
const {recordCostEvidence,normalizeCostUsage}=await import('../src/lib/usage-costs.ts');
const compatibilityDate=readFileSync(new URL('../wrangler.toml',import.meta.url),'utf8').match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];assert(compatibilityDate);
const mf=new Miniflare({modules:true,compatibilityDate,d1Databases:['HPS_DB'],script:'export default {fetch(){return new Response("local budget test")}}'});
try{
 const db=await mf.getD1Database('HPS_DB');
 for(const file of ['0006-model-usage.sql','0007-access-contracts.sql','0008-usage-costs.sql','0009-budget-admission.sql','0009-budget-admission.sql']){
  const sql=readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean);
  for(const statement of sql)await db.prepare(statement).run();
 }
 const h=await budgetHarness(db,{amount:910,subjectSlots:1});
 const contexts=await Promise.all(Array.from({length:20},(_,i)=>h.access('kid'+String(i+1).padStart(2,'0'))));
 const results=await Promise.allSettled(contexts.map((c,i)=>reserve(h.env,c,h.input('contend-'+i,'kid'+String(i+1).padStart(2,'0')))));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,10);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM budget_reservations').first()).n,10);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM usage_jobs').first()).n,10,'failed admission creates no job');
 let balances=await budgetBalances(h.env,h.root.account_id);assert.equal(balances[0].available,0);assert.equal(balances[0].held,910);
 const a=results.find(r=>r.status==='fulfilled').value;
 await dispatch(h.env,a.request_id);
 const evidence=syntheticEvidence(a,normalizeCostUsage(a.protocol,nativeRaw));
 await Promise.all(Array.from({length:12},()=>recordCostEvidence(h.env,evidence)));
 balances=await budgetBalances(h.env,h.root.account_id);assert.equal(balances[0].spent,32);assert.equal(balances[0].held,819);assert.equal(balances[0].available,59);
 await assert.rejects(reserve(h.env,await h.access(a.user_id),h.input('insufficient-after-settlement',a.user_id)),/admission_denied/);
 const newer=Array.from({length:10},(_,i)=>syntheticEvidence(a,normalizeCostUsage(a.protocol,{...nativeRaw,output_tokens:i+3}),i+2));
 await Promise.all(newer.reverse().map(e=>recordCostEvidence(h.env,e)));
 assert.equal((await budgetBalances(h.env,h.root.account_id))[0].spent,62);
 // Shrinking a parent cannot race past already durable child reservations.
 const root=await readBudgetAccount(h.env,h.root.account_id);
 await assert.rejects(createBudgetChild(h.env,{id:'too-large-child',parent_id:root.id,expected_parent_revision:root.revision,kind:'allocation',scope_kind:'subject',scope_id:'subject:new',max_concurrent:1,limits:{'currency:USD:micro':91}},'operator'));
 assert.equal(await db.prepare("SELECT id FROM budget_accounts WHERE id='too-large-child'").first(),null);
 // A root pause's revision invalidates a previously read admission snapshot.
 const stale=await h.access('kid30');
 await updateBudgetAccount(h.env,root.id,{expected_revision:root.revision,paused:true,max_concurrent:100,limits:{'currency:USD:micro':910}},'operator');
 await assert.rejects(reserve(h.env,stale,h.input('stale-paused','kid30')),/admission_denied/);
 console.log('PASS real local D1: 20 students / 10 funded calls, resource+slot atomicity, repeated migration, 12-way duplicate and reversed evidence, allocation rollback and pause revision');
}finally{await mf.dispose();}
