// Remote classroom operations R5 (#751) — legacy HAIN7 adapter for the report runner.
//
// The seven-axis HAIN7 engine (skills/hain7-report) is retired for NEW measurement and stays
// available for explicitly selected historical replay. This adapter connects exactly that:
// it runs the existing engine unchanged (`--legacy-replay`) on a job pinned to the
// `legacy-seven-assets` model and carries its findings into a legacy draft.
//
//   - Seven stays seven. Nothing is converted into the six-capability model.
//   - No score, band, percentile or peer comparison is carried: only which axis had learner
//     evidence, and the learner's own words behind it (verbatim, by line locator).
//   - The engine's 28-marker human review is carried as a flag. Without it the draft is
//     `review_required / marker_review_missing` and cannot be approved as if reviewed.
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_SEVEN_ASSETS } from '../worker/src/lib/measurement-core/index.ts';

const ENGINE = fileURLToPath(new URL('../skills/hain7-report/scripts/hain7_signal.py', import.meta.url));
export const LEGACY_RUBRIC_PREFIX = 'hain7-studio-signal';
const keyOf = (english) => LEGACY_SEVEN_ASSETS.capabilities.find((c) => c.key === String(english).toUpperCase())?.key;

/** Pure mapping: the engine's auditable analysis + the verified input → a legacy draft. */
export function legacyDraftFromAnalysis(analysis, job, eventsText, rendererRevision) {
  const lines = eventsText.split('\n').filter((l) => l.trim()), byId = new Map((analysis.evidence_index ?? []).map((e) => [e.evidence_id, e]));
  const findings = LEGACY_SEVEN_ASSETS.capabilities.map((cap) => {
    const axis = Object.values(analysis.axes ?? {}).find((a) => keyOf(a.english) === cap.key), evidence = [];
    for (const m of axis?.markers ?? []) {
      if (!(m.score > 0)) continue;
      for (const id of m.evidence_ids ?? []) {
        const e = byId.get(id); if (!e || e.role !== 'learner' || !Number.isSafeInteger(e.line)) continue; // AI prose and context are never learner evidence
        let text = ''; try { text = String(JSON.parse(lines[e.line - 1] ?? '{}').text ?? ''); } catch { text = ''; }
        const quote = text.slice(0, 300); if (!quote.trim() || evidence.some((x) => x.locator.line === e.line)) continue;
        evidence.push({ locator: { line: e.line, ...(typeof e.turn_id === 'string' ? { turn_id: e.turn_id } : {}) }, quote });
      }
    }
    return evidence.length ? { capability: cap.key, status: 'observed', claim: String(axis.strength ?? '').slice(0, 600), evidence: evidence.slice(0, 3) } : { capability: cap.key, status: 'unobserved', claim: '', evidence: [] };
  });
  return { format: 'hps-classroom-report-draft/1', versions: { capability_model: { id: LEGACY_SEVEN_ASSETS.id, revision: LEGACY_SEVEN_ASSETS.revision }, rubric: job.rubric, evaluator: job.evaluator, renderer_revision: rendererRevision },
    findings, next_experiment: '', legacy: { fingerprint: String(analysis.session_fingerprint ?? ''), marker_review_complete: analysis.review?.status === 'complete' } };
}

/** `context`: the operator's HAIN7 report context JSON (participant/lesson/privacy). `review`: optional completed 28-marker review. */
export function legacyEvaluator({ context, review, python = 'python3' }) {
  return async ({ job, events, rendererRevision }) => {
    if (job.capability_model !== LEGACY_SEVEN_ASSETS.id) throw new Error('legacy_engine_wrong_model');
    const dir = await mkdtemp(join(tmpdir(), 'hps-legacy-hain7-'));
    try {
      const input = join(dir, 'events.jsonl'), out = join(dir, 'analysis.json'); await writeFile(input, events, { mode: 0o600 });
      await new Promise((resolve, reject) => execFile(python, [ENGINE, '--legacy-replay', '--input', input, '--context', context, ...(review ? ['--review', review] : []), '--analysis-output', out, '--force'], { timeout: 120_000, maxBuffer: 1024 * 1024 }, (err) => (err ? reject(new Error('legacy_engine_failed')) : resolve())));
      return legacyDraftFromAnalysis(JSON.parse(await readFile(out, 'utf8')), job, events, rendererRevision);
    } finally { await rm(dir, { recursive: true, force: true }); } // the learner's record does not outlive the job on this machine
  };
}
