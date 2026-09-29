// Remote classroom operations U4 (#751) — cause → action → follow-up observation, with synthetic accounts.
// Service + SQLite layer of AT-40. The real app's executors are covered in extensions/…/classroom-ops-recovery.smoke.mjs
// and the real window in e2e/classroom/mac-recovery.mjs. Nothing here proves a real device, a real model or a school network.
import assert from 'node:assert/strict';
import { localOps } from './harness/classroom-ops.mjs';
import * as ops from '../src/lib/classroom-ops.ts';
import * as rec from '../src/lib/classroom-recovery.ts';
const tick = () => new Promise((r) => setTimeout(r, 8)); // the Service reads the real clock; order is made by really waiting
let count = 0; async function check(name, fn) { await fn(); count++; console.log('PASS ' + name); }
const base = { followups: [], reports_followup: true, latest_issue: null, receipt: { observed_at: 10, received_at: 11 } };
const verdict = (action, state, result_code, extra = {}) => rec.recoveryOutcome({ ...base, action, state, result_code, ...extra });

await check('controls: `succeeded` alone never means resolved — every action, every result code (positive and negative samples)', async () => {
  // Negative controls first: nothing that did not run, or whose outcome is unknown, may read as resolved or executed.
  for (const action of ['retry_diagnostics', 'refresh_connection', 'restart_preview', 'cancel_current_run', 'reset_runtime', 'retry_evidence_upload']) {
    for (const [state, code] of [['not_connected', ''], ['unsupported', ''], ['expired', 'ttl'], ['expired', 'epoch_stale'], ['cancelled', 'instructor_cancelled'], ['rejected', 'seat_busy'], ['rejected', 'start_window_closed']]) assert.equal(verdict(action, state, code).verdict, 'not_executed', `${action} ${state}`);
    assert.equal(verdict(action, 'outcome_unknown', 'no_receipt').verdict, 'unverified'); assert.equal(verdict(action, 'queued', '').verdict, 'pending'); assert.equal(verdict(action, 'running', '').verdict, 'pending');
    assert.notEqual(verdict(action, 'succeeded', '').verdict, 'resolved', `${action}: a bare success is not a resolution`);
  }
  assert.equal(verdict('retry_diagnostics', 'not_connected', '').basis, 'not_reached_app');
  // Diagnosis: finishing is not fixing. The finding decides.
  assert.deepEqual([verdict('retry_diagnostics', 'succeeded', 'token_ok').verdict, verdict('retry_diagnostics', 'succeeded', 'token_ok').basis], ['executed', 'token_ok_cause_not_covered']);
  for (const [code, cause, next] of [['service_unreachable', 'network', 'check_network_not_pc'], ['profile_network', 'network', 'check_network_not_pc'], ['no_token', 'no_token', 'issue_and_deliver_token'], ['profile_401', 'token_rejected', 'reissue_token'], ['profile_403', 'class_or_roster', 'check_class_open_and_roster'], ['profile_500', 'service_error', 'wait_then_diagnose_again']]) {
    const o = verdict('retry_diagnostics', 'succeeded', code); assert.deepEqual([o.verdict, o.cause, o.next], ['remains', cause, next], code);
  }
  assert.equal(verdict('retry_diagnostics', 'failed', 'interrupted').verdict, 'unverified');
  // Runtime: a preserved restart is a READY state, not a run. Refusals that changed nothing keep the cause.
  assert.deepEqual([verdict('reset_runtime', 'succeeded', 'reset_ok').verdict, verdict('reset_runtime', 'succeeded', 'reset_ok').basis], ['executed', 'ready_next_run_not_observed']);
  assert.equal(verdict('reset_runtime', 'succeeded', 'reset_ok', { reports_followup: false }).basis, 'ready_app_cannot_report_next_run');
  for (const code of ['stop_unconfirmed', 'draft_not_saved', 'preserve_failed', 'evidence_not_flushed', 'preservation_mismatch']) assert.deepEqual([verdict('reset_runtime', 'failed', code).verdict, verdict('reset_runtime', 'failed', code).cause], ['remains', code]);
  assert.equal(verdict('reset_runtime', 'failed', 'reset_done_probe_failed').next, 'run_diagnostics'); assert.equal(verdict('cancel_current_run', 'failed', 'stop_unconfirmed').verdict, 'remains');
  assert.equal(verdict('cancel_current_run', 'succeeded', 'no_active_run').basis, 'nothing_was_running');
  const f = (check, extra = {}) => [{ check, observed_at: 20, received_at: 21, ...extra }];
  assert.deepEqual([verdict('reset_runtime', 'succeeded', 'reset_ok', { followups: f('turn_completed') }).verdict, verdict('reset_runtime', 'succeeded', 'reset_ok', { followups: f('turn_completed') }).observed_at], ['resolved', 20]);
  assert.deepEqual([verdict('cancel_current_run', 'succeeded', 'run_stopped', { followups: f('turn_completed') }).verdict], ['resolved']);
  const shared = verdict('reset_runtime', 'succeeded', 'reset_ok', { followups: f('turn_failed', { error_class: 'provider_5xx' }) }); assert.deepEqual([shared.verdict, shared.cause, shared.next], ['remains', 'provider_5xx', 'shared_cause_not_pc'], 'a shared outage is never "fixed by resetting the PC"');
  assert.equal(verdict('reset_runtime', 'succeeded', 'reset_ok', { followups: [...f('turn_completed'), { check: 'turn_failed', error_class: 'unknown', observed_at: 30, received_at: 31 }] }).verdict, 'remains', 'the latest linked run decides');
  // Preview: only an artifact that really opened counts; a server health check (what older apps did) does not.
  assert.equal(verdict('restart_preview', 'succeeded', 'preview_artifact_ok').verdict, 'resolved'); assert.equal(verdict('restart_preview', 'succeeded', 'preview_reopened_artifact_ok').basis, 'artifact_reopened_new_address');
  assert.deepEqual([verdict('restart_preview', 'succeeded', 'preview_reloaded').verdict, verdict('restart_preview', 'succeeded', 'preview_reloaded').basis], ['executed', 'server_health_only']);
  for (const [code, cause] of [['preview_artifact_missing', 'artifact_not_found'], ['preview_restarted_new_url', 'preview_tab_stale'], ['preview_unhealthy', 'preview_server_down']]) assert.deepEqual([verdict('restart_preview', 'failed', code).verdict, verdict('restart_preview', 'failed', code).cause], ['remains', cause]);
  assert.equal(verdict('restart_preview', 'failed', 'no_preview').verdict, 'not_executed');
  for (const current_cause of ['provider_5xx', 'provider_rate_limit', 'budget_limit', 'sdk_not_ready']) {
    const o = verdict('retry_diagnostics', 'succeeded', 'token_ok', { current_cause });
    assert.deepEqual([o.verdict, o.cause, o.basis], ['executed', current_cause, 'token_ok_cause_not_covered']);
  }
  for (const current_cause of ['network', 'auth_expired', 'class_not_open', '']) {
    assert.equal(verdict('retry_diagnostics', 'succeeded', 'token_ok', { current_cause }).verdict, 'resolved');
  }
  // Token: which issue the app verified. No issue id = no claim about a re-issued token.
  assert.equal(verdict('refresh_connection', 'succeeded', 'profile_verified').verdict, 'executed');
  assert.equal(verdict('refresh_connection', 'succeeded', 'profile_verified', { reports_followup: false }).basis, 'profile_valid_app_cannot_name_issue');
  const issue = { id: 'issue-new-0001', count: 2 };
  assert.deepEqual(((o) => [o.verdict, o.basis])(verdict('refresh_connection', 'succeeded', 'profile_verified', { latest_issue: issue, followups: f('profile_verified', { token_jti: 'issue-new-0001' }) })), ['resolved', 'reissued_token_active']);
  assert.deepEqual(((o) => [o.verdict, o.basis])(verdict('refresh_connection', 'succeeded', 'profile_verified', { latest_issue: { ...issue, count: 1 }, followups: f('profile_verified', { token_jti: 'issue-new-0001' }) })), ['resolved', 'existing_token_rechecked']);
  assert.deepEqual(((o) => [o.verdict, o.cause, o.next])(verdict('refresh_connection', 'succeeded', 'profile_verified', { latest_issue: issue, followups: f('profile_verified', { token_jti: 'issue-old-0001' }) })), ['remains', 'new_issue_not_in_app', 'deliver_new_token']);
  assert.equal(verdict('refresh_connection', 'failed', 'busy_active_run').verdict, 'not_executed'); assert.equal(verdict('refresh_connection', 'failed', 'profile_not_verified').verdict, 'remains');
  // Upload: the device's "sent" is not the Service's "verified".
  assert.deepEqual([verdict('retry_evidence_upload', 'succeeded', 'receipt_verified').verdict, verdict('retry_evidence_upload', 'succeeded', 'receipt_verified').next], ['executed', 'see_collection_result']);
  assert.deepEqual(['verified', 'transferring', 'awaiting_device', 'resend_wait', 'refused', 'held', 'grace_over', 'not_delivered', 'excluded', 'unknown', 'a_future_phase'].map(rec.collectOutcome), ['resolved', 'pending', 'pending', 'unverified', 'remains', 'remains', 'remains', 'not_executed', 'not_executed', 'unverified', 'unverified']);
  assert.deepEqual(rec.summarizeOutcomes([{ verdict: 'resolved' }, { verdict: 'not_executed' }, { verdict: 'remains' }, { verdict: 'not_executed' }]), { resolved: 1, remains: 1, executed: 0, unverified: 0, not_executed: 2, pending: 0, total: 4 });
});

