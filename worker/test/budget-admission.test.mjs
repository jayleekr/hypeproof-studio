import './harness/loader.mjs';
import assert from 'node:assert/strict';
import {budgetHarness} from './harness/budgets.mjs';
import {syntheticPlan,syntheticEvent} from './harness/access.mjs';
import {syntheticPrice,syntheticEvidence,nativeRaw,openaiRaw} from './harness/usage-costs.mjs';
const {reserveBudgetAttempt:reserve,dispatchBudgetAttempt:dispatch,resolveExecutionAccess}=await import('../src/lib/budget-admission.ts');
const {budgetBalances,createBudgetChild,readBudgetAccount,updateBudgetAccount,initializeBudget,budgetSubjectKey}=await import('../src/lib/budgets.ts');
const {recordCostEvidence,normalizeCostUsage,recordInvoiceAdjustment,publishUsagePrice}=await import('../src/lib/usage-costs.ts');
const {applyAccessEvent,publishAccessPlan}=await import('../src/lib/access-contracts.ts');
const {issue}=await import('../src/lib/tokens.ts');
const {withMockUpstream,TEST_SECRET}=await import('./harness/index.mjs');
const bal=async h=>(await budgetBalances(h.env,h.root.account_id))[0];
const h=await budgetHarness(undefined,{amount:182,subjectSlots:1});
try{
  let ctx=await h.access();const a=await reserve(h.env,ctx,h.input('first'));
  assert.equal((await bal(h)).held,91);assert.equal((await bal(h)).available,91);
  await assert.rejects(reserve(h.env,ctx,h.input('second')),/budget_admission_denied/);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM usage_jobs').get().n,1,'failed admission rolls back new job and attempt');
  await dispatch(h.env,a.request_id);await assert.rejects(dispatch(h.env,a.request_id),/already_dispatched/);
  let e=syntheticEvidence(a,normalizeCostUsage(a.protocol,nativeRaw));
  await recordCostEvidence(h.env,{...e,execution:'unknown',complete:false});
  assert.equal((await bal(h)).spent,32);assert.equal((await bal(h)).held,59);
  await assert.rejects(reserve(h.env,ctx,h.input('timed-out-slot')),/budget_admission_denied/);
  await recordCostEvidence(h.env,{...e,id:'ended',version:2});
  assert.equal((await bal(h)).held,0);assert.equal((await bal(h)).available,150);
  await recordCostEvidence(h.env,{...e,id:'ended',version:2});assert.equal((await bal(h)).spent,32);
  const b=await reserve(h.env,ctx,h.input('new-after-ended'));
  await recordCostEvidence(h.env,{id:'not-sent',request_id:b.request_id,version:1,source:'execution-proof',source_ref:'synthetic-before-dispatch-proof',execution:'not_sent',returned_model:null,service_tier:null,region:null,complete:true,meters:{},issues:[]});
  assert.equal((await bal(h)).available,150);
  await recordInvoiceAdjustment(h.env,{id:'positive',request_id:a.request_id,invoice_ref:'synthetic-invoice',currency:'USD',amount_micro:200,reason:'synthetic late charge'});
  assert.equal((await bal(h)).available,-50);assert.equal((await bal(h)).overrun,141);
  await assert.rejects(reserve(h.env,ctx,h.input('overrun')),/budget_admission_denied/);
  await recordInvoiceAdjustment(h.env,{id:'credit',request_id:a.request_id,invoice_ref:'synthetic-credit',currency:'USD',amount_micro:-500,reason:'synthetic credit'});
  assert.equal((await bal(h)).available,182);assert.equal((await bal(h)).unapplied_credit,-268,'credit does not mint extra grant');
  console.log('PASS resource+slot rollback, pending/partial/ended/not-sent, duplicate/late evidence, negative exposure and unapplied credits');

  const parent=await readBudgetAccount(h.env,h.root.account_id);
  const child=await createBudgetChild(h.env,{id:'seat-allocation',parent_id:parent.id,expected_parent_revision:parent.revision,kind:'allocation',scope_kind:'subject',scope_id:await budgetSubjectKey(h.env,h.payload()),max_concurrent:1,limits:{'currency:USD:micro':100}},'operator');
  assert.equal((await bal(h)).allocated,100);assert.equal((await bal(h)).available,82);
  await reserve(h.env,await h.access(),h.input('allocated'));
  assert.equal((await bal(h)).held,0,'earmark not charged twice');
  assert.equal((await budgetBalances(h.env,child.id))[0].held,91);
  await assert.rejects(updateBudgetAccount(h.env,child.id,{expected_revision:child.revision,paused:false,max_concurrent:1,limits:{'currency:USD:micro':50}},'operator'));
  await updateBudgetAccount(h.env,child.id,{expected_revision:child.revision,paused:true,max_concurrent:1,limits:{'currency:USD:micro':100}},'operator');
  await assert.rejects(updateBudgetAccount(h.env,child.id,{expected_revision:child.revision,paused:false,max_concurrent:1,limits:{'currency:USD:micro':100}},'operator'),/revision_conflict/);
  console.log('PASS earmarked allocation, no parent double debit, consumed grant shrink and stale CAS denial');
}finally{h.close();}

