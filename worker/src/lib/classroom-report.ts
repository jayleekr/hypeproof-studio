// Remote classroom operations R5 (#751) — report draft contract.
// Reuses the measurement core's capability models, finding statuses and score/
// conversion refusal. Nothing here scores, ranks or converts 7 legacy axes into 6.
import { CAPABILITY_MODELS, capabilityModel, forbidKeys, type CapabilityModel } from './measurement-core/index.ts';

export const RENDERER_REVISION = 'observation-report/1';
export const LEASE_MS = 5 * 60_000;
/**
 * Where a draft body lives. One object per LEASE GENERATION, never one per job: a writer whose lease was lost (expired and
 * re-claimed, or the learner withdrew) can then only ever touch its own object. It cannot overwrite the draft another
 * generation committed, and discarding its late write cannot delete that draft either. The committed body is the one
 * named by the job row's `lease_generation` — a job is never leased again once a result is stored.
 */
export const draftPrefix = (j: { cohort_id: string; class_run_id: string; student_id: string; id: string }) => `classroom-reports/${j.cohort_id}/${j.class_run_id}/${j.student_id}/${j.id}/`;
export const draftKey = (j: { cohort_id: string; class_run_id: string; student_id: string; id: string }, generation: number) => `${draftPrefix(j)}draft.g${generation}.json`;
export const NOT_YET_SEEN = '아직 충분히 보지 못함';
export const JOB_STATES = ['queued', 'leased', 'missing', 'partial', 'quarantined', 'draft', 'review_required', 'approved', 'failed'] as const;
export const modelById = (id: string): CapabilityModel | undefined => CAPABILITY_MODELS.find((m) => m.id === id);

export type EvidenceActor = 'student' | 'ai' | 'teacher' | 'external_user' | 'tool' | 'system' | 'unknown';
export type EvidenceSource = 'real' | 'simulated' | 'self_reported' | 'unverified';
/** `event_id` for records that carry one; `locator` (1-based line, optional turn) for the legacy spool that does not. */
export interface DraftEvidence { event_id?: string; locator?: { line: number; turn_id?: string }; quote: string; actor?: EvidenceActor; source_state?: EvidenceSource }
export interface DraftFinding { capability: string; status: 'observed' | 'unobserved' | 'insufficient_evidence'; claim: string; evidence: DraftEvidence[]; assistance?: string; change?: { before: string; after: string } }

