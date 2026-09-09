import type { Env } from '../env';
import type { TokenPayload } from './tokens';
import { getRoster } from './kv';

/** Sales entitlements are independent of provider price schedules (AB-01). */
export interface AccessPlan {
  schema: 'hps-access-plan/1';
  revision: string;
  sku: string;
  label: string;
  source: { repository: 'jayleekr/hypeprooflab'; path: 'web/src/lib/pricing.ts'; commit: string; pricing_version: string; content_sha256: string };
  publication: 'synthetic' | 'approved';
  approval_ref: string | null;
  mode: 'included' | 'byo';
  sale: { currency: string; minor_units: number };
  policy: { timezone: string; renewal: 'none' | 'calendar'; overage: 'deny'; rollover: 'none'; grace: 'none' };
  allowed: { models: string[]; efforts: string[]; features: string[]; runtimes: string[] };
  included: { meter: string; amount: number }[];
}
export interface AccessEvent {
  schema: 'hps-access-event/1';
  event_id: string;
  contract_id: string;
  source_version: number;
  /** Reference to an operator-verified agreement/provider snapshot, never a checkout redirect. */
  verification_ref: string;
  subject: { kind: 'account' | 'cohort' | 'organization'; id: string };
  payer: { kind: 'account' | 'organization' | 'sponsor' | 'external'; id: string };
  plan_revision: string;
  period: { id: string; starts_at: number; ends_at: number };
  state: 'active' | 'suspended' | 'ended';
}
export class AccessError extends Error {
  code: string;
  status: 400 | 401 | 403 | 404 | 409 | 429 | 503;
  constructor(code: string, status: 400 | 401 | 403 | 404 | 409 | 429 | 503 = 400) { super(code); this.code=code; this.status=status; }
}
export function accessEnabled(env: Env): boolean { return env.HPS_ACCESS_CONTRACTS === 'enabled'; }
export function requireAccessEnabled(env: Env): void {
  if (!accessEnabled(env)) throw new AccessError('access_not_configured', 503);
}
export function accessId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
}
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new AccessError(code); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function record(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function list(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 64 && value.every(accessId) && new Set(value).size === value.length;
}
function keys(value: Record<string, unknown>, names: string[]): boolean { return Object.keys(value).every(k => names.includes(k)); }
export function validateAccessPlan(value: unknown): AccessPlan {
  check(record(value) && keys(value, ['schema','revision','sku','label','source','publication','approval_ref','mode','sale','policy','allowed','included']), 'invalid_plan');
  check(value.schema === 'hps-access-plan/1' && accessId(value.revision) && accessId(value.sku), 'invalid_plan_identity');
  check(typeof value.label === 'string' && value.label.length > 0 && value.label.length <= 100, 'invalid_plan_label');
  const s = value.source;
  check(record(s) && keys(s,['repository','path','commit','pricing_version','content_sha256']) && s.repository === 'jayleekr/hypeprooflab' && s.path === 'web/src/lib/pricing.ts' && /^[a-f0-9]{40}$/.test(s.commit) && /^[a-f0-9]{64}$/.test(s.content_sha256) && typeof s.pricing_version === 'string' && s.pricing_version.length > 0, 'invalid_pricing_source');
  check(['synthetic','approved'].includes(value.publication) && (value.approval_ref === null || (typeof value.approval_ref === 'string' && value.approval_ref.length <= 300)), 'invalid_publication');
  check(value.publication !== 'approved' || !!value.approval_ref, 'approval_reference_required');
  check(['included','byo'].includes(value.mode), 'invalid_funding_mode');
  check(record(value.sale) && keys(value.sale,['currency','minor_units']) && /^[A-Z]{3}$/.test(value.sale.currency) && integer(value.sale.minor_units), 'invalid_sale_price');
  const p = value.policy;
  check(record(p) && keys(p,['timezone','renewal','overage','rollover','grace']) && ['none','calendar'].includes(p.renewal) && p.overage === 'deny' && p.rollover === 'none' && p.grace === 'none', 'unsupported_commercial_policy');
  try { new Intl.DateTimeFormat('en', { timeZone: p.timezone }).format(); } catch { throw new AccessError('invalid_period_timezone'); }
  check(typeof p.timezone === 'string' && p.timezone.length > 0, 'invalid_period_timezone');
  check(record(value.allowed) && keys(value.allowed,['models','efforts','features','runtimes']) && ['models','efforts','features','runtimes'].every(k => list(value.allowed[k])), 'invalid_entitlements');
  check(value.allowed.models.length > 0 && value.allowed.runtimes.length > 0 && value.allowed.efforts.every((x: string) => ['low','medium','high','max'].includes(x)) && value.allowed.runtimes.every((x: string) => ['proxy','agent-sdk','byo'].includes(x)), 'invalid_entitlements');
  check(Array.isArray(value.included) && value.included.length <= 16 && value.included.every((m: unknown) => record(m) && keys(m,['meter','amount']) && accessId(m.meter) && integer(m.amount) && m.amount > 0) && new Set(value.included.map((m: { meter: string }) => m.meter)).size === value.included.length, 'invalid_included_resources');
  check(value.mode === 'included' ? value.included.length > 0 : value.included.length === 0, 'included_resources_required');
  return value as AccessPlan;
}
export function validateAccessEvent(value: unknown): AccessEvent {
  check(record(value) && keys(value,['schema','event_id','contract_id','source_version','verification_ref','subject','payer','plan_revision','period','state']), 'invalid_access_event');
  check(value.schema === 'hps-access-event/1' && accessId(value.event_id) && accessId(value.contract_id) && accessId(value.plan_revision) && integer(value.source_version) && value.source_version > 0, 'invalid_access_event');
  check(typeof value.verification_ref === 'string' && value.verification_ref.length > 0 && value.verification_ref.length <= 300, 'verification_reference_required');
  check(record(value.subject) && keys(value.subject,['kind','id']) && ['account','cohort','organization'].includes(value.subject.kind) && accessId(value.subject.id), 'invalid_subject');
  check(record(value.payer) && keys(value.payer,['kind','id']) && ['account','organization','sponsor','external'].includes(value.payer.kind) && accessId(value.payer.id), 'invalid_payer');
  check(record(value.period) && keys(value.period,['id','starts_at','ends_at']) && accessId(value.period.id) && integer(value.period.starts_at) && integer(value.period.ends_at) && value.period.ends_at > value.period.starts_at, 'invalid_period');
  check(['active','suspended','ended'].includes(value.state), 'invalid_contract_state');
  return value as AccessEvent;
}
/** Stable JSON prevents key-order-only retries from becoming conflicts. */
export function accessJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(accessJson).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + accessJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export async function accessDigest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessJson(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
}
export async function assertPlanPublication(env: Env, plan: AccessPlan, digest: string): Promise<void> {
  // An approved plan is an exact immutable artifact, not a user-supplied approval flag.
  if (plan.publication === 'synthetic') {
    if (env.ENVIRONMENT !== 'dev') throw new AccessError('synthetic_contract_forbidden', 403);
  } else if (!(env.HPS_ACCESS_APPROVED_PLAN_DIGESTS ?? '').split(',').includes(digest)) {
    throw new AccessError('plan_not_approved', 403);
  }
}
export async function publishAccessPlan(env: Env, value: unknown): Promise<AccessPlan> {
  requireAccessEnabled(env);
  const plan = validateAccessPlan(value), digest = await accessDigest(plan);
  await assertPlanPublication(env, plan, digest);
  await env.HPS_DB.prepare('INSERT INTO access_plans(revision,digest,document,created_at) VALUES (?,?,?,?) ON CONFLICT(revision) DO NOTHING')
    .bind(plan.revision,digest,accessJson(plan),Date.now()).run();
  const saved = await env.HPS_DB.prepare('SELECT digest FROM access_plans WHERE revision=?').bind(plan.revision).first<{digest:string}>();
  if (saved?.digest !== digest) throw new AccessError('plan_revision_conflict', 409);
  return plan;
}
export async function readAccessPlan(env: Env, revision: string, historical=false): Promise<AccessPlan> {
  const row = await env.HPS_DB.prepare('SELECT document,digest FROM access_plans WHERE revision=?').bind(revision).first<{document:string;digest:string}>();
  if (!row) throw new AccessError('plan_not_found', 404);
  const plan = validateAccessPlan(JSON.parse(row.document));
  if(await accessDigest(plan)!==row.digest)throw new AccessError('plan_integrity_failure',503);
  if(!historical||plan.publication==='synthetic')await assertPlanPublication(env,plan,row.digest);
  return plan;
}
export interface AccessAccount { id: string; user_id: string; profile_id: string; active: number }
export async function readAccessAccount(env: Env, id: string): Promise<AccessAccount | null> {
  return env.HPS_DB.prepare('SELECT * FROM access_accounts WHERE id=?').bind(id).first<AccessAccount>();
}
export async function accountForToken(env: Env, payload: TokenPayload): Promise<string | null> {
  if (payload.account) {
    const a = await readAccessAccount(env,payload.account);
    if (!a || !a.active || a.user_id !== payload.u || a.profile_id !== payload.p || payload.c !== '') throw new AccessError('account_unavailable', 403);
    return a.id;
  }
  const row = await env.HPS_DB.prepare(`SELECT a.id,a.active FROM access_seats s JOIN access_accounts a ON a.id=s.account_id
    WHERE s.cohort_id=? AND s.user_id=?`).bind(payload.c,payload.u).first<{id:string;active:number}>();
  // A disabled linked identity must not become a fresh, unlinked budget subject.
  if(row&&!row.active)throw new AccessError('account_unavailable',403);
  return row?.id ?? null;
}
export async function applyAccessEvent(env: Env, value: unknown): Promise<{ applied: boolean; event: AccessEvent }> {
  requireAccessEnabled(env);
  const event = validateAccessEvent(value), digest = await accessDigest(event);
  await readAccessPlan(env,event.plan_revision);
  if (event.subject.kind === 'account' && !await readAccessAccount(env,event.subject.id)) throw new AccessError('account_not_found',404);
  if (event.subject.kind === 'cohort' && !await getRoster(env.HPS_KV,event.subject.id)) throw new AccessError('cohort_not_found',404);
  if (event.subject.kind === 'organization' && !await env.HPS_DB.prepare('SELECT id FROM access_organizations WHERE id=?').bind(event.subject.id).first()) throw new AccessError('organization_not_found',404);
  const old = await env.HPS_DB.prepare('SELECT document FROM access_contracts WHERE id=?').bind(event.contract_id).first<{document:string}>();
  if (old) {
    const before: AccessEvent = JSON.parse(old.document);
    if (accessJson(before.subject) !== accessJson(event.subject) || accessJson(before.payer) !== accessJson(event.payer)) throw new AccessError('contract_owner_immutable',409);
    if (event.source_version > before.source_version && event.period.id !== before.period.id) {
      if (event.period.starts_at < before.period.ends_at) throw new AccessError('period_overlap',409);
      if (event.period.starts_at > Date.now() && before.period.ends_at > Date.now()) throw new AccessError('renewal_not_effective',409);
      const priorPlan = await readAccessPlan(env,before.plan_revision);
      if (priorPlan.policy.renewal === 'none') throw new AccessError('renewal_not_allowed',409);
    }
  }
  // A period never refills because of login, suspension/resume, a duplicate or a late event.
  // D1 batch is transactional. The SQL predicates also protect against concurrent writers.
  const document = accessJson(event);
  const results = await env.HPS_DB.batch([
    env.HPS_DB.prepare(`INSERT INTO access_events(event_id,contract_id,source_version,digest,document,received_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(event.event_id,event.contract_id,event.source_version,digest,document,Date.now()),
    env.HPS_DB.prepare(`INSERT INTO access_contracts(id,subject_kind,subject_id,payer_kind,payer_id,source_version,event_id,state,period_id,document)
      SELECT ?,?,?,?,?,?,?,?,?,? FROM access_events WHERE event_id=? AND digest=?
      ON CONFLICT(id) DO UPDATE SET source_version=excluded.source_version,event_id=excluded.event_id,state=excluded.state,period_id=excluded.period_id,document=excluded.document
      WHERE access_contracts.source_version < excluded.source_version
        AND access_contracts.subject_kind=excluded.subject_kind AND access_contracts.subject_id=excluded.subject_id
        AND access_contracts.payer_kind=excluded.payer_kind AND access_contracts.payer_id=excluded.payer_id`)
      .bind(event.contract_id,event.subject.kind,event.subject.id,event.payer.kind,event.payer.id,event.source_version,event.event_id,event.state,event.period.id,document,event.event_id,digest),
    env.HPS_DB.prepare(`INSERT INTO access_periods(id,contract_id,plan_revision,starts_at,ends_at)
      SELECT ?,?,?,?,CASE WHEN NOT EXISTS(SELECT 1 FROM access_periods WHERE contract_id=? AND id<>? AND starts_at<? AND ends_at>?)
        THEN ? ELSE NULL END FROM access_contracts WHERE id=? AND event_id=?
      ON CONFLICT(id) DO UPDATE SET plan_revision=CASE
        WHEN access_periods.contract_id=excluded.contract_id AND access_periods.plan_revision=excluded.plan_revision
          AND access_periods.starts_at=excluded.starts_at AND access_periods.ends_at=excluded.ends_at
        THEN access_periods.plan_revision ELSE NULL END`)
      .bind(event.period.id,event.contract_id,event.plan_revision,event.period.starts_at,event.contract_id,event.period.id,event.period.ends_at,event.period.starts_at,event.period.ends_at,event.contract_id,event.event_id),
  ]);
  const saved = await env.HPS_DB.prepare('SELECT digest FROM access_events WHERE event_id=?').bind(event.event_id).first<{digest:string}>();
  if (saved?.digest !== digest) throw new AccessError('event_revision_conflict',409);
  const head = await env.HPS_DB.prepare('SELECT subject_kind,subject_id,payer_kind,payer_id FROM access_contracts WHERE id=?').bind(event.contract_id).first<{subject_kind:string;subject_id:string;payer_kind:string;payer_id:string}>();
  if (!head || head.subject_kind !== event.subject.kind || head.subject_id !== event.subject.id || head.payer_kind !== event.payer.kind || head.payer_id !== event.payer.id) throw new AccessError('contract_owner_immutable',409);
  return { applied: results[1]?.meta.changes === 1, event };
}
export interface AccessChoice { contract: AccessEvent; plan: AccessPlan }
export async function accessChoices(env: Env, payload: TokenPayload, now = Date.now(), includeInactive=false): Promise<AccessChoice[]> {
  requireAccessEnabled(env);
  const account = await accountForToken(env,payload);
  const policies = payload.c ? await env.HPS_DB.prepare('SELECT allow_personal FROM access_course_policies WHERE cohort_id=?').bind(payload.c).first<{allow_personal:number}>() : null;
  const rows = await env.HPS_DB.prepare(`SELECT DISTINCT c.document FROM access_contracts c WHERE ${includeInactive?"1":"c.state='active'"} AND (
      (c.subject_kind='cohort' AND c.subject_id=? AND ?<>'') OR
      (c.subject_kind='account' AND c.subject_id=? AND ?=1) OR
      (c.subject_kind='organization' AND (EXISTS (SELECT 1 FROM access_org_cohorts x WHERE x.organization_id=c.subject_id AND x.cohort_id=? AND ?<>'')
        OR (?=1 AND EXISTS (SELECT 1 FROM access_org_members m WHERE m.organization_id=c.subject_id AND m.account_id=?)))))`)
    .bind(payload.c,payload.c,account,payload.c ? (policies?.allow_personal ?? 0) : 1,payload.c,payload.c,payload.c ? (policies?.allow_personal ?? 0) : 1,account).all<{document:string}>();
  const choices: AccessChoice[] = [];
  for (const row of rows.results) {
    const contract: AccessEvent = JSON.parse(row.document);
    if (!includeInactive && (contract.period.starts_at > now || contract.period.ends_at <= now)) continue;
    choices.push({contract,plan:await readAccessPlan(env,contract.plan_revision,includeInactive)});
  }
  return choices;
}
export function selectAccessChoice(choices: AccessChoice[], selected: string | undefined): AccessChoice {
  if (!selected) throw new AccessError('funding_selection_required',409);
  const choice = choices.find(x => x.contract.contract_id === selected);
  if (!choice) throw new AccessError('funding_unavailable',403);
  return choice;
}
export function permitsAccess(choice: AccessChoice, need: { model: string; effort?: string | null; runtime: string; features: string[] }): boolean {
  const a = choice.plan.allowed;
  return a.models.includes(need.model) && a.runtimes.includes(need.runtime) && (!need.effort || a.efforts.includes(need.effort)) && need.features.every(f => a.features.includes(f));
}
