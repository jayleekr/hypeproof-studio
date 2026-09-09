import type { Env } from '../env';
import type { TokenPayload } from './tokens';
import { AccessError, accessId, accessJson, accessDigest, accessChoices, type AccessChoice } from './access-contracts';
import { getRoster } from './kv';
import { budgetBalances, budgetSubjectKey, budgetAccountsForSubject, readBudgetRoot, readBudgetAccount, validateBudgetLimits, type BudgetMutationGuard, type BudgetAccount } from './budgets';

export interface BudgetDelegation {account_id:string;issuer_id:string;cohort_id:string;revision:number;active:number;max_concurrent:number;limits:string}
export async function publishBudgetDelegation(env:Env,value:any):Promise<BudgetDelegation>{
  if(!value||!accessId(value.account_id)||!accessId(value.issuer_id)||!accessId(value.cohort_id)||!Number.isSafeInteger(value.expected_revision)||value.expected_revision<0||typeof value.active!=='boolean'||!Number.isSafeInteger(value.max_concurrent)||value.max_concurrent<1||value.max_concurrent>10000)throw new AccessError('invalid_budget_delegation');
  validateBudgetLimits(value.limits);
  const a=await readBudgetAccount(env,value.account_id),balances=await budgetBalances(env,a.id);
  if(a.scope_kind!=='cohort'||a.scope_id!==value.cohort_id||!await getRoster(env.HPS_KV,value.cohort_id))throw new AccessError('delegation_class_mismatch',403);
  if(Object.keys(value.limits).length!==balances.length||balances.some(b=>!Object.hasOwn(value.limits,b.meter)))throw new AccessError('delegation_meter_mismatch');
  const nonce=crypto.randomUUID();
  const changes=await env.HPS_DB.batch([
    env.HPS_DB.prepare(`INSERT INTO budget_delegations(account_id,issuer_id,cohort_id,revision,active,max_concurrent,limits) SELECT ?,?,?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM budget_delegations WHERE account_id=? AND issuer_id=?)
      ON CONFLICT(account_id,issuer_id) DO UPDATE SET revision=excluded.revision,active=excluded.active,max_concurrent=excluded.max_concurrent,limits=excluded.limits WHERE budget_delegations.revision=? AND budget_delegations.cohort_id=excluded.cohort_id`)
      .bind(a.id,value.issuer_id,value.cohort_id,value.expected_revision+1,value.active?1:0,value.max_concurrent,accessJson(value.limits),value.expected_revision,a.id,value.issuer_id,value.expected_revision),
    env.HPS_DB.prepare('INSERT INTO budget_changes(id,account_id,actor,document,created_at) SELECT ?,?,?,?,? WHERE changes()=1')
      .bind(nonce,a.id,'operator',accessJson({kind:'delegation',input:value}),Date.now()),
  ]);
  if(changes[0]?.meta.changes!==1)throw new AccessError('delegation_revision_conflict',409);
  return (await env.HPS_DB.prepare('SELECT * FROM budget_delegations WHERE account_id=? AND issuer_id=?').bind(a.id,value.issuer_id).first<BudgetDelegation>())!;
}
async function delegationFor(env:Env,cohort:string,issuer:string,account:string){
  const d=await env.HPS_DB.prepare('SELECT * FROM budget_delegations WHERE account_id=? AND issuer_id=? AND cohort_id=? AND active=1').bind(account,issuer,cohort).first<BudgetDelegation>();
  if(!d)throw new AccessError('budget_delegation_required',403);
  const guard:BudgetMutationGuard={sql:'EXISTS(SELECT 1 FROM budget_delegations WHERE account_id=? AND issuer_id=? AND cohort_id=? AND revision=? AND active=1)',args:[account,issuer,cohort,d.revision]};
  return{d,guard};
}
/** Called only after the existing issuer scope gate. The SQL guard is consumed
 * inside the budget mutation transaction, so concurrent revocation wins. */