interface InputEvent { line: number; event_id?: string; turn_id?: string; actor: EvidenceActor; source_state: EvidenceSource; text: string }
const ACTOR_BY_TYPE: Record<string, EvidenceActor> = { prompt: 'student', response: 'ai', artifact_snapshot: 'ai', usage: 'system', turn_end: 'system', workflow: 'student' };
const ACTORS: EvidenceActor[] = ['student', 'ai', 'teacher', 'external_user', 'tool', 'system', 'unknown'];
/** Decode the verified record once: who produced each event, how it was sourced, and its DECODED text. */
export function indexInput(inputText: string): InputEvent[] {
  const out: InputEvent[] = []; let line = 0;
  for (const raw of inputText.split('\n')) {
    if (!raw.trim()) continue; line++;
    let e: Record<string, unknown>; try { e = JSON.parse(raw); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    const actor = ACTORS.includes(e.actor as EvidenceActor) ? (e.actor as EvidenceActor) : ACTOR_BY_TYPE[String(e.type)] ?? 'unknown';
    // `actual` is the spool's word for what the envelope calls `real`. Nothing declared means unverified, not real.
    const declared = e.source_state === 'actual' ? 'real' : e.source_state;
    const source_state = (['real', 'simulated', 'self_reported', 'unverified'] as const).includes(declared as EvidenceSource) ? (declared as EvidenceSource) : 'unverified';
    const text = [e.text, e.content].filter((x) => typeof x === 'string').join('\n');
    out.push({ line, ...(typeof e.event_id === 'string' ? { event_id: e.event_id } : {}), ...(typeof e.turn_id === 'string' ? { turn_id: e.turn_id } : {}), actor, source_state, text });
  }
  return out;
}
function locate(events: InputEvent[], ev: DraftEvidence): InputEvent | null {
  if (typeof ev.event_id === 'string' && ev.event_id) return events.find((e) => e.event_id === ev.event_id) ?? null;
  const l = ev.locator; if (!l || !Number.isSafeInteger(l.line)) return null;
  const hit = events.find((e) => e.line === l.line) ?? null;
  return hit && (l.turn_id === undefined || hit.turn_id === l.turn_id) ? hit : null;
}
export interface Draft {
  format: 'hps-classroom-report-draft/1';
  versions: { capability_model: { id: string; revision: number }; rubric: string; evaluator: string; renderer_revision: string };
  findings: DraftFinding[];
  next_experiment: string;
  /** Legacy HAIN7 only: the existing report's own fingerprint and its 28-marker human review flag. Carried, never recomputed or converted. */
  legacy?: { fingerprint: string; marker_review_complete: boolean };
}
export type DraftVerdict = { ok: true; draft: Draft; state: 'review_required' | 'partial'; reason: string } | { ok: false; state: 'quarantined' | 'failed'; reason: string };

/**
 * Words the EVALUATOR writes (claim, change, next experiment) may not grade the learner. Keys were already refused; this is the
 * same rule for prose: a number used as a score, a rank, a percentile, a level, or an AI-dependency estimate. It is deliberately
 * narrow — a number that is part of what the learner did ("390px", "3단계로 줄임") is not a grade. Quotes are the record's own
 * words and are never touched by this.
 */
export const GRADE_LANGUAGE = /(\d+(?:\.\d+)?\s*점(?!검)|\d+\s*(?:등|위)(?![가-힣])|(?:상위|하위)\s*\d+\s*(?:%|퍼센트|프로)|백분위|\d+\s*등급|[A-F][+-]?\s*(?:등급|학점)|레벨\s*\d|Lv\.?\s*\d|(?:AI\s*)?의존도\s*(?:는|가|:)?\s*\d+|\d+\s*\/\s*(?:10|100)\b)/i;
/** `inputText` is the verified events.jsonl the job was built from: every quote must be in the event it names, or the draft is about someone/something else. */
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
  const written = [typeof d.next_experiment === 'string' ? d.next_experiment : '', ...d.findings.flatMap((f: any) => [f?.claim, f?.change?.before, f?.change?.after].filter((x) => typeof x === 'string'))];
  if (written.some((t) => GRADE_LANGUAGE.test(t))) return fail('grade_language', 'quarantined');
  const keys = new Set(model.capabilities.map((c) => c.key));
  const events = indexInput(inputText);
  for (const f of d.findings) {
    if (!keys.has(f.capability) || !['observed', 'unobserved', 'insufficient_evidence'].includes(f.status) || typeof f.claim !== 'string' || f.claim.length > 600 || !Array.isArray(f.evidence)) return fail('finding_invalid');
    if (f.status === 'observed' && !f.evidence.length) return fail('observed_without_evidence', 'quarantined');
    if (f.status !== 'observed' && f.evidence.length) return fail('unobserved_with_evidence');
    let ownWork = false;
    for (const e of f.evidence) {
      if (typeof e?.quote !== 'string' || !e.quote || e.quote.length > 2000) return fail('evidence_not_in_input', 'quarantined');
      // The quote has to be in THAT event, compared with its decoded text: a string that merely occurs somewhere in the
      // file — under an invented id, or in another event — is a claim about something else.
      const hit = locate(events, e);
      if (!hit) return fail('evidence_event_not_found', 'quarantined');
      if (!hit.text.includes(e.quote)) return fail('evidence_not_in_event', 'quarantined');
      if ((e.actor !== undefined && e.actor !== hit.actor) || (e.source_state !== undefined && e.source_state !== hit.source_state)) return fail('evidence_provenance_mismatch', 'quarantined');
      e.actor = hit.actor; e.source_state = hit.source_state;
      if (hit.actor === 'student' && hit.source_state !== 'simulated') ownWork = true;
    }
    // An observed behaviour is a statement about the learner. AI output, a teacher's words or a simulated case may be
    // quoted as context, but they cannot be the whole basis for it.
    if (f.status === 'observed' && !ownWork) return fail('evidence_not_student_work', 'quarantined');
  }
  if (new Set(d.findings.map((f) => f.capability)).size !== d.findings.length) return fail('finding_invalid');
  if (typeof d.next_experiment !== 'string' || d.next_experiment.length > 300) return fail('draft_invalid');
  if (model.status === 'legacy') { if (!d.legacy || typeof d.legacy.fingerprint !== 'string' || !/^[a-f0-9]{16,64}$/.test(d.legacy.fingerprint)) return fail('legacy_fingerprint_missing'); if (d.legacy.marker_review_complete !== true) return { ok: true, draft: d, state: 'review_required', reason: 'marker_review_missing' }; }
  else if (d.legacy) return fail('legacy_conversion', 'quarantined');
  // Bytes verified but behaviour coverage unknown/gappy: the draft is kept and says so; it is not a complete observation.
  return { ok: true, draft: d, state: job.input_coverage === 'complete' ? 'review_required' : 'partial', reason: job.input_coverage === 'complete' ? '' : 'input_' + job.input_coverage };
}