await check('controls: cause → one first action; a shared cause never recommends a per-PC action; pause has three separate observations', async () => {
  const seat = (o) => rec.recommendAction({ connected: true, attention: 'ok', reason: '', entry_stage: 'runtime_ready', in_shared_incident: false, ...o });
  assert.equal(seat({}).action, ''); assert.equal(seat({ connected: false, attention: 'unknown', reason: 'not_connected' }).action, 'pairing');
  assert.deepEqual([seat({ attention: 'blocked', reason: 'auth_expired' }).family, seat({ attention: 'blocked', reason: 'auth_expired' }).action], ['token', 'issuer']);
  assert.equal(seat({ attention: 'blocked', reason: 'auth_rejected', entry_stage: 'token_rejected' }).action, 'issuer'); assert.equal(seat({ token_app_verified: 'other_token' }).action, 'refresh_connection');
  assert.equal(seat({ attention: 'blocked', reason: 'sdk_not_ready', runtime_status: 'idle' }).action, 'reset_runtime'); assert.equal(seat({ attention: 'blocked', reason: 'sdk_not_ready', runtime_status: 'running' }).action, 'cancel_current_run');
  assert.equal(seat({ attention: 'caution', reason: 'upload_failed' }).action, 'collection'); assert.equal(seat({ attention: 'unknown', reason: 'stale_signal' }).action, 'retry_diagnostics');
  for (const reason of rec.SHARED_CAUSES) { const r = seat({ attention: 'blocked', reason, in_shared_incident: true }); assert.deepEqual([r.family, r.action], ['shared', 'none_shared_incident'], reason); assert.notEqual(seat({ attention: 'blocked', reason }).action, 'reset_runtime'); }
  assert.deepEqual(rec.SHARED_CAUSES, [...ops.COMMON_CAUSE_CLASSES], 'the two lists are the same list');
  const c = (o) => rec.controlOutcome({ paused: false, control_revision: 2, control_updated_at: 100, device: 'applied', runtime: { status: 'running', received_at: 101 }, state_from_current_connection: true, ...o });
  assert.equal(c({}).resumed_run, 'observed'); assert.equal(c({ runtime: { status: 'running', received_at: 100 } }).resumed_run, 'not_observed', 'the same instant proves no order');
  assert.equal(c({ runtime: { status: 'running', received_at: 99 } }).resumed_run, 'not_observed', 'a run before the resume is not a resumed run'); assert.equal(c({ runtime: { status: 'idle', received_at: 200 } }).resumed_run, 'not_observed');
  assert.equal(c({ state_from_current_connection: false }).resumed_run, 'not_observed', 'another connection\'s signal'); assert.equal(c({ device: 'unknown' }).resumed_run, 'not_observed'); assert.equal(c({ control_updated_at: null }).resumed_run, 'not_observed');
  assert.deepEqual(c({ paused: true }), { service: 'blocking_new_runs', device: 'applied', resumed_run: 'not_applicable' }); assert.equal(c({ control_revision: 0 }).service, 'never_set');
  assert.equal(ops.keepsRuntimeFault({ boot_seen_at: 5, seq: 3, observed_at: 1, received_at: 1, actor: 'system', value: { stage: 'runtime_failed' } }, 'token_verified', 5), true);
  assert.equal(ops.keepsRuntimeFault({ boot_seen_at: 5, seq: 3, observed_at: 1, received_at: 1, actor: 'system', value: { stage: 'runtime_failed' } }, 'runtime_ready', 5), false);
  assert.equal(ops.keepsRuntimeFault({ boot_seen_at: 5, seq: 3, observed_at: 1, received_at: 1, actor: 'system', value: { stage: 'runtime_failed' } }, 'token_verified', 6), false, 'a new app process starts clean');
});