export async function delegatedBudgetMutation(env:Env,cohort:string,issuer:string|null,target:BudgetAccount,input:any,creating=false):Promise<BudgetMutationGuard|undefined>{
  const base=creating?target:target.scope_kind==='subject'&&target.parent_id?await readBudgetAccount(env,target.parent_id):target;
  if(base.scope_kind!=='cohort'||base.scope_id!==cohort)throw new AccessError('budget_class_scope_denied',403);
  if(!issuer)return undefined; // Already authenticated operator, not Chalk.
  const {d,guard}=await delegationFor(env,cohort,issuer,base.id);
  validateBudgetLimits(input.limits);const ceiling=JSON.parse(d.limits),current=creating?[]:await budgetBalances(env,target.id);
  const unchanged=(m:string,n:unknown)=>current.some(b=>b.meter===m&&b.granted===n);
  if(!Number.isSafeInteger(input.max_concurrent)||(input.max_concurrent>d.max_concurrent&&(creating||input.max_concurrent!==target.max_concurrent))||Object.keys(input.limits).length!==Object.keys(ceiling).length||Object.entries(input.limits).some(([m,n])=>!Object.hasOwn(ceiling,m)||((n as number)>ceiling[m]&&!unchanged(m,n))))throw new AccessError('budget_delegation_ceiling',403);
  return guard;
}
const projectedAccount=(a:BudgetAccount)=>({id:a.id,parent_id:a.parent_id,kind:a.kind,scope_kind:a.scope_kind,scope_id:a.scope_id,revision:a.revision,paused:!!a.paused,max_concurrent:a.max_concurrent});
export async function classBudgetView(env:Env,cohort:string,issuer:string|null){
  const bases=await env.HPS_DB.prepare("SELECT * FROM budget_accounts WHERE scope_kind='cohort' AND scope_id=? ORDER BY period_id,id LIMIT 101").bind(cohort).all<BudgetAccount>();
  const rows=[];
  const roster=await getRoster(env.HPS_KV,cohort);
  const links=await env.HPS_DB.prepare('SELECT s.user_id,s.account_id FROM access_seats s JOIN access_accounts a ON a.id=s.account_id AND a.active=1 WHERE s.cohort_id=?').bind(cohort).all<{user_id:string;account_id:string}>();
  const linked=new Map(links.results.map(s=>[s.user_id,s.account_id]));
  const seats=await Promise.all((roster?.users??[]).slice(0,500).map(async user=>({user_id:user,subject_key:'subject:'+await accessDigest(linked.has(user)?{account:linked.get(user)}:{cohort,user})})));
  for(const base of bases.results.slice(0,100)){
    const d=issuer?await env.HPS_DB.prepare('SELECT * FROM budget_delegations WHERE account_id=? AND issuer_id=? AND active=1').bind(base.id,issuer).first<BudgetDelegation>():null;
    const children=await env.HPS_DB.prepare("SELECT * FROM budget_accounts WHERE parent_id=? AND scope_kind='subject' ORDER BY id LIMIT 501").bind(base.id).all<BudgetAccount>();
    const requests=await env.HPS_DB.prepare("SELECT id,user_id,note,state,resolution,created_at FROM budget_requests WHERE account_id=? ORDER BY created_at DESC LIMIT 101").bind(base.id).all();
    const allBalances=await env.HPS_DB.prepare(`SELECT b.* FROM budget_account_balances b WHERE b.account_id=? OR b.account_id IN (SELECT id FROM budget_accounts WHERE parent_id=? AND scope_kind='subject' ORDER BY id LIMIT 500)`).bind(base.id,base.id).all<import('./budgets').BudgetBalance>();
    for(const b of allBalances.results)for(const k of ['granted','available','spent','held','overrun','allocated','unresolved'] as const)if(!Number.isSafeInteger(b[k]))throw new AccessError('budget_aggregate_overflow',503);
    rows.push({account:projectedAccount(base),balances:allBalances.results.filter(b=>b.account_id===base.id),can_edit:!issuer||!!d,
      delegation:d?{revision:d.revision,max_concurrent:d.max_concurrent,limits:JSON.parse(d.limits)}:null,
      children:children.results.slice(0,500).map(a=>({account:projectedAccount(a),balances:allBalances.results.filter(b=>b.account_id===a.id)})),requests:requests.results.slice(0,100),
      truncated:children.results.length>500||requests.results.length>100});
  }
  return{schema:'hps-class-budget/1',cohort,as_of:new Date().toISOString(),budgets:rows,seats,truncated:bases.results.length>100||(roster?.users.length??0)>500,forecast:{state:'unavailable',reason:'검증된 실제 수업 사용 분포가 아직 없습니다.'}};
}
async function choiceUsage(env:Env,p:TokenPayload,choice:AccessChoice,subject:string){
  const {contract,plan}=choice;
  const active=contract.state==='active'&&contract.period.starts_at<=Date.now()&&contract.period.ends_at>Date.now();
  const base={id:contract.contract_id,period_id:contract.period.id,plan_revision:plan.revision,label:plan.label,source_kind:contract.subject.kind,mode:plan.mode,
    starts_at:contract.period.starts_at,ends_at:contract.period.ends_at,included:plan.included,allowed:plan.allowed,policy:plan.policy,active};
  if(plan.mode==='byo')return{...base,available:false,state:'external_unknown',resources:[],can_request:false};
  try{
    const root=await readBudgetRoot(env,contract.period.id),accounts=await budgetAccountsForSubject(env,root,p.c,subject);
    const sets=await Promise.all(accounts.charge.map(a=>budgetBalances(env,a.id)));
    const resources=[];
    for(const first of sets[0]??[]){
      const same=sets.map(s=>s.find(b=>b.meter===first.meter)!);
      const own=await env.HPS_DB.prepare(`SELECT COALESCE(SUM(b.spent),0) spent,COALESCE(SUM(b.held),0) held,COALESCE(SUM(b.overrun),0) overrun,COALESCE(SUM(CASE WHEN b.final=0 THEN 1 ELSE 0 END),0) unresolved
        FROM budget_line_balances b JOIN budget_reservations r ON r.request_id=b.request_id WHERE b.account_id=? AND b.meter=? AND r.subject_key=?`)
        .bind(accounts.charge[0]!.id,first.meter,subject).first<{spent:number;held:number;overrun:number;unresolved:number}>();
      resources.push({meter:first.meter,limit:Math.min(...same.map(b=>b.granted)),remaining:Math.min(...same.map(b=>b.available)),shared:accounts.charge.some(a=>a.scope_kind!=='subject'),...own});
    }
    const deficit=await env.HPS_DB.prepare('SELECT 1 FROM budget_account_balances b JOIN budget_accounts a ON a.id=b.account_id WHERE a.period_id=? AND b.available<0 LIMIT 1').bind(root.period_id).first();
    const paused=accounts.ancestors.some(a=>a.paused),available=active&&!paused&&!deficit&&resources.every(r=>r.remaining>0);
    const pending=await env.HPS_DB.prepare("SELECT id,state,created_at,note,resolution FROM budget_requests WHERE period_id=? AND subject_key=? ORDER BY created_at DESC LIMIT 1").bind(root.period_id,subject).first();
    return{...base,available,state:!active?'ended':paused?'paused':deficit?'review_required':available?'ready':'exhausted',resources,pending_request:pending,can_request:active&&!!p.c&&accounts.ancestors.some(a=>a.scope_kind==='cohort'&&a.scope_id===p.c)};
  }catch(error){
    if(error instanceof AccessError&&['budget_not_configured','class_budget_assignment_missing'].includes(error.code))return{...base,available:false,state:'not_configured',resources:[],can_request:false};
    throw error;
  }
}
export async function participantAccessView(env:Env,p:TokenPayload){
  const choices=await accessChoices(env,p,Date.now(),true),subject=await budgetSubjectKey(env,p);
  const policy=p.c?await env.HPS_DB.prepare('SELECT required FROM access_course_policies WHERE cohort_id=?').bind(p.c).first<{required:number}>():null;
  return{schema:'hps-access-view/1',configured:true,required:!!p.account||!!policy?.required,selection_required:true,as_of:new Date().toISOString(),
    choices:await Promise.all(choices.slice(0,100).map(choice=>choiceUsage(env,p,choice,subject))),truncated:choices.length>100};
}
export async function requestBudgetHelp(env:Env,p:TokenPayload,value:any){
  if(!value||!accessId(value.source_id)||typeof value.note!=='string'||value.note.trim().length<1||value.note.length>280)throw new AccessError('invalid_budget_request');
  const choice=(await accessChoices(env,p)).find(c=>c.contract.contract_id===value.source_id);
  if(!choice||!p.c)throw new AccessError('class_budget_required',403);
  const root=await readBudgetRoot(env,choice.contract.period.id),subject=await budgetSubjectKey(env,p),accounts=await budgetAccountsForSubject(env,root,p.c,subject);
  const base=accounts.ancestors.find(a=>a.scope_kind==='cohort'&&a.scope_id===p.c);
  if(!base)throw new AccessError('class_budget_required',403);
  await env.HPS_DB.prepare(`INSERT INTO budget_requests(id,period_id,account_id,subject_key,cohort_id,user_id,note,state,created_at) VALUES (?,?,?,?,?,?,?,'pending',?) ON CONFLICT DO NOTHING`)
    .bind(crypto.randomUUID(),root.period_id,base.id,subject,p.c,p.u,value.note.trim(),Date.now()).run();
  return env.HPS_DB.prepare("SELECT id,state,note,created_at FROM budget_requests WHERE period_id=? AND subject_key=? AND state='pending'").bind(root.period_id,subject).first();
}
export async function resolveBudgetHelp(env:Env,cohort:string,issuer:string|null,id:string,value:any){
  if(typeof value?.resolution!=='string'||!value.resolution.trim()||value.resolution.length>280)throw new AccessError('invalid_budget_resolution');
  const r=await env.HPS_DB.prepare('SELECT account_id FROM budget_requests WHERE id=? AND cohort_id=?').bind(id,cohort).first<{account_id:string}>();
  if(!r)throw new AccessError('budget_request_not_found',404);
  const guard=issuer?(await delegationFor(env,cohort,issuer,r.account_id)).guard:undefined;
  const result=await env.HPS_DB.prepare(`UPDATE budget_requests SET state='resolved',resolution=?,resolved_by=?,resolved_at=? WHERE id=? AND state='pending' AND (${guard?.sql??'1'})`)
    .bind(value.resolution.trim(),issuer??'operator',Date.now(),id,...(guard?.args??[])).run();
  if(result.meta.changes!==1)throw new AccessError('request_or_delegation_changed',409);
  return{ok:true,budget_effect:'none'};
}
