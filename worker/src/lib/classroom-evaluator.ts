// Remote classroom operations R5 (#751) — the evaluator adapter behind a report draft.
//
// Nothing new is scored here. It reuses what already exists:
//   - the measurement core's capability model (definitions, `observe` / `insufficient`
//     wording) IS the rubric — its `definition_revision` is the rubric version;
//   - the core's evidence catalog: the model SELECTS immutable excerpts by id, it never
//     authors a quote, so a fabricated citation cannot be produced;
//   - the existing Anthropic transport, secret scrubbing and no-retry/no-tools rule of
//     lib/native-assessment.ts.
// The output is an ordinary draft that goes through validateDraft like any other: a
// human still reviews it, and delivery still needs its own approval.
//
// Not configured is a state, not an empty report: without HPS_CLASSROOM_EVALUATOR the job
// stays queued and says `evaluator_not_configured`.
import type { Env } from '../env';
import { callAnthropic } from './anthropic';
import { scrubSecrets } from './scrub-secrets';
import { makeEvidenceCatalog, resolveEvidenceSelections, type CapabilityModel } from './measurement-core/index.ts';
import { RENDERER_REVISION, indexInput, type Draft, type DraftEvidence } from './classroom-report';

export const SERVICE_EVALUATOR = 'service-anthropic';
export const EVALUATOR_REVISION = 'service-anthropic:1';
export const DEFAULT_EVALUATOR_MODEL = 'claude-sonnet-4-5';
const MAX_EVENT_CHARS = 4000, MAX_EVENTS = 400;

export interface EvaluatorConfig { id: string; model: string }
/** null → no evaluator is configured for this Service. The caller reports that; it never substitutes an empty draft. */
export function evaluatorConfig(env: Env, profileModel?: string): EvaluatorConfig | null {
  if (env.HPS_CLASSROOM_EVALUATOR !== SERVICE_EVALUATOR || !env.ANTHROPIC_API_KEY) return null;
  // Explicit setting, else the model the class profile already runs on, else the documented default.
  const model = env.HPS_CLASSROOM_EVALUATOR_MODEL && /^[A-Za-z0-9_.:-]{1,80}$/.test(env.HPS_CLASSROOM_EVALUATOR_MODEL) ? env.HPS_CLASSROOM_EVALUATOR_MODEL : profileModel ?? DEFAULT_EVALUATOR_MODEL;
  return { id: EVALUATOR_REVISION, model };
}
/** The rubric a job is pinned to when the Service evaluates: the capability model's own operational definitions. */
export const rubricVersion = (model: CapabilityModel) => `capability-definitions@${model.definition_revision}`.slice(0, 64).replace(/[^A-Za-z0-9_.:+-]/g, '-');

export function systemPrompt(model: CapabilityModel): string {
  const rows = model.capabilities.map((c) => `- ${c.key} (${c.label_ko}): ${c.definition}\n  관찰로 인정: ${c.observe}\n  근거로 부족: ${c.insufficient}`).join('\n');
  return [
    '너는 한 학생의 한 수업 기록을 읽고, 아래 역량 정의에 비추어 "관찰된 행동"만 서술하는 관찰 보조자다. 채점자가 아니다.',
    '규칙:',
    '1. 점수·등급·순위·백분위·수준·다른 학생과의 비교·AI 의존도 추정치를 쓰지 않는다.',
    '2. 근거는 evidence_catalog의 quote_id로만 고른다. 문장을 새로 쓰거나 바꾸지 않는다.',
    '3. basis=true 인 항목(학생 본인의 실제 입력)만 "observed"의 근거가 된다. AI 응답·강사의 말·가상 사례는 맥락으로만 덧붙일 수 있고, 그것만으로는 observed가 아니다.',
    '4. 근거가 없거나 부족하면 그 역량은 "unobserved"다. 이는 낮은 능력이 아니라 이번 기록에 볼 장면이 없었다는 뜻이다. 추측으로 채우지 않는다.',
    '5. claim은 학생이 실제로 한 행동을 한국어 한두 문장으로 쓴다. 성격·재능·태도를 단정하지 않는다.',
    '6. 같은 역량에서 학생의 판단이 기록 안에서 바뀌었으면 change.before/after에 그 전후를 적는다. 바뀌지 않았으면 change를 넣지 않는다.',
    '7. AI나 강사의 도움을 받은 수행이면 assistance에 "assisted"를, 스스로 했음이 기록에 보이면 "independent"를, 알 수 없으면 "unknown"을 적는다.',
    '8. next_experiment는 다음 수업에서 학생이 직접 해 볼 수 있는 작은 실험 하나다. 처방이나 평가가 아니다. 근거가 없으면 빈 문자열.',
    `역량 모델: ${model.id} r${model.revision} (${model.definition_revision})`,
    rows,
  ].join('\n');
}

