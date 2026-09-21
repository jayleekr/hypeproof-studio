// Remote classroom operations (#751, U4) — what a recovery action actually achieved.
//
// The command ledger answers "did the device run it" (`succeeded`). That is not the question an instructor asks.
// This module answers "is the cause gone", from three kinds of evidence and nothing else:
//   1. the terminal receipt of THAT command (its result code is the device's own postcondition check),
//   2. follow-up observations the device linked to THAT command id, reported over the same connection,
//   3. facts the Service holds itself (which token issue is the latest; whether an upload was verified).
// A signal that is older than the command, that came over another connection, or that is merely "the board looks fine
// now" never turns into `resolved`. No import on purpose: tests load this file directly.

/** Declared by an app that links follow-up observations to a command. Absent = the Service cannot expect them. */
export const FOLLOWUP_CAPABILITY = 'recovery_followup';
/** Target states in which the device may already be reporting about a command it holds. The event schema itself lives in classroom-ops.ts. */
export const FOLLOWUP_LINKABLE_STATES = ['accepted', 'running', 'succeeded', 'failed', 'outcome_unknown'] as const;

/**
 * resolved     the cause this action addresses was observed gone, by evidence linked to this command
 * remains      the action ran (or refused to change anything) and the cause was observed still there
 * executed     the action ran; nothing observed yet says whether the cause is gone
 * unverified   it may have run; the outcome could not be observed
 * not_executed it never ran on the device
 * pending      not final yet
 */
export type OutcomeVerdict = 'resolved' | 'remains' | 'executed' | 'unverified' | 'not_executed' | 'pending';
export interface Followup { check: string; token_jti?: string; error_class?: string; runtime?: string; observed_at: number; received_at: number }
export interface OutcomeInput {
  action: string; state: string; result_code: string;
  /** When the terminal receipt was observed on the device / stored by the Service. */
  receipt?: { observed_at?: number; received_at?: number } | null;
  /** Only observations already proven to belong to this command, this seat and this connection. */
  followups: Followup[];
  /** Did the app that ran it declare FOLLOWUP_CAPABILITY? null = unknown (no live connection to read it from). */
  reports_followup: boolean | null;
  /** The newest unexpired learning-token issue the Service recorded for this learner; `count` = how many it recorded. */
  latest_issue?: { id: string; count: number } | null;
}
export interface Outcome { verdict: OutcomeVerdict; cause: string; basis: string; next: string; observed_at: number | null }

const OPEN = ['queued', 'leased', 'accepted', 'running'];
/** Causes many seats share. A per-PC action is never the recommended answer to one of these. */
export const SHARED_CAUSES = ['provider_rate_limit', 'provider_5xx', 'network', 'class_not_open', 'budget_limit'];

