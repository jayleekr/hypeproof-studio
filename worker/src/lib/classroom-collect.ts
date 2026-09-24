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
export const COLLECT_REQUEST_FIELDS = ['idempotency_key', 'roster_revision', 'purpose', 'notice_version', 'dry_run', 'targets', 'mode', 'kinds'] as const;
/**
 * U1b (#751) — WHAT a selected collection asks for. Every kind is a subset of the class record the learner already consented
 * to send for `class_report` (notice-v1: "내 질문·AI 응답·작업 이벤트"), so no kind needs a new consent and none widens it:
 *   record    — every event of this learner in the class window (the U1 content), now across app restarts
 *   prompts   — the learner's `prompt` events only (text as recorded, truncation flags, instructor prompt references)
 *   artifacts — only artifact versions the learner explicitly approved (`artifact_approval`), plus those approvals
 * The record already contains the other two, so `record` is asked alone; `prompts`+`artifacts` may be asked together.
 */
export const COLLECT_KINDS = ['record', 'prompts', 'artifacts'] as const;
export type CollectKind = (typeof COLLECT_KINDS)[number];
const KIND_SETS = ['record', 'prompts', 'artifacts', 'artifacts,prompts'];
export function normalizeKinds(v: unknown): CollectKind[] | null {
  if (!Array.isArray(v) || !v.length || v.some((k) => typeof k !== 'string') || new Set(v).size !== v.length) return null;
  const sorted = [...(v as string[])].sort();
  return KIND_SETS.includes(sorted.join(',')) ? (sorted as CollectKind[]) : null;
}
// This file stays import-free (tests load it without the Service resolver). The two shapes are the command ledger's ID_RE and
// UUIDISH_RE; classroom-ops-selected-collect.test.mjs fails if they drift apart.
export const COLLECT_SEAT_RE = /^[A-Za-z0-9_-]{1,128}$/, COLLECT_KEY_RE = /^[A-Za-z0-9-]{8,64}$/;
const SEAT_RE = COLLECT_SEAT_RE, KEY_RE = COLLECT_KEY_RE, NOTICE = /^[A-Za-z0-9_.-]{1,64}$/;
/** `kinds` absent = the U1 request (the current session's whole record, schema /2). Present = U1b (schema /3, every session in the window). */
export interface CollectRequest { idempotency_key: string; roster_revision: number; purpose: string; notice_version: string; dry_run: boolean; scope: 'roster' | 'targets'; mode: 'finish' | 'collect_only'; targets: string[]; kinds?: CollectKind[] }
export function normalizeCollectRequest(b: unknown, maxTargets: number): { ok: true; value: CollectRequest } | { ok: false; reason: string; detail: string } {
  const no = (reason: string, detail: string) => ({ ok: false as const, reason, detail });
  if (!b || typeof b !== 'object' || Array.isArray(b)) return no('request_invalid', 'a JSON object is required');
  const o = b as Record<string, unknown>, unknown = Object.keys(o).filter((k) => !(COLLECT_REQUEST_FIELDS as readonly string[]).includes(k));
  if (unknown.length) return no('unknown_field', 'unknown field: ' + unknown.slice(0, 5).join(', '));
  if (typeof o.idempotency_key !== 'string' || !KEY_RE.test(o.idempotency_key) || !Number.isInteger(o.roster_revision) || typeof o.dry_run !== 'boolean' || !(PURPOSES as readonly string[]).includes(o.purpose as string) || typeof o.notice_version !== 'string' || !NOTICE.test(o.notice_version)) return no('request_invalid', 'idempotency_key, roster_revision, purpose, notice_version and dry_run required');
  if (o.mode !== undefined && !(COLLECT_MODES as readonly string[]).includes(o.mode as string)) return no('mode_invalid', 'mode is finish or collect_only');
  const base = { idempotency_key: o.idempotency_key, roster_revision: o.roster_revision as number, purpose: o.purpose as string, notice_version: o.notice_version, dry_run: o.dry_run };
  // The class wrap-up feeds evaluation from the current session's whole record; kinds and restarted sessions are not part of it (U1b).
  let kinds: CollectKind[] | undefined;
  if (o.kinds !== undefined) { const k = normalizeKinds(o.kinds); if (!k) return no('kinds_invalid', 'kinds is ["record"], or one or both of "prompts" and "artifacts"'); kinds = k; }
  if (o.targets === undefined) {
    // Collect-only over "everyone" must name everyone: the whole roster is never a default of the new action.
    if (o.mode === 'collect_only') return no('targets_required', 'collect_only names its seats explicitly');
    if (kinds) return no('kinds_not_allowed', 'the class wrap-up collects the whole record; kinds belong to a selected collection');
    return { ok: true, value: { ...base, scope: 'roster', mode: 'finish', targets: [] } };
  }
  if (!Array.isArray(o.targets)) return no('targets_invalid', 'targets is a list of seat ids');
  if (!o.targets.length) return no('targets_empty', 'an empty selection collects nothing; it is not the whole class');
  if (o.targets.length > maxTargets) return no('targets_invalid', 'too many seats');
  if (o.targets.some((t) => typeof t !== 'string' || !SEAT_RE.test(t))) return no('targets_invalid', 'a seat id is malformed');
  if (new Set(o.targets).size !== o.targets.length) return no('targets_duplicate', 'a seat is named twice');
  if (o.mode === 'finish') return no('mode_not_allowed', 'the class wrap-up (evaluation may follow) covers the whole roster; selected seats are collect_only');
  return { ok: true, value: { ...base, scope: 'targets', mode: 'collect_only', targets: [...(o.targets as string[])].sort(), ...(kinds ? { kinds } : {}) } };
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
 *   transferring      yes      -      yes        the device accepted / is running, OR — after the request ENDED — bytes arrived LATER than
 *                                                that end and within ACTIVE_MS (a resumed upload), OR it reported "sent" and
 *                                                verification is still pending (bounded by SETTLE_MS)
 *   resend_wait        -      yes     yes        the device failed with `offline_pending`: it KEEPS the frozen copy and resumes when
 *                                                the app restarts or reconnects. Not a transfer in progress, not a final refusal.
 *   refused            -      yes     yes        a final refusal: the device gave up (upload_refused, verify_failed, …) or the Service
 *                                                marked the record incomplete. Files that already arrived do not make it "sending".
 *   unknown            -      yes     yes        the device started and never reported back (`outcome_unknown`), or "sent" without a
 *                                                verification for longer than SETTLE_MS. Neither a success nor a failure.
 *
 * `partial` = some files of this revision are stored but it is not verified. It is a fact about stored bytes, never evidence
 * that a transfer is happening NOW — only a running command is, or bytes that arrived AFTER the request had ended.
 *
 * Order matters (reproduced 2026-09-21, management-20260921/upload-terminal-order-check.mjs): "meta arrived, then the device
 * reported failure" and "the device reported failure, then a file arrived" both show recent bytes and a failed request. Only
 * the second is a resumed transfer. `item.updated_at` is the Service's receive time of the last upload PUT for this seat
 * (new file or an identical re-send) and `request.updated_at` is the Service's receive time of the terminal report — the same
 * clock. Bytes count as resumed activity only when they are STRICTLY later than the terminal report. Equal times, or a missing
 * or unreadable time on either side, prove no order — and an order that is not proven is never turned into "in progress".
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
  // From here the request is over. What it ended as is the answer — unless a file arrived AFTER it ended (a resumed upload).
  // A file that arrived BEFORE the failure report is how that attempt went, not a new one.
  const endedAt = item.request?.updated_at, bytesAt = item.updated_at;
  const resumed = item.state === 'uploading' && r !== 'succeeded' && Number.isFinite(endedAt) && Number.isFinite(bytesAt) && bytesAt > (endedAt as number) && ctx.now - bytesAt < COLLECT_ACTIVE_MS;
  if (resumed) return out('transferring', true, false, true);
  if (r === 'succeeded') return ctx.now - (item.request?.updated_at ?? item.updated_at) < COLLECT_SETTLE_MS ? out('transferring', true, false, true) : out('unknown', false, true, true);
  if (r === 'outcome_unknown') return out('unknown', false, true, true);
  if (r === 'failed') return code === 'offline_pending' ? out('resend_wait', false, true, true) : out('refused', false, true, true);
  if (['rejected', 'unsupported', 'expired', 'cancelled', 'not_connected'].includes(r)) return out('not_delivered', false, true, true);
  return out('unknown', false, false, true);
}

