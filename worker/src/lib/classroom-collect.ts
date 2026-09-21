// Remote classroom operations R4 (#751) — pure parts of consented record collection.
// "Complete" is decided here, by the Service, from the bytes it actually holds:
// a PUT 200, or the mere presence of a manifest, proves nothing.
export const SNAPSHOT_SCHEMA = 'hps-classroom-snapshot/1';
export const SNAPSHOT_FILES: Record<string, { maxBytes: number; contentType: string }> = {
  'session.meta.json': { maxBytes: 256 * 1024, contentType: 'application/json' },
  'events.jsonl': { maxBytes: 8 * 1024 * 1024, contentType: 'application/x-ndjson' },
};
export const PURPOSES = ['class_report'] as const;
export const CONSENT_BASES = ['adult_self', 'guardian_verified'] as const;
export const UPLOAD_GRACE_MS = 24 * 3_600_000;
// `not_selected` is roster metadata of a targeted batch: no command, no upload, no object and no evaluation exists for that learner.
export const ITEM_STATES = ['consent_missing', 'guardian_consent_missing', 'withdrawn', 'not_connected', 'not_selected', 'requested', 'uploading', 'verified', 'incomplete', 'quarantined'] as const;

/**
 * What a collection request asks for, normalized. The contract that matters most is what this REFUSES:
 *  - `targets` absent  = the class wrap-up over the whole roster (the behaviour before targets existed). Its mode is `finish`.
 *  - `targets` present = exactly those seats, mode `collect_only` (no evaluation, no delivery). An empty list, a duplicate, a
 *    malformed id or a field this contract does not know is refused. Nothing is ever widened to the whole roster: a caller
 *    that misspells `targets` gets a 400, not everybody's records.
 * Whether the seats belong to THIS run is the route's question (it needs the roster); this function is pure.
 */