export function recoveryOutcome(i: OutcomeInput): Outcome {
  const at = i.receipt?.observed_at ?? i.receipt?.received_at ?? null;
  const out = (verdict: OutcomeVerdict, cause: string, basis: string, next = '', observed_at: number | null = at): Outcome => ({ verdict, cause, basis, next, observed_at });
  if (OPEN.includes(i.state)) return out('pending', '', i.state, '', null);
  // Never reached the app, or the app refused before doing anything. The problem is exactly where it was.
  if (i.state === 'not_connected') return out('not_executed', '', 'not_reached_app', 'pair_or_bring_online', null);
  if (i.state === 'unsupported') return out('not_executed', '', 'app_does_not_support', 'onsite_or_update_app', null);
  if (i.state === 'expired') return out('not_executed', '', i.result_code === 'epoch_stale' ? 'connection_generation_changed' : 'not_received_in_time', 'check_online_then_retry', null);
  if (i.state === 'cancelled') return out('not_executed', '', 'cancelled', '', null);
  if (i.state === 'rejected') return out('not_executed', '', i.result_code || 'refused_by_device', i.result_code === 'seat_busy' ? 'wait_for_running_action' : 'check_online_then_retry', null);
  if (i.state === 'outcome_unknown') return out('unverified', '', i.result_code || 'no_result', 'onsite_check');
  if (i.state !== 'succeeded' && i.state !== 'failed') return out('unverified', '', 'unknown_state', 'onsite_check');

  const code = i.result_code, last = (checks: string[]) => i.followups.filter((f) => checks.includes(f.check)).sort((a, b) => a.received_at - b.received_at).at(-1);
  const interrupted = ['interrupted', 'timeout', 'executor_error', 'connection_closed'].includes(code);

  if (i.action === 'retry_diagnostics') {
    // The diagnosis finishing is not the fault being gone: its finding is the verdict.
    if (code === 'token_ok') return out('resolved', '', 'service_and_token_ok');
    if (code === 'service_unreachable' || code === 'profile_network') return out('remains', 'network', code, 'check_network_not_pc');
    if (code === 'no_token') return out('remains', 'no_token', code, 'issue_and_deliver_token');
    if (code === 'profile_401') return out('remains', 'token_rejected', code, 'reissue_token');
    if (code === 'profile_403') return out('remains', 'class_or_roster', code, 'check_class_open_and_roster');
    if (/^profile_\d+$/.test(code)) return out('remains', 'service_error', code, 'wait_then_diagnose_again');
    return out('unverified', '', code || 'no_finding', 'diagnose_again');
  }
  if (i.action === 'refresh_connection') {
    if (code === 'busy_active_run') return out('not_executed', '', code, 'retry_after_run');
    if (code === 'profile_not_verified') return out('remains', 'token_or_connection', code, 'run_diagnostics');
    if (code !== 'profile_verified') return out('unverified', '', code || 'no_result', 'run_diagnostics');
    const f = last(['profile_verified']);
    // Which issue the app verified is the whole question after a re-issue. Without it, "verified" says nothing about the new token.
    if (!f || !f.token_jti) return out('executed', '', i.reports_followup === false ? 'profile_valid_app_cannot_name_issue' : 'profile_valid_issue_not_reported', 'check_token_line');
    if (!i.latest_issue) return out('resolved', '', 'profile_valid_no_issue_record', '', f.observed_at);
    if (f.token_jti !== i.latest_issue.id) return out('remains', 'new_issue_not_in_app', 'older_issue_rechecked', 'deliver_new_token', f.observed_at);
    return out('resolved', '', i.latest_issue.count > 1 ? 'reissued_token_active' : 'existing_token_rechecked', '', f.observed_at);
  }
  if (i.action === 'cancel_current_run' || i.action === 'reset_runtime') {
    if (i.action === 'cancel_current_run' && code === 'no_active_run') return out('executed', '', 'nothing_was_running');
    // Refusals that changed nothing: the fault is still there and new runs may be held.
    if (['stop_unconfirmed', 'draft_not_saved', 'preserve_failed', 'evidence_not_flushed', 'preservation_mismatch', 'deadline_before_change'].includes(code)) return out('remains', code, code, 'onsite_check');
    if (code === 'reset_done_probe_failed') return out('remains', 'connection_after_reset', code, 'run_diagnostics');
    if (interrupted || i.state === 'failed') return out('unverified', '', code || 'no_result', 'onsite_check');
    // Stopped / restarted and preserved — a READY state that cost nothing to check. Whether the AI really runs again is
    // known only from the learner's next question, linked to this command by the device.
    const f = last(['turn_completed', 'turn_failed']);
    if (!f) return out('executed', '', i.reports_followup === false ? 'ready_app_cannot_report_next_run' : 'ready_next_run_not_observed', 'ask_learner_to_send_next_question');
    if (f.check === 'turn_completed') return out('resolved', '', 'next_run_completed', '', f.observed_at);
    const cause = f.error_class || 'unknown';
    return out('remains', cause, 'next_run_failed', SHARED_CAUSES.includes(cause) ? 'shared_cause_not_pc' : 'onsite_check', f.observed_at);
  }
  if (i.action === 'restart_preview') {
    if (code === 'no_preview') return out('not_executed', '', 'no_preview_open', 'ask_learner_to_open_preview');
    if (code === 'preview_artifact_ok') return out('resolved', '', 'artifact_opened_same_address');
    if (code === 'preview_reopened_artifact_ok') return out('resolved', '', 'artifact_reopened_new_address');
    if (code === 'preview_restarted_new_url') return out('remains', 'preview_tab_stale', code, 'ask_learner_to_reopen_preview');
    if (code === 'preview_artifact_missing') return out('remains', 'artifact_not_found', code, 'check_learner_file');
    if (code === 'preview_unhealthy') return out('remains', 'preview_server_down', code, 'onsite_check');
    // The server alone was checked: an older app (a 404 passed that check), or a current one that found no preview tab of the
    // learner's own to re-load — either way nobody saw the learner's tab show the page.
    if (code === 'preview_reloaded') return out('executed', '', 'server_health_only', 'ask_learner_whether_preview_shows');
    return out('unverified', '', code || 'no_result', 'onsite_check');
  }
  if (i.action === 'retry_evidence_upload') {
    // The device's "sent" is not the Service's "verified": the collection result owns that answer.
    return out(i.state === 'succeeded' ? 'executed' : 'unverified', '', i.state === 'succeeded' ? 'see_collection_result' : code || 'no_result', 'see_collection_result');
  }
  // Coaching and anything else: `succeeded` means shown, which is all it ever claimed.
  return i.state === 'succeeded' ? out('executed', '', code || 'done') : out('unverified', '', code || 'no_result');
}