await check('controls: the follow-up event carries an id, a code and a public issue id — nothing else', async () => {
  const ok = (p) => ops.validatePayload('recovery', p).ok;
  assert.ok(ok({ command_id: 'cmd-00000001', check: 'turn_completed' })); assert.ok(ok({ command_id: 'cmd-00000001', check: 'profile_verified', token_jti: 'issue-0000001' })); assert.ok(ok({ command_id: 'cmd-00000001', check: 'turn_failed', error_class: 'provider_5xx', runtime: 'agent-sdk' }));
  for (const bad of [{ check: 'turn_completed' }, { command_id: 'cmd-00000001', check: 'fixed' }, { command_id: 'cmd-00000001', check: 'turn_completed', token_jti: 'issue-0000001' }, { command_id: 'cmd-00000001', check: 'turn_failed', error_class: 'Traceback: /Users/x' }, { command_id: 'cmd-00000001', check: 'turn_completed', text: '학생 질문' }, { command_id: 'cmd-00000001', check: 'profile_verified', token: 'eyJ…' }, { command_id: '../x', check: 'turn_completed' }]) assert.equal(ok(bad), false, JSON.stringify(bad));
});

const f = await localOps();
const seats = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }, { seat_id: 'A3', student_id: 'student-c' }, { seat_id: 'A4', student_id: 'legacy-test-seat' }];
const CAPS = ['observe', 'commands', 'retry_diagnostics', 'refresh_connection', 'restart_preview', 'cancel_current_run', 'reset_runtime', 'retry_evidence_upload'];
try {
  await f.freeze(); assert.equal((await f.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true } })).status, 201);
  const a1 = (await f.pair('A1', 1, 1, [...CAPS, rec.FOLLOWUP_CAPABILITY])).conn.json, a2 = (await f.pair('A2', 1, 2, [...CAPS, rec.FOLLOWUP_CAPABILITY])).conn.json, a3 = (await f.pair('A3', 1, 3, CAPS)).conn.json; // A3 = app before U4; A4 never connects
  const view = async (id) => (await f.request(f.base + '/commands/' + id)).json, seatOf = async (id) => (await f.request(f.base + '/status')).json.seats.find((s) => s.seat_id === id);
  let seq = { 1: 0, 2: 0, 3: 0 };
  /** One command, run to its final receipt on the given connection, as the app would. */
  const runOn = async (conn, n, commandId, state, code, events = []) => {
    const got = (await f.sync(conn.credential, [], n)).json.commands.find((x) => x.command_id === commandId); assert.ok(got, 'delivered');
    assert.equal((await f.sync(conn.credential, [], n, { receipts: [f.receipt(got, 'accepted')] })).json.receipt_acks[0].proceed, true);
    const r = await f.sync(conn.credential, events.map((e) => f.event(++seq[n], 'recovery', { command_id: commandId, ...e })), n, { receipts: [f.receipt(got, state, code)] }); assert.equal(r.status, 200, r.raw); return r.json;
  };

  await check('AT-40 selected seats only: a batch reports each target\'s outcome; offline and old-app seats are never counted as resolved', async () => {
    await f.sync(a1.credential, [f.event(++seq[1], 'error', { class: 'network', blocking: true })], 1);
    const sent = (await f.command('retry_diagnostics', ['A1', 'A3', 'A4'])).json; assert.deepEqual(sent.targets.map((t) => [t.seat_id, t.outcome.verdict]), [['A1', 'pending'], ['A3', 'pending'], ['A4', 'not_executed']]);
    assert.equal(sent.targets[2].outcome.basis, 'not_reached_app'); assert.deepEqual([sent.summary.outcomes.resolved, sent.summary.outcomes.not_executed], [0, 1]);
    await runOn(a1, 1, sent.command.id, 'succeeded', 'token_ok'); await runOn(a3, 3, sent.command.id, 'succeeded', 'service_unreachable');
    const v = await view(sent.command.id);
    assert.deepEqual(v.targets.map((t) => [t.seat_id, t.state, t.outcome.verdict, t.outcome.cause]), [['A1', 'succeeded', 'resolved', ''], ['A3', 'succeeded', 'remains', 'network'], ['A4', 'not_connected', 'not_executed', '']]);
    assert.deepEqual([v.summary.done, v.summary.all_succeeded, v.summary.outcomes.resolved, v.summary.outcomes.remains, v.summary.outcomes.not_executed], [true, false, 1, 1, 1], 'two devices "succeeded"; one cause is gone');
    assert.ok(v.targets[0].outcome.observed_at > 0);
    // The seat that was not selected has no command and no outcome at all.
    const a2seat = await seatOf('A2'); assert.equal(a2seat.last_command, null); assert.equal(f.db.prepare("SELECT count(*) n FROM ops_command_targets WHERE seat_id='A2'").get().n, 0);
    const a3seat = await seatOf('A3'); assert.deepEqual([a3seat.last_command.outcome.verdict, a3seat.last_command.outcome.next], ['remains', 'check_network_not_pc']); assert.equal(a3seat.last_command.target_grant, undefined, 'ledger internals stay out of the board');
  });

  await check('AT-40 token diagnostics cannot resolve provider, budget or SDK faults in either API view', async () => {
    for (const reason of ['provider_5xx', 'provider_rate_limit', 'budget_limit', 'sdk_not_ready']) {
      await f.sync(a1.credential, [f.event(++seq[1], 'error', { class: reason, blocking: true })], 1);
      const sent = (await f.command('retry_diagnostics', ['A1'])).json;
      await runOn(a1, 1, sent.command.id, 'succeeded', 'token_ok');
      const outcome = (await view(sent.command.id)).targets[0].outcome;
      const seat = await seatOf('A1');
      assert.deepEqual([outcome.verdict, outcome.cause, seat.last_command.outcome.verdict, seat.reason], ['executed', reason, 'executed', reason]);
    }
    await f.sync(a1.credential, [f.event(++seq[1], 'error', { class: 'sdk_not_ready', blocking: false, cleared: true })], 1);
  });

  await check('AT-40 token: an existing issue re-checked, a re-issued token activated, and the old one still in the app are three different answers', async () => {
    await f.request('/admin/tokens/issue', 'POST', { u: 'student-a', c: f.cohort, p: f.profile, hours: 2 }); await f.sync(a1.credential, [], 1); // first recorded issue; the connection's login generation moves
    const first = f.db.prepare("SELECT jti FROM ops_token_issues WHERE student_id='student-a' ORDER BY issued_at DESC").get().jti;
    let c = (await f.command('refresh_connection', ['A1'])).json; await runOn(a1, 1, c.command.id, 'succeeded', 'profile_verified', [{ check: 'profile_verified', token_jti: first }]);
    assert.deepEqual(((o) => [o.verdict, o.basis])((await view(c.command.id)).targets[0].outcome), ['resolved', 'existing_token_rechecked']);
    await tick(); await f.request('/admin/tokens/issue', 'POST', { u: 'student-a', c: f.cohort, p: f.profile, hours: 2 }); await f.sync(a1.credential, [], 1);
    const second = f.db.prepare("SELECT jti FROM ops_token_issues WHERE student_id='student-a' ORDER BY issued_at DESC").get().jti; assert.notEqual(second, first);
    assert.deepEqual(((o) => [o.verdict, o.cause])((await view(c.command.id)).targets[0].outcome), ['remains', 'new_issue_not_in_app'], 'a re-issue after the fact: what was verified is no longer the newest issue');
    c = (await f.command('refresh_connection', ['A1'])).json; await runOn(a1, 1, c.command.id, 'succeeded', 'profile_verified', [{ check: 'profile_verified', token_jti: first }]);
    assert.deepEqual(((o) => [o.verdict, o.next])((await view(c.command.id)).targets[0].outcome), ['remains', 'deliver_new_token'], 'the app verified the OLD token: issuing is not receiving');
    c = (await f.command('refresh_connection', ['A1'])).json; await runOn(a1, 1, c.command.id, 'succeeded', 'profile_verified', [{ check: 'profile_verified', token_jti: second }]);
    assert.deepEqual(((o) => [o.verdict, o.basis])((await view(c.command.id)).targets[0].outcome), ['resolved', 'reissued_token_active']); assert.equal((await seatOf('A1')).last_command.outcome.basis, 'reissued_token_active');
    // An app that cannot name the issue: the profile is valid, the issue is unknown — not resolved.
    c = (await f.command('refresh_connection', ['A3'])).json; await runOn(a3, 3, c.command.id, 'succeeded', 'profile_verified');
    assert.deepEqual(((o) => [o.verdict, o.basis])((await view(c.command.id)).targets[0].outcome), ['executed', 'profile_valid_app_cannot_name_issue']);
    assert.equal(JSON.stringify(await view(c.command.id)).includes('hps_'), false); assert.equal(f.db.prepare("SELECT count(*) n FROM ops_events WHERE payload_json LIKE '%eyJ%'").get().n, 0, 'no token text in the ledger');
  });

  await check('AT-40 linking: a follow-up counts only for the command it names, from the connection that ran it, in the login generation it ran under', async () => {
    const mine = (await f.command('reset_runtime', ['A2'])).json; await runOn(a2, 2, mine.command.id, 'succeeded', 'reset_ok');
    assert.deepEqual(((o) => [o.verdict, o.basis, o.next])((await view(mine.command.id)).targets[0].outcome), ['executed', 'ready_next_run_not_observed', 'ask_learner_to_send_next_question']);
    const events = () => f.db.prepare("SELECT disposition FROM ops_events WHERE kind='recovery' AND seat_id=? ORDER BY received_at,seq").all('A1').map((r) => r.disposition);
    const before = events().length;
    // Another seat names A2's command: stored, unlinked, never read.
    let r = await f.sync(a1.credential, [f.event(++seq[1], 'recovery', { command_id: mine.command.id, check: 'turn_completed' })], 1); assert.deepEqual(r.json.quarantined, [seq[1]]); assert.equal(events().slice(before)[0], 'unlinked');
    // A command id that does not exist, and a command that never reached this device (still queued).
    r = await f.sync(a2.credential, [f.event(++seq[2], 'recovery', { command_id: 'no-such-command-0001', check: 'turn_completed' })], 2); assert.deepEqual(r.json.quarantined, [seq[2]]);
    const queued = (await f.command('restart_preview', ['A2'])).json; r = await f.sync(a2.credential, [f.event(++seq[2], 'recovery', { command_id: queued.command.id, check: 'turn_completed' })], 2, {}); assert.deepEqual(r.json.quarantined, [seq[2]], 'not yet accepted by the device');
    assert.equal((await view(mine.command.id)).targets[0].outcome.verdict, 'executed', 'none of that resolved anything');
    // The learner's next question, reported by the device that ran the reset, named by that command.
    r = await f.sync(a2.credential, [f.event(++seq[2], 'recovery', { command_id: mine.command.id, check: 'turn_completed', runtime: 'agent-sdk' })], 2); assert.deepEqual(r.json.quarantined, []);
    assert.deepEqual(((o) => [o.verdict, o.basis])((await view(mine.command.id)).targets[0].outcome), ['resolved', 'next_run_completed']);
    // A resend of the same event is the same event (no second row); a follow-up after a new login generation is not linked.
    const n = f.db.prepare("SELECT count(*) n FROM ops_events WHERE kind='recovery' AND seat_id='A2' AND disposition='applied'").get().n;
    const other = (await f.command('cancel_current_run', ['A2'])).json; await runOn(a2, 2, other.command.id, 'succeeded', 'run_stopped');
    await f.request('/admin/tokens/issue', 'POST', { u: 'student-b', c: f.cohort, p: f.profile, hours: 2 });
    r = await f.sync(a2.credential, [f.event(++seq[2], 'recovery', { command_id: other.command.id, check: 'turn_completed' })], 2); assert.deepEqual(r.json.quarantined, [seq[2]], 'the learner signed in again: the old generation\'s follow-up proves nothing');
    assert.equal((await view(other.command.id)).targets[0].outcome.verdict, 'executed'); assert.equal(f.db.prepare("SELECT count(*) n FROM ops_events WHERE kind='recovery' AND seat_id='A2' AND disposition='applied'").get().n, n);
  });

  await check('AT-40 a new device does not inherit the old device\'s follow-ups, and a failed follow-up read never produces a resolution', async () => {
    const c = (await f.command('reset_runtime', ['A1'])).json; await runOn(a1, 1, c.command.id, 'succeeded', 'reset_ok', [{ check: 'turn_completed' }]); assert.equal((await view(c.command.id)).targets[0].outcome.verdict, 'resolved');
    f.fail("e.kind='recovery'"); const blind = await view(c.command.id); f.fail('');
    assert.deepEqual([blind.targets[0].outcome.verdict, blind.summary.followups], ['executed', 'unknown'], 'unreadable evidence is not evidence');
    // Tampered ledger: the same event under another connection's grant is not this command's evidence.
    f.db.prepare("UPDATE ops_events SET grant_id='another-grant' WHERE kind='recovery' AND seat_id='A1' AND payload_json LIKE ?").run('%' + c.command.id + '%');
    assert.equal((await view(c.command.id)).targets[0].outcome.verdict, 'executed');
  });

  await check('AT-40 profile re-check does not erase a runtime fault: the board keeps the cause until a run completes', async () => {
    const b1 = (await f.pair('A1', 1, 11, [...CAPS, rec.FOLLOWUP_CAPABILITY])).conn.json; let s = 0;
    await f.sync(b1.credential, [f.event(++s, 'activation', { stage: 'runtime_failed', reason: 'unknown' }), f.event(++s, 'error', { class: 'unknown', blocking: true })], 11);
    assert.deepEqual(((x) => [x.attention, x.recommended.action])(await seatOf('A1')), ['blocked', 'reset_runtime']);
    await f.sync(b1.credential, [f.event(++s, 'activation', { stage: 'token_verified', token_jti: f.db.prepare("SELECT jti FROM ops_token_issues WHERE student_id='student-a' ORDER BY issued_at DESC").get().jti })], 11);
    let seat = await seatOf('A1'); assert.deepEqual([seat.activation.stage, seat.attention], ['runtime_failed', 'blocked'], 'a token check is not a runtime recovery'); assert.equal(seat.token.app_verified, 'matches_issue', 'the token evidence itself IS updated');
    await f.sync(b1.credential, [f.event(++s, 'activation', { stage: 'runtime_ready' }), f.event(++s, 'error', { class: 'unknown', blocking: false, cleared: true })], 11);
    seat = await seatOf('A1'); assert.deepEqual([seat.activation.stage, seat.attention, seat.recommended.action], ['runtime_ready', 'ok', '']);
  });

  await check('AT-40 pause/resume: the Service\'s block, each device\'s hold and a run after the resume are reported separately', async () => {
    const live = (await f.pair('A2', 1, 12, CAPS)).conn.json; let s = 0;
    const put = (paused, rev) => f.request(f.base + '/control', 'PUT', { paused, expected_control_revision: rev });
    assert.equal((await seatOf('A2')).control_outcome.service, 'never_set');
    assert.equal((await put(true, 0)).status, 200); await f.sync(live.credential, [], 12, { sample: { idle_ms: 0, runtime_status: 'idle', observed_at: Date.now(), control_revision: 0 } });
    assert.deepEqual((await seatOf('A2')).control_outcome, { service: 'blocking_new_runs', device: 'pending', resumed_run: 'not_applicable' });
    assert.deepEqual((await seatOf('A4')).control_outcome, { service: 'blocking_new_runs', device: 'unknown', resumed_run: 'not_applicable' }, 'a seat that never connected is not "applied"');
    await f.sync(live.credential, [f.event(++s, 'runtime', { status: 'running' })], 12, { sample: { idle_ms: 0, runtime_status: 'running', observed_at: Date.now(), control_revision: 1 } });
    assert.equal((await seatOf('A2')).control_outcome.device, 'applied');
    await tick(); assert.equal((await put(false, 1)).status, 200);
    await f.sync(live.credential, [], 12, { sample: { idle_ms: 0, runtime_status: 'idle', observed_at: Date.now(), control_revision: 2 } });
    assert.deepEqual((await seatOf('A2')).control_outcome, { service: 'admitting', device: 'applied', resumed_run: 'not_observed' }, 'the run seen BEFORE the resume is not a resumed run');
    // A short run: `running` and the `idle` that follows arrive in ONE sync. The run was still seen (found on the real Mac: the idle overwrote it).
    await tick(); await f.sync(live.credential, [f.event(++s, 'runtime', { status: 'idle' }), f.event(++s, 'runtime', { status: 'running' }), f.event(++s, 'runtime', { status: 'idle' })], 12, { sample: { idle_ms: 0, runtime_status: 'running', observed_at: Date.now(), control_revision: 2 } });
    assert.equal((await seatOf('A2')).control_outcome.resumed_run, 'observed');
    assert.equal((await seatOf('A2')).runtime.status, 'idle', 'the board\'s runtime line is the latest report; the run-after-resume is its own fact');
    // Another device for the same seat has not run anything: the old connection's run is not its run.
    const replaced = (await f.pair('A2', 1, 13, CAPS)).conn.json; await f.sync(replaced.credential, [], 13, { sample: { idle_ms: 0, runtime_status: 'idle', observed_at: Date.now(), control_revision: 2 } });
    assert.equal((await seatOf('A2')).control_outcome.resumed_run, 'not_observed');
  });
} finally { await f.close?.(); }
console.log(`${count} remote classroom recovery controls passed`);