export const COLLECT_MODES = ['finish', 'collect_only'] as const;
export const COLLECT_REQUEST_FIELDS = ['idempotency_key', 'roster_revision', 'purpose', 'notice_version', 'dry_run', 'targets', 'mode'] as const;
// This file stays import-free (tests load it without the Service resolver). The two shapes are the command ledger's ID_RE and
// UUIDISH_RE; classroom-ops-selected-collect.test.mjs fails if they drift apart.
export const COLLECT_SEAT_RE = /^[A-Za-z0-9_-]{1,128}$/, COLLECT_KEY_RE = /^[A-Za-z0-9-]{8,64}$/;
const SEAT_RE = COLLECT_SEAT_RE, KEY_RE = COLLECT_KEY_RE, NOTICE = /^[A-Za-z0-9_.-]{1,64}$/;
export interface CollectRequest { idempotency_key: string; roster_revision: number; purpose: string; notice_version: string; dry_run: boolean; scope: 'roster' | 'targets'; mode: 'finish' | 'collect_only'; targets: string[] }
export function normalizeCollectRequest(b: unknown, maxTargets: number): { ok: true; value: CollectRequest } | { ok: false; reason: string; detail: string } {
  const no = (reason: string, detail: string) => ({ ok: false as const, reason, detail });
  if (!b || typeof b !== 'object' || Array.isArray(b)) return no('request_invalid', 'a JSON object is required');
  const o = b as Record<string, unknown>, unknown = Object.keys(o).filter((k) => !(COLLECT_REQUEST_FIELDS as readonly string[]).includes(k));
  if (unknown.length) return no('unknown_field', 'unknown field: ' + unknown.slice(0, 5).join(', '));
  if (typeof o.idempotency_key !== 'string' || !KEY_RE.test(o.idempotency_key) || !Number.isInteger(o.roster_revision) || typeof o.dry_run !== 'boolean' || !(PURPOSES as readonly string[]).includes(o.purpose as string) || typeof o.notice_version !== 'string' || !NOTICE.test(o.notice_version)) return no('request_invalid', 'idempotency_key, roster_revision, purpose, notice_version and dry_run required');
  if (o.mode !== undefined && !(COLLECT_MODES as readonly string[]).includes(o.mode as string)) return no('mode_invalid', 'mode is finish or collect_only');
  const base = { idempotency_key: o.idempotency_key, roster_revision: o.roster_revision as number, purpose: o.purpose as string, notice_version: o.notice_version, dry_run: o.dry_run };
  if (o.targets === undefined) {
    // Collect-only over "everyone" must name everyone: the whole roster is never a default of the new action.
    if (o.mode === 'collect_only') return no('targets_required', 'collect_only names its seats explicitly');
    return { ok: true, value: { ...base, scope: 'roster', mode: 'finish', targets: [] } };
  }
  if (!Array.isArray(o.targets)) return no('targets_invalid', 'targets is a list of seat ids');
  if (!o.targets.length) return no('targets_empty', 'an empty selection collects nothing; it is not the whole class');
  if (o.targets.length > maxTargets) return no('targets_invalid', 'too many seats');
  if (o.targets.some((t) => typeof t !== 'string' || !SEAT_RE.test(t))) return no('targets_invalid', 'a seat id is malformed');
  if (new Set(o.targets).size !== o.targets.length) return no('targets_duplicate', 'a seat is named twice');
  if (o.mode === 'finish') return no('mode_not_allowed', 'the class wrap-up (evaluation may follow) covers the whole roster; selected seats are collect_only');
  return { ok: true, value: { ...base, scope: 'targets', mode: 'collect_only', targets: [...(o.targets as string[])].sort() } };
}
/**
 * What one selected seat of a collection batch IS right now — from three independent facts, none of which is enough alone:
 *   the collection ITEM (what the Service holds), the device REQUEST (what happened to the command), the upload GRACE
 *   (whether this batch can still receive anything). The table in docs/requirements/classroom-admin.md (U1 · 회수 생명주기)
 *   is this function; the rows are evaluated top to bottom.
 *
 *   phase            active  retry  may_change   meaning
 *   verified           -       -       -         the Service verified a record (a failed command before it is history, not status)
 *   excluded           -       -       -         consent missing / withdrawn — asking again changes nothing
 *   held               -       -       -         quarantined: a person looks first
 *   grace_over         -      yes      -         the upload window of THIS batch has closed without a verified record
 *   not_delivered      -      yes    (item: -)   no device ever got it: no connection, or the command expired / was rejected /
 *                                                cancelled / unsupported before it ran
 *   awaiting_device   yes      -      yes        asked; queued or assigned by the server — no device receipt yet
 *   transferring      yes      -      yes        the device accepted / is running, OR bytes arrived within ACTIVE_MS, OR it reported
 *                                                "sent" and verification is still pending (bounded by SETTLE_MS)
 *   resend_wait        -      yes     yes        the device failed with `offline_pending`: it KEEPS the frozen copy and resumes when
 *                                                the app restarts or reconnects. Not a transfer in progress, not a final refusal.
 *   refused            -      yes     yes        a final refusal: the device gave up (upload_refused, verify_failed, …) or the Service
 *                                                marked the record incomplete. Files that already arrived do not make it "sending".
 *   unknown            -      yes     yes        the device started and never reported back (`outcome_unknown`), or "sent" without a
 *                                                verification for longer than SETTLE_MS. Neither a success nor a failure.
 *
 * `partial` = some files of this revision are stored but it is not verified. It is a fact about stored bytes, never evidence
 * that a transfer is happening NOW — only recent bytes (ACTIVE_MS) or a running command are.
 * `may_change` is why a panel must not say "final" and must be looked at again: inside the grace window a late upload can
 * still turn a failed or unknown target into `verified`.
 */
