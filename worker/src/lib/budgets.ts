import type { Env } from '../env';
import type { TokenPayload } from './tokens';
import { AccessError, accessId, accessJson, accessDigest, requireAccessEnabled, readAccessPlan, accountForToken, type AccessEvent } from './access-contracts';
import { readUsagePrice, USAGE_METERS } from './usage-costs';

export interface BudgetAccount {
  id:string;period_id:string;parent_id:string|null;kind:'pool'|'allocation'|'cap';
  scope_kind:'root'|'cohort'|'subject';scope_id:string;max_concurrent:number;paused:number;revision:number;
}
export interface BudgetRoot {period_id:string;account_id:string;subject_concurrency:number;revision:number;document:string;digest:string}
export interface BudgetBalance {account_id:string;meter:string;granted:number;allocated:number;spent:number;held:number;overrun:number;unapplied_credit:number;unresolved:number;available:number}
export interface BudgetRootInput {period_id:string;max_concurrent:number;subject_concurrency:number;price_revisions:string[];exposure_ref:string}
export interface BudgetChildInput {id:string;parent_id:string;expected_parent_revision:number;kind:'allocation'|'cap';scope_kind:'cohort'|'subject';scope_id:string;max_concurrent:number;limits:Record<string,number>}
export interface BudgetUpdate {expected_revision:number;paused:boolean;max_concurrent:number;limits:Record<string,number>}
const obj=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const slots=(v:unknown):v is number=>integer(v)&&v>=1&&v<=10000;
function check(ok:unknown,code:string,status:400|403|404|409|503=400):asserts ok{if(!ok)throw new AccessError(code,status);}
export const budgetMeter=(v:string):boolean=>USAGE_METERS.includes(v as typeof USAGE_METERS[number])||/^currency:[A-Z]{3}:micro$/.test(v)||v==='requests:count';
export function validateBudgetLimits(v:unknown):asserts v is Record<string,number>{
  check(obj(v)&&Object.keys(v).length>0&&Object.keys(v).length<=16&&Object.entries(v).every(([m,n])=>budgetMeter(m)&&integer(n)),'invalid_budget_limits');
}
export async function budgetSubjectKey(env:Env,p:TokenPayload):Promise<string>{
  const account=await accountForToken(env,p);
  return 'subject:'+await accessDigest(account?{account}:{cohort:p.c,user:p.u});
}
export async function readBudgetAccount(env:Env,id:string):Promise<BudgetAccount>{
  const a=await env.HPS_DB.prepare('SELECT * FROM budget_accounts WHERE id=?').bind(id).first<BudgetAccount>();
  if(!a)throw new AccessError('budget_account_not_found',404);return a;
}
export async function readBudgetRoot(env:Env,period:string):Promise<BudgetRoot>{
  const r=await env.HPS_DB.prepare('SELECT * FROM budget_roots WHERE period_id=?').bind(period).first<BudgetRoot>();
  if(!r)throw new AccessError('budget_not_configured',503);return r;
}
export async function budgetBalances(env:Env,id:string):Promise<BudgetBalance[]>{
  const r=await env.HPS_DB.prepare('SELECT * FROM budget_account_balances WHERE account_id=? ORDER BY meter').bind(id).all<BudgetBalance>();
  for(const row of r.results)for(const field of ['granted','allocated','spent','held','overrun','unapplied_credit','unresolved','available'] as const)check(Number.isSafeInteger(row[field]),'budget_aggregate_overflow',503);
  return r.results;
}
export async function initializeBudget(env:Env,value:unknown):Promise<BudgetRoot>{
  requireAccessEnabled(env);
  check(obj(value)&&accessId(value.period_id)&&slots(value.max_concurrent)&&slots(value.subject_concurrency)&&value.subject_concurrency<=value.max_concurrent&&Array.isArray(value.price_revisions)&&value.price_revisions.length>0&&value.price_revisions.length<=64&&value.price_revisions.every(accessId)&&typeof value.exposure_ref==='string'&&value.exposure_ref.length>0&&value.exposure_ref.length<=300,'invalid_budget_root');
  const input=value as BudgetRootInput;
  const period=await env.HPS_DB.prepare('SELECT contract_id,plan_revision FROM access_periods WHERE id=?').bind(input.period_id).first<{contract_id:string;plan_revision:string}>();
  check(period,'budget_period_not_found',404);
  const plan=await readAccessPlan(env,period.plan_revision);check(plan.mode==='included','external_budget_not_supported',409);
  const limits=Object.fromEntries(plan.included.map(m=>[m.meter,m.amount]));validateBudgetLimits(limits);
  const contractRow=await env.HPS_DB.prepare('SELECT document FROM access_contracts WHERE id=?').bind(period.contract_id).first<{document:string}>();check(contractRow,'budget_contract_not_found',404);
  const contract:AccessEvent=JSON.parse(contractRow.document);
  const prices=await Promise.all(input.price_revisions.map(rev=>readUsagePrice(env,rev)));
  check(new Set(prices.map(p=>[p.provider,p.model,p.protocol].join(':'))).size===prices.length,'ambiguous_budget_prices');
  for(const p of prices)check(plan.allowed.models.includes(p.model),'budget_price_model_not_entitled',403);
  const id='pool:'+await accessDigest(input.period_id),digest=await accessDigest(input);
  const statements=[
    env.HPS_DB.prepare(`INSERT INTO budget_accounts(id,period_id,parent_id,kind,scope_kind,scope_id,max_concurrent)
      VALUES (?,?,NULL,'pool',?,?,?) ON CONFLICT DO NOTHING`).bind(id,input.period_id,contract.subject.kind==='cohort'?'cohort':'root',contract.subject.id,input.max_concurrent),
    env.HPS_DB.prepare(`INSERT INTO budget_roots(period_id,account_id,subject_concurrency,document,digest) VALUES (?,?,?,?,?)
      ON CONFLICT(period_id) DO UPDATE SET digest=CASE WHEN budget_roots.digest=excluded.digest THEN budget_roots.digest ELSE NULL END`)
      .bind(input.period_id,id,input.subject_concurrency,accessJson(input),digest),
    ...Object.entries(limits).map(([m,n])=>env.HPS_DB.prepare('INSERT INTO budget_limits(account_id,meter,granted) VALUES (?,?,?) ON CONFLICT DO NOTHING').bind(id,m,n)),
    ...prices.map(p=>env.HPS_DB.prepare('INSERT INTO budget_runtime_prices(root_id,provider,model,protocol,price_revision) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING').bind(id,p.provider,p.model,p.protocol,p.revision)),
  ];
  await env.HPS_DB.batch(statements);return readBudgetRoot(env,input.period_id);
}
export async function createBudgetChild(env:Env,value:unknown,actor:string):Promise<BudgetAccount>{
  requireAccessEnabled(env);
  check(obj(value)&&accessId(value.id)&&accessId(value.parent_id)&&integer(value.expected_parent_revision)&&value.expected_parent_revision>0&&['allocation','cap'].includes(value.kind)&&['cohort','subject'].includes(value.scope_kind)&&accessId(value.scope_id)&&slots(value.max_concurrent),'invalid_budget_child');
  validateBudgetLimits(value.limits);const input=value as BudgetChildInput,parent=await readBudgetAccount(env,input.parent_id);
  check(input.kind!=='allocation'||parent.kind!=='cap','allocation_under_cap_forbidden',409);
  check(parent.scope_kind!=='subject'&&(input.scope_kind!=='cohort'||(!parent.parent_id&&parent.scope_kind==='root')),'unsupported_budget_hierarchy',409);
  const ancestors=await budgetAncestors(env,parent.id);check(ancestors.length<8,'budget_nesting_limit',409);
  const parentLimits=await budgetBalances(env,parent.id);
  check(parentLimits.length===Object.keys(input.limits).length&&parentLimits.every(l=>Object.hasOwn(input.limits,l.meter)),'budget_meter_set_mismatch');
  const predicates:string[]=[],args:unknown[]=[];
  for(const [meter,amount]of Object.entries(input.limits)){
    predicates.push(`EXISTS(SELECT 1 FROM budget_account_balances WHERE account_id=? AND meter=? AND ${input.kind==='allocation'?'available':'granted'}>=?)`);
    args.push(parent.id,meter,amount);
  }
  await env.HPS_DB.batch([
    env.HPS_DB.prepare(`INSERT INTO budget_accounts(id,period_id,parent_id,kind,scope_kind,scope_id,max_concurrent,guard)
      VALUES (?,?,?,?,?,?,?,CASE WHEN EXISTS(SELECT 1 FROM budget_accounts WHERE id=? AND revision=? AND paused=0)
        AND ${predicates.join(' AND ')} THEN 1 ELSE 0 END)`)
      .bind(input.id,parent.period_id,parent.id,input.kind,input.scope_kind,input.scope_id,input.max_concurrent,parent.id,input.expected_parent_revision,...args),
    ...Object.entries(input.limits).map(([m,n])=>env.HPS_DB.prepare('INSERT INTO budget_limits(account_id,meter,granted) VALUES (?,?,?)').bind(input.id,m,n)),
    env.HPS_DB.prepare('UPDATE budget_accounts SET revision=revision+1 WHERE id=?').bind(parent.id),
    env.HPS_DB.prepare('INSERT INTO budget_changes(id,account_id,actor,document,created_at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(),input.id,actor,accessJson({kind:'created',input}),Date.now()),
  ]);
  return readBudgetAccount(env,input.id);
}
export async function updateBudgetAccount(env:Env,id:string,value:unknown,actor:string):Promise<BudgetAccount>{
  requireAccessEnabled(env);check(obj(value)&&integer(value.expected_revision)&&value.expected_revision>0&&typeof value.paused==='boolean'&&slots(value.max_concurrent),'invalid_budget_update');
  validateBudgetLimits(value.limits);const input=value as BudgetUpdate,a=await readBudgetAccount(env,id),own=await budgetBalances(env,id);
  check(own.length===Object.keys(input.limits).length&&own.every(l=>Object.hasOwn(input.limits,l.meter)),'budget_meter_set_mismatch');
  const conditions:string[]=[],args:unknown[]=[];
  for(const l of own){
    const desired=input.limits[l.meter]!;
    check(a.kind!=='pool'||desired===l.granted,'root_grant_is_contract_owned',403);
    if(desired===l.granted)continue; // Pausing remains possible after a late overrun.
    conditions.push('EXISTS(SELECT 1 FROM budget_account_balances WHERE account_id=? AND meter=? AND allocated+spent+held<=?)');args.push(id,l.meter,desired);
    if(a.parent_id){conditions.push(`EXISTS(SELECT 1 FROM budget_account_balances WHERE account_id=? AND meter=? AND ${a.kind==='allocation'?'available+?':'granted'}>=?)`);
      args.push(a.parent_id,l.meter,...(a.kind==='allocation'?[l.granted]:[]),desired);}
  }
  const nonce=crypto.randomUUID();
  const results=await env.HPS_DB.batch([
    env.HPS_DB.prepare(`UPDATE budget_accounts SET revision=revision+1,paused=?,max_concurrent=?,mutation_id=?,guard=CASE WHEN ${conditions.length?conditions.join(' AND '):'1'} THEN 1 ELSE 0 END WHERE id=? AND revision=?`)
      .bind(input.paused?1:0,input.max_concurrent,nonce,...args,id,input.expected_revision),
    ...Object.entries(input.limits).map(([m,n])=>env.HPS_DB.prepare('UPDATE budget_limits SET granted=? WHERE account_id=? AND meter=? AND EXISTS(SELECT 1 FROM budget_accounts WHERE id=? AND mutation_id=?)').bind(n,id,m,id,nonce)),
    env.HPS_DB.prepare(`UPDATE budget_accounts SET revision=revision+1 WHERE id=? AND EXISTS(SELECT 1 FROM budget_accounts WHERE id=? AND mutation_id=?)`).bind(a.parent_id,id,nonce),
    env.HPS_DB.prepare('INSERT INTO budget_changes(id,account_id,actor,document,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM budget_accounts WHERE id=? AND mutation_id=?)')
      .bind(nonce,id,actor,accessJson({kind:'updated',before:{account:a,limits:own},input}),Date.now(),id,nonce),
  ]);
  if(results[0]?.meta.changes!==1)throw new AccessError('budget_revision_conflict',409);
  return readBudgetAccount(env,id);
}
/** The full ancestry is used for pause/revision checks, even above an allocation. */
export async function budgetAncestors(env:Env,id:string):Promise<BudgetAccount[]>{
  const rows:BudgetAccount[]=[];let current:string|null=id;
  while(current){check(rows.length<8&&!rows.some(r=>r.id===current),'invalid_budget_hierarchy',409);const a=await readBudgetAccount(env,current);rows.push(a);current=a.parent_id;}
  return rows;
}
export async function budgetAccountsForSubject(env:Env,root:BudgetRoot,cohort:string,subject:string):Promise<{leaf:BudgetAccount;charge:BudgetAccount[];ancestors:BudgetAccount[]}>{
  const rootAccount=await readBudgetAccount(env,root.account_id);let base=rootAccount;
  const owner=await env.HPS_DB.prepare('SELECT c.subject_kind FROM access_periods p JOIN access_contracts c ON c.id=p.contract_id WHERE p.id=?').bind(root.period_id).first<{subject_kind:string}>();
  if(cohort&&owner?.subject_kind==='organization'){
    const row=await env.HPS_DB.prepare("SELECT * FROM budget_accounts WHERE period_id=? AND scope_kind='cohort' AND scope_id=? AND parent_id=?").bind(root.period_id,cohort,root.account_id).first<BudgetAccount>();
    if(!row)throw new AccessError('class_budget_assignment_missing',403);base=row;
  }
  const seat=await env.HPS_DB.prepare("SELECT * FROM budget_accounts WHERE parent_id=? AND scope_kind='subject' AND scope_id=?").bind(base.id,subject).first<BudgetAccount>();
  const leaf=seat??base,ancestors=await budgetAncestors(env,leaf.id),charge:BudgetAccount[]=[];
  for(const a of ancestors){charge.push(a);if(a.kind!=='cap')break;}
  // An optional global subject cap spans several classes/allocations. It is only
  // a ceiling; adding it must not charge its pool ancestor a second time.
  if(base.id!==root.account_id){
    const global=await env.HPS_DB.prepare("SELECT * FROM budget_accounts WHERE parent_id=? AND kind='cap' AND scope_kind='subject' AND scope_id=?").bind(root.account_id,subject).first<BudgetAccount>();
    if(global&&!charge.some(a=>a.id===global.id)){charge.push(global);ancestors.push(global);}
  }
  return{leaf,charge,ancestors};
}
