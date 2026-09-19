#!/usr/bin/env node
// Remote classroom operations R5 (#751) — restricted batch runner for the operator's Mac.
//
//   node --experimental-strip-types scripts/classroom-report-runner.mjs --service https://… [--once]
//       [--legacy-hain7 <context.json> [--legacy-review <review.json>]]   legacy seven-axis jobs → the existing HAIN7 engine
//       [--evaluator ./my-evaluator.mjs]                                  a locally supplied evaluator module (advanced)
//   credential: env HPS_RUNNER_CREDENTIAL (per-batch, from POST …/report-batches/:id/runner-grants). Never a CLI argument, never logged.
//
// It reuses the measurement core's capability models; it is not a second scorer. By default a
// six-capability job is evaluated INSIDE the Service (POST …/evaluate): the learner's record
// never reaches this machine. If the Service has no evaluator configured the job goes back to
// the queue as `evaluator_not_configured` — an empty draft is never sent in its place.
// Legacy seven-axis jobs run the existing HAIN7 engine locally. One job at a time, inputs in
// memory only, bounded size and time. If this Mac sleeps, jobs stay queued in D1 and the
// lease expires; nothing is lost and nothing is half-written.
import { capabilityModel, CAPABILITY_MODELS } from '../worker/src/lib/measurement-core/index.ts';

export const RENDERER_REVISION = 'observation-report/1';
const MAX_INPUT_BYTES = 8 * 1024 * 1024, JOB_TIMEOUT_MS = 4 * 60_000;

export function emptyDraft(job) {
  const model = CAPABILITY_MODELS.find((m) => m.id === job.capability_model);
  if (!model || !capabilityModel(model.id, model.revision)) throw new Error('unknown_capability_model');
  return { format: 'hps-classroom-report-draft/1', versions: { capability_model: { id: model.id, revision: model.revision }, rubric: job.rubric, evaluator: job.evaluator, renderer_revision: RENDERER_REVISION },
    findings: model.capabilities.map((c) => ({ capability: c.key, status: 'unobserved', claim: '', evidence: [] })), next_experiment: '' };
}

export async function runOnce({ service, credential, evaluate, legacyEvaluate, fetchImpl = fetch, log = console.log }) {
  const call = async (path, init = {}) => { const r = await fetchImpl(service.replace(/\/$/, '') + '/v1/classroom/ops/runner' + path, { ...init, headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json', ...(init.headers ?? {}) } }); return r; };
  const claimed = await (await call('/claim', { method: 'POST', body: '{}' })).json();
  if (!claimed.job) return { claimed: false };
  const job = claimed.job, gen = job.lease_generation;
  const beat = setInterval(() => void call(`/jobs/${job.id}/heartbeat`, { method: 'POST', body: JSON.stringify({ lease_generation: gen }) }).catch(() => undefined), Math.floor(job.lease_ms / 3));
  try {
    const legacy = job.capability_model === 'legacy-seven-assets';
    // Six-capability jobs: the Service evaluates. Nothing of the learner's record is downloaded here.
    if (!legacy && !evaluate) {
      const out = await call(`/jobs/${job.id}/evaluate`, { method: 'POST', body: JSON.stringify({ lease_generation: gen }) }); const body = await out.json();
      log(`job ${job.id}: ${body.state ?? body.reason}${body.reason ? ' (' + body.reason + ')' : ''}`); return { claimed: true, job: job.id, status: out.status, ...body };
    }
    // The legacy seven-axis report keeps its own engine (skills/hain7-report): this runner never converts between models.
    const engine = legacy ? legacyEvaluate : evaluate;
    if (!engine) throw new Error('legacy_engine_not_configured');
    const res = await call(`/jobs/${job.id}/input/events.jsonl?generation=${gen}`); if (!res.ok) throw new Error('input_unavailable');
    const bytes = await res.arrayBuffer(); if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error('input_too_large');
    const events = new TextDecoder().decode(bytes);
    let timer; const draft = await Promise.race([engine({ job, events, empty: emptyDraft(job), rendererRevision: RENDERER_REVISION }), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('job_timeout')), JOB_TIMEOUT_MS); })]).finally(() => clearTimeout(timer));
    const out = await call(`/jobs/${job.id}/result`, { method: 'POST', body: JSON.stringify({ lease_generation: gen, draft }) }); const body = await out.json();
    log(`job ${job.id}: ${body.state ?? body.reason}${body.reason ? ' (' + body.reason + ')' : ''}`); return { claimed: true, job: job.id, status: out.status, ...body };
  } catch (err) {
    const code = String(err?.message ?? 'runner_failed').replace(/[^a-z_]/g, '').slice(0, 48) || 'runner_failed';
    const out = await call(`/jobs/${job.id}/result`, { method: 'POST', body: JSON.stringify({ lease_generation: gen, failed: code }) }); log(`job ${job.id}: failed (${code})`); return { claimed: true, job: job.id, status: out.status, state: 'failed', reason: code };
  } finally { clearInterval(beat); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const service = arg('--service'), credential = process.env.HPS_RUNNER_CREDENTIAL;
  if (!service || !credential) { console.error('usage: HPS_RUNNER_CREDENTIAL=… node --experimental-strip-types scripts/classroom-report-runner.mjs --service <url> [--evaluator <module>] [--once]'); process.exit(2); }
  const evaluate = arg('--evaluator') ? (await import(new URL(arg('--evaluator'), `file://${process.cwd()}/`).href)).evaluate : undefined;
  const legacyEvaluate = arg('--legacy-hain7') ? (await import('./classroom-legacy-hain7.mjs')).legacyEvaluator({ context: arg('--legacy-hain7'), review: arg('--legacy-review') }) : undefined;
  for (;;) { const r = await runOnce({ service, credential, evaluate, legacyEvaluate }); if (process.argv.includes('--once')) break; if (!r.claimed) await new Promise((res) => setTimeout(res, 15000)); }
}
