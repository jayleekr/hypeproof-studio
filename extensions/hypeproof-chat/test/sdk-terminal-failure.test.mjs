// #751 U4 — a turn the Agent SDK ended with an error is a FAILED turn for every consumer, and its cause is only what THIS
// turn's stream said. The real runSdkCoach (bundled, `vscode` stubbed) runs against a scripted SDK `query()` — no binary, no
// network, no model. The provider's mapping (sdkTurnEndFailure / the catch that reads `status`), the real RecoveryWatch and
// the Service's real recoveryOutcome finish the chain. Not a Studio window: the real-window check is mac-recovery.mjs R3.
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecoveryWatch, turnObservations } from '../src/classroomOps.ts';
import { classifyTurnError, sdkTurnEndFailure } from '../src/chatPanelHelpers.ts';
import { recoveryOutcome } from '../../../worker/src/lib/classroom-recovery.ts';

let dir, runSdkCoach;
test.before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hps-sdk-terminal-'));
  const out = join(dir, 'sdk.cjs');
  await build({ entryPoints: [fileURLToPath(new URL('../src/sdkCoach.ts', import.meta.url))], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', external: ['@anthropic-ai/claude-agent-sdk', 'zod'],
    plugins: [{ name: 'vscode-stub', setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports={window:{},workspace:{},Uri:{file:(p)=>({fsPath:p})}};', loader: 'js' })); } }] });
  ({ runSdkCoach } = createRequire(import.meta.url)(out));
});
test.after(async () => { await rm(dir, { recursive: true, force: true }); });

const retry = (status) => ({ type: 'system', subtype: 'api_retry', error_status: status, error: status === 429 ? 'rate_limit' : 'server_error' });
const said = (text) => ({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text }] } });
const never = () => new Promise(() => {});

/**
 * One turn the way chatPanelProvider runs it: the value runSdkCoach returns or the error it throws, mapped by the same
 * code the provider uses, into the TurnOutcome every consumer reads (closeTurn / spool / observation take `ok`).
 */
async function turn(events, { hang = false, throws = null } = {}) {
  const shown = [];
  const sdk = { query: () => (async function* () { for (const e of events) yield e; if (throws) throw throws; if (hang) await never(); })() };
  let ok = true, errorKind, failure = {};
  try {
    const end = await runSdkCoach({ sdk, binaryResolution: { available: true, reasons: [] }, gatewayUrl: 'http://127.0.0.1:1/v1', token: 't', model: 'm', profile: {}, systemPrompt: '', history: [], userText: 'q', signal: new AbortController().signal, stallTimeoutMs: hang ? 60 : 0, onDelta: (d) => shown.push(d) });
    const ended = sdkTurnEndFailure(end);
    if (ended) { ok = false; errorKind = ended.errorKind; failure = ended.failure; }
  } catch (err) {
    ok = false; errorKind = classifyTurnError(err);
    if (typeof err?.status === 'number') failure = { status: err.status };
    shown.push(err.message);
  }
  return { outcome: { ok, runtime: 'agent-sdk', ...(errorKind ? { errorKind } : {}), ...failure }, shown };
}
/** The learner's next turn after an instructor's reset, as the board judges it. */
function judged(outcome) {
  const w = new RecoveryWatch(); w.arm('cmd-reset-0001', 1);
  const f = w.onTurn(outcome, 1);
  return { followup: f, verdict: recoveryOutcome({ action: 'reset_runtime', state: 'succeeded', result_code: 'reset_ready', receipt: { observed_at: 1 }, followups: [{ ...f, observed_at: 2, received_at: 2 }], reports_followup: true }) };
}

test('control: a normal SDK turn is completed and resolves the reset', async () => {
  const { outcome, shown } = await turn([said('안녕'), { type: 'result', subtype: 'success', is_error: false }]);
  assert.equal(outcome.ok, true); assert.deepEqual(shown, ['안녕']);
  const { followup, verdict } = judged(outcome);
  assert.equal(followup.check, 'turn_completed'); assert.equal(verdict.verdict, 'resolved');
});

test('terminal error result: the learner reads one notice; every consumer gets the same failure; the cause is the result\'s own status', async () => {
  const { outcome, shown } = await turn([retry(500), retry(500), { type: 'result', subtype: 'success', is_error: true, api_error_status: 500 }]);
  assert.equal(outcome.ok, false, 'closeTurn / spool / observation read ok:false as failed');
  assert.equal(outcome.errorKind, 'sdk_result:is_error'); assert.equal(shown.length, 1, 'one notice, no duplicate');
  const { followup, verdict } = judged(outcome);
  assert.deepEqual([followup.check, followup.error_class], ['turn_failed', 'provider_5xx']);
  assert.deepEqual([verdict.verdict, verdict.cause, verdict.next], ['remains', 'provider_5xx', 'shared_cause_not_pc']);
  assert.equal(turnObservations(outcome).find((o) => o.kind === 'error').payload.class, 'provider_5xx');
  assert.equal(turnObservations(outcome).some((o) => o.payload.stage === 'runtime_ready'), false, 'a failed turn is never "runtime ready"');
});