export const COLLECT_ACTIVE_MS = 90_000, COLLECT_SETTLE_MS = 5 * 60_000;
export type CollectPhase = 'verified' | 'excluded' | 'held' | 'grace_over' | 'not_delivered' | 'awaiting_device' | 'transferring' | 'resend_wait' | 'refused' | 'unknown';
export interface CollectStatus { phase: CollectPhase; active: boolean; retryable: boolean; may_change: boolean; partial: boolean }
export function collectStatus(item: { state: string; updated_at: number; request?: { state: string; result_code?: string | null; updated_at?: number | null } | null }, ctx: { now: number; upload_until: number }): CollectStatus {
  const out = (phase: CollectPhase, active: boolean, retryable: boolean, may_change: boolean): CollectStatus => ({ phase, active, retryable, may_change, partial: item.state === 'uploading' });
  if (item.state === 'verified') return out('verified', false, false, false);
  if (['consent_missing', 'guardian_consent_missing', 'withdrawn'].includes(item.state)) return out('excluded', false, false, false);
  if (item.state === 'quarantined') return out('held', false, false, false);
  if (ctx.now >= ctx.upload_until) return out('grace_over', false, true, false);
  if (item.state === 'not_connected') return out('not_delivered', false, true, false);
  if (item.state === 'incomplete') return out('refused', false, true, true);
  if (item.state !== 'requested' && item.state !== 'uploading') return out('unknown', false, false, true); // a state this build does not know is not guessed at
  const r = item.request?.state ?? '', code = item.request?.result_code ?? '';
  if (r === '' || r === 'queued' || r === 'leased') return out('awaiting_device', true, false, true);
  if (r === 'accepted' || r === 'running') return out('transferring', true, false, true);
  // From here the command is over. Bytes that arrived a moment ago are the only remaining evidence of a transfer in progress
  // (a resumed upload); a file that arrived and then nothing is not.
  if (item.state === 'uploading' && ctx.now - item.updated_at < COLLECT_ACTIVE_MS) return out('transferring', true, false, true);
  if (r === 'succeeded') return ctx.now - (item.request?.updated_at ?? item.updated_at) < COLLECT_SETTLE_MS ? out('transferring', true, false, true) : out('unknown', false, true, true);
  if (r === 'outcome_unknown') return out('unknown', false, true, true);
  if (r === 'failed') return code === 'offline_pending' ? out('resend_wait', false, true, true) : out('refused', false, true, true);
  if (['rejected', 'unsupported', 'expired', 'cancelled', 'not_connected'].includes(r)) return out('not_delivered', false, true, true);
  return out('unknown', false, false, true);
}

/** Everything that makes two requests "the same request". The idempotency key itself is not part of it. */
export const collectRequestCanonical = (r: Pick<CollectRequest, 'scope' | 'mode' | 'targets' | 'purpose' | 'notice_version' | 'dry_run' | 'roster_revision'>): string => JSON.stringify([r.scope, r.mode, r.targets, r.purpose, r.notice_version, r.dry_run, r.roster_revision]);

export interface ManifestFile { name: string; bytes: number; sha256: string }
/**
 * What the device says this snapshot IS. The Service never trusts it on its own: every
 * field is compared with the grant, the batch, the consent and the bytes it holds.
 * Schema /2 requires it. Schema /1 (no binding) is accepted only when the spool metadata
 * itself names this class run — the current run is never assumed for an unbound record.
 */
export interface SnapshotBinding {
  class_run_id: string; batch_id: string; seat_id: string; spool_session_id: string;
  student: { u: string; c: string; p: string };
  /** The confirmed lesson this App was bound to, or null for a run without a pinned lesson. */
  activity: { course_id: string; version: string } | null;
  consent: { purpose: string; notice_version: string };
  /** Declared extent of events.jsonl. `final_line_sha256` names the last confirmed event. */
  range: { lines: number; from_ts: string; to_ts: string; final_line_sha256: string; first_seq?: number; last_seq?: number; session_last_seq?: number; other_sessions_in_window?: number };
}
export interface SnapshotManifest { schema: string; files: ManifestFile[]; binding?: SnapshotBinding }
export type Coverage = 'complete' | 'gaps' | 'sequence_unavailable' | 'damaged' | 'range_unknown';
export const SNAPSHOT_SCHEMA_V2 = 'hps-classroom-snapshot/2';
const ID = /^[A-Za-z0-9_.:-]{1,128}$/, TS = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const str = (v: unknown, re = ID) => typeof v === 'string' && re.test(v);

function validateBinding(v: unknown): SnapshotBinding | null {
  const b = v as SnapshotBinding; if (!b || typeof b !== 'object') return null;
  if (![b.class_run_id, b.batch_id, b.seat_id, b.spool_session_id].every((x) => str(x)) || !b.student || ![b.student.u, b.student.c, b.student.p].every((x) => str(x))) return null;
  if (b.activity !== null && !(b.activity && str(b.activity.course_id) && str(b.activity.version))) return null;
  if (!b.consent || !str(b.consent.purpose) || !str(b.consent.notice_version)) return null;
  const r = b.range; if (!r || !Number.isSafeInteger(r.lines) || r.lines < 1 || !str(r.from_ts, TS) || !str(r.to_ts, TS) || !str(r.final_line_sha256, /^[a-f0-9]{64}$/)) return null;
  if ((r.first_seq === undefined) !== (r.last_seq === undefined) || (r.first_seq !== undefined && (!Number.isSafeInteger(r.first_seq) || !Number.isSafeInteger(r.last_seq) || r.first_seq! < 1 || r.last_seq! < r.first_seq!))) return null;
  if ((r.session_last_seq !== undefined && !(Number.isSafeInteger(r.session_last_seq) && r.session_last_seq >= 1)) || (r.other_sessions_in_window !== undefined && !(Number.isSafeInteger(r.other_sessions_in_window) && r.other_sessions_in_window >= 0 && r.other_sessions_in_window <= 10_000))) return null;
  return b;
}