/** Everything that makes two requests "the same request". The idempotency key itself is not part of it. */
// Kinds join the canonical form only when asked, so every request hash recorded before U1b stays what it was.
export const collectRequestCanonical = (r: Pick<CollectRequest, 'scope' | 'mode' | 'targets' | 'purpose' | 'notice_version' | 'dry_run' | 'roster_revision' | 'kinds'>): string => JSON.stringify([r.scope, r.mode, r.targets, r.purpose, r.notice_version, r.dry_run, r.roster_revision, ...(r.kinds ? [r.kinds] : [])]);

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
export interface SnapshotManifest { schema: string; files: ManifestFile[]; binding?: SnapshotBinding; collection?: CollectionBinding }
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
  if (o.schema === SNAPSHOT_SCHEMA_V3) return validateCollectionManifest(o);
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

// ── U1b (#751): schema /3 — the kinds a selected collection asked for, over every session of this learner in the window ──
//
// One PART per spool session (app restart, second window, sealed session): its own session.meta.json (`p<i>.meta.json`), an
// INDEX of every event of that session inside the class window (`p<i>.index.jsonl` — seq, ts, type and the sha256 of the raw
// line; never content), and the raw event lines of the asked kinds only (`p<i>.events.jsonl`, absent when none). Lines are
// the spool's own bytes: each part keeps its session_id and seq — sessions are never concatenated into one fake stream.
// The index is what lets the Service tell "not asked for" from "missing" without receiving the lines that were not asked for.
export const SNAPSHOT_SCHEMA_V3 = 'hps-classroom-snapshot/3';
export const MAX_PARTS = 8;
export const V3_FILE_RE = /^p([1-8])\.(meta\.json|index\.jsonl|events\.jsonl)$/;
const V3_SPECS: Record<string, { maxBytes: number; contentType: string }> = { 'meta.json': { maxBytes: 256 * 1024, contentType: 'application/json' }, 'index.jsonl': { maxBytes: 2 * 1024 * 1024, contentType: 'application/x-ndjson' }, 'events.jsonl': { maxBytes: 8 * 1024 * 1024, contentType: 'application/x-ndjson' } };
/** Which file names a batch accepts: the legacy two for a batch without kinds, the part files for a U1b batch. Anything else is refused at PUT. */
export function snapshotFileSpec(name: string, kinds: boolean): { maxBytes: number; contentType: string } | null {
  if (!kinds) return Object.prototype.hasOwnProperty.call(SNAPSHOT_FILES, name) ? SNAPSHOT_FILES[name]! : null;
  const m = V3_FILE_RE.exec(name); return m ? V3_SPECS[m[2]!]! : null;
}
/** The event types a kind carries. `lesson_binding` (the U3 basis marker, no learner text) travels with every kind as provenance. */
export function kindSelects(kinds: readonly string[], type: unknown, artifactSha: unknown, approved: ReadonlySet<string>): boolean {
  if (kinds.includes('record')) return true;
  if (type === 'lesson_binding') return true;
  if (kinds.includes('prompts') && type === 'prompt') return true;
  if (kinds.includes('artifacts') && (type === 'artifact_approval' || (type === 'artifact_snapshot' && typeof artifactSha === 'string' && approved.has(artifactSha)))) return true;
  return false;
}
export type LineCategory = 'prompt' | 'response' | 'artifact_approved' | 'artifact_unapproved' | 'other';
export const lineCategory = (type: unknown, artifactSha: unknown, approved: ReadonlySet<string>): LineCategory =>
  type === 'prompt' ? 'prompt' : type === 'response' ? 'response' : type === 'artifact_snapshot' ? (typeof artifactSha === 'string' && approved.has(artifactSha) ? 'artifact_approved' : 'artifact_unapproved') : 'other';