// Real authenticated routes reserve before any synthetic provider dispatch.
for(const protocol of ['openai-chat','anthropic-messages']){
 const profile=protocol==='openai-chat'?'studio-model-practice':'canary-sdk-contract',cohort=protocol==='openai-chat'?profile:'canary-internal';
 const h=await budgetHarness(undefined,{amount:1000000,cohort});
 try{
  const price=syntheticPrice('route-price',protocol);price.bounds['tokens:output']=20000;
  await publishUsagePrice(h.env,price);
  // Distinct model bindings can be appended only via a new explicit test root.
  h.db.prepare('DELETE FROM budget_runtime_prices WHERE root_id=?').run(h.root.account_id);
  h.db.prepare('INSERT INTO budget_runtime_prices VALUES (?,?,?,?,?)').run(h.root.account_id,price.provider,price.model,protocol,price.revision);
  await h.request(`/admin/access/cohorts/${cohort}/policy`,{method:'PUT',body:{expected_revision:0,required:true,allow_personal:false}});
  h.db.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(cohort,'Synthetic class');
  const session={session_id:'route-session',profile_id:profile,starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()};
  h.db.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)').run(session.session_id,cohort,profile,session.starts_at,session.ends_at);
  await h.env.HPS_KV.put(`cohort:${cohort}:active_session`,JSON.stringify(session));
  h.env.ANTHROPIC_API_KEY='synthetic-key';h.env.OPENAI_API_KEY='synthetic-key';
  const auth='Bearer '+(await issue({u:'kid01',c:cohort,p:profile},1,TEST_SECRET)).token;
  const path=protocol==='openai-chat'?'/v1/chat/completions':'/v1/messages';
  const body={model:price.model,max_tokens:10,stream:false,messages:[{role:'user',content:'synthetic test'}]};
  await withMockUpstream((url,init)=>{
    const attempt=h.db.prepare("SELECT * FROM usage_attempt_costs WHERE execution_state='sent'").get();assert(attempt,'durable reservation and sent state exist before fetch');
    const wire=JSON.parse(init.body);assert.equal(wire.service_tier,protocol==='openai-chat'?'default':'standard_only');
    return protocol==='openai-chat'?Response.json({model:price.model,service_tier:'default',choices:[{message:{content:'Synthetic'},finish_reason:'stop'}],usage:openaiRaw}):Response.json({model:price.model,content:[{type:'text',text:'Synthetic'}],usage:nativeRaw});
  },async calls=>{
    const noSource=await h.request(path,{auth,method:'POST',body});assert.equal(noSource.status,409,noSource.text);assert.equal(calls.length,0);
    const r=await h.request(path,{auth,method:'POST',body,headers:{'x-hps-funding-source':h.contract.contract_id,'x-hps-turn-id':'same-turn'}});assert.equal(r.status,200,r.text);assert.equal(calls.length,1);
    const balances=await bal(h);assert.equal(balances.held,0);assert.equal(balances.spent,protocol==='openai-chat'?38:32);
  });
  console.log('PASS authenticated '+path+': legacy-client denial, pre-dispatch reservation, one provider call, settled current balance');
 }finally{h.close();}
}

