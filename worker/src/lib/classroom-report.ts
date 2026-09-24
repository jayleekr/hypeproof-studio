// Remote classroom operations R5 (#751) — report draft contract.
// Reuses the measurement core's capability models, finding statuses and score/
// conversion refusal. Nothing here scores, ranks or converts 7 legacy axes into 6.
import { CAPABILITY_MODELS, capabilityModel, forbidKeys, type CapabilityModel } from './measurement-core/index.ts';

export const RENDERER_REVISION = 'observation-report/1';
export const LEASE_MS = 5 * 60_000;
export const NOT_YET_SEEN = '아직 충분히 보지 못함';
export const JOB_STATES = ['queued', 'leased', 'missing', 'partial', 'quarantined', 'draft', 'review_required', 'approved', 'failed'] as const;
export const modelById = (id: string): CapabilityModel | undefined => CAPABILITY_MODELS.find((m) => m.id === id);

export interface DraftFinding { capability: string; status: 'observed' | 'unobserved' | 'insufficient_evidence'; claim: string; evidence: Array<{ event_id: string; quote: string }>; assistance?: string; change?: { before: string; after: string } }
export interface Draft {
  format: 'hps-classroom-report-draft/1';
  versions: { capability_model: { id: string; revision: number }; rubric: string; evaluator: string; renderer_revision: string };
  findings: DraftFinding[];
  next_experiment: string;
  /** Legacy HAIN7 only: the existing report's own fingerprint and its 28-marker human review flag. Carried, never recomputed or converted. */
  legacy?: { fingerprint: string; marker_review_complete: boolean };
}
export type DraftVerdict = { ok: true; draft: Draft; state: 'review_required' | 'partial'; reason: string } | { ok: false; state: 'quarantined' | 'failed'; reason: string };

/** `inputText` is the verified events.jsonl the job was built from: every quote must be in it, or the draft is about someone/something else. */
export function validateDraft(value: unknown, job: { capability_model: string; rubric: string; evaluator: string; input_coverage: string }, inputText: string): DraftVerdict {
  const fail = (reason: string, state: 'quarantined' | 'failed' = 'failed'): DraftVerdict => ({ ok: false, state, reason });
  if (!value || typeof value !== 'object') return fail('draft_invalid');
  const d = value as Draft;
  try { forbidKeys(d); } catch (e) { return fail((e as Error).message === 'legacy_conversion' ? 'legacy_conversion' : 'score_in_draft', 'quarantined'); }
  if (d.format !== 'hps-classroom-report-draft/1' || !d.versions || !Array.isArray(d.findings)) return fail('draft_invalid');
  const model = capabilityModel(d.versions.capability_model?.id, d.versions.capability_model?.revision);
  // The job pins the model. A draft in the other model is not "close enough" — six and seven are different instruments.
  if (!model || model.id !== job.capability_model) return fail('model_mismatch', 'quarantined');
  if (d.versions.rubric !== job.rubric || d.versions.evaluator !== job.evaluator || d.versions.renderer_revision !== RENDERER_REVISION) return fail('version_mismatch', 'quarantined');
  const keys = new Set(model.capabilities.map((c) => c.key));
  for (const f of d.findings) {
    if (!keys.has(f.capability) || !['observed', 'unobserved', 'insufficient_evidence'].includes(f.status) || typeof f.claim !== 'string' || f.claim.length > 600 || !Array.isArray(f.evidence)) return fail('finding_invalid');
    if (f.status === 'observed' && !f.evidence.length) return fail('observed_without_evidence', 'quarantined');
    if (f.status !== 'observed' && f.evidence.length) return fail('unobserved_with_evidence');
    for (const e of f.evidence) if (typeof e?.quote !== 'string' || !e.quote || e.quote.length > 2000 || !inputText.includes(e.quote)) return fail('evidence_not_in_input', 'quarantined');
  }
  if (new Set(d.findings.map((f) => f.capability)).size !== d.findings.length) return fail('finding_invalid');
  if (typeof d.next_experiment !== 'string' || d.next_experiment.length > 300) return fail('draft_invalid');
  if (model.status === 'legacy') { if (!d.legacy || typeof d.legacy.fingerprint !== 'string' || !/^[a-f0-9]{16,64}$/.test(d.legacy.fingerprint)) return fail('legacy_fingerprint_missing'); if (d.legacy.marker_review_complete !== true) return { ok: true, draft: d, state: 'review_required', reason: 'marker_review_missing' }; }
  else if (d.legacy) return fail('legacy_conversion', 'quarantined');
  // Bytes verified but behaviour coverage unknown/gappy: the draft is kept and says so; it is not a complete observation.
  return { ok: true, draft: d, state: job.input_coverage === 'complete' ? 'review_required' : 'partial', reason: job.input_coverage === 'complete' ? '' : 'input_' + job.input_coverage };
}

