import './harness/loader.mjs';
import assert from 'node:assert/strict';
import {budgetHarness} from './harness/budgets.mjs';
const {budgetSubjectKey,readBudgetAccount,updateBudgetAccount,budgetBalances}=await import('../src/lib/budgets.ts');
const {delegatedBudgetMutation}=await import('../src/lib/budget-views.ts');
const {reserveBudgetAttempt}=await import('../src/lib/budget-admission.ts');
const h=await budgetHarness();
try{
 const base='/admin/cohorts/'+h.cohort;
 const q=(path,method='GET',body,auth=h.instructor)=>h.request(path,{method,body,auth});
 let r=await q(base+'/budgets');assert.equal(r.status,200,r.text);assert.equal(r.json.budgets[0].can_edit,false);
 const subject=await budgetSubjectKey(h.env,h.payload()),root=h.root.account_id;
 const child={id:'teacher-seat-cap',parent_id:root,expected_parent_revision:1,kind:'cap',scope_kind:'subject',scope_id:subject,max_concurrent:1,limits:{'currency:USD:micro':100}};
 assert.equal((await q(base+'/budgets/children','POST',child)).status,403,'issuer role alone is not budget authority');
 const d={account_id:root,issuer_id:'synthetic-teacher',cohort_id:h.cohort,expected_revision:0,active:true,max_concurrent:2,limits:{'currency:USD:micro':1000}};
 assert.equal((await q('/admin/access/budget-delegations','PUT',d,h.admin)).status,200);
 assert.equal((await q('/admin/access/budget-delegations','PUT',d)).status,401,'instructor cannot grant own authority');
 assert.equal((await q(base+'/budgets/children','POST',{...child,limits:{'currency:USD:micro':1001}})).status,403);
 assert.equal((await q(base+'/budgets/children','POST',{...child,scope_id:'subject:someone-else'})).status,403);
 assert.equal((await q(base+'/budgets/children','POST',child,h.student)).status,403);
 r=await q(base+'/budgets/children','POST',child);assert.equal(r.status,201,r.text);
 const cap=r.json;
 const update={expected_revision:cap.revision,paused:true,max_concurrent:1,limits:{'currency:USD:micro':100}};
 assert.equal((await q('/admin/cohorts/other-class/budgets/'+cap.id,'PUT',update)).status,403);
 assert.equal((await q(base+'/budgets/'+cap.id,'PUT',update)).status,200);
 assert.equal((await q(base+'/budgets/'+cap.id,'PUT',update)).status,409);
 assert.equal((await q('/admin/access/budget-ledger/'+root)).status,401);
 r=await q('/v1/access','GET',undefined,h.student);assert.equal(r.status,200,r.text);assert.equal(r.json.choices[0].state,'paused');assert.equal(r.json.choices[0].resources[0].remaining,100);
 for(const field of ['payer','invoice_ref','issuer_id','synthetic-teacher','source_key'])assert(!r.text.includes(field));
 r=await q('/v1/access/requests','POST',{source_id:h.contract.contract_id,note:'마무리 검증을 위한 추가 사용 요청'},h.student);assert.equal(r.status,201,r.text);const request=r.json;
 const replay=await q('/v1/access/requests','POST',{source_id:h.contract.contract_id,note:'duplicate'},h.student);assert.equal(replay.json.id,request.id);
 assert.equal((await q(base+'/budget-requests/'+request.id,'PUT',{resolution:'학생 상한을 검토했습니다.'})).status,200);
 assert.equal((await budgetBalances(h.env,cap.id))[0].granted,100,'resolving request does not mint budget');
 const fresh=await readBudgetAccount(h.env,cap.id),newUpdate={...update,expected_revision:fresh.revision,paused:false};
 const authority=await delegatedBudgetMutation(h.env,h.cohort,'synthetic-teacher',fresh,newUpdate);
 assert.equal((await q('/admin/access/budget-delegations','PUT',{...d,expected_revision:1,active:false},h.admin)).status,200);
 await assert.rejects(updateBudgetAccount(h.env,cap.id,newUpdate,'synthetic-teacher',authority),'in-transaction delegation revocation');
 assert.equal((await readBudgetAccount(h.env,cap.id)).paused,1);
 console.log('PASS issuer + budget delegation, class/student/operator isolation, grant ceilings, CAS, requests without credit minting and transactional revoke');
 // Ended contracts retain own usage display, but cannot be selected for execution.
 h.db.prepare("UPDATE access_contracts SET state='ended',document=json_set(document,'$.state','ended') WHERE id=?").run(h.contract.contract_id);
 r=await q('/v1/access','GET',undefined,h.student);assert.equal(r.json.choices[0].state,'ended');assert.equal(r.json.choices[0].available,false);
 console.log('PASS expired/ended own access remains readable, and selection reports unavailable');
}finally{h.close();}

const historical=await budgetHarness();
try{
 const {recordCostEvidence,normalizeCostUsage}=await import('../src/lib/usage-costs.ts');
 const {syntheticEvidence,nativeRaw}=await import('./harness/usage-costs.mjs');
 const {createBudgetChild}=await import('../src/lib/budgets.ts');
 const a=await reserveBudgetAttempt(historical.env,await historical.access(),historical.input('before-new-cap'));
 await recordCostEvidence(historical.env,syntheticEvidence(a,normalizeCostUsage(a.protocol,nativeRaw)));
 const child={id:'later-cap',parent_id:historical.root.account_id,expected_parent_revision:1,kind:'cap',scope_kind:'subject',scope_id:await budgetSubjectKey(historical.env,historical.payload()),max_concurrent:1,limits:{'currency:USD:micro':50}};
 await assert.rejects(createBudgetChild(historical.env,{...child,id:'below-used',limits:{'currency:USD:micro':10}},'operator'));
 await createBudgetChild(historical.env,child,'operator');
 const b=(await budgetBalances(historical.env,child.id))[0];assert.equal(b.spent,32);assert.equal(b.available,18);
 assert.equal((await budgetBalances(historical.env,historical.root.account_id))[0].spent,32,'new cap does not spend parent twice');
 console.log('PASS creating a period cap after usage includes prior spend and cannot reset or undercut it');
}finally{historical.close();}
