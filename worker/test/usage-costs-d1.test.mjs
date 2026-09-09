import './harness/loader.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {accessHarness,syntheticPlan,syntheticEvent} from './harness/access.mjs';
import {syntheticPrice,syntheticAttempt,syntheticEvidence,nativeRaw} from './harness/usage-costs.mjs';
const {publishAccessPlan,applyAccessEvent}=await import('../src/lib/access-contracts.ts');
const {publishUsagePrice,registerUsageAttempt,recordCostEvidence,normalizeCostUsage}=await import('../src/lib/usage-costs.ts');
const compatibilityDate=readFileSync(new URL('../wrangler.toml',import.meta.url),'utf8').match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];assert(compatibilityDate);
const mf=new Miniflare({modules:true,compatibilityDate,d1Databases:['HPS_DB'],script:'export default {fetch(){return new Response("local costs test")}}'});
try{
  const db=await mf.getD1Database('HPS_DB');
  for(const file of ['0006-model-usage.sql','0007-access-contracts.sql','0008-usage-costs.sql']){
    const sql=readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean);
    for(const statement of sql)await db.prepare(statement).run();
  }
  const h=await accessHarness(db),contract=syntheticEvent(),price=syntheticPrice(),a=syntheticAttempt(contract,price);
  await publishAccessPlan(h.env,syntheticPlan());await applyAccessEvent(h.env,contract);await publishUsagePrice(h.env,price);
  await Promise.all(Array.from({length:12},()=>registerUsageAttempt(h.env,a)));
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM model_usage_requests').first()).n,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM usage_attempt_costs').first()).n,1);
  const evidence=syntheticEvidence(a,normalizeCostUsage(a.protocol,nativeRaw));
  const results=await Promise.all(Array.from({length:12},()=>recordCostEvidence(h.env,evidence)));
  assert.equal(results.filter(r=>r.applied).length,1);
  const later=Array.from({length:12},(_,i)=>syntheticEvidence(a,normalizeCostUsage(a.protocol,{...nativeRaw,output_tokens:i+3}),i+2));
  await Promise.all(later.reverse().map(e=>recordCostEvidence(h.env,e)));
  let row=await db.prepare('SELECT * FROM usage_attempt_costs').first();assert.equal(row.evidence_version,13);assert.equal(row.amount_micro,68);
  await recordCostEvidence(h.env,evidence);row=await db.prepare('SELECT * FROM usage_attempt_costs').first();assert.equal(row.amount_micro,68);
  await assert.rejects(registerUsageAttempt(h.env,{...a,request_id:'wrong-job-owner',subject_key:'another-principal'}));
  assert.equal(await db.prepare("SELECT * FROM model_usage_requests WHERE request_id='wrong-job-owner'").first(),null,'registration rollback leaves no extra attempt');
  // Simulate ACK loss after a durable commit, then retry the exact report.
  const ack=syntheticEvidence(a,normalizeCostUsage(a.protocol,{...nativeRaw,output_tokens:20}),14);
  await recordCostEvidence(h.env,ack);
  const replay=await recordCostEvidence(h.env,ack);assert.equal(replay.applied,false);assert.equal(replay.amount_micro,86);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM usage_cost_evidence').first()).n,14);
  console.log('PASS real local D1: one attempt/cost per request, 12-way duplicate and out-of-order evidence, atomic registration rollback and durable ACK-loss replay');
}finally{await mf.dispose();}