interface CatalogEntry { quote_id: string; event_id: string; quote: string; basis: boolean; actor: string; source_state: string }
/** Decoded events of the verified input → an immutable excerpt catalog. Ids are the record's own event_id, or `L<line>` for the legacy spool. */
export function buildCatalog(inputText: string): { catalog: CatalogEntry[]; locators: Map<string, DraftEvidence> } {
  // An event whose text contains something that looks like a secret is left out entirely: a scrubbed excerpt would no
  // longer be a verbatim quote of the record, and a credential is not evidence of anything.
  const events = indexInput(inputText).filter((e) => e.text.trim() && scrubSecrets(e.text) === e.text).slice(0, MAX_EVENTS), locators = new Map<string, DraftEvidence>();
  const batchEvents = events.map((e) => {
    const id = e.event_id ?? `L${e.line}`;
    locators.set(id, e.event_id ? { event_id: e.event_id, quote: '' } : { locator: { line: e.line, ...(e.turn_id ? { turn_id: e.turn_id } : {}) }, quote: '' });
    return { id, text: e.text.slice(0, MAX_EVENT_CHARS), actor: e.actor, source_state: e.source_state };
  });
  const meta = new Map(batchEvents.map((e) => [e.id, e]));
  const catalog = makeEvidenceCatalog({ events: batchEvents } as never).map((q) => { const e = meta.get(q.event_id)!; return { ...q, actor: e.actor, source_state: e.source_state, basis: e.actor === 'student' && e.source_state !== 'simulated' }; });
  return { catalog, locators };
}

function outputSchema(model: CapabilityModel, quoteIds: string[]) {
  const capability = { type: 'string', enum: model.capabilities.map((c) => c.key) };
  const observed = { type: 'object', additionalProperties: false, required: ['capability', 'status', 'claim', 'evidence', 'assistance'], properties: {
    capability, status: { type: 'string', enum: ['observed'] }, claim: { type: 'string' }, assistance: { type: 'string', enum: ['unknown', 'assisted', 'independent'] },
    evidence: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['quote_id'], properties: { quote_id: { type: 'string', enum: quoteIds } } } },
    change: { type: 'object', additionalProperties: false, required: ['before', 'after'], properties: { before: { type: 'string' }, after: { type: 'string' } } } } };
  const unobserved = { type: 'object', additionalProperties: false, required: ['capability', 'status'], properties: { capability, status: { type: 'string', enum: ['unobserved'] } } };
  return { type: 'object', additionalProperties: false, required: ['findings', 'next_experiment'], properties: { findings: { type: 'array', items: { anyOf: [observed, unobserved] } }, next_experiment: { type: 'string' } } };
}

/**
 * Turn the model's selections into a draft. Pure, so the contract is testable without a provider:
 * unknown quote ids are refused by the core; a capability the model skipped is `unobserved`;
 * every capability of the model appears exactly once.
 */