export function summarizeOutcomes(list: Array<{ verdict: OutcomeVerdict }>): Record<OutcomeVerdict, number> & { total: number } {
  const n = { resolved: 0, remains: 0, executed: 0, unverified: 0, not_executed: 0, pending: 0, total: list.length };
  for (const o of list) n[o.verdict]++;
  return n;
}

/** U1's collection phases in the same words. `verified` is the Service's own receipt check, never the device's claim. */
export function collectOutcome(phase: string): OutcomeVerdict {
  if (phase === 'verified') return 'resolved';
  if (phase === 'awaiting_device' || phase === 'transferring') return 'pending';
  if (phase === 'refused' || phase === 'held' || phase === 'grace_over') return 'remains';
  if (phase === 'not_delivered' || phase === 'excluded') return 'not_executed';
  return 'unverified'; // resend_wait, unknown and any phase this build does not know
}

/**
 * Pause / resume. The Service's own admission changes the moment the control row is saved; what each DEVICE did is a
 * separate observation, and a run after a resume is a third one. None is inferred from another.
 */
export interface ControlOutcomeInput { paused: boolean; control_revision: number; control_updated_at: number | null; device: 'applied' | 'pending' | 'unknown'; runtime?: { status?: unknown; received_at?: number } | null; state_from_current_connection: boolean }
export function controlOutcome(i: ControlOutcomeInput): { service: 'blocking_new_runs' | 'admitting' | 'never_set'; device: 'applied' | 'pending' | 'unknown'; resumed_run: 'observed' | 'not_observed' | 'not_applicable' } {
  const service = i.control_revision === 0 ? 'never_set' : i.paused ? 'blocking_new_runs' : 'admitting';
  if (service !== 'admitting') return { service, device: i.device, resumed_run: 'not_applicable' };
  // Strictly after the resume, on the Service's clock, from the connection that is live now. Equal or missing = not shown.
  const after = i.state_from_current_connection && i.device === 'applied' && i.runtime?.status === 'running' && Number.isFinite(i.runtime.received_at) && Number.isFinite(i.control_updated_at) && (i.runtime.received_at as number) > (i.control_updated_at as number);
  return { service, device: i.device, resumed_run: after ? 'observed' : 'not_observed' };
}

/**
 * Cause → the ONE first action (AT-40). Nothing here can name a shell, a reinstall or a PC-wide action: the answer is
 * an allowlisted command id, an instructor step outside the ledger (`issuer`, `pairing`, `collection`), or "not this PC".
 */
export interface SeatCause { connected: boolean; attention: string; reason: string; entry_stage: string; runtime_status?: unknown; token_app_verified?: string | null; upload_status?: unknown; in_shared_incident: boolean }
export function recommendAction(s: SeatCause): { family: 'none' | 'connection' | 'token' | 'runtime' | 'upload' | 'shared'; cause: string; action: string; why: string } {
  if (!s.connected) return { family: 'connection', cause: s.reason || 'not_connected', action: 'pairing', why: 'no_live_connection_nothing_can_be_sent' };
  if (s.in_shared_incident || (SHARED_CAUSES.includes(s.reason) && s.attention !== 'ok')) return { family: 'shared', cause: s.reason, action: s.in_shared_incident ? 'none_shared_incident' : 'retry_diagnostics', why: 'shared_cause_is_not_fixed_on_one_pc' };
  if (s.entry_stage === 'token_rejected' || ['auth_expired', 'auth_revoked', 'auth_signature', 'auth_rejected', 'profile_mismatch', 'roster_missing'].includes(s.reason)) return { family: 'token', cause: s.reason || 'token_rejected', action: 'issuer', why: 'a_rejected_token_is_not_fixed_by_rechecking_it' };
  if (s.token_app_verified === 'other_token') return { family: 'token', cause: 'new_issue_not_in_app', action: 'refresh_connection', why: 'confirm_which_issue_the_app_holds' };
  if (s.attention === 'unknown') return { family: 'connection', cause: s.reason, action: 'retry_diagnostics', why: 'no_fresh_signal' };
  if (['sdk_not_ready', 'tool_not_ready', 'unknown'].includes(s.reason) && s.attention === 'blocked') return { family: 'runtime', cause: s.reason, action: s.runtime_status === 'running' || s.runtime_status === 'waiting_approval' ? 'cancel_current_run' : 'reset_runtime', why: 'runtime_fault_files_and_conversation_are_kept' };
  if (s.reason === 'upload_failed' || s.upload_status === 'failed') return { family: 'upload', cause: 'upload_failed', action: 'collection', why: 'resend_runs_under_the_consent_and_batch_already_recorded' };
  if (s.attention === 'blocked' || s.attention === 'caution') return { family: 'connection', cause: s.reason, action: 'retry_diagnostics', why: 'find_the_cause_first' };
  return { family: 'none', cause: '', action: '', why: '' };
}
