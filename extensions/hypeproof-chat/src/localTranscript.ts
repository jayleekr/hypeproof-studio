import { createHash } from 'node:crypto';
import { DEFAULT_CAPABILITY_MODEL, validateObservation, redactText } from '../../../worker/src/lib/measurement-core/index.ts';
import type { ObservationEvent, ObservationBatch } from '../../../worker/src/lib/measurement-core/legacy-observation.ts';
import type { Interpretation } from '../../../worker/src/lib/measurement-core/interpretation.ts';
import type { ReviewHost } from './localReviewProtocol.ts';

export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
/** Explicitly selected message transcript only. Never executes tool text or scans other projects. */
export function parseLocalTranscript(raw: string, host: ReviewHost) {
  if (!['claude-code', 'codex'].includes(host)) throw Error('unsupported_host');
  if (Buffer.byteLength(raw) > MAX_TRANSCRIPT_BYTES) throw Error('transcript_too_large');
  const rows = raw.split(/\r?\n/).filter(l => l.trim()).map((l, i) => {
    try { return { row: JSON.parse(l), line: i + 1 }; } catch { throw Error('invalid_transcript_json'); }
  });
  let session = '', project = '';
  const events: ObservationEvent[] = [];
  const exclusions = new Set<string>();
  const models = new Set<string>();
  for (const { row: r, line } of rows) {
    if (!r || typeof r !== 'object') throw Error('invalid_transcript_record');
    if (host === 'codex' && r.type === 'session_meta') { session = r.payload?.id; project = r.payload?.cwd; }
    if (host === 'claude-code' && r.sessionId) {
      if (session && session !== r.sessionId) throw Error('mixed_sessions');
      session = r.sessionId; project = r.cwd || project;
    }
    if (typeof r.message?.model === 'string') models.add(r.message.model);
    let role: string | undefined, content: unknown;
    if (host === 'codex' && r.type === 'response_item' && r.payload?.type === 'message') {
      role = r.payload.role; content = r.payload.content;
    } else if (host === 'claude-code' && ['user', 'assistant'].includes(r.type) && !r.isMeta) {
      role = r.message?.role; content = r.message?.content;
    }
    if (role !== 'user' && role !== 'assistant') continue;
    const plain = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(c => ['text', 'input_text', 'output_text'].includes(c?.type) && typeof c.text === 'string').map(c => c.text).join('\n') : '';
    if (!plain.trim()) continue;
    // Host-injected instructions are not the person's behavior.
    if (role === 'user' && /^\s*(# AGENTS\.md instructions|<environment_context>|<INSTRUCTIONS>|<system-reminder>|<skill>)/.test(plain)) {
      exclusions.add('Host-injected instructions omitted'); continue;
    }
    if (plain.length > 20000 || events.length >= 500) throw Error('transcript_exceeds_event_limit');
    const at = Date.parse(r.timestamp);
    if (!Number.isFinite(at)) throw Error('missing_event_timestamp');
    const redacted = redactText(plain);
    for (const x of redacted.exclusions) exclusions.add(x.kind);
    events.push({ id: 'line-' + line, seq: events.length + 1, task: 'imported', at, kind: role === 'user' ? 'user' : 'coach', text: redacted.text, assistance: 'unknown' });
  }
  if (typeof session !== 'string' || !session || typeof project !== 'string' || !project || !events.length) throw Error('unsupported_or_empty_transcript');
  const batch: ObservationBatch = { format: 'hps-observation/1', scope: 'jay-local', session, program: 'explicit-transcript-import/1', events, incomplete: true };
  validateObservation(batch);
  return { host, project, batch, models: [...models], digest: createHash('sha256').update(raw).digest('hex'), exclusions: [...exclusions] };
}
export function manualInterpretation(batch: ObservationBatch, models: string[]): Interpretation {
  const model = DEFAULT_CAPABILITY_MODEL;
  return {
    format: 'hps-interpretation/1', id: 'manual-review', revision: 1, supersedes: null,
    batch: { format: batch.format, scope: batch.scope, session: batch.session, program: batch.program },
    versions: { bundle_format: batch.format, capability_model: { id: model.id, revision: model.revision }, definition_revision: model.definition_revision,
      rubric: 'unknown', evaluator: { id: 'manual-review', version: '1' }, analysis_ai_model: 'unknown', work_ai_models: models.length ? models : 'unknown' },
    findings: model.capabilities.map(c => ({ capability: c.key, status: 'insufficient_evidence', claim: 'Not assessed. Review the source evidence and add your judgment.', evidence: [], assistance: 'unknown', review: 'unreviewed' })),
    unclassified: [],
  };
}
