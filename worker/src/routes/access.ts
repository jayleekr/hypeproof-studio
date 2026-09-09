import { publishBudgetDelegation, delegatedBudgetMutation, classBudgetView, participantAccessView, requestBudgetHelp, resolveBudgetHelp } from '../lib/budget-views';
import { initializeBudget, createBudgetChild, updateBudgetAccount, readBudgetAccount, budgetBalances } from '../lib/budgets';
import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import { bearer, verify, issue, TokenError, type TokenPayload } from '../lib/tokens';
import { getRoster, isTokenRevoked } from '../lib/kv';
import { getProfile } from '../profiles';
import { crossProviderEnabled } from '../profiles/types';
import { publishUsagePrice, registerUsageAttempt, recordCostEvidence, recordInvoiceAdjustment, usageJobCosts } from '../lib/usage-costs';
import { authorizeIssuerForCohort } from '../lib/instructor-auth';
import { AccessError, accessEnabled, requireAccessEnabled, accessId, publishAccessPlan, applyAccessEvent,
  accountForToken, readAccessAccount, accessDigest, type AccessEvent } from '../lib/access-contracts';

type AccessContext = Context<{ Bindings: Env }>;
/** Existing HMAC identity and roster, usable when paid execution/session has ended. */
export async function accessPrincipal(c: AccessContext): Promise<TokenPayload> {
  const token = bearer(c.req.header('authorization'));
  if (!token) throw new AccessError('authentication_required',401);
  let p: TokenPayload;
  try { p = await verify(token,c.env.HPS_SIGNING_SECRET); }
  catch (e) { if (e instanceof TokenError) throw new AccessError(e.code,401); throw e; }
  if (p.role === 'issuer') throw new AccessError('participant_required',403);
  if (p.jti && await isTokenRevoked(c.env.HPS_KV,p.jti)) throw new AccessError('revoked',401);
  if (p.account) {
    requireAccessEnabled(c.env);
    await accountForToken(c.env,p);
  } else {
    if (getProfile(p.p)?.session.cohort_id !== p.c || !(await getRoster(c.env.HPS_KV,p.c))?.users.includes(p.u)) throw new AccessError('participant_unavailable',403);
  }
  return p;
}
function errorHandler(error: Error, c: AccessContext): Response {
  if (error instanceof AccessError) return c.json({error:{code:error.code,type:'access',message:error.code}},error.status);
  if (error instanceof SyntaxError) return c.json({error:{code:'invalid_json',type:'access'}},400);
  // D1 constraint errors contain SQL, never echo them to users.
  if (/constraint failed|UNIQUE constraint|NOT NULL constraint/i.test(error.message)) return c.json({error:{code:'contract_revision_conflict',type:'access'}},409);
  console.error('access storage failure',error);
  return c.json({error:{code:'access_unavailable',type:'access'}},503);
}
export const access = new Hono<{Bindings:Env}>();
access.onError(errorHandler);
access.get('/',async c => {
  const p = await accessPrincipal(c);
  if (!accessEnabled(c.env)) return c.json({schema:'hps-access-view/1',configured:false,as_of:new Date().toISOString(),choices:[]});
  c.header('cache-control','no-store');
  return c.json(await participantAccessView(c.env,p));
});

access.post('/requests',async c=>{requireAccessEnabled(c.env);if((await c.req.text()).length>4096)throw new AccessError('access_document_too_large');const p=await accessPrincipal(c);return c.json(await requestBudgetHelp(c.env,p,await c.req.json()),201);});