/** The learner's last word on each artifact version wins, in time order across every part (approve → withdraw → approve again). */
export function approvedArtifacts(entries: Array<{ type?: unknown; ts?: unknown; artifact_sha256?: unknown; approved?: unknown; part: number; order: number }>): Set<string> {
  const list = entries.filter((e) => e.type === 'artifact_approval' && typeof e.artifact_sha256 === 'string').sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')) || a.part - b.part || a.order - b.order);
  const state = new Map<string, boolean>(); for (const e of list) state.set(e.artifact_sha256 as string, e.approved === true);
  return new Set([...state].filter(([, v]) => v).map(([k]) => k));
}
export interface CollectionPart { part: number; spool_session_id: string; current: boolean; lines: number; included: number; from_ts: string; to_ts: string; first_seq?: number; last_seq?: number; session_last_seq?: number; final_index_sha256: string; torn_tail: boolean }
export interface CollectionBinding { class_run_id: string; batch_id: string; seat_id: string; student: { u: string; c: string; p: string }; activity: { course_id: string; version: string } | null; consent: { purpose: string; notice_version: string }; kinds: CollectKind[]; parts: CollectionPart[]; omitted: { unreadable: number; over_limit: number } }
const small = (v: unknown, max = 10_000) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
function validateCollectionBinding(v: unknown): CollectionBinding | null {
  const b = v as CollectionBinding; if (!b || typeof b !== 'object') return null;
  if (![b.class_run_id, b.batch_id, b.seat_id].every((x) => str(x)) || !b.student || ![b.student.u, b.student.c, b.student.p].every((x) => str(x))) return null;
  if (b.activity !== null && !(b.activity && str(b.activity.course_id) && str(b.activity.version))) return null;
  if (!b.consent || !str(b.consent.purpose) || !str(b.consent.notice_version) || !normalizeKinds(b.kinds) || normalizeKinds(b.kinds)!.join() !== b.kinds.join()) return null;
  if (!b.omitted || !small(b.omitted.unreadable) || !small(b.omitted.over_limit) || !Array.isArray(b.parts) || !b.parts.length || b.parts.length > MAX_PARTS) return null;
  for (const [i, p] of b.parts.entries()) {
    if (!p || p.part !== i + 1 || !str(p.spool_session_id) || typeof p.current !== 'boolean' || typeof p.torn_tail !== 'boolean' || !Number.isSafeInteger(p.lines) || p.lines < 1 || p.lines > 1_000_000 || !small(p.included, p.lines)) return null;
    if (!str(p.from_ts, TS) || !str(p.to_ts, TS) || !str(p.final_index_sha256, /^[a-f0-9]{64}$/)) return null;
    if ((p.first_seq === undefined) !== (p.last_seq === undefined) || (p.first_seq !== undefined && (!Number.isSafeInteger(p.first_seq) || !Number.isSafeInteger(p.last_seq) || p.first_seq! < 1 || p.last_seq! < p.first_seq!))) return null;
    if (p.session_last_seq !== undefined && (!p.current || !Number.isSafeInteger(p.session_last_seq) || p.session_last_seq < 1)) return null;
  }
  if (b.parts.filter((p) => p.current).length > 1) return null;
  return b;
}
function validateCollectionManifest(o: Record<string, unknown>): { ok: true; value: SnapshotManifest } | { ok: false; error: string } {
  if (!Array.isArray(o.files) || !o.files.length || o.files.length > MAX_PARTS * 3) return { ok: false, error: 'schema and files[] required' };
  const b = validateCollectionBinding(o.collection); if (!b) return { ok: false, error: 'schema /3 needs a complete collection binding' };
  if (o.binding !== undefined) return { ok: false, error: 'schema /3 carries `collection`, not `binding`' };
  const seen = new Set<string>();
  for (const f of o.files as Array<Record<string, unknown>>) {
    if (!f || typeof f.name !== 'string' || !V3_FILE_RE.test(f.name) || seen.has(f.name) || !Number.isSafeInteger(f.bytes) || typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)) return { ok: false, error: 'each file needs an allowed part name, bytes and sha256' };
    seen.add(f.name);
  }
  // Exactly the files the binding declares: meta and index for every part, events when that part included a line.
  const want = new Set(b.parts.flatMap((p) => [`p${p.part}.meta.json`, `p${p.part}.index.jsonl`, ...(p.included ? [`p${p.part}.events.jsonl`] : [])]));
  if (want.size !== seen.size || [...want].some((n) => !seen.has(n))) return { ok: false, error: 'the files do not match the declared parts' };
  return { ok: true, value: { schema: SNAPSHOT_SCHEMA_V3, files: o.files as ManifestFile[], collection: b } };
}
/**
 * How an artifact line stores its page: `false` = the whole page (its hash is checked by the caller), `true` = cut at the spool's
 * size limit and saying so consistently (the original was larger than what is stored), `null` = inconsistent — not a line the App writes.
 */