export interface ReportSection { title: string; items: Array<{ text: string; evidence?: DraftEvidence[]; label?: string; assistance?: string }> ; note?: string }
/**
 * The report a guardian or learner reads: observed behaviour → the actual evidence → how a judgement changed →
 * one next experiment. A single class describes that class only; a growth pattern needs evidence from more than
 * one class run. Missing evidence is "not seen enough yet" — never zero, low, or a rank. No numbers up front.
 */
export function composeReport(draft: Draft, ctx: { class_runs_with_evidence: number; coverage: string; model: CapabilityModel }): { sections: ReportSection[]; method: Record<string, unknown> } {
  const label = (k: string) => ctx.model.capabilities.find((c) => c.key === k)?.label_ko ?? k;
  const observed = draft.findings.filter((f) => f.status === 'observed'), rest = draft.findings.filter((f) => f.status !== 'observed'), changed = observed.filter((f) => f.change);
  const sections: ReportSection[] = [
    { title: '이번 수업에서 관찰된 행동', items: observed.map((f) => ({ label: label(f.capability), text: f.claim, evidence: f.evidence, ...(f.assistance ? { assistance: f.assistance } : {}) })), note: observed.length ? undefined : `이번 수업 기록에서는 ${NOT_YET_SEEN}.` },
// The quotes behind a changed judgement are already shown with the observed behaviour above; repeating them here only makes the page longer.
    { title: '판단이 바뀐 과정', items: changed.map((f) => ({ label: label(f.capability), text: `${f.change!.before} → ${f.change!.after}` })), note: changed.length ? undefined : '이번 수업 기록에서 판단을 바꾼 장면은 관찰되지 않았습니다. 바꾸지 않은 것이 문제라는 뜻은 아닙니다.' },
    { title: NOT_YET_SEEN, items: rest.map((f) => ({ label: label(f.capability), text: NOT_YET_SEEN })), note: '점수나 미달이 아닙니다. 이번 기록에 그 행동을 볼 장면이 없었다는 뜻입니다.' },
    { title: '다음에 실험해볼 것', items: draft.next_experiment ? [{ text: draft.next_experiment }] : [], note: draft.next_experiment ? undefined : '다음 실험은 검수자가 학생과 함께 정합니다.' },
  ];
  if (ctx.class_runs_with_evidence >= 2) sections.splice(2, 0, { title: '최근 반복된 패턴', items: [], note: `근거가 있는 수업 ${ctx.class_runs_with_evidence}회를 함께 본 경우에만 적습니다. 검수자가 회차별 근거를 확인한 뒤 작성합니다.` });
  if (ctx.coverage !== 'complete') sections.unshift({ title: '이 보고서가 본 범위', items: [], note: ctx.coverage === 'gaps' ? '수업 기록 일부가 빠져 있습니다. 빠진 구간의 행동은 이 보고서에 없습니다.' : ctx.coverage === 'damaged' ? '수업 기록 일부가 손상돼 읽을 수 없었습니다. 읽을 수 있었던 장면만 서술합니다.' : ctx.coverage === 'range_unknown' ? '기록의 시작과 끝을 확인할 수 없었습니다. 기록에 남은 장면만 서술합니다.' : '구형 기록이라 빠진 구간이 있는지 확인할 수 없습니다. 기록에 남은 장면만 서술합니다.' });
  // Versions and counts are method detail: folded, never the headline, and never a score.
  return { sections, method: { capability_model: draft.versions.capability_model, rubric: draft.versions.rubric, evaluator: draft.versions.evaluator, renderer_revision: draft.versions.renderer_revision, observed_findings: observed.length, not_yet_seen: rest.length, scope: ctx.class_runs_with_evidence >= 2 ? 'cumulative' : 'single_class' } };
}