test('explicit error_during_execution with no status in this turn stays unclassified — no guess', async () => {
  const { outcome } = await turn([said('작업 중'), { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['x'] }]);
  assert.deepEqual([outcome.ok, outcome.errorKind, outcome.status], [false, 'sdk_result:error_during_execution', undefined]);
  const { followup, verdict } = judged(outcome);
  assert.equal(followup.error_class, 'unknown'); assert.deepEqual([verdict.verdict, verdict.next], ['remains', 'onsite_check']);
});

test('retries still standing when the result ends the turn name the cause; a later good response clears them', async () => {
  assert.equal((await turn([retry(500), { type: 'result', subtype: 'error_during_execution', is_error: true }])).outcome.status, 500);
  assert.equal((await turn([retry(500), said('돌아옴'), { type: 'result', subtype: 'error_during_execution', is_error: true }])).outcome.status, undefined, 'answered retries are not this failure\'s cause');
  assert.equal((await turn([retry(500), retry(null), { type: 'result', subtype: 'error_during_execution', is_error: true }])).outcome.status, undefined, 'the standing retry is a connection error with no status');
});

test('stall after retries: 500 → provider_5xx, 429 → provider_rate_limit; the learner copy is unchanged', async () => {
  const five = await turn([retry(500), retry(500)], { hang: true });
  assert.deepEqual([five.outcome.errorKind, five.outcome.status], ['stall', 500]); assert.match(five.shown[0], /AI 서비스 오류로 응답을 받지 못했습니다.*\(500\)/);
  assert.equal(judged(five.outcome).followup.error_class, 'provider_5xx'); assert.equal(judged(five.outcome).verdict.next, 'shared_cause_not_pc');
  const rate = await turn([retry(429)], { hang: true });
  assert.equal(judged(rate.outcome).followup.error_class, 'provider_rate_limit'); assert.match(rate.shown[0], /\(429\)/);
});

test('no evidence stays unknown, and a previous turn\'s status is never carried into the next turn', async () => {
  const bare = await turn([], { hang: true });
  assert.deepEqual([bare.outcome.errorKind, bare.outcome.status], ['stall', undefined]); assert.equal(judged(bare.outcome).followup.error_class, 'unknown');
  await turn([retry(500), { type: 'result', subtype: 'success', is_error: true, api_error_status: 500 }]);
  const next = await turn([said('다음 질문'), { type: 'result', subtype: 'error_during_execution', is_error: true }]);
  assert.equal(next.outcome.status, undefined); assert.equal(judged(next.outcome).followup.error_class, 'unknown');
});

test('the real SDK\'s own ending: retries, an API-error message, then query() THROWS a plain Error — the status of this turn\'s retries is the cause', async () => {
  // Shape seen on a real Mac (run 7): the gateway answered 502 for the provider's 500; the SDK retried, printed
  // "API Error: 502 …" and threw. Before the fix this came out as `unknown`.
  const apiError = { type: 'assistant', error: 'server_error', message: { id: 'e', content: [{ type: 'text', text: 'API Error: 502 upstream error (status 500).' }] } };
  const real = await turn([retry(502), retry(502), apiError], { throws: new Error('Claude Code process exited with code 1') });
  assert.deepEqual([real.outcome.ok, real.outcome.errorKind, real.outcome.status], [false, 'error', 502]);
  assert.deepEqual([judged(real.outcome).followup.error_class, judged(real.outcome).verdict.next], ['provider_5xx', 'shared_cause_not_pc']);
  const synthetic = { type: 'assistant', message: { id: 's', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 502 upstream error' }] } };
  assert.equal((await turn([retry(502), synthetic], { throws: new Error('exit 1') })).outcome.status, 502, 'the CLI\'s own API-error line does not count as an answer');
  const bare = await turn([said('작업 중')], { throws: new Error('boom') });
  assert.equal(bare.outcome.status, undefined, 'a thrown error with no status in this turn stays unknown'); assert.equal(judged(bare.outcome).followup.error_class, 'unknown');
  const own = Object.assign(new Error('auth'), { status: 401 }); const kept = await turn([retry(500)], { throws: own });
  assert.equal(kept.outcome.status, 401, 'an error that already names its status keeps it');
});