export interface ReportSection { title: string; items: Array<{ text: string; evidence?: Array<{ event_id: string; quote: string }>; label?: string }> ; note?: string }
/**
 * The report a guardian or learner reads: observed behaviour → the actual evidence → how a judgement changed →
 * one next experiment. A single class describes that class only; a growth pattern needs evidence from more than
 * one class run. Missing evidence is "not seen enough yet" — never zero, low, or a rank. No numbers up front.
 */
export function composeReport(draft: Draft, ctx: { class_runs_with_evidence: number; coverage: string; model: CapabilityModel }): { sections: ReportSection[]; method: Record<string, unknown> } {
  const label = (k: string) => ctx.model.capabilities.find((c) => c.key === k)?.label_ko ?? k;
  const observed = draft.findings.filter((f) => f.status === 'observed'), rest = draft.findings.filter((f) => f.status !== 'observed'), changed = observed.filter((f) => f.change);
  const sections: ReportSection[] = [
    { title: '이번 수업에서 관찰된 행동', items: observed.map((f) => ({ label: label(f.capability), text: f.claim, evidence: f.evidence })), note: observed.length ? undefined : `이번 수업 기록에서는 ${NOT_YET_SEEN}.` },
    { title: '판단이 바뀐 과정', items: changed.map((f) => ({ label: label(f.capability), text: `${f.change!.before} → ${f.change!.after}`, evidence: f.evidence })), note: changed.length ? undefined : '이번 수업 기록에서 판단을 바꾼 장면은 관찰되지 않았습니다. 바꾸지 않은 것이 문제라는 뜻은 아닙니다.' },
    { title: NOT_YET_SEEN, items: rest.map((f) => ({ label: label(f.capability), text: NOT_YET_SEEN })), note: '점수나 미달이 아닙니다. 이번 기록에 그 행동을 볼 장면이 없었다는 뜻입니다.' },
    { title: '다음에 실험해볼 것', items: draft.next_experiment ? [{ text: draft.next_experiment }] : [], note: draft.next_experiment ? undefined : '다음 실험은 검수자가 학생과 함께 정합니다.' },
  ];
  if (ctx.class_runs_with_evidence >= 2) sections.splice(2, 0, { title: '최근 반복된 패턴', items: [], note: `근거가 있는 수업 ${ctx.class_runs_with_evidence}회를 함께 본 경우에만 적습니다. 검수자가 회차별 근거를 확인한 뒤 작성합니다.` });
  if (ctx.coverage !== 'complete') sections.unshift({ title: '이 보고서가 본 범위', items: [], note: ctx.coverage === 'gaps' ? '수업 기록 일부가 빠져 있습니다. 빠진 구간의 행동은 이 보고서에 없습니다.' : '구형 기록이라 빠진 구간이 있는지 확인할 수 없습니다. 기록에 남은 장면만 서술합니다.' });
  // Versions and counts are method detail: folded, never the headline, and never a score.
  return { sections, method: { capability_model: draft.versions.capability_model, rubric: draft.versions.rubric, evaluator: draft.versions.evaluator, renderer_revision: draft.versions.renderer_revision, observed_findings: observed.length, not_yet_seen: rest.length, scope: ctx.class_runs_with_evidence >= 2 ? 'cumulative' : 'single_class' } };
}
