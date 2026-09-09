import type { Context } from 'hono';
import type { Env } from '../env';
import type { TokenPayload } from './tokens';
import { AccessError, accessEnabled, accessDigest, accessJson, accessChoices, selectAccessChoice, accountForToken, permitsAccess, type AccessChoice } from './access-contracts';
import { readBudgetRoot, budgetSubjectKey, budgetAccountsForSubject, budgetBalances, type BudgetRoot } from './budgets';
import { readUsagePrice, computeUsageCost, validateUsageAttempt, usageAttemptStatements, markUsageAttemptSent, type UsageAttempt, type UsageMeter } from './usage-costs';
import { validTurnId } from './request-settings';

export interface ExecutionAccess {choice:AccessChoice;root:BudgetRoot;subject:string;account:string|null;policy_revision:number}
export async function resolveExecutionAccess(env:Env,p:TokenPayload,selected:string|undefined):Promise<ExecutionAccess|null>{
  if(!accessEnabled(env)){
    if(p.account||selected)throw new AccessError('access_not_configured',503);
    // Disabling publishing must never turn a previously required paid class
    // back into an unmetered legacy class. Only a pre-P1 schema is compatible.
    try{
      const policy=await env.HPS_DB.prepare('SELECT required FROM access_course_policies WHERE cohort_id=?').bind(p.c).first<{required:number}>();
      if(policy?.required)throw new AccessError('access_not_configured',503);
    }catch(error){
      if(!(error instanceof Error&&/no such table: access_course_policies/i.test(error.message)))throw error;
    }
    return null;
  }
  const policy=p.c?await env.HPS_DB.prepare('SELECT revision,required FROM access_course_policies WHERE cohort_id=?').bind(p.c).first<{revision:number;required:number}>():null;
  if(!p.account&&!selected&&!policy?.required)return null;
  const choice=selectAccessChoice(await accessChoices(env,p),selected);
  if(choice.plan.mode!=='included')throw new AccessError('external_execution_not_supported',403);
  return{choice,root:await readBudgetRoot(env,choice.contract.period.id),subject:await budgetSubjectKey(env,p),account:await accountForToken(env,p),policy_revision:policy?.revision??0};
}
export function budgetErrorResponse(c:Context<{Bindings:Env}>,error:unknown):Response{
  const known=error instanceof AccessError;
  if(!known)console.error('budget admission storage failure',error);
  const code=known?error.code:'budget_unavailable';
  const message=code==='funding_selection_required'?'이번 작업에 사용할 이용권을 선택해 주세요.':
    code==='budget_admission_denied'?'사용 가능한 예산 또는 동시 실행 한도에 도달했거나 설정이 변경되었습니다. 사용량을 확인해 주세요.':
    code==='job_funding_locked'?'진행 중인 작업의 이용권은 바꿀 수 없습니다. 새 대화에서 선택해 주세요.':
    known&&error.status===403?'이 이용권으로는 선택한 모델이나 기능을 사용할 수 없습니다.':
    '이용권과 사용 한도를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.';
  return c.json({error:{type:'access',code,message}},known?error.status:503);
}
export interface AdmissionRequest {
  request_id:string;turn_id?:string;session_id:string;payload:TokenPayload;
  provider:string;model:string;runtime:'proxy'|'agent-sdk';effort?:string|null;
  protocol:'anthropic-messages'|'openai-chat';body:Record<string,any>;features?:string[];
}
/** Validate the actual provider body, after lesson/profile transformations.
 * Bounds are an operator-reviewed maximum exposure, not a chars/token estimate.
 * Unmetered hosted tools/media cannot be smuggled into the paid gateway. */
