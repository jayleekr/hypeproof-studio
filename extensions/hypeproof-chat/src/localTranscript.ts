import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { DEFAULT_CAPABILITY_MODEL, validateObservation, redactText } from '../../../worker/src/lib/measurement-core/index.ts';
import type { ObservationEvent, ObservationBatch } from '../../../worker/src/lib/measurement-core/legacy-observation.ts';
import type { Interpretation } from '../../../worker/src/lib/measurement-core/interpretation.ts';
import type { ReviewHost } from './localReviewProtocol.ts';

export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
/** Explicitly selected message transcript only. Never executes tool text or scans other projects. */
export function parseLocalTranscript(raw: string, host: ReviewHost) {
  if (!['claude-code', 'codex'].includes(host)) throw Error('unsupported_host');
  if (Buffer.byteLength(raw) > MAX_TRANSCRIPT_BYTES) throw Error('transcript_too_large');
  const lines = raw.split(/\r?\n/);
  let pendingTail = false;
  const rows = lines.flatMap((l, i) => {
    if (!l.trim()) return [];
    if (i === lines.length - 1) { try { JSON.parse(l); } catch { if (i === 0) throw Error('invalid_transcript_json'); pendingTail = true; return []; } }
    try { return [{ row: JSON.parse(l), line: i + 1 }]; } catch { throw Error('invalid_transcript_json'); }
  });
  return parseRows(rows, host, createHash('sha256').update(raw).digest('hex'), pendingTail);
}

function parseRows(rows: Array<{ row: any; line: number }>, host: ReviewHost, digest: string, pendingTail: boolean) {
  let session = '', project = '';
  const events: ObservationEvent[] = [];
  let windowed = false;
  const exclusions = new Set<string>();
  const models = new Set<string>();
  const conditions: Array<{ line: number; at: string | null; model: string; reasoning: string | null }> = [];
  if (pendingTail) exclusions.add('Incomplete final JSONL record omitted; refresh after the writer finishes.');
  let sequence = 0;
  for (const { row: r, line } of rows) {
    if (!r || typeof r !== 'object') throw Error('invalid_transcript_record');
    if (host === 'codex' && r.type === 'session_meta') {
      if (session && session !== r.payload?.id) throw Error('mixed_sessions');
      if (project && project !== r.payload?.cwd) throw Error('mixed_projects');
      session = r.payload?.id; project = r.payload?.cwd;
    }
    if (host === 'claude-code' && r.sessionId) {
      if (session && session !== r.sessionId) throw Error('mixed_sessions');
      if (project && r.cwd && project !== r.cwd) throw Error('mixed_projects');
      session = r.sessionId; project = r.cwd || project;
    }
    if (host === 'codex' && r.type === 'turn_context' && typeof r.payload?.model === 'string') {
      models.add(r.payload.model);
      conditions.push({ line, at: typeof r.timestamp === 'string' ? r.timestamp : null, model: r.payload.model, reasoning: typeof r.payload.effort === 'string' ? r.payload.effort : null });
    }
    if (host === 'claude-code' && typeof r.message?.model === 'string') {
      models.add(r.message.model);
      if (conditions.at(-1)?.model !== r.message.model) conditions.push({ line, at: typeof r.timestamp === 'string' ? r.timestamp : null, model: r.message.model, reasoning: null });
    }
    let role: string | undefined, content: unknown;
    if (host === 'codex' && r.type === 'response_item' && r.payload?.type === 'message') {
      if (r.payload.channel === 'analysis') { exclusions.add('Hidden reasoning omitted'); continue; }
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
    sequence++;
    if (plain.length > 20000 || sequence > 10000) { exclusions.add('Messages beyond the per-event or sequence limit omitted; this is partial evidence.'); continue; }
    const at = Date.parse(r.timestamp);
    if (!Number.isFinite(at)) throw Error('missing_event_timestamp');
    const redacted = redactText(plain);
    for (const x of redacted.exclusions) exclusions.add(x.kind);
    if (events.length === 500) { events.shift(); windowed = true; }
    events.push({ id: 'line-' + line, seq: sequence, task: 'imported', at, kind: role === 'user' ? 'user' : 'coach', text: redacted.text, assistance: 'unknown' });
  }
  if (windowed) { exclusions.add('Only the most recent 500 eligible messages are included in this snapshot.'); }
  if (typeof session !== 'string' || !session || typeof project !== 'string' || !project || !events.length) throw Error('unsupported_or_empty_transcript');
  const batch: ObservationBatch = { format: 'hps-observation/1', scope: 'jay-local', session, program: 'explicit-transcript-import/1', events, incomplete: true };
  validateObservation(batch);
  return { host, project, batch, models: [...models], digest, exclusions: [...exclusions], conditions };
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

/** Selected live transcript: snapshot the initial byte range, hash it, and skip tool/hidden payloads before retaining rows. */
export async function parseLocalTranscriptFile(path: string, host: ReviewHost) {
  if (!['claude-code', 'codex'].includes(host)) throw Error('unsupported_host');
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !stat.size || stat.size > 1024 * 1024 * 1024) throw Error('transcript_too_large');
    const stream = file.createReadStream({ start: 0, end: stat.size - 1, autoClose: false });
    let lastByte = 0;
    const hash = createHash('sha256'); stream.on('data', chunk => { hash.update(chunk); lastByte = typeof chunk === 'string' ? chunk.charCodeAt(chunk.length - 1) : chunk[chunk.length - 1]; });
    const input = createInterface({ input: stream, crlfDelay: Infinity });
    const rows: Array<{ row: any; line: number }> = [];
    let line = 0, badLine = 0;
    for await (const text of input) {
      line++;
      if (!text.trim()) continue;
      if (badLine) throw Error('invalid_transcript_json');
      let r; try { r = JSON.parse(text); } catch { badLine = line; continue; }
      if (!r || typeof r !== 'object') throw Error('invalid_transcript_record');
      if (host === 'codex') {
        if (r.type === 'session_meta') rows.push({ row: { type: r.type, payload: { id: r.payload?.id, cwd: r.payload?.cwd } }, line });
        else if (r.type === 'turn_context') rows.push({ row: { type: r.type, timestamp: r.timestamp, payload: { model: r.payload?.model, effort: r.payload?.effort } }, line });
        else if (r.type === 'response_item' && r.payload?.type === 'message') rows.push({ row: r.payload.channel === 'analysis' ? { ...r, payload: { ...r.payload, content: [] } } : r, line });
      } else if (['user', 'assistant'].includes(r.type)) rows.push({ row: r, line });
      else if (r.sessionId) rows.push({ row: { sessionId: r.sessionId, cwd: r.cwd }, line });
      if (rows.length > 20000) throw Error('transcript_metadata_limit');
    }
    if (badLine && (badLine === 1 || lastByte === 10)) throw Error('invalid_transcript_json');
    return parseRows(rows, host, hash.digest('hex'), !!badLine);
  } finally { await file.close(); }
}