export function draftFromSelections(raw: unknown, model: CapabilityModel, job: { rubric: string; evaluator: string }, built: ReturnType<typeof buildCatalog>): Draft {
  const o = raw as { findings?: unknown; next_experiment?: unknown };
  const resolved = resolveEvidenceSelections(Array.isArray(o?.findings) ? o.findings.map((f: any) => (f?.status === 'unobserved' ? { capability: f.capability, status: 'unobserved' } : f)) : o?.findings, built.catalog) as Array<Record<string, any>>;
  const byKey = new Map<string, Record<string, any>>();
  for (const f of resolved) if (typeof f?.capability === 'string' && !byKey.has(f.capability)) byKey.set(f.capability, f);
  const findings = model.capabilities.map((c) => {
    const f = byKey.get(c.key);
    if (!f || f.status !== 'observed' || !f.evidence.length) return { capability: c.key, status: 'unobserved' as const, claim: '', evidence: [] };
    const evidence = f.evidence.map((e: { event_id: string; quote: string }) => ({ ...built.locators.get(e.event_id)!, quote: e.quote }));
    return { capability: c.key, status: 'observed' as const, claim: String(f.claim ?? '').slice(0, 600), evidence, ...(['assisted', 'independent'].includes(f.assistance) ? { assistance: f.assistance } : {}), ...(f.change && typeof f.change.before === 'string' && typeof f.change.after === 'string' ? { change: { before: f.change.before.slice(0, 300), after: f.change.after.slice(0, 300) } } : {}) };
  });
  return { format: 'hps-classroom-report-draft/1', versions: { capability_model: { id: model.id, revision: model.revision }, rubric: job.rubric, evaluator: job.evaluator, renderer_revision: RENDERER_REVISION }, findings, next_experiment: typeof o?.next_experiment === 'string' ? o.next_experiment.slice(0, 300) : '' };
}

export type Transport = (request: Record<string, unknown>, signal: AbortSignal) => Promise<Response>;
/** One bounded call, no tools, no automatic retry, nothing logged. Throws a short machine code on failure. */
export async function evaluateInput(env: Env, cfg: EvaluatorConfig, model: CapabilityModel, job: { rubric: string; evaluator: string }, inputText: string, transport?: Transport): Promise<{ draft: Draft; usage: Record<string, number>; analysis_ai_model: string }> {
  const built = buildCatalog(inputText);
  // Nothing the learner said is in the record: every capability is "not seen yet". No provider call is made for that.
  if (!built.catalog.some((q) => q.basis)) return { draft: draftFromSelections({ findings: [], next_experiment: '' }, model, job, built), usage: {}, analysis_ai_model: 'none' };
  const request = { model: cfg.model, max_tokens: 4096, stream: false, output_config: { format: { type: 'json_schema', schema: outputSchema(model, built.catalog.map((q) => q.quote_id)) } },
    system: [{ type: 'text' as const, text: systemPrompt(model) }],
    messages: [{ role: 'user' as const, content: JSON.stringify({ evidence_catalog: built.catalog.map(({ quote_id, quote, basis, actor, source_state }) => ({ quote_id, quote, basis, actor, source_state })) }) }] };
  const signal = AbortSignal.timeout(90_000);
  const response = transport ? await transport(request, signal) : await callAnthropic(request as never, env.ANTHROPIC_API_KEY!, { url: env.ANTHROPIC_PROXY_URL, proxySecret: env.ANTHROPIC_PROXY_SECRET, signal });
  if (!response.ok) throw Error('evaluator_provider_' + response.status);
  const result = (await response.json()) as { content?: Array<{ type: string; text?: string }>; usage?: Record<string, number> };
  const text = (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  let parsed: unknown; try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); } catch { throw Error('evaluator_output_invalid'); }
  return { draft: draftFromSelections(parsed, model, job, built), usage: result.usage ?? {}, analysis_ai_model: cfg.model };
}