/** Mounted behind the existing admin gate. Issuers get only the scoped GET. */
export const accessAdmin = new Hono<{Bindings:Env}>();
accessAdmin.onError(errorHandler);
for (const path of ['/access/*','/cohorts/:cohort/access','/cohorts/:cohort/budgets','/cohorts/:cohort/budgets/*','/cohorts/:cohort/budget-requests/*']) accessAdmin.use(path,async(c,next)=>{requireAccessEnabled(c.env);c.header('cache-control','no-store');await next();});
accessAdmin.use('/access/*',async(c,next)=>{
  if (c.req.method !== 'GET') {
    const text=await c.req.text();
    if (text.length>32768) throw new AccessError('access_document_too_large');
    const body=JSON.parse(text);
    if(!body||typeof body!=='object'||Array.isArray(body))throw new AccessError('invalid_access_document');
  }
  await next();
});
for(const path of ['/cohorts/:cohort/budgets/*','/cohorts/:cohort/budget-requests/*'])accessAdmin.use(path,async(c,next)=>{
  if(c.req.method!=='GET'){const raw=await c.req.text();if(raw.length>32768)throw new AccessError('access_document_too_large');}
  await next();
});
accessAdmin.put('/access/budget-delegations',async c=>c.json(await publishBudgetDelegation(c.env,await c.req.json())));
accessAdmin.get('/access/budget-roots',async c=>{
  const rows=await c.env.HPS_DB.prepare('SELECT r.account_id,r.period_id,c.id contract_id,c.subject_kind,c.subject_id,c.state,p.starts_at,p.ends_at FROM budget_roots r JOIN access_periods p ON p.id=r.period_id JOIN access_contracts c ON c.id=p.contract_id ORDER BY p.starts_at DESC LIMIT 101').all();
  return c.json({as_of:new Date().toISOString(),roots:rows.results.slice(0,100),truncated:rows.results.length>100});
});
accessAdmin.get('/access/budget-ledger/:id',async c=>{
  const id=c.req.param('id');await readBudgetAccount(c.env,id);
  const rows=await c.env.HPS_DB.prepare(`SELECT r.request_id,r.subject_key,r.created_at,a.job_id,a.price_revision,a.execution_state,a.evidence_version,a.pricing_state,a.amount_micro,a.currency,
    json_extract(a.document,'$.provider') provider,json_extract(a.document,'$.requested_model') model,json_extract(r.document,'$.quote.amount_micro') reserved_quote,
    (SELECT COALESCE(SUM(x.amount_micro),0) FROM usage_invoice_adjustments x WHERE x.request_id=r.request_id AND x.currency=a.currency) invoice_adjustment
    FROM budget_reservations r JOIN usage_attempt_costs a ON a.request_id=r.request_id WHERE r.root_id=? ORDER BY r.created_at DESC,r.request_id LIMIT 101`).bind(id).all();
  const audit=await c.env.HPS_DB.prepare('SELECT id,actor,document,created_at FROM budget_changes WHERE account_id=? ORDER BY created_at DESC LIMIT 101').bind(id).all();
  return c.json({as_of:new Date().toISOString(),attempts:rows.results.slice(0,100),audit:audit.results.slice(0,100),truncated:rows.results.length>100||audit.results.length>100});
});
accessAdmin.get('/cohorts/:cohort/budgets',async c=>{
  const cohort=c.req.param('cohort'),auth=await authorizeIssuerForCohort(c,cohort);if(auth instanceof Response)return auth;
  return c.json(await classBudgetView(c.env,cohort,auth?.payload.u??null));
});
accessAdmin.post('/cohorts/:cohort/budgets/children',async c=>{
  const cohort=c.req.param('cohort'),auth=await authorizeIssuerForCohort(c,cohort);if(auth instanceof Response)return auth;
  const body=await c.req.json(),parent=await readBudgetAccount(c.env,body.parent_id);
  if(body.scope_kind!=='subject')throw new AccessError('student_budget_only',403);
  const view=await classBudgetView(c.env,cohort,auth?.payload.u??null);
  if(!view.seats.some(s=>s.subject_key===body.scope_id))throw new AccessError('student_not_in_class',403);
  const guard=await delegatedBudgetMutation(c.env,cohort,auth?.payload.u??null,parent,body,true);
  return c.json(await createBudgetChild(c.env,body,auth?.payload.u??'operator',guard),201);
});
accessAdmin.put('/cohorts/:cohort/budgets/:id',async c=>{
  const cohort=c.req.param('cohort'),auth=await authorizeIssuerForCohort(c,cohort);if(auth instanceof Response)return auth;
  const body=await c.req.json(),target=await readBudgetAccount(c.env,c.req.param('id'));
  const guard=await delegatedBudgetMutation(c.env,cohort,auth?.payload.u??null,target,body);
  return c.json(await updateBudgetAccount(c.env,target.id,body,auth?.payload.u??'operator',guard));
});
accessAdmin.put('/cohorts/:cohort/budget-requests/:id',async c=>{
  const cohort=c.req.param('cohort'),auth=await authorizeIssuerForCohort(c,cohort);if(auth instanceof Response)return auth;
  return c.json(await resolveBudgetHelp(c.env,cohort,auth?.payload.u??null,c.req.param('id'),await c.req.json()));
});
accessAdmin.post('/access/budgets',async c=>c.json(await initializeBudget(c.env,await c.req.json()),201));
accessAdmin.post('/access/budgets/children',async c=>c.json(await createBudgetChild(c.env,await c.req.json(),'operator'),201));
accessAdmin.put('/access/budgets/:id',async c=>c.json(await updateBudgetAccount(c.env,c.req.param('id'),await c.req.json(),'operator')));
accessAdmin.get('/access/budgets/:id',async c=>c.json({account:await readBudgetAccount(c.env,c.req.param('id')),balances:await budgetBalances(c.env,c.req.param('id')),as_of:new Date().toISOString()}));
accessAdmin.post('/access/plans',async c=>c.json(await publishAccessPlan(c.env,await c.req.json()),201));
accessAdmin.post('/access/events',async c=>c.json(await applyAccessEvent(c.env,await c.req.json())));
accessAdmin.post('/access/usage/prices',async c=>c.json(await publishUsagePrice(c.env,await c.req.json()),201));
accessAdmin.post('/access/usage/attempts',async c=>c.json(await registerUsageAttempt(c.env,await c.req.json()),201));
accessAdmin.post('/access/usage/evidence',async c=>c.json(await recordCostEvidence(c.env,await c.req.json())));
accessAdmin.post('/access/usage/invoice-adjustments',async c=>{await recordInvoiceAdjustment(c.env,await c.req.json());return c.json({ok:true});});
accessAdmin.get('/access/usage/jobs/:id',async c=>c.json(await usageJobCosts(c.env,c.req.param('id'))));
accessAdmin.put('/access/accounts/:id',async c=>{
  const id=c.req.param('id'), body=await c.req.json();
  if (!accessId(id)||!accessId(body.user_id)||!accessId(body.profile_id)||typeof body.active!=='boolean') throw new AccessError('invalid_account');
  const profile=getProfile(body.profile_id);
  // Personal execution initially uses the existing explicitly adult proxy policy.
  if (!profile||!crossProviderEnabled(profile)) throw new AccessError('unsupported_personal_profile',409);
  await c.env.HPS_DB.prepare(`INSERT INTO access_accounts(id,user_id,profile_id,active) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET active=excluded.active WHERE access_accounts.user_id=excluded.user_id AND access_accounts.profile_id=excluded.profile_id`)
    .bind(id,body.user_id,body.profile_id,body.active?1:0).run();
  const row=await readAccessAccount(c.env,id);
  if(row?.user_id!==body.user_id||row?.profile_id!==body.profile_id) throw new AccessError('account_identity_immutable',409);
  return c.json(row);
});
accessAdmin.post('/access/accounts/:id/token',async c=>{
  const account=await readAccessAccount(c.env,c.req.param('id'));
  if(!account?.active) throw new AccessError('account_unavailable',403);
  const body=await c.req.json();
  if(!Number.isInteger(body.hours)||body.hours<1||body.hours>24) throw new AccessError('invalid_token_duration');
  // This issues identity only. Login or token mint never creates an entitlement.
  return c.json(await issue({u:account.user_id,c:'',p:account.profile_id,account:account.id},body.hours,c.env.HPS_SIGNING_SECRET));
});
accessAdmin.put('/access/accounts/:id/seats',async c=>{
  const id=c.req.param('id'),body=await c.req.json();
  if(!await readAccessAccount(c.env,id)||!accessId(body.cohort_id)||!accessId(body.user_id)) throw new AccessError('invalid_seat_link');
  if(!(await getRoster(c.env.HPS_KV,body.cohort_id))?.users.includes(body.user_id)) throw new AccessError('participant_unavailable',403);
  const previousSubject='subject:'+await accessDigest({cohort:body.cohort_id,user:body.user_id});
  // Link identities before class budget initialization. Migrating a running
  // class needs an explicit transfer contract; it cannot erase an old cap.
  await c.env.HPS_DB.prepare(`INSERT INTO access_seats(cohort_id,user_id,account_id) SELECT ?,?,?
    WHERE NOT EXISTS(SELECT 1 FROM budget_accounts WHERE (scope_kind='cohort' AND scope_id=?) OR (scope_kind='subject' AND scope_id=?))
      AND NOT EXISTS(SELECT 1 FROM budget_reservations WHERE subject_key=?) ON CONFLICT DO NOTHING`)
    .bind(body.cohort_id,body.user_id,id,body.cohort_id,previousSubject,previousSubject).run();
  const saved=await c.env.HPS_DB.prepare('SELECT account_id FROM access_seats WHERE cohort_id=? AND user_id=?').bind(body.cohort_id,body.user_id).first<{account_id:string}>();
  if(saved?.account_id!==id) throw new AccessError(saved?'seat_link_conflict':'seat_link_requires_budget_migration',409);
  return c.json({ok:true});
});
accessAdmin.put('/access/organizations/:id',async c=>{
  const id=c.req.param('id');if(!accessId(id))throw new AccessError('invalid_organization');
  await c.env.HPS_DB.prepare('INSERT INTO access_organizations(id) VALUES (?) ON CONFLICT DO NOTHING').bind(id).run();
  return c.json({id});
});
accessAdmin.put('/access/organizations/:id/members/:account',async c=>{
  const id=c.req.param('id'),account=c.req.param('account');
  if(!accessId(id)||!await readAccessAccount(c.env,account))throw new AccessError('invalid_organization_member');
  await c.env.HPS_DB.prepare('INSERT INTO access_org_members(organization_id,account_id) VALUES (?,?) ON CONFLICT DO NOTHING').bind(id,account).run();
  return c.json({ok:true});
});
accessAdmin.put('/access/organizations/:id/cohorts/:cohort',async c=>{
  const id=c.req.param('id'),cohort=c.req.param('cohort');
  if(!accessId(id)||!await getRoster(c.env.HPS_KV,cohort))throw new AccessError('invalid_organization_cohort');
  await c.env.HPS_DB.prepare('INSERT INTO access_org_cohorts(organization_id,cohort_id) VALUES (?,?) ON CONFLICT DO NOTHING').bind(id,cohort).run();
  const row=await c.env.HPS_DB.prepare('SELECT organization_id FROM access_org_cohorts WHERE cohort_id=?').bind(cohort).first<{organization_id:string}>();
  if(row?.organization_id!==id)throw new AccessError('organization_cohort_conflict',409);
  return c.json({ok:true});
});
accessAdmin.put('/access/cohorts/:cohort/policy',async c=>{
  const cohort=c.req.param('cohort'),b=await c.req.json();
  if(!await getRoster(c.env.HPS_KV,cohort)||!Number.isSafeInteger(b.expected_revision)||b.expected_revision<0||typeof b.required!=='boolean'||typeof b.allow_personal!=='boolean')throw new AccessError('invalid_course_access_policy');
  const r=await c.env.HPS_DB.prepare(`INSERT INTO access_course_policies(cohort_id,revision,required,allow_personal) SELECT ?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM access_course_policies WHERE cohort_id=?)
    ON CONFLICT(cohort_id) DO UPDATE SET revision=excluded.revision,required=excluded.required,allow_personal=excluded.allow_personal WHERE access_course_policies.revision=?`)
    .bind(cohort,b.expected_revision+1,b.required?1:0,b.allow_personal?1:0,b.expected_revision,cohort,b.expected_revision).run();
  if(r.meta.changes!==1)throw new AccessError('course_policy_conflict',409);
  return c.json({revision:b.expected_revision+1});
});
accessAdmin.get('/cohorts/:cohort/access',async c=>{
  const cohort=c.req.param('cohort'),auth=await authorizeIssuerForCohort(c,cohort);
  if(auth instanceof Response)return auth;
  const rows=await c.env.HPS_DB.prepare(`SELECT document FROM access_contracts WHERE subject_kind='cohort' AND subject_id=?`).bind(cohort).all<{document:string}>();
  // No personal subscriptions, sale prices, provider invoice details or student text.
  return c.json({as_of:new Date().toISOString(),contracts:rows.results.map(r=>{const e:AccessEvent=JSON.parse(r.document);return{id:e.contract_id,state:e.state,plan_revision:e.plan_revision,period:e.period};})});
});