function validateWire(body:Record<string,any>,protocol:AdmissionRequest['protocol'],features:string[]):void{
  if(body.modalities?.some((m:unknown)=>m!=='text')||body.audio||body.container||body.mcp_servers||body.context_management)
    throw new AccessError('unbounded_execution_feature',403);
  for(const tool of body.tools??[]){
    const local=protocol==='openai-chat'?tool?.type==='function':!tool?.type||tool.type==='custom';
    if(!local)throw new AccessError('unmetered_hosted_tool',403);
    const name=protocol==='openai-chat'?tool.function?.name:tool.name;
    const groups:Record<string,string>={Read:'read',Grep:'read',Glob:'read',Write:'write',Edit:'write',MultiEdit:'write',Bash:'shell',Task:'subagents',Agent:'subagents'};
    const browserNames=['browser_navigate','browser_read','browser_screenshot','browser_click','browser_type','browser_back','browser_forward','browser_dialog',
      'mcp__hypeproof__browser_open','mcp__hypeproof__browser_screenshot','mcp__hypeproof__browser_read','mcp__hypeproof__browser_click','mcp__hypeproof__browser_type','mcp__hypeproof__live_preview_start'];
    const feature=groups[name]??(browserNames.includes(name)?'browser':null);
    if(!feature||!features.includes(feature))throw new AccessError('tool_not_entitled_or_metered',403);
  }
  const visit=(value:any):void=>{
    if(Array.isArray(value)){value.forEach(visit);return;}
    if(!value||typeof value!=='object')return;
    if(['image','image_url','input_audio','document','video','file','server_tool_use','web_search_tool_result'].includes(value.type))throw new AccessError('unbounded_media_or_tool',403);
    Object.values(value).forEach(visit);
  };
  visit(body.messages);
}
export async function reserveBudgetAttempt(env:Env,access:ExecutionAccess,input:AdmissionRequest):Promise<UsageAttempt>{
  const {choice,root,subject,account}=access,p=input.payload,now=Date.now();
  if(!permitsAccess(choice,{model:input.model,effort:input.effort,runtime:input.runtime,features:[]}))throw new AccessError('entitlement_not_allowed',403);
  if(!['anthropic','openai'].includes(input.provider))throw new AccessError('metered_provider_not_supported',403);
  validateWire(input.body,input.protocol,(input.features??[]).filter(f=>choice.plan.allowed.features.includes(f)));
  const binding=await env.HPS_DB.prepare('SELECT price_revision FROM budget_runtime_prices WHERE root_id=? AND provider=? AND model=? AND protocol=?')
    .bind(root.account_id,input.provider,input.model,input.protocol).first<{price_revision:string}>();
  if(!binding)throw new AccessError('budget_price_not_configured',503);
  const price=await readUsagePrice(env,binding.price_revision);
  if(price.starts_at>now||price.ends_at<=now||price.region!==env.HPS_USAGE_REGION||price.service_tier!==(input.provider==='anthropic'?'standard':'default'))throw new AccessError('budget_price_dimensions_unconfirmed',503);
  input.body.service_tier=input.provider==='anthropic'?'standard_only':'default';
  if(input.provider==='anthropic')input.body.inference_geo=price.region;
  const expected:UsageMeter[]=input.protocol==='anthropic-messages'?['tokens:input','tokens:output','tokens:cache_read','tokens:cache_write:5m','tokens:cache_write:1h']:['tokens:input','tokens:output','tokens:cache_read','tokens:cache_write'];
  const meters:Partial<Record<UsageMeter,number>>={};
  for(const m of expected){const bound=price.bounds[m];if(!Number.isSafeInteger(bound)||!bound)throw new AccessError('usage_bound_missing',503);meters[m]=bound;}
  const output=input.body.max_completion_tokens??input.body.max_tokens;
  if(!Number.isSafeInteger(output)||output<1||output>meters['tokens:output']!)throw new AccessError('output_exceeds_reviewed_bound',403);
  meters['tokens:output']=output;
  const policy='policy:'+await accessDigest({plan:choice.plan.revision,profile:p.p,lesson:p.lesson??null,course:access.policy_revision,root:root.revision});
  if(input.turn_id!==undefined&&!validTurnId(input.turn_id))throw new AccessError('invalid_turn_id');
  const job='job:'+await accessDigest({subject,turn:input.turn_id??input.request_id});
  const prior=await env.HPS_DB.prepare('SELECT contract_id,period_id,policy_revision FROM usage_jobs WHERE id=?').bind(job).first<{contract_id:string;period_id:string;policy_revision:string}>();
  if(prior&&(prior.contract_id!==choice.contract.contract_id||prior.period_id!==root.period_id||prior.policy_revision!==policy))throw new AccessError('job_funding_locked',409);
  const attempt=validateUsageAttempt({request_id:input.request_id,job_id:job,subject_key:subject,cohort_id:p.c,user_id:p.u,session_id:input.session_id,
    contract_id:choice.contract.contract_id,period_id:root.period_id,policy_revision:policy,provider:input.provider,requested_model:input.model,
    protocol:input.protocol,price_revision:price.revision,started_at:now,expected_meters:expected});
  const quote=computeUsageCost(attempt,{id:'quote',request_id:attempt.request_id,version:1,source:'execution-proof',source_ref:price.revision,
    execution:'ended',returned_model:input.model,service_tier:price.service_tier,region:price.region,complete:true,meters,issues:[]},price);
  if(quote.state!=='priced'||quote.amount_micro===null)throw new AccessError('usage_bound_unpriced',503);
  const accounts=await budgetAccountsForSubject(env,root,p.c,subject);
  const lines:{account:string;meter:string;bound:number}[]=[];
  for(const a of accounts.charge){
    const limits=await budgetBalances(env,a.id);
    for(const l of limits){
      const bound=l.meter===`currency:${quote.currency}:micro`?quote.amount_micro:l.meter==='requests:count'?1:meters[l.meter as UsageMeter];
      if(bound===undefined)throw new AccessError('budget_meter_not_supported',503);
      lines.push({account:a.id,meter:l.meter,bound});
    }
  }
  // SQL reads execute in the same D1 transaction as the insertion. Independent
  // preflight reads are never treated as a reservation or a remaining balance.
  const tests:string[]=[],args:unknown[]=[];
  const guard=(sql:string,...values:unknown[])=>{tests.push(sql);args.push(...values);};
  guard(`EXISTS(SELECT 1 FROM access_contracts c JOIN access_periods p ON p.id=c.period_id WHERE c.id=? AND c.state='active' AND c.source_version=? AND p.id=? AND p.starts_at<=? AND p.ends_at>?)`,choice.contract.contract_id,choice.contract.source_version,root.period_id,now,now);
  guard('? > ?',p.exp*1000,now);
  guard('COALESCE((SELECT revision FROM access_course_policies WHERE cohort_id=?),0)=?',p.c,access.policy_revision);
  if(p.account)guard('EXISTS(SELECT 1 FROM access_accounts WHERE id=? AND active=1 AND user_id=? AND profile_id=?)',p.account,p.u,p.p);
  else guard(`COALESCE((SELECT a.id FROM access_seats s JOIN access_accounts a ON a.id=s.account_id AND a.active=1 WHERE s.cohort_id=? AND s.user_id=?),'')=?`,p.c,p.u,account??'');
  const owner=choice.contract.subject;
  if(owner.kind==='account')guard('?=? AND (?=\'\' OR EXISTS(SELECT 1 FROM access_course_policies WHERE cohort_id=? AND allow_personal=1))',owner.id,account,p.c,p.c);
  if(owner.kind==='cohort')guard('?=?',owner.id,p.c);
  if(owner.kind==='organization')guard(`EXISTS(SELECT 1 FROM access_org_cohorts WHERE organization_id=? AND cohort_id=? AND ?<>'') OR
    ((?='' OR EXISTS(SELECT 1 FROM access_course_policies WHERE cohort_id=? AND allow_personal=1)) AND EXISTS(SELECT 1 FROM access_org_members WHERE organization_id=? AND account_id=?))`,owner.id,p.c,p.c,p.c,p.c,owner.id,account);
  guard('EXISTS(SELECT 1 FROM budget_roots WHERE account_id=? AND revision=?)',root.account_id,root.revision);
  guard('EXISTS(SELECT 1 FROM budget_runtime_prices WHERE root_id=? AND provider=? AND model=? AND protocol=? AND price_revision=?)',root.account_id,input.provider,input.model,input.protocol,price.revision);
  // A dedicated child's deficit is not silently funded by another class.
  // Stop new execution across the affected period until its exposure is reviewed.
  guard('NOT EXISTS(SELECT 1 FROM budget_account_balances b JOIN budget_accounts x ON x.id=b.account_id WHERE x.period_id=? AND b.available<0)',root.period_id);
  const active="a.execution_state IN ('reserved','sent','unknown')";
  guard(`(SELECT COUNT(*) FROM budget_reservations r JOIN usage_attempt_costs a ON a.request_id=r.request_id WHERE r.root_id=? AND r.subject_key=? AND ${active})<?`,root.account_id,subject,root.subject_concurrency);
  for(const a of accounts.ancestors){
    guard('EXISTS(SELECT 1 FROM budget_accounts WHERE id=? AND paused=0 AND revision=?)',a.id,a.revision);
    // A pool's slots also cover allocated descendants, which have no pool charge lines.
    if(a.id===root.account_id)guard(`(SELECT COUNT(*) FROM budget_reservations r JOIN usage_attempt_costs a ON a.request_id=r.request_id WHERE r.root_id=? AND ${active})<?`,a.id,a.max_concurrent);
    else guard(`(SELECT COUNT(DISTINCT r.request_id) FROM budget_reservations r JOIN usage_attempt_costs a ON a.request_id=r.request_id
      WHERE ${active} AND (r.leaf_id=? OR EXISTS(SELECT 1 FROM budget_reservation_scopes l WHERE l.request_id=r.request_id AND l.account_id=?)))<?`,a.id,a.id,a.max_concurrent);
  }
  guard(`NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM budget_account_balances b
    WHERE b.account_id=json_extract(j.value,'$.account') AND b.meter=json_extract(j.value,'$.meter') AND b.available>=json_extract(j.value,'$.bound')))`,accessJson(lines));
  try{
    await env.HPS_DB.batch([
      ...usageAttemptStatements(env,attempt,await accessDigest(attempt)),
      env.HPS_DB.prepare(`INSERT INTO budget_reservations(request_id,root_id,leaf_id,subject_key,created_at,document,admitted) VALUES (?,?,?,?,?,?,CASE WHEN ${tests.map(t=>'('+t+')').join(' AND ')} THEN 1 ELSE 0 END)`)
        .bind(attempt.request_id,root.account_id,accounts.leaf.id,subject,now,accessJson({price:price.revision,quote,lines}),...args),
      ...accounts.ancestors.map(a=>env.HPS_DB.prepare('INSERT INTO budget_reservation_scopes(request_id,account_id) VALUES (?,?)').bind(attempt.request_id,a.id)),
      ...lines.map(l=>env.HPS_DB.prepare('INSERT INTO budget_reservation_lines(request_id,account_id,meter,bound) VALUES (?,?,?,?)').bind(attempt.request_id,l.account,l.meter,l.bound)),
    ]);
  }catch(error){
    if(error instanceof Error&&/constraint|admitted/i.test(error.message))throw new AccessError('budget_admission_denied',429);
    throw error;
  }
  return attempt;
}
/** Only one caller can transition the durable attempt to dispatched. A missing
 * acknowledgement remains reserved for explicit reconciliation; never retry it. */
export async function dispatchBudgetAttempt(env:Env,id:string):Promise<void>{
  if(!await markUsageAttemptSent(env,id))throw new AccessError('attempt_already_dispatched',409);
}