export function validateManifest(m: unknown): { ok: true; value: SnapshotManifest } | { ok: false; error: string } {
  if (!m || typeof m !== 'object') return { ok: false, error: 'manifest must be an object' };
  const o = m as Record<string, unknown>;
  if ((o.schema !== SNAPSHOT_SCHEMA && o.schema !== SNAPSHOT_SCHEMA_V2) || !Array.isArray(o.files) || !o.files.length || o.files.length > Object.keys(SNAPSHOT_FILES).length) return { ok: false, error: 'schema and files[] required' };
  const seen = new Set<string>();
  for (const f of o.files as Array<Record<string, unknown>>) {
    if (!f || typeof f.name !== 'string' || !(f.name in SNAPSHOT_FILES) || seen.has(f.name) || !Number.isSafeInteger(f.bytes) || typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)) return { ok: false, error: 'each file needs an allowed name, bytes and sha256' };
    seen.add(f.name);
  }
  if (!seen.has('events.jsonl')) return { ok: false, error: 'events.jsonl is required' };
  // Identity lives in the spool metadata, not in the event lines: without it nothing can be attributed.
  if (!seen.has('session.meta.json')) return { ok: false, error: 'session.meta.json is required' };
  let binding: SnapshotBinding | undefined;
  if (o.schema === SNAPSHOT_SCHEMA_V2) { const b = validateBinding(o.binding); if (!b) return { ok: false, error: 'schema /2 needs a complete binding' }; binding = b; }
  else if (o.binding !== undefined) return { ok: false, error: 'binding requires schema /2' };
  return { ok: true, value: { schema: o.schema as string, files: o.files as ManifestFile[], ...(binding ? { binding } : {}) } };
}

export interface SnapshotOwner { student: string; cohort: string; profile: string; class_run_id: string; batch_id: string; seat_id: string; purpose: string; notice_version: string; activity: { course_id: string; version: string } | null; run_starts_at: number; upload_until: number }
/**
 * Who and what a snapshot belongs to, decided from the spool metadata the Service holds
 * and the device's binding. Returns '' when it is this learner's record of this class run,
 * otherwise the reason it must be held apart from collection and evaluation.
 */
export function attributionProblem(metaText: string, binding: SnapshotBinding | undefined, owner: SnapshotOwner): string {
  let meta: Record<string, any>; try { meta = JSON.parse(metaText); } catch { return 'metadata_invalid'; }
  const user = meta?.user;
  // No identity in the record: it is not assumed to be the learner who happens to hold this seat now.
  if (!user || typeof user !== 'object' || typeof user.u !== 'string' || typeof user.c !== 'string' || typeof user.p !== 'string') return 'identity_unbound';
  if (user.u !== owner.student) return 'foreign_student';
  if (user.c !== owner.cohort) return 'foreign_cohort';
  if (user.p !== owner.profile) return 'foreign_profile';
  if (typeof meta.session_id !== 'string' || !meta.session_id) return 'metadata_invalid';
  if (!binding) return meta.session_id === owner.class_run_id ? '' : 'run_unbound';
  if (binding.student.u !== owner.student || binding.student.c !== owner.cohort || binding.student.p !== owner.profile) return 'foreign_student';
  if (binding.class_run_id !== owner.class_run_id || binding.batch_id !== owner.batch_id) return 'foreign_run';
  if (binding.seat_id !== owner.seat_id) return 'foreign_seat';
  if (binding.spool_session_id !== meta.session_id) return 'binding_mismatch';
  if (binding.consent.purpose !== owner.purpose || binding.consent.notice_version !== owner.notice_version) return 'consent_scope_mismatch';
  if (JSON.stringify(binding.activity ?? null) !== JSON.stringify(owner.activity ?? null)) return 'foreign_activity';
  // The declared extent has to sit inside this class run's window: an earlier session on the same PC is another activity.
  const from = Date.parse(binding.range.from_ts), to = Date.parse(binding.range.to_ts);
  if (!(from <= to) || from < owner.run_starts_at - 3_600_000 || to > owner.upload_until) return 'outside_run_window';
  return '';
}