export function artifactCut(e: Record<string, unknown>): boolean | null {
  if (typeof e.content !== 'string' || typeof e.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(e.sha256)) return null;
  const stored = new TextEncoder().encode(e.content).byteLength;
  if (e.content_truncated !== true) return e.content_truncated === undefined && (e.content_bytes === undefined || e.content_bytes === stored) ? false : null;
  return Number.isSafeInteger(e.content_bytes) && (e.content_bytes as number) > stored && Number.isSafeInteger(e.content_original_chars) && (e.content_original_chars as number) > e.content.length ? true : null;
}
export interface CollectionOwner extends SnapshotOwner { kinds: readonly string[] }
export interface CollectionExtent {
  lines: number; included: number; from_ts: string; to_ts: string; other_sessions_in_window: number; kinds: string[]; sessions: number;
  parts: Array<{ current: boolean; lines: number; included: number; from_ts: string; to_ts: string; first_seq?: number; last_seq?: number; start_proven: boolean; end_proven: boolean; torn_tail: boolean; truncated_prompts: number; truncated_artifacts: number; coverage: Coverage }>;
  received: Record<LineCategory, number> & { instructor_refs: number; truncated_prompts: number; truncated_artifacts: number; basis_markers: number };
  not_sent: Record<LineCategory, number>;
  omitted: { unreadable: number; over_limit: number }; reasons: string[];
}
const COVERAGE_RANK: Record<Coverage, number> = { complete: 0, range_unknown: 1, sequence_unavailable: 2, gaps: 3, damaged: 4 };
const worst = (a: Coverage, b: Coverage): Coverage => (COVERAGE_RANK[b] > COVERAGE_RANK[a] ? b : a);
const nd = (text: string) => { const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop(); return lines; };
const zero = (): Record<LineCategory, number> => ({ prompt: 0, response: 0, artifact_approved: 0, artifact_unapproved: 0, other: 0 });
/**
 * The Service's own reading of a /3 snapshot, from the bytes it holds. `problem` = it is not this learner's record of this run,
 * or it carries something that was not asked for (quarantine; the caller also deletes the bytes). Otherwise the coverage answer,
 * every reason it is not `complete`, and the extent the instructor view shows (numbers, times and flags — no session id, no content).
 */
