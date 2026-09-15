import { createHash } from 'node:crypto';
import { LocalRecord, confirmPurpose, verifyReceipt, redactDeep, digestOf, type SubmissionBundle, type ReviewAction } from '../../../worker/src/lib/measurement-core/index.ts';
import { FileRecordStorage } from './localRecordFile.ts';
import { manualInterpretation, parseLocalTranscript } from './localTranscript.ts';
import type { ReviewHost, TaskCard } from './localReviewProtocol.ts';

/** All mutations use the same file lock; source originals are never written. */
export class LocalReviewService {
  readonly store: FileRecordStorage;
  readonly record: LocalRecord;
  constructor(root: string) { this.store = new FileRecordStorage(root); this.record = new LocalRecord(this.store); }
  async import(raw: string, host: ReviewHost, project: string): Promise<TaskCard> {
    return this.importParsed(parseLocalTranscript(raw, host), project);
  }
  async importParsed(parsed: ReturnType<typeof parseLocalTranscript>, project: string): Promise<TaskCard> {
    const host = parsed.host;
    if (parsed.project !== project) throw Error('transcript_project_mismatch');
    return this.store.exclusive(async () => {
      const sessionKey = createHash('sha256').update(host + ':' + parsed.batch.session).digest('hex');
      if (await this.store.read('deleted-sessions/' + sessionKey)) throw Error('task_deleted');
      const existing = await this.record.taskForSession(host, parsed.batch.session);
      const id = existing || 'task-' + parsed.digest.slice(0, 32);
      const prior = existing && await this.store.read('imports/' + id) ? await this.card(id) : undefined;
      if (prior?.source.digest === parsed.digest) return prior;
      if (await this.store.read('deleted/' + id)) throw Error('task_deleted');
      if (!(await this.store.read('tasks/' + id))) {
        const purpose = parsed.batch.events.find(e => e.kind === 'user')?.text.slice(0, 2000);
        await this.record.createTask({ id, project, at: Date.now(), ...(purpose ? { purpose: { text: purpose, source: 'issue' as const, ref: 'Selected transcript; not yet confirmed' } } : {}) });
      }
      await this.store.remove('previews/' + id);
      await this.record.linkSession(id, { host, session_id: parsed.batch.session, by: 'user', at: Date.now() });
      await this.record.appendObservations(host, parsed.batch);
      const interpretation = manualInterpretation(parsed.batch, parsed.models);
      if (prior) {
        interpretation.revision = prior.interpretation.revision + 1;
        interpretation.supersedes = { id: prior.interpretation.id, revision: prior.interpretation.revision };
        interpretation.reason = 'New explicit session snapshot; earlier evidence and human reviews remain preserved.';
      }
      await this.record.saveInterpretation(id, interpretation, parsed.batch, host);
      await this.store.remove('previews/' + id);
      await this.store.write('imports/' + id, JSON.stringify(redactDeep({ host, session: parsed.batch.session, digest: parsed.digest, evidence: 'captured-replay', exclusions: parsed.exclusions, conditions: parsed.conditions, snapshots: [...(prior?.source.snapshots || []), { digest: parsed.digest, at: Date.now(), messages: parsed.batch.events.length, conditions: parsed.conditions }],
        limitations: ['Explicit message snapshot; automatic capture is off.', 'Tools, artifacts, approvals, hidden reasoning and later messages are not imported.', 'No AI capability assessment; observations await human interpretation. Assistance remains unknown.'] })));
      return this.card(id);
    });
  }
  async card(id: string): Promise<TaskCard> {
    const { data } = await this.record.exportTask(id);
    const source = await this.store.read('imports/' + id);
    if (!source) throw Error('import_incomplete_retry_original_file');
    const interpretations = data.interpretations as Array<{ interpretation: TaskCard['interpretation'] }>;
    const receipts = data.receipts as TaskCard['receipts'];
    for (const receipt of receipts) if (!(await verifyReceipt(this.store, receipt)).ok) throw Error('receipt_integrity_failure');
    return { task: data.task as TaskCard['task'], observations: (data.observations as TaskCard['observations']).sort((a,b) => a.event.at - b.event.at || a.event.seq - b.event.seq), interpretation: interpretations.sort((a,b) => b.interpretation.revision - a.interpretation.revision)[0].interpretation,
      source: JSON.parse(source), reviews: (data.reviews as TaskCard['reviews']).sort((a,b) => a.at - b.at), receipts, improvements: data.improvements as TaskCard['improvements'] };
  }
  async purpose(id: string, text: string) {
    return this.store.exclusive(async () => { await this.store.remove('previews/' + id); await this.record.saveTask(confirmPurpose(await this.record.getTask(id), { by: 'user', at: Date.now(), text })); await this.store.remove('previews/' + id); });
  }
  async review(id: string, capability: string, action: ReviewAction, text: string, evidence: string[] = []) {
    return this.store.exclusive(async () => {
      const card = await this.card(id);
      if (!Array.isArray(evidence) || evidence.length > 10 || evidence.some(key => !card.observations.some(o => o.key === key))) throw Error('invalid_evidence_selection');
      const note = text + (evidence.length ? '\nEvidence: ' + evidence.join(', ') : '');
      if (note.length > 2000) throw Error('review_note_too_long');
      await this.store.remove('previews/' + id);
      const review = await this.record.reviewFinding(id, { interpretation: { id: card.interpretation.id, revision: card.interpretation.revision }, capability, action, by: 'user', at: Date.now(), note, ...(action === 'correct' ? { corrected_claim: text } : {}) });
      await this.store.remove('previews/' + id); return review;
    });
  }
  async improvement(id: string, text: string) {
    return this.store.exclusive(async () => {
      await this.record.chooseImprovement(id, { id: 'next-' + id, text, choice: 'selected', evidence: [], by: 'user', at: Date.now() });
    });
  }
  async followUp(id: string, improvement: string, attempt: 'tried' | 'not_tried' | 'unknown', observed: string) {
    return this.store.exclusive(async () => {
      const current = await this.record.getTask(id);
      const entry = (await this.record.records()).improvements.find(i => i.id === improvement);
      if (!entry || (await this.record.getTask(entry.task)).project !== current.project) throw Error('foreign_improvement');
      await this.record.recordFollowUp(improvement, { task: id, attempt, observed, by: 'user', at: Date.now() });
    });
  }
  private async previewState(card: TaskCard): Promise<string> {
    // Bind all mutable source/review state, excluding receipts so retries stay idempotent.
    return digestOf({ task: card.task, source: card.source, observations: card.observations, interpretation: card.interpretation, reviews: card.reviews });
  }
  async preview(id: string, includeEvidence: boolean): Promise<SubmissionBundle> {
    return this.store.exclusive(async () => {
      const card = await this.card(id);
      const latest = new Map(card.reviews.map(r => [r.capability, r]));
      const excludedReviews = card.reviews.filter(r => latest.get(r.capability)?.action === 'exclude');
      // An interpretation contains all six findings. Excluding one means omitting the
      // whole original interpretation; selected human reviews remain independent records.
      const includeInterpretation = excludedReviews.length === 0;
      const bundle = await this.record.buildSubmission({ id, revision: card.receipts.length + 1, task: id, at: Date.now(),
        observations: includeEvidence ? card.observations.map(o => o.key) : [],
        interpretations: includeInterpretation ? [{ id: card.interpretation.id, revision: card.interpretation.revision }] : [],
        reviews: card.reviews.filter(r => latest.get(r.capability)?.action !== 'exclude').map(r => r.key),
        excluded: [...(!includeEvidence ? card.observations.map(o => ({ ref: o.key, why: 'Source text excluded by user' })) : []),
          ...excludedReviews.map(r => ({ ref: r.key, why: 'Capability excluded by user' })),
          ...(!includeInterpretation ? [{ ref: `interpretations/${id}/manual-review@${card.interpretation.revision}`, why: 'Contains excluded capability' }] : [])] });
      await this.store.write('previews/' + id, JSON.stringify({ bundle, state: await this.previewState(card) }));
      return bundle;
    });
  }
  async submit(id: string, digest: string) {
    return this.store.exclusive(async () => {
      const raw = await this.store.read('previews/' + id);
      if (!raw) throw Error('preview_required');
      const preview = JSON.parse(raw) as { bundle?: SubmissionBundle; state?: string };
      if (!preview.bundle || typeof preview.state !== 'string') throw Error('preview_required');
      const bundle = preview.bundle;
      if (preview.state !== await this.previewState(await this.card(id))) throw Error('preview_changed');
      if (bundle.digest !== digest) throw Error('preview_changed');
      const receipt = await this.record.submit(bundle, Date.now());
      if (!(await verifyReceipt(this.store, receipt)).ok) throw Error('receipt_integrity_failure');
      return receipt;
    });
  }
  async delete(id: string) {
    return this.store.exclusive(async () => {
      const card = await this.card(id);
      const sessionKey = createHash('sha256').update(card.source.host + ':' + card.source.session).digest('hex');
      await this.store.write('deleted-sessions/' + sessionKey, 'deleted');
      await this.record.deleteTask(id, { by: 'user', at: Date.now() });
      await this.store.remove('imports/' + id); await this.store.remove('previews/' + id);
    });
  }
}
