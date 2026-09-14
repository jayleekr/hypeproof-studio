import { LocalRecord, confirmPurpose, verifyReceipt, type SubmissionBundle, type ReviewAction } from '../../../worker/src/lib/measurement-core/index.ts';
import { FileRecordStorage } from './localRecordFile.ts';
import { manualInterpretation, parseLocalTranscript } from './localTranscript.ts';
import type { ReviewHost, TaskCard } from './localReviewProtocol.ts';

/** All mutations use the same file lock; source originals are never written. */
export class LocalReviewService {
  readonly store: FileRecordStorage;
  readonly record: LocalRecord;
  constructor(root: string) { this.store = new FileRecordStorage(root); this.record = new LocalRecord(this.store); }
  async import(raw: string, host: ReviewHost, project: string): Promise<TaskCard> {
    const parsed = parseLocalTranscript(raw, host);
    if (parsed.project !== project) throw Error('transcript_project_mismatch');
    const id = 'task-' + parsed.digest.slice(0, 32);
    return this.store.exclusive(async () => {
      if (await this.store.read('deleted/' + id)) throw Error('task_deleted');
      if (!(await this.store.read('tasks/' + id))) {
        const purpose = parsed.batch.events.find(e => e.kind === 'user')?.text.slice(0, 2000);
        await this.record.createTask({ id, project, at: Date.now(), ...(purpose ? { purpose: { text: purpose, source: 'issue' as const, ref: 'Selected transcript; not yet confirmed' } } : {}) });
      }
      await this.record.linkSession(id, { host, session_id: parsed.batch.session, by: 'user', at: Date.now() });
      await this.record.appendObservations(host, parsed.batch);
      await this.record.saveInterpretation(id, manualInterpretation(parsed.batch, parsed.models), parsed.batch, host);
      await this.store.write('imports/' + id, JSON.stringify({ host, session: parsed.batch.session, digest: parsed.digest, evidence: 'captured-replay', exclusions: parsed.exclusions,
        limitations: ['Explicit message snapshot; automatic capture is off.', 'Tools, artifacts, approvals, hidden reasoning and later messages are not imported.', 'No AI assessment; six capabilities await human review. Assistance remains unknown.'] }));
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
    return { task: data.task as TaskCard['task'], observations: data.observations as TaskCard['observations'], interpretation: interpretations[0].interpretation,
      source: JSON.parse(source), reviews: data.reviews as TaskCard['reviews'], receipts };
  }
  async purpose(id: string, text: string) {
    return this.store.exclusive(async () => { await this.record.saveTask(confirmPurpose(await this.record.getTask(id), { by: 'user', at: Date.now(), text })); await this.store.remove('previews/' + id); });
  }
  async review(id: string, capability: string, action: ReviewAction, text: string) {
    return this.store.exclusive(async () => { const review = await this.record.reviewFinding(id, { interpretation: { id: 'manual-review', revision: 1 }, capability, action, by: 'user', at: Date.now(), note: text, ...(action === 'correct' ? { corrected_claim: text } : {}) }); await this.store.remove('previews/' + id); return review; });
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
        interpretations: includeInterpretation ? [{ id: 'manual-review', revision: 1 }] : [],
        reviews: card.reviews.filter(r => latest.get(r.capability)?.action !== 'exclude').map(r => r.key),
        excluded: [...(!includeEvidence ? card.observations.map(o => ({ ref: o.key, why: 'Source text excluded by user' })) : []),
          ...excludedReviews.map(r => ({ ref: r.key, why: 'Capability excluded by user' })),
          ...(!includeInterpretation ? [{ ref: `interpretations/${id}/manual-review@1`, why: 'Contains excluded capability' }] : [])] });
      await this.store.write('previews/' + id, JSON.stringify(bundle));
      return bundle;
    });
  }
  async submit(id: string, digest: string) {
    return this.store.exclusive(async () => {
      const raw = await this.store.read('previews/' + id);
      if (!raw) throw Error('preview_required');
      const bundle = JSON.parse(raw) as SubmissionBundle;
      if (bundle.digest !== digest) throw Error('preview_changed');
      const receipt = await this.record.submit(bundle, Date.now());
      if (!(await verifyReceipt(this.store, receipt)).ok) throw Error('receipt_integrity_failure');
      return receipt;
    });
  }
  async delete(id: string) {
    return this.store.exclusive(async () => {
      await this.record.deleteTask(id, { by: 'user', at: Date.now() });
      await this.store.remove('imports/' + id); await this.store.remove('previews/' + id);
    });
  }
}