const personal=await budgetHarness();
try{
 const account='synthetic-account',id='studio-model-practice';
 assert.equal((await personal.request('/admin/access/accounts/'+account,{method:'PUT',body:{user_id:'personal-user',profile_id:id,active:true}})).status,200);
 const contract=syntheticEvent('personal-contract','account',account);await applyAccessEvent(personal.env,contract);
 const price=syntheticPrice('personal-openai','openai-chat');price.bounds['tokens:output']=100;await publishUsagePrice(personal.env,price);
 const root=await initializeBudget(personal.env,{period_id:contract.period.id,max_concurrent:2,subject_concurrency:1,price_revisions:[price.revision],exposure_ref:'synthetic-account'});
 const auth='Bearer '+(await issue({u:'personal-user',c:'',p:id,account},1,TEST_SECRET)).token;
 personal.env.OPENAI_API_KEY='synthetic-key';
 assert.equal((await personal.request('/v1/profile',{auth})).status,200);
 await withMockUpstream(()=>Response.json({model:price.model,service_tier:'default',choices:[{message:{content:'Synthetic personal'},finish_reason:'stop'}],usage:openaiRaw}),async calls=>{
  const r=await personal.request('/v1/chat/completions',{auth,method:'POST',body:{model:price.model,max_tokens:10,messages:[{role:'user',content:'synthetic'}]},headers:{'x-hps-funding-source':contract.contract_id}});assert.equal(r.status,200,r.text);assert.equal(calls.length,1);
 });
 assert.equal(personal.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0,'no invented class session');
 assert.equal((await budgetBalances(personal.env,root.account_id))[0].spent,38);
 console.log('PASS personal account executes and settles without class/session creation or request-limit fallback');
}finally{personal.close();}

const guard=await budgetHarness(undefined,{amount:10000});
try{
 const access=await guard.access(),input=guard.input('hosted-tool');
 for(const patch of [{tools:[{type:'web_search_20250305',name:'web_search'}]},{tools:[{name:'Write',input_schema:{type:'object'}}]},
  {messages:[{role:'user',content:[{type:'image',source:{type:'base64',data:'synthetic'}}]}]},{context_management:{edits:[]}}]){
  await assert.rejects(reserve(guard.env,access,{...input,body:{...input.body,...patch}}));
 }
 assert.equal(guard.db.prepare('SELECT COUNT(*) n FROM usage_attempt_costs').get().n,0);
 await reserve(guard.env,access,guard.input('locked-job','kid01',{turn_id:'immutable-turn'}));
 const other=syntheticEvent('other-source','cohort',guard.cohort);await applyAccessEvent(guard.env,other);
 await initializeBudget(guard.env,{period_id:other.period.id,max_concurrent:10,subject_concurrency:2,price_revisions:[guard.price.revision],exposure_ref:'synthetic-second-source'});
 const otherAccess=await resolveExecutionAccess(guard.env,guard.payload(),other.contract_id);
 await assert.rejects(reserve(guard.env,otherAccess,guard.input('no-source-switch','kid01',{turn_id:'immutable-turn'})),/job_funding_locked/);
 await applyAccessEvent(guard.env,{...guard.contract,event_id:'suspend',source_version:2,state:'suspended'});
 await assert.rejects(reserve(guard.env,access,guard.input('old-entitlement')),/admission_denied/);
 console.log('PASS paid hosted/media/tool negative controls, immutable turn funding and stale suspended entitlement');
}finally{guard.close();}