/**
 * Behavioural coverage is a separate answer from byte integrity.
 *  - A line that is not a JSON event is never skipped into "complete": the record is `damaged`.
 *  - A record without seq (any build before the spool wrote one, or a line that lost it): `sequence_unavailable`,
 *    never invented. That says nothing about the record's age.
 *  - Sequenced events are `complete` only against a DECLARED start and end whose final event
 *    the Service can see; a contiguous tail alone proves nothing about what came before it.
 *  - `complete` also needs the spool's own counter (`session_last_seq`: an event that was allocated but is not in
 *    the copy is a lost tail → `gaps`) and the App's statement that no other session of this learner in the class
 *    window was left out (app restart, second window, sealed session → `range_unknown`). Undeclared is unknown.
 * Also flags a line that names another owner — one learner's file must not carry another's events.
 */
export function eventCoverage(jsonl: string, owner: { student: string }, range?: SnapshotBinding['range']): { coverage: Coverage; lines: number; foreign: boolean; malformed: number; range_problem: string } {
  const seqs: number[] = []; let lines = 0, foreign = false, unsequenced = 0, malformed = 0, firstTs = '', lastTs = '';
  for (const raw of jsonl.split('\n')) {
    if (!raw.trim()) continue; lines++;
    let e: Record<string, unknown> | null = null; try { e = JSON.parse(raw); } catch { e = null; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) { malformed++; continue; }
    const who = e.user ?? e.u ?? e.student_id;
    if (typeof who === 'string' && who !== owner.student) foreign = true;
    if (typeof e.ts === 'string') { firstTs ||= e.ts; lastTs = e.ts; }
    if (Number.isSafeInteger(e.seq)) seqs.push(e.seq as number); else unsequenced++;
  }
  let range_problem = '';
  if (range) {
    if (range.lines !== lines) range_problem = 'line_count_mismatch';
    else if (firstTs && (range.from_ts !== firstTs || range.to_ts !== lastTs)) range_problem = 'declared_extent_mismatch';
  }
  if (malformed) return { coverage: 'damaged', lines, foreign, malformed, range_problem };
  if (!seqs.length || unsequenced) return { coverage: 'sequence_unavailable', lines, foreign, malformed, range_problem };
  const sorted = [...seqs].sort((a, b) => a - b);
  const contiguous = sorted.every((s, i) => i === 0 || s === sorted[i - 1]! + 1);
  if (!contiguous) return { coverage: 'gaps', lines, foreign, malformed, range_problem };
  if (!range || range.first_seq === undefined) return { coverage: 'range_unknown', lines, foreign, malformed, range_problem };
  const last = sorted[sorted.length - 1]!, bounded = range.first_seq === sorted[0] && range.last_seq === last;
  if (!bounded || range_problem) return { coverage: 'gaps', lines, foreign, malformed, range_problem: range_problem || 'declared_seq_mismatch' };
  if (range.session_last_seq === undefined || range.other_sessions_in_window === undefined) return { coverage: 'range_unknown', lines, foreign, malformed, range_problem: 'extent_not_declared' };
  if (range.session_last_seq !== last) return { coverage: 'gaps', lines, foreign, malformed, range_problem: range.session_last_seq > last ? 'tail_missing' : 'declared_seq_mismatch' };
  if (range.other_sessions_in_window > 0) return { coverage: 'range_unknown', lines, foreign, malformed, range_problem: 'other_session_not_included' };
  return { coverage: 'complete', lines, foreign, malformed, range_problem: '' };
}
export async function finalLineSha(jsonl: string): Promise<string> {
  const last = jsonl.split('\n').filter((l) => l.trim()).pop() ?? '';
  return sha256Bytes(new TextEncoder().encode(last).buffer as ArrayBuffer);
}

export async function sha256Bytes(b: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export const snapshotKey = (cohort: string, run: string, student: string, batch: string, revision: number, file: string) => `classroom-snapshots/${cohort}/${run}/${student}/${batch}/r${revision}/${file}`;
