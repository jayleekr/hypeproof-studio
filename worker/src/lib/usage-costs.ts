import type { Env } from '../env';
import { AccessError, accessDigest, accessId, accessJson, requireAccessEnabled } from './access-contracts';

export const USAGE_METERS = ['tokens:input','tokens:output','tokens:cache_read','tokens:cache_write','tokens:cache_write:5m','tokens:cache_write:1h',
  'tool:web_search:requests','tool:web_fetch:requests','browser:seconds','computer:seconds','execution:seconds','storage:byte-seconds'] as const;
export type UsageMeter = typeof USAGE_METERS[number];
export interface UsagePrice {
  schema: 'hps-usage-price/1'; revision: string; publication: 'synthetic' | 'approved';
  source: { url: string; revision: string; checked_at: number };
  provider: string; model: string; protocol: 'anthropic-messages' | 'openai-chat' | 'metered-tool';
  service_tier: string; region: string; starts_at: number; ends_at: number;
  currency: string; rounding: 'ceil-per-meter';
  rates: Partial<Record<UsageMeter,{numerator:number;denominator:number}>>;
  /** Explicit accepted exposure, never derived from a guessed chars/token ratio. */
  bounds: Partial<Record<UsageMeter,number>>;
  fx: { revision:string; currency:string; numerator:number; denominator:number; source:string } | null;
}
export interface UsageAttempt {
  request_id: string; job_id: string; subject_key: string;
  cohort_id: string; user_id: string; session_id: string;
  contract_id: string; period_id: string; policy_revision: string;
  provider: string; requested_model: string; protocol: UsagePrice['protocol'];
  price_revision: string | null; started_at: number;
  /** Only meters the server expects from this call. SDK tools are individual attempts. */
  expected_meters: UsageMeter[];
}
export interface CostEvidence {
  id: string; request_id: string; version: number;
  source: 'provider-response' | 'provider-reconciliation' | 'execution-proof'; source_ref: string;
  execution: 'ended' | 'unknown' | 'not_sent';
  returned_model: string | null; service_tier: string | null; region: string | null;
  complete: boolean; meters: Partial<Record<UsageMeter,number | null>>;
  issues: string[];
  /** Explicit historical correction; the original reservation quote remains intact. */
  reconciled_price_revision?: string;
}
export interface ComputedCost {
  state: 'unpriced' | 'partial' | 'priced';
  amount_micro: number | null; currency: string | null;
  native_amount_micro: number | null; native_currency: string | null;
  price_revision: string | null; fx_revision: string | null;
  issues: string[];
}
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const object = (v: unknown): v is Record<string,any> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v:Record<string,unknown>,names:string[]) => Object.keys(v).every(k=>names.includes(k));
function check(ok: unknown, code: string): asserts ok { if(!ok)throw new AccessError(code); }
function safeAmount(v: bigint): number { if(v<0n||v>BigInt(Number.MAX_SAFE_INTEGER))throw new AccessError('cost_overflow',409);return Number(v); }
function ceilRatio(amount:number,numerator:number,denominator:number):number {
  return safeAmount((BigInt(amount)*BigInt(numerator)+BigInt(denominator)-1n)/BigInt(denominator));
}
export function validateUsagePrice(value: unknown): UsagePrice {
  check(object(value)&&keys(value,['schema','revision','publication','source','provider','model','protocol','service_tier','region','starts_at','ends_at','currency','rounding','rates','bounds','fx'])&&value.schema==='hps-usage-price/1'&&accessId(value.revision),'invalid_usage_price');
  check(['synthetic','approved'].includes(value.publication)&&object(value.source)&&typeof value.source.url==='string'&&/^https:\/\//.test(value.source.url)&&accessId(value.source.revision)&&count(value.source.checked_at),'invalid_price_source');
  check(accessId(value.provider)&&accessId(value.model)&&['anthropic-messages','openai-chat','metered-tool'].includes(value.protocol)&&accessId(value.service_tier)&&accessId(value.region),'invalid_price_dimensions');
  check(count(value.starts_at)&&count(value.ends_at)&&value.ends_at>value.starts_at&&/^[A-Z]{3}$/.test(value.currency)&&value.rounding==='ceil-per-meter','invalid_price_period');
  check(object(value.rates)&&Object.keys(value.rates).length>0&&object(value.bounds),'invalid_price_rates');
  for(const [meter,rate] of Object.entries(value.rates))check(USAGE_METERS.includes(meter as UsageMeter)&&object(rate)&&count(rate.numerator)&&count(rate.denominator)&&rate.denominator>0,'invalid_meter_rate');
  for(const [meter,bound] of Object.entries(value.bounds))check(USAGE_METERS.includes(meter as UsageMeter)&&count(bound)&&bound>0&&meter in value.rates,'invalid_meter_bound');
  check(value.fx===null||(object(value.fx)&&accessId(value.fx.revision)&&/^[A-Z]{3}$/.test(value.fx.currency)&&value.fx.currency!==value.currency&&count(value.fx.numerator)&&value.fx.numerator>0&&count(value.fx.denominator)&&value.fx.denominator>0&&typeof value.fx.source==='string'&&value.fx.source.length>0),'invalid_fx_policy');
  return value as UsagePrice;
}
async function approvedPrice(env:Env,price:UsagePrice,digest:string):Promise<void> {
  if(price.publication==='synthetic') {if(env.ENVIRONMENT!=='dev')throw new AccessError('synthetic_price_forbidden',403);}
  else if(!(env.HPS_USAGE_APPROVED_PRICE_DIGESTS??'').split(',').includes(digest))throw new AccessError('usage_price_not_approved',403);
}
export async function publishUsagePrice(env:Env,value:unknown):Promise<UsagePrice> {
  requireAccessEnabled(env);const price=validateUsagePrice(value),digest=await accessDigest(price);
  await approvedPrice(env,price,digest);
  await env.HPS_DB.prepare('INSERT INTO usage_price_revisions(revision,digest,document) VALUES (?,?,?) ON CONFLICT DO NOTHING').bind(price.revision,digest,accessJson(price)).run();
  const saved=await env.HPS_DB.prepare('SELECT digest FROM usage_price_revisions WHERE revision=?').bind(price.revision).first<{digest:string}>();
  if(saved?.digest!==digest)throw new AccessError('usage_price_revision_conflict',409);
  return price;
}
export async function readUsagePrice(env:Env,revision:string,mode:'admission'|'historical'='admission'):Promise<UsagePrice> {
  const row=await env.HPS_DB.prepare('SELECT document,digest FROM usage_price_revisions WHERE revision=?').bind(revision).first<{document:string;digest:string}>();
  if(!row)throw new AccessError('usage_price_not_found',404);
  const price=validateUsagePrice(JSON.parse(row.document));
  if(await accessDigest(price)!==row.digest)throw new AccessError('usage_price_integrity_failure',503);
  if(mode==='admission'||price.publication==='synthetic')await approvedPrice(env,price,row.digest);
  return price;
}
export function validateUsageAttempt(value:unknown):UsageAttempt {
  check(object(value)&&keys(value,['request_id','job_id','subject_key','cohort_id','user_id','session_id','contract_id','period_id','policy_revision','provider','requested_model','protocol','price_revision','started_at','expected_meters']),'invalid_usage_attempt');
  for(const field of ['request_id','job_id','subject_key','user_id','session_id','contract_id','period_id','policy_revision','provider','requested_model'])check(accessId(value[field]),'invalid_attempt_'+field);
  check(value.cohort_id===''||accessId(value.cohort_id),'invalid_attempt_cohort');
  check(['anthropic-messages','openai-chat','metered-tool'].includes(value.protocol)&&(value.price_revision===null||accessId(value.price_revision))&&count(value.started_at),'invalid_attempt_dimensions');
  check(Array.isArray(value.expected_meters)&&value.expected_meters.length>0&&value.expected_meters.every((m:UsageMeter)=>USAGE_METERS.includes(m))&&new Set(value.expected_meters).size===value.expected_meters.length,'invalid_expected_meters');
  const core=value.protocol==='anthropic-messages'?['tokens:input','tokens:output','tokens:cache_read','tokens:cache_write:5m','tokens:cache_write:1h']:
    value.protocol==='openai-chat'?['tokens:input','tokens:output','tokens:cache_read','tokens:cache_write']:[];
  check(core.every(m=>value.expected_meters.includes(m)),'missing_expected_token_meters');
  return value as UsageAttempt;
}
/** Register attribution against the existing attempt, or create that same identity once.
 * P3 includes these statements in the reservation transaction before dispatch. */
export function usageAttemptStatements(env:Env,a:UsageAttempt,digest:string):D1PreparedStatement[] {
  return [
    env.HPS_DB.prepare(`INSERT INTO usage_jobs(id,subject_key,contract_id,period_id,policy_revision,created_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET subject_key=CASE WHEN usage_jobs.subject_key=excluded.subject_key AND usage_jobs.contract_id=excluded.contract_id
        AND usage_jobs.period_id=excluded.period_id AND usage_jobs.policy_revision=excluded.policy_revision THEN usage_jobs.subject_key ELSE NULL END`)
      .bind(a.job_id,a.subject_key,a.contract_id,a.period_id,a.policy_revision,a.started_at),
    env.HPS_DB.prepare(`INSERT INTO model_usage_requests(request_id,cohort_id,user_id,session_id,provider,requested_model) VALUES (?,?,?,?,?,?)
      ON CONFLICT(request_id) DO UPDATE SET user_id=CASE WHEN model_usage_requests.cohort_id=excluded.cohort_id AND model_usage_requests.user_id=excluded.user_id
        AND model_usage_requests.session_id=excluded.session_id AND model_usage_requests.provider=excluded.provider AND model_usage_requests.requested_model=excluded.requested_model
        THEN model_usage_requests.user_id ELSE NULL END`).bind(a.request_id,a.cohort_id,a.user_id,a.session_id,a.provider,a.requested_model),
    env.HPS_DB.prepare(`INSERT INTO usage_attempt_costs(request_id,job_id,price_revision,document,digest,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(request_id) DO UPDATE SET digest=CASE WHEN usage_attempt_costs.digest=excluded.digest THEN usage_attempt_costs.digest ELSE NULL END`)
      .bind(a.request_id,a.job_id,a.price_revision,accessJson(a),digest,a.started_at),
  ];
}
export async function registerUsageAttempt(env:Env,value:unknown):Promise<UsageAttempt> {
  requireAccessEnabled(env);const a=validateUsageAttempt(value);
  const period=await env.HPS_DB.prepare('SELECT contract_id FROM access_periods WHERE id=?').bind(a.period_id).first<{contract_id:string}>();
  if(period?.contract_id!==a.contract_id)throw new AccessError('attempt_period_mismatch',409);
  if(a.price_revision) {
    const price=await readUsagePrice(env,a.price_revision);
    if(price.provider!==a.provider||price.protocol!==a.protocol||price.model!==a.requested_model||price.starts_at>a.started_at||price.ends_at<=a.started_at)throw new AccessError('attempt_price_mismatch',409);
  }
  await env.HPS_DB.batch(usageAttemptStatements(env,a,await accessDigest(a)));return a;
}
export async function markUsageAttemptSent(env:Env,id:string):Promise<boolean> {
  const r=await env.HPS_DB.prepare("UPDATE usage_attempt_costs SET execution_state='sent',updated_at=? WHERE request_id=? AND execution_state='reserved'").bind(Date.now(),id).run();
  return r.meta.changes===1;
}
export function validateCostEvidence(value:unknown):CostEvidence {
  check(object(value)&&keys(value,['id','request_id','version','source','source_ref','execution','returned_model','service_tier','region','complete','meters','issues','reconciled_price_revision'])&&accessId(value.id)&&accessId(value.request_id)&&count(value.version)&&value.version>0,'invalid_cost_evidence');
  check(['provider-response','provider-reconciliation','execution-proof'].includes(value.source)&&typeof value.source_ref==='string'&&value.source_ref.length>0&&value.source_ref.length<=300,'invalid_evidence_source');
  check(['ended','unknown','not_sent'].includes(value.execution)&&typeof value.complete==='boolean','invalid_execution_evidence');
  for(const k of ['returned_model','service_tier','region'])check(value[k]===null||accessId(value[k]),'invalid_evidence_dimensions');
  check(object(value.meters)&&Object.entries(value.meters).every(([m,v])=>USAGE_METERS.includes(m as UsageMeter)&&(v===null||count(v))),'invalid_usage_meters');
  check(Array.isArray(value.issues)&&value.issues.length<=32&&value.issues.every(accessId),'invalid_evidence_issues');
  if(value.reconciled_price_revision!==undefined)check(value.source==='provider-reconciliation'&&accessId(value.reconciled_price_revision),'invalid_price_reconciliation');
  if(value.execution==='not_sent')check(value.source==='execution-proof'&&value.complete===true&&Object.values(value.meters).every(v=>v===0)&&value.issues.length===0,'invalid_not_sent_proof');
  return value as CostEvidence;
}
export function computeUsageCost(a:UsageAttempt,e:CostEvidence,price:UsagePrice|null):ComputedCost {
  const result:ComputedCost={state:'unpriced',amount_micro:null,currency:price?.fx?.currency??price?.currency??null,
    native_amount_micro:null,native_currency:price?.currency??null,price_revision:price?.revision??null,fx_revision:price?.fx?.revision??null,issues:[...e.issues]};
  if(!price){result.issues.push('price_missing');return result;}
  if(e.execution==='not_sent')return{...result,state:'priced',amount_micro:0,native_amount_micro:0};
  if(e.returned_model!==price.model||a.provider!==price.provider||a.protocol!==price.protocol||e.service_tier!==price.service_tier||e.region!==price.region||a.started_at<price.starts_at||a.started_at>=price.ends_at){result.issues.push('price_dimensions_unconfirmed');return result;}
  let total=0n,priced=0;
  const meters=new Set<UsageMeter>([...a.expected_meters,...Object.keys(e.meters) as UsageMeter[]]);
  for(const meter of meters){
    const amount=e.meters[meter],rate=price.rates[meter];
    if(amount===null||amount===undefined){result.issues.push('missing:'+meter);continue;}
    if(amount===0){priced++;continue;}
    if(!rate){result.issues.push('unpriced:'+meter);continue;}
    total+=BigInt(ceilRatio(amount,rate.numerator,rate.denominator));priced++;
  }
  if(!e.complete)result.issues.push('measurement_incomplete');
  if(priced){result.native_amount_micro=safeAmount(total);result.amount_micro=price.fx?ceilRatio(result.native_amount_micro,price.fx.numerator,price.fx.denominator):result.native_amount_micro;}
  result.state=result.issues.length===0?'priced':priced?'partial':'unpriced';return result;
}
/** Whitelist billing counts only. Never persist messages, prompts, response text or keys. */
export function normalizeCostUsage(protocol:UsagePrice['protocol'],raw:unknown):Pick<CostEvidence,'meters'|'issues'> {
  const r=object(raw)?raw:{},meters:CostEvidence['meters']={},issues:string[]=[];
  const n=(v:unknown):number|null=>count(v)?v:null;
  if(protocol==='metered-tool'){
    for(const [m,v] of Object.entries(object(r.meters)?r.meters:{})){
      if(USAGE_METERS.includes(m as UsageMeter))meters[m as UsageMeter]=n(v);else issues.push('unsupported_meter');
    }
    return{meters,issues};
  }
  if(protocol==='anthropic-messages'){
    meters['tokens:input']=n(r.input_tokens);meters['tokens:output']=n(r.output_tokens);meters['tokens:cache_read']=n(r.cache_read_input_tokens);
    const aggregate=n(r.cache_creation_input_tokens),five=n(r.cache_creation?.ephemeral_5m_input_tokens),hour=n(r.cache_creation?.ephemeral_1h_input_tokens);
    if(aggregate===0&&(five??0)===0&&(hour??0)===0){meters['tokens:cache_write:5m']=0;meters['tokens:cache_write:1h']=0;}
    else if(five!==null&&hour!==null&&aggregate!==null&&five+hour===aggregate){meters['tokens:cache_write:5m']=five;meters['tokens:cache_write:1h']=hour;}
    else {meters['tokens:cache_write:5m']=null;meters['tokens:cache_write:1h']=null;issues.push('cache_write_ttl_unconfirmed');}
    for(const [key,value] of Object.entries(object(r.server_tool_use)?r.server_tool_use:{})){
      if(key==='web_search_requests')meters['tool:web_search:requests']=n(value);
      else if(key==='web_fetch_requests')meters['tool:web_fetch:requests']=n(value);
      else if(value!==0)issues.push('unsupported_server_tool_meter');
    }
  }else{
    const input=n(r.prompt_tokens),output=n(r.completion_tokens),read=n(r.prompt_tokens_details?.cached_tokens),write=n(r.prompt_tokens_details?.cache_write_tokens);
    const valid=input!==null&&read!==null&&write!==null&&read+write<=input;
    meters['tokens:input']=valid?input!-read!-write!:null;meters['tokens:output']=output;
    meters['tokens:cache_read']=valid?read:null;meters['tokens:cache_write']=valid?write:null;
    if(!valid)issues.push('input_cache_split_unconfirmed');
    const total=n(r.total_tokens);if(input===null||output===null||total===null||input+output!==total)issues.push('token_total_unconfirmed');
    // Reasoning and predicted output counts are inclusive in completion_tokens.
    // Audio/image prices need dedicated dimensions; never price those as text.
    if([r.prompt_tokens_details?.audio_tokens,r.prompt_tokens_details?.image_tokens].some(v=>v!==undefined&&v!==0)){
      issues.push('non_text_tokens');for(const m of ['tokens:input','tokens:cache_read','tokens:cache_write'] as const)meters[m]=null;
    }
    if(r.completion_tokens_details?.audio_tokens!==undefined&&r.completion_tokens_details.audio_tokens!==0){issues.push('non_text_tokens');meters['tokens:output']=null;}
  }
  return{meters,issues:[...new Set(issues)]};
}
export async function recordCostEvidence(env:Env,value:unknown):Promise<ComputedCost & {evidence_version:number;applied:boolean}> {
  requireAccessEnabled(env);const e=validateCostEvidence(value),digest=await accessDigest(e);
  const row=await env.HPS_DB.prepare('SELECT document,execution_state FROM usage_attempt_costs WHERE request_id=?').bind(e.request_id).first<{document:string;execution_state:string}>();
  if(!row)throw new AccessError('usage_attempt_not_found',404);
  if(e.execution==='not_sent'&&!['reserved','not_sent'].includes(row.execution_state))throw new AccessError('attempt_already_dispatched',409);
  const a:UsageAttempt=JSON.parse(row.document),revision=e.reconciled_price_revision??a.price_revision;
  const price=revision?await readUsagePrice(env,revision,'historical'):null;
  const cost=computeUsageCost(a,e,price);
  const results=await env.HPS_DB.batch([
    env.HPS_DB.prepare('INSERT INTO usage_cost_evidence(id,request_id,version,digest,document,cost_document,received_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .bind(e.id,e.request_id,e.version,digest,accessJson(e),accessJson(cost),Date.now()),
    env.HPS_DB.prepare(`UPDATE usage_attempt_costs SET evidence_id=?,evidence_version=?,execution_state=?,pricing_state=?,amount_micro=?,currency=?,updated_at=?
      WHERE request_id=? AND evidence_version<? AND EXISTS(SELECT 1 FROM usage_cost_evidence WHERE id=? AND digest=?)
        AND (?<>'not_sent' OR execution_state IN ('reserved','not_sent'))`)
      .bind(e.id,e.version,e.execution,cost.state,cost.amount_micro,cost.currency,Date.now(),e.request_id,e.version,e.id,digest,e.execution),
  ]);
  const saved=await env.HPS_DB.prepare('SELECT digest FROM usage_cost_evidence WHERE id=?').bind(e.id).first<{digest:string}>();
  if(saved?.digest!==digest)throw new AccessError('cost_evidence_conflict',409);
  const current=await env.HPS_DB.prepare(`SELECT a.evidence_version,e.cost_document FROM usage_attempt_costs a
    JOIN usage_cost_evidence e ON e.id=a.evidence_id WHERE a.request_id=?`).bind(e.request_id).first<{evidence_version:number;cost_document:string}>();
  if(!current)throw new AccessError('execution_evidence_conflict',409);
  return {...JSON.parse(current.cost_document),evidence_version:current.evidence_version,applied:results[1]?.meta.changes===1};
}

/** Invoked by both real HTTP routes. P3 creates attribution before dispatch;
 * legacy requests without an attribution remain explicitly unpriced. */
export async function captureUsageCost(env:Env,id:string,meta:{usage:unknown;model:string|null;tier:string|null;region:string|null;complete:boolean;ended:boolean}):Promise<void> {
  if(env.HPS_ACCESS_CONTRACTS!=='enabled')return;
  const row=await env.HPS_DB.prepare('SELECT document FROM usage_attempt_costs WHERE request_id=?').bind(id).first<{document:string}>();
  if(!row)return;
  const a:UsageAttempt=JSON.parse(row.document);
  const normalized=normalizeCostUsage(a.protocol,meta.usage);
  await recordCostEvidence(env,{id:id+':response',request_id:id,version:1,source:'provider-response',source_ref:id,
    execution:meta.ended?'ended':'unknown',returned_model:meta.model,service_tier:meta.tier,region:meta.region,
    complete:meta.complete,...normalized});
}

export async function usageJobCosts(env:Env,id:string) {
  const job=await env.HPS_DB.prepare('SELECT * FROM usage_jobs WHERE id=?').bind(id).first();
  if(!job)throw new AccessError('usage_job_not_found',404);
  const attempts=await env.HPS_DB.prepare(`SELECT a.request_id,a.price_revision,a.execution_state,a.evidence_version,a.pricing_state,a.amount_micro,a.currency,e.cost_document
    FROM usage_attempt_costs a LEFT JOIN usage_cost_evidence e ON e.id=a.evidence_id WHERE a.job_id=? ORDER BY a.request_id LIMIT 1001`).bind(id).all();
  const adjustments=await env.HPS_DB.prepare(`SELECT x.id,x.request_id,x.invoice_ref,x.currency,x.amount_micro,x.reason,x.created_at FROM usage_invoice_adjustments x
    JOIN usage_attempt_costs a ON a.request_id=x.request_id WHERE a.job_id=? ORDER BY x.created_at,x.id LIMIT 1001`).bind(id).all();
  return{job,attempts:attempts.results.slice(0,1000),adjustments:adjustments.results.slice(0,1000),as_of:new Date().toISOString(),
    truncated:attempts.results.length>1000||adjustments.results.length>1000,aggregation:'one-cost-per-attempt',historical_usage_log:'not-added',payment_effect:'none'};
}
export async function recordInvoiceAdjustment(env:Env,value:unknown):Promise<void> {
  requireAccessEnabled(env);check(object(value)&&keys(value,['id','request_id','invoice_ref','currency','amount_micro','reason'])&&accessId(value.id)&&accessId(value.request_id)&&typeof value.invoice_ref==='string'&&value.invoice_ref.length>0&&value.invoice_ref.length<=300&&/^[A-Z]{3}$/.test(value.currency)&&Number.isSafeInteger(value.amount_micro)&&typeof value.reason==='string'&&value.reason.length>0&&value.reason.length<=300,'invalid_invoice_adjustment');
  const attempt=await env.HPS_DB.prepare('SELECT execution_state FROM usage_attempt_costs WHERE request_id=?').bind(value.request_id).first<{execution_state:string}>();
  if(attempt?.execution_state==='not_sent'&&value.amount_micro!==0)throw new AccessError('invoice_execution_conflict',409);
  const digest=await accessDigest(value);
  await env.HPS_DB.prepare(`INSERT INTO usage_invoice_adjustments(id,request_id,invoice_ref,currency,amount_micro,reason,digest,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
    .bind(value.id,value.request_id,value.invoice_ref,value.currency,value.amount_micro,value.reason,digest,Date.now()).run();
  const saved=await env.HPS_DB.prepare('SELECT digest FROM usage_invoice_adjustments WHERE id=?').bind(value.id).first<{digest:string}>();
  if(saved?.digest!==digest)throw new AccessError('invoice_adjustment_conflict',409);
}