const org=await budgetHarness(undefined,{amount:1000});
try{
 const e=syntheticEvent('org-contract','organization','synthetic-org');
 org.db.prepare('INSERT INTO access_organizations VALUES (?)').run(e.subject.id);
 for(const c of [org.cohort,'class-two'])org.db.prepare('INSERT INTO access_org_cohorts VALUES (?,?)').run(e.subject.id,c);
 org.db.prepare('INSERT INTO access_accounts VALUES (?,?,?,1)').run('shared-account','global-user','studio-model-practice');
 for(const [c,u] of [[org.cohort,'kid01'],['class-two','other-seat']])org.db.prepare('INSERT INTO access_seats VALUES (?,?,?)').run(c,u,'shared-account');
 await applyAccessEvent(org.env,e);
 const r=await initializeBudget(org.env,{period_id:e.period.id,max_concurrent:10,subject_concurrency:1,price_revisions:[org.price.revision],exposure_ref:'synthetic-organization'});
 let root=await readBudgetAccount(org.env,r.account_id);
 for(const [id,c] of [['class-allocation-one',org.cohort],['class-allocation-two','class-two']]){
  await createBudgetChild(org.env,{id,parent_id:root.id,expected_parent_revision:root.revision,kind:'allocation',scope_kind:'cohort',scope_id:c,max_concurrent:5,limits:{'currency:USD:micro':400}},'operator');
  root=await readBudgetAccount(org.env,r.account_id);
 }
 const subject=await budgetSubjectKey(org.env,org.payload());
 const cap=await createBudgetChild(org.env,{id:'global-seat-cap',parent_id:root.id,expected_parent_revision:root.revision,kind:'cap',scope_kind:'subject',scope_id:subject,max_concurrent:1,limits:{'currency:USD:micro':100}},'operator');
 let ctx=await resolveExecutionAccess(org.env,org.payload(),e.contract_id);
 const a=await reserve(org.env,ctx,org.input('org-class-one'));
 const secondPayload={...org.payload('other-seat'),c:'class-two'};
 assert.equal(await budgetSubjectKey(org.env,secondPayload),subject);
 const second=await resolveExecutionAccess(org.env,secondPayload,e.contract_id);
 await assert.rejects(reserve(org.env,second,org.input('org-class-two','other-seat',{payload:secondPayload})),/admission_denied/);
 await recordCostEvidence(org.env,syntheticEvidence(a,normalizeCostUsage(a.protocol,nativeRaw)));
 await assert.rejects(reserve(org.env,second,org.input('global-cap-after-ended','other-seat',{payload:secondPayload})),/admission_denied/);
 assert.equal((await budgetBalances(org.env,r.account_id))[0].spent,0);
 assert.equal((await budgetBalances(org.env,r.account_id))[0].allocated,800);
 assert.equal((await budgetBalances(org.env,cap.id))[0].spent,32);
 // Reissuing token/time context cannot refill the global account cap.
 await assert.rejects(reserve(org.env,second,org.input('token-reissue','other-seat',{payload:{...secondPayload,iat:secondPayload.iat+1,jti:'synthetic-reissue'}})),/admission_denied/);
 console.log('PASS organization class allocations, stable cross-class account cap/slot and no token-reissue reset');
}finally{org.close();}

const rollback=await budgetHarness();
try{
 await rollback.request(`/admin/access/cohorts/${rollback.cohort}/policy`,{method:'PUT',body:{expected_revision:0,required:true,allow_personal:false}});
 rollback.env.HPS_ACCESS_CONTRACTS='disabled';
 await assert.rejects(resolveExecutionAccess(rollback.env,rollback.payload(),undefined),/access_not_configured/);
 assert.equal(rollback.db.prepare('SELECT COUNT(*) n FROM usage_attempt_costs').get().n,0);
 console.log('PASS disabling access publication cannot reopen a required class as legacy unmetered execution');
}finally{rollback.close();}