export async function verifyCollection(texts: Map<string, string>, b: CollectionBinding, owner: CollectionOwner): Promise<{ problem: string } | { coverage: Coverage; reason: string; reasons: string[]; extent: CollectionExtent }> {
  if (b.student.u !== owner.student || b.student.c !== owner.cohort || b.student.p !== owner.profile) return { problem: 'foreign_student' };
  if (b.class_run_id !== owner.class_run_id || b.batch_id !== owner.batch_id) return { problem: 'foreign_run' };
  if (b.seat_id !== owner.seat_id) return { problem: 'foreign_seat' };
  if (b.consent.purpose !== owner.purpose || b.consent.notice_version !== owner.notice_version) return { problem: 'consent_scope_mismatch' };
  if (JSON.stringify(b.activity ?? null) !== JSON.stringify(owner.activity ?? null)) return { problem: 'foreign_activity' };
  if ([...owner.kinds].sort().join() !== b.kinds.join()) return { problem: 'kind_scope_mismatch' };
  type Entry = { seq?: unknown; ts?: unknown; type?: unknown; sha256?: unknown; artifact_sha256?: unknown; approved?: unknown; truncated?: unknown; malformed?: unknown; part: number; order: number };
  const sessions = new Set<string>(), indexes: Entry[][] = [];
  for (const p of b.parts) {
    let meta: Record<string, any>; try { meta = JSON.parse(texts.get(`p${p.part}.meta.json`) ?? ''); } catch { return { problem: 'metadata_invalid' }; }
    const user = meta?.user;
    if (!user || typeof user !== 'object' || typeof user.u !== 'string' || typeof user.c !== 'string' || typeof user.p !== 'string') return { problem: 'identity_unbound' };
    if (user.u !== owner.student) return { problem: 'foreign_student' };
    if (user.c !== owner.cohort) return { problem: 'foreign_cohort' };
    if (user.p !== owner.profile) return { problem: 'foreign_profile' };
    if (meta.session_id !== p.spool_session_id) return { problem: 'binding_mismatch' };
    if (sessions.has(p.spool_session_id)) return { problem: 'duplicate_session' }; sessions.add(p.spool_session_id);
    const raw = nd(texts.get(`p${p.part}.index.jsonl`) ?? ''), idx: Entry[] = [];
    for (const [order, line] of raw.entries()) {
      let e: Record<string, unknown> | null = null; try { e = JSON.parse(line); } catch { e = null; }
      if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(e.sha256)) return { problem: 'index_invalid' };
      idx.push({ ...e, part: p.part, order });
    }
    if (idx.length !== p.lines || (await sha256Bytes(new TextEncoder().encode(raw.at(-1) ?? '').buffer as ArrayBuffer)) !== p.final_index_sha256) return { problem: 'range_mismatch' };
    const ts = idx.map((e) => e.ts).filter((t): t is string => typeof t === 'string');
    if (ts.length && (ts[0] !== p.from_ts || ts.at(-1) !== p.to_ts)) return { problem: 'range_mismatch' };
    // An earlier session is only this class's when all of it sits inside the run itself; the current one may start in the lead-in.
    const earliest = p.current ? owner.run_starts_at - 3_600_000 : owner.run_starts_at;
    if (ts.some((t) => !(Date.parse(t) >= earliest && Date.parse(t) <= owner.upload_until))) return { problem: 'outside_run_window' };
    indexes.push(idx);
  }
  const approved = approvedArtifacts(indexes.flat());
  const received = { ...zero(), instructor_refs: 0, truncated_prompts: 0, truncated_artifacts: 0, basis_markers: 0 }, notSent = zero(), reasons: string[] = [], parts: CollectionExtent['parts'] = [];
  const add = (r: string) => { if (!reasons.includes(r)) reasons.push(r); };
  let coverage: Coverage = 'complete';
  for (const [n, p] of b.parts.entries()) {
    const idx = indexes[n]!, events = texts.has(`p${p.part}.events.jsonl`) ? nd(texts.get(`p${p.part}.events.jsonl`)!) : [];
    if (events.length !== p.included) return { problem: 'range_mismatch' };
    // Every sent line is an index entry, in order, with the same type/seq/ts — and of a kind that was asked for.
    const sent = new Set<number>(); let cursor = 0, truncated = 0, cutArtifacts = 0;
    for (const line of events) {
      const sha = await sha256Bytes(new TextEncoder().encode(line).buffer as ArrayBuffer);
      while (cursor < idx.length && idx[cursor]!.sha256 !== sha) cursor++;
      if (cursor >= idx.length) return { problem: 'index_mismatch' };
      const entry = idx[cursor]!; sent.add(cursor++);
      let e: Record<string, unknown> | null = null; try { e = JSON.parse(line); } catch { e = null; }
      // The index writes an absent field as null (older spool lines have no ts or seq); the line simply lacks it.
      if (!e || typeof e !== 'object' || Array.isArray(e) || (e.type ?? null) !== (entry.type ?? null) || (e.seq ?? null) !== (entry.seq ?? null) || (e.ts ?? null) !== (entry.ts ?? null)) return { problem: 'index_mismatch' };
      const artifact = e.type === 'artifact_snapshot' ? e.sha256 : e.type === 'artifact_approval' ? e.artifact_sha256 : undefined;
      if (artifact !== undefined && artifact !== entry.artifact_sha256) return { problem: 'index_mismatch' };
      // Which versions count as approved is read from the index (so an unsent line can be classified); the index's approval must be
      // the line's own — never a flag the device set on the side (#751 U1b review F3).
      if (e.type === 'artifact_approval' && (typeof entry.approved !== 'boolean' || entry.approved !== (e.approved === true))) return { problem: 'index_mismatch' };
      // An artifact line carries its version hash (sha256 of the WHOLE page) and the page as stored. A whole page must hash to it;
      // a page the spool cut at its size limit must say so and say how big the original was. A cut page is never "the approved
      // result" in full: it is received, counted and makes the answer not complete (F2).
      if (e.type === 'artifact_snapshot') {
        const cut = artifactCut(e); if (cut === null) return { problem: 'artifact_content_mismatch' };
        if (cut) cutArtifacts++;
        else if ((await sha256Bytes(new TextEncoder().encode(e.content as string).buffer as ArrayBuffer)) !== e.sha256) return { problem: 'artifact_content_mismatch' };
      }
      if (!kindSelects(b.kinds, e.type, e.sha256, approved)) return { problem: 'kind_violation' };
      const cat = lineCategory(e.type, e.sha256, approved); received[cat]++;
      if (e.type === 'prompt') { if (e.text_truncated === true) { received.truncated_prompts++; truncated++; } if (Array.isArray(e.instructor_prompt_refs) && e.instructor_prompt_refs.length) received.instructor_refs++; }
      if (e.type === 'lesson_binding') received.basis_markers++;
    }
    received.truncated_artifacts += cutArtifacts;
    // What was not sent is counted from the index only. A line of an asked kind that did not arrive is a gap, not "not asked".
    // An approval the kinds asked for that did not arrive is different: the index alone would then decide what counts as approved.
    let missing = false;
    for (const [i, entry] of idx.entries()) {
      if (sent.has(i)) continue;
      if (kindSelects(b.kinds, entry.type, entry.artifact_sha256, approved)) { if (entry.type === 'artifact_approval') return { problem: 'index_mismatch' }; missing = true; }
      else notSent[lineCategory(entry.type, entry.artifact_sha256, approved)]++;
    }
    // Sequence coverage is read on the whole window of this session (the index), never on the filtered lines.
    let c: Coverage = 'complete'; const partReasons: string[] = [];
    const seqs = idx.map((e) => e.seq), malformed = idx.some((e) => e.malformed === true || typeof e.type !== 'string');
    const nums = seqs.filter((s): s is number => Number.isSafeInteger(s)), sorted = [...nums].sort((x, y) => x - y);
    const contiguous = sorted.every((s, i) => i === 0 || s === sorted[i - 1]! + 1), last = sorted.at(-1);
    const startProven = !!sorted.length && p.first_seq !== undefined && p.first_seq === sorted[0] && p.last_seq === last;
    let endProven = false;
    if (malformed) { c = 'damaged'; partReasons.push('damaged_line'); }
    else if (nums.length !== idx.length) { c = 'sequence_unavailable'; partReasons.push('sequence_unavailable'); }
    else if (!contiguous) { c = 'gaps'; partReasons.push('seq_gap'); }
    else {
      if (p.current) {
        if (p.session_last_seq === undefined) { c = worst(c, 'range_unknown'); partReasons.push('extent_not_declared'); }
        else if (p.session_last_seq > last!) { c = worst(c, 'gaps'); partReasons.push('tail_missing'); }
        else if (p.session_last_seq < last!) { c = worst(c, 'gaps'); partReasons.push('declared_seq_mismatch'); }
        else endProven = true;
      } else if (idx.at(-1)!.type === 'session_close') endProven = true;
      else { c = worst(c, 'range_unknown'); partReasons.push('earlier_session_end_unproven'); }
      if (!startProven) { c = worst(c, 'range_unknown'); partReasons.push('start_not_proven'); }
    }
    // Bytes after the last newline were left out. Whatever came before them — even a session_close — is not where that session
    // ended: something was still being written after it (a crash mid-append, another window). Never a proven end (F1).
    if (p.torn_tail) { endProven = false; c = worst(c, 'range_unknown'); partReasons.push('torn_tail_dropped'); }
    if (missing) { c = worst(c, 'gaps'); partReasons.push('selected_line_missing'); }
    if (truncated) { c = worst(c, 'gaps'); partReasons.push('prompt_truncated'); }
    if (cutArtifacts) { c = worst(c, 'gaps'); partReasons.push('artifact_truncated'); }
    coverage = worst(coverage, c); partReasons.forEach(add);
    parts.push({ current: p.current, lines: idx.length, included: events.length, from_ts: p.from_ts, to_ts: p.to_ts, ...(p.first_seq !== undefined ? { first_seq: p.first_seq, last_seq: p.last_seq } : {}), start_proven: startProven, end_proven: endProven, torn_tail: p.torn_tail, truncated_prompts: truncated, truncated_artifacts: cutArtifacts, coverage: c });
  }
  const omitted = b.omitted.unreadable + b.omitted.over_limit;
  if (omitted) { coverage = worst(coverage, 'range_unknown'); add('session_not_included'); }
  const order = ['damaged_line', 'seq_gap', 'tail_missing', 'selected_line_missing', 'artifact_truncated', 'prompt_truncated', 'declared_seq_mismatch', 'sequence_unavailable', 'session_not_included', 'earlier_session_end_unproven', 'extent_not_declared', 'start_not_proven', 'torn_tail_dropped'];
  reasons.sort((x, y) => order.indexOf(x) - order.indexOf(y));
  const froms = b.parts.map((p) => p.from_ts).sort(), tos = b.parts.map((p) => p.to_ts).sort();
  return { coverage, reason: coverage === 'complete' ? '' : reasons.find((r) => r !== 'torn_tail_dropped') ?? reasons[0] ?? '', reasons, extent: { lines: parts.reduce((s, p) => s + p.lines, 0), included: parts.reduce((s, p) => s + p.included, 0), from_ts: froms[0]!, to_ts: tos.at(-1)!, other_sessions_in_window: omitted, kinds: [...b.kinds], sessions: b.parts.length, parts, received, not_sent: notSent, omitted: { ...b.omitted }, reasons } };
}

export async function sha256Bytes(b: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export const snapshotKey = (cohort: string, run: string, student: string, batch: string, revision: number, file: string) => `classroom-snapshots/${cohort}/${run}/${student}/${batch}/r${revision}/${file}`;
