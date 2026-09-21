// Remote classroom operations (#751, U2) — the D1 side of targeted distribution, shared by the instructor routes, the
// device sync and the issuer-revocation hooks. Every write here is set-based: the number of statements never grows with
// the number of seats (D1 allows 50 queries per invocation on the Free plan, 100 bound parameters per statement).
//
// Three facts are kept apart on purpose:
//   classroom_distribution_targets  what one run of a distribution PROVED about delivery to one participant
//   classroom_distribution_cards    which revision that participant's CURRENT device holds now, and any withdrawal owed
//   ops_issuer_fences               the D1 copy of "this issuer token was revoked" (KV revocation can lag a minute)
import type { Env } from '../env';
import {
  DIST_CLIENT_CAPABILITY, MAX_SYNC_ITEMS, MAX_SYNC_ITEM_BYTES, MAX_SYNC_RECEIPTS, MAX_SYNC_WITHDRAWS, applyWithinMs,
  deliveryKey, nextDistState, offerDelayMs, offerKeyInput, validateOfferReceipt, validateWithdrawReceipt, withdrawKeyInput,
} from './classroom-distribution';

type Db = Env['HPS_DB'];
type Stmt = ReturnType<Db['prepare']>;
const T = 'classroom_distribution_targets', C = 'classroom_distribution_cards', D = 'classroom_distributions', O = 'classroom_content_objects';
const OPEN = "('accepted','offered','received')";
// Audit rows are written as conditional INSERT … SELECT next to the transition they describe: a row that did not change leaves no audit.

/** Counts what a request really cost: D1 bills rows scanned and rows written (indexes included), not rows returned. */
export interface DbMeter { statements: number; rows_read: number; rows_written: number; unmetered: number }
export const newMeter = (): DbMeter => ({ statements: 0, rows_read: 0, rows_written: 0, unmetered: 0 });
/** A missing `meta` is counted as UNMETERED, never as zero: the SQLite shim reports no row counts and must not look free. */
export function meterResult(m: DbMeter | undefined, result: { meta?: { rows_read?: number; rows_written?: number } } | null | undefined, statements = 1) {
  if (!m) return; m.statements += statements;
  const meta = result?.meta;
  if (meta && typeof meta.rows_read === 'number' && typeof meta.rows_written === 'number') { m.rows_read += meta.rows_read; m.rows_written += meta.rows_written; } else m.unmetered += statements;
}
async function batch(db: Db, stmts: Stmt[], m?: DbMeter) { const r = await db.batch(stmts); if (m) for (const x of r as Array<{ meta?: any }>) meterResult(m, x); return r as Array<{ meta?: { changes?: number } }>; }
async function all<R>(st: Stmt, m?: DbMeter): Promise<R[]> { const r = await st.all(); meterResult(m, r as any); return (r.results ?? []) as R[]; }

// ── coverage: does anything still permit the revision this device shows? ─────
/**
 * A card stays only while some distribution run still permits the revision AND hash it shows now. An older run of an
 * older revision does not count (that would quietly show the learner v1 again after v2 was withdrawn), and a run that is
 * still pending counts only until it fails, expires or is revoked — which is why this is re-settled wherever a target
 * leaves the effective set. A run closed because its instructor's token was revoked keeps what it had already put on a
 * device: the revocation ends the authority to send more, it does not retract what was sent with it.
 */
const PERMITS = `EXISTS (SELECT 1 FROM ${T} t JOIN ${D} d ON d.id=t.distribution_id JOIN ${O} o ON o.object_id=t.object_id
 WHERE t.class_run_id=${C}.class_run_id AND t.seat_id=${C}.seat_id AND t.student_id=${C}.student_id AND t.object_id=${C}.object_id
 AND t.revision=${C}.revision AND d.content_hash=${C}.content_hash AND o.retired_at IS NULL
 AND ((d.revoked_at IS NULL AND t.state IN ('reflected','no_change','accepted','offered','received')) OR (d.revoke_reason='issuer_revoked' AND t.state IN ('reflected','no_change'))))`;
/** `scope` is a WHERE fragment over the cards table (no alias) — by run, by run+seat or by run+object. */
export function coverageStatements(db: Db, scope: string, args: unknown[], now: number): Stmt[] {
  return [
    db.prepare(`UPDATE ${C} SET state='withdraw_pending',pending=1,withdraw_offers=0,next_withdraw_at=0,withdraw_key='',
 withdraw_seq=(SELECT o.event_seq+1 FROM ${O} o WHERE o.object_id=${C}.object_id),
 withdraw_reason=CASE WHEN (SELECT o.retired_at FROM ${O} o WHERE o.object_id=${C}.object_id) IS NOT NULL THEN 'retired' ELSE 'revoked' END,updated_at=?
 WHERE ${scope} AND state='present' AND NOT ${PERMITS}`).bind(now, ...args),
    // Every withdrawal takes the next event number of its object, so a device can order it against offers it has seen.
    db.prepare(`UPDATE ${O} SET event_seq=event_seq+1 WHERE EXISTS (SELECT 1 FROM ${C} c WHERE c.object_id=${O}.object_id AND c.state='withdraw_pending' AND c.withdraw_seq=${O}.event_seq+1)`),
  ];
}

/**
 * Lazy settlement — nothing runs on a timer, so every read settles what is overdue first. `scope` is a WHERE fragment
 * over the targets table; `cardScope` the matching one over cards.
 */
export function settleStatements(db: Db, o: { scope: string; args: unknown[]; cardScope: string; cardArgs: unknown[]; runEnded: boolean; now: number }): Stmt[] {
  const live = (tbl: string) => `EXISTS (SELECT 1 FROM class_run_seats x WHERE x.class_run_id=${tbl}.class_run_id AND x.seat_id=${tbl}.seat_id AND x.seat_revision=${tbl}.seat_revision AND x.student_id=${tbl}.student_id AND x.replaced_at IS NULL)`;
  return [
    // The seat changed hands or the learner moved: the intent named a participant, and that participant is not there any more.
    db.prepare(`UPDATE ${T} SET state='target_changed',result_code='seat_replaced',pending=0,updated_at=? WHERE ${o.scope} AND state IN ${OPEN} AND NOT ${live(T)}`).bind(o.now, ...o.args),
    // Never offered = it did not go anywhere. Offered without a final receipt = it may be there: unknown, never success.
    db.prepare(`UPDATE ${T} SET state=CASE WHEN offers>0 THEN 'unconfirmed' ELSE 'expired' END,result_code=CASE WHEN offers>0 THEN 'no_receipt' ELSE 'ttl' END,pending=0,updated_at=?
 WHERE ${o.scope} AND state IN ${OPEN} AND (?=1 OR EXISTS (SELECT 1 FROM ${D} d WHERE d.id=${T}.distribution_id AND d.expires_at<=?))`).bind(o.now, ...o.args, o.runEnded ? 1 : 0, o.now),
    db.prepare(`UPDATE ${C} SET state='detached',pending=0,updated_at=? WHERE ${o.cardScope} AND state IN ('present','withdraw_pending') AND NOT ${live(C)}`).bind(o.now, ...o.cardArgs),
    ...coverageStatements(db, o.cardScope, o.cardArgs, o.now),
    // A withdrawal owed to a device whose connection is gone can never be confirmed. It is NOT counted as removed.
    db.prepare(`UPDATE ${C} SET state='withdraw_unconfirmed',pending=0,updated_at=? WHERE ${o.cardScope} AND state='withdraw_pending'
 AND NOT EXISTS (SELECT 1 FROM ops_grants g WHERE g.class_run_id=${C}.class_run_id AND g.seat_id=${C}.seat_id AND g.kind='connection' AND g.state='active' AND g.expires_at>? AND g.device_registration_id=${C}.device_registration_id)`).bind(o.now, ...o.cardArgs, o.now),
  ];
}

// ── issuer fence ─────────────────────────────────────────────────────────────
/**
 * KV revocation is what the token verifier reads, and it can reach other locations a minute late. Distribution does not
 * rely on it: a revoked issuer id is written to the D1 primary, the enqueue guards read it, and — when `sweep` — the same
 * transaction closes every open distribution that token created, so the next sync of ANY learner stops carrying it, no
 * matter which instructor paired that learner. Idempotent: repeating a revocation changes nothing more.
 */
export function issuerFenceStatements(db: Db, jti: string, o: { reason: string; by: string; sweep: boolean; now: number }): Stmt[] {
  const mine = `(SELECT id FROM ${D} WHERE issuer_jti=? AND revoked_at IS NULL)`;
  const stmts = [db.prepare("INSERT INTO ops_issuer_fences(issuer_jti,state,reason,recorded_by,created_at,updated_at) VALUES(?,'revoked',?,?,?,?) ON CONFLICT(issuer_jti) DO UPDATE SET state='revoked',reason=excluded.reason,recorded_by=excluded.recorded_by,revision=ops_issuer_fences.revision+1,updated_at=excluded.updated_at WHERE ops_issuer_fences.state<>'revoked'").bind(jti, o.reason.slice(0, 64), o.by.slice(0, 64), o.now, o.now)];
  if (!o.sweep) return stmts;
  return [...stmts,
    db.prepare(`UPDATE ${O} SET event_seq=event_seq+1 WHERE object_id IN (SELECT object_id FROM ${D} WHERE issuer_jti=? AND revoked_at IS NULL)`).bind(jti),
    db.prepare(`UPDATE ${T} SET state='revoked',result_code='issuer_revoked',pending=0,updated_at=? WHERE state IN ${OPEN} AND distribution_id IN ${mine}`).bind(o.now, jti),
    db.prepare(`UPDATE ${D} SET revoked_at=?,revoked_by='system',revoke_reason='issuer_revoked',revoke_seq=(SELECT o.event_seq FROM ${O} o WHERE o.object_id=${D}.object_id),row_revision=row_revision+1 WHERE issuer_jti=? AND revoked_at IS NULL`).bind(o.now, jti),
  ];
}
/** Un-revoke restores the token, not what the sweep closed: a swept distribution stays closed and is sent again if wanted. */
export const issuerFenceLiftStatement = (db: Db, jti: string, now: number) =>
  db.prepare("UPDATE ops_issuer_fences SET state='lifted',revision=revision+1,updated_at=? WHERE issuer_jti=? AND state='revoked'").bind(now, jti);
export const NOT_FENCED = "NOT EXISTS (SELECT 1 FROM ops_issuer_fences f WHERE f.issuer_jti=? AND f.state='revoked')";

// ── device sync ──────────────────────────────────────────────────────────────
/**
 * Everything that makes an offer legitimate, evaluated by the SAME statement that records it. The candidates are read
 * first (to build the payload), so between that read and this write a withdrawal, the run switch, the class end, a seat
 * re-assignment, a new login generation or another window taking the seat lease may land — reproduced 2026-09-21
 * (management-20260921/u2-revoke-inbox-impact.mjs): the item stayed in the answer although its ledger row said
 * `revoked, offers=0`, the device stored it, its receipts were refused as stale, and no withdrawal ever followed.
 * An item goes into the answer only if this conditional UPDATE changed its row; a re-read would only move the race.
 * Binds, in order: seat_revision, student_id, now, now, grant id, connection epoch, now, grant id, app instance.
 */
const OFFER_GUARD = `state IN ${OPEN} AND pending=1 AND seat_revision=? AND student_id=?
 AND EXISTS (SELECT 1 FROM ${D} d JOIN ${O} ob ON ob.object_id=d.object_id WHERE d.id=${T}.distribution_id AND d.revoked_at IS NULL AND ob.retired_at IS NULL AND d.expires_at>?)
 AND EXISTS (SELECT 1 FROM class_run_ops r WHERE r.class_run_id=${T}.class_run_id AND json_extract(r.flags_json,'$.ops_distribute')=1 AND r.ends_at>? AND NOT EXISTS (SELECT 1 FROM sessions z WHERE z.id=r.class_run_id AND z.ended_at IS NOT NULL))
 AND EXISTS (SELECT 1 FROM class_run_seats x WHERE x.class_run_id=${T}.class_run_id AND x.seat_id=${T}.seat_id AND x.seat_revision=${T}.seat_revision AND x.student_id=${T}.student_id AND x.replaced_at IS NULL)
 AND EXISTS (SELECT 1 FROM ops_grants gg WHERE gg.id=? AND gg.kind='connection' AND gg.state='active' AND gg.connection_epoch=? AND gg.expires_at>?)
 AND EXISTS (SELECT 1 FROM ops_seat_leases l WHERE l.grant_id=? AND l.app_instance_id=?)`;
/**
 * WHO a write is made for, checked by the write itself. A receipt is evidence and is settled even with the feature off or
 * the run closed — but only under the identity this sync was authorised as: the seat still this learner's, this grant
 * active at this login generation, this window holding the seat. A re-login or a seat change that lands after the row was
 * read must not be recorded under the identity it replaced. Binds: seat_revision, student_id, grant id, epoch, now, grant id, app instance.
 */
const IDENTITY_GUARD = `seat_revision=? AND student_id=?
 AND EXISTS (SELECT 1 FROM class_run_seats x WHERE x.class_run_id=${T}.class_run_id AND x.seat_id=${T}.seat_id AND x.seat_revision=${T}.seat_revision AND x.student_id=${T}.student_id AND x.replaced_at IS NULL)
 AND EXISTS (SELECT 1 FROM ops_grants gg WHERE gg.id=? AND gg.kind='connection' AND gg.state='active' AND gg.connection_epoch=? AND gg.expires_at>?)
 AND EXISTS (SELECT 1 FROM ops_seat_leases l WHERE l.grant_id=? AND l.app_instance_id=?)`;
const changed = (r: { meta?: { changes?: number } } | undefined) => (r?.meta?.changes ?? 0) === 1;
export interface SyncGrant { id: string; class_run_id: string; seat_id: string; seat_revision: number; student_id: string; connection_epoch: number; device_registration_id: string | null }
export interface DistributionBlock { items: Array<Record<string, unknown>>; withdraw: Array<Record<string, unknown>>; receipt_acks: Array<Record<string, unknown>>; withdraw_acks: Array<Record<string, unknown>>; more: boolean }
type TargetRow = { distribution_id: string; seat_id: string; seat_revision: number; student_id: string; object_id: string; revision: number; state: string; device_generation: number; offer_key: string; offers: number; content_hash: string; seq: number; revoked_at: number | null; revoke_reason: string | null; retired_at: number | null; expires_at: number; first_offered_at: number | null };

/**
 * One exchange inside /sync. Three flows with different conditions (the table in the requirements is the contract):
 *   new offers         flag ON · run open · not revoked/retired/expired · the participant of the target IS this grant's
 *   receipt settlement whenever the device can sync at all — a receipt is evidence of an offer that already went out
 *   withdrawals        whenever the device can sync at all — switching the feature off must not strand a retraction
 * The caller has already verified the credential, the grant, the live seat and the lease owner. Returns null when there
 * is nothing to say, so an idle sync answers byte-for-byte as it did before this existed.
 */
export async function distributionExchange(db: Db, g: SyncGrant, o: { body: unknown; declared: boolean; instance: string; flagOn: boolean; runEnded: boolean; runEndsAt: number; pendingHint: boolean; now: number; meter?: DbMeter }): Promise<DistributionBlock | null> {
  const body = (o.body && typeof o.body === 'object' && !Array.isArray(o.body) ? o.body : {}) as Record<string, unknown>;
  const receiptsIn = Array.isArray(body.receipts) ? body.receipts : [], withdrawIn = Array.isArray(body.withdraw_receipts) ? body.withdraw_receipts : [];
  if (!o.pendingHint && !receiptsIn.length && !withdrawIn.length) return null;
  const now = o.now, device = g.device_registration_id ?? '', seatArgs = [g.class_run_id, g.seat_id];
  if (!o.declared) {
    // An app that cannot hold an inbox is told apart from an offline one: the instructor sees "not supported", not "pending".
    if (o.flagOn && !o.runEnded) await batch(db, [db.prepare(`UPDATE ${T} SET state='unsupported',result_code='capability_missing',pending=0,grant_id=?,device_registration_id=?,updated_at=? WHERE class_run_id=? AND seat_id=? AND seat_revision=? AND student_id=? AND pending=1 AND state IN ${OPEN}`).bind(g.id, device, now, ...seatArgs, g.seat_revision, g.student_id)], o.meter);
    return null;
  }
  const identityArgs = [g.seat_revision, g.student_id, g.id, g.connection_epoch, now, g.id, o.instance];
  const block: DistributionBlock = { items: [], withdraw: [], receipt_acks: [], withdraw_acks: [], more: receiptsIn.length > MAX_SYNC_RECEIPTS || withdrawIn.length > MAX_SYNC_WITHDRAWS };

  for (const raw of receiptsIn.slice(0, MAX_SYNC_RECEIPTS)) {
    const v = validateOfferReceipt(raw), key = String((raw as any)?.offer_key ?? '').slice(0, 32), stage = String((raw as any)?.stage ?? '').slice(0, 16);
    const ack = (recorded: boolean, reason: string, final = true) => block.receipt_acks.push({ offer_key: key, stage, recorded, reason, final });
    if (!v.ok) { ack(false, 'schema'); continue; }
    const r = v.value, rows = await all<TargetRow>(db.prepare(`SELECT t.*,d.content_hash,d.seq,d.revoked_at,d.revoke_reason,d.expires_at,ob.retired_at FROM ${T} t JOIN ${D} d ON d.id=t.distribution_id JOIN ${O} ob ON ob.object_id=t.object_id WHERE t.distribution_id=? AND t.class_run_id=? AND t.seat_id=?`).bind(r.distribution_id, ...seatArgs), o.meter), t = rows[0];
    // The key binds grant, login generation, device generation, object, revision and hash. Anything else is an older offer.
    // …and it is re-derived from the connection this sync came in on, not merely compared with what the row remembers: a
    // receipt minted under an earlier login generation must not pass just because no newer offer has gone out yet.
    const current = t ? await deliveryKey(offerKeyInput({ distribution_id: t.distribution_id, seat_id: t.seat_id, device_generation: t.device_generation, grant_id: g.id, connection_epoch: g.connection_epoch, object_id: t.object_id, revision: t.revision, content_hash: t.content_hash })) : '';
    if (!t || r.offer_key !== current || t.object_id !== r.object_id || t.revision !== r.revision || t.content_hash !== r.content_hash || t.seq !== r.seq || t.student_id !== g.student_id || t.seat_revision !== g.seat_revision) { ack(false, 'stale_offer'); continue; }
    const closed = t.revoked_at !== null || t.retired_at !== null;
    // The key is right for THIS connection but the row never recorded it (or recorded another): only a closed run may be
    // answered — with a withdrawal, below. For a live run an unrecorded key proves nothing and is refused as stale.
    if (t.offer_key !== r.offer_key && !(closed && t.state === 'revoked')) { ack(false, 'stale_offer'); continue; }
    if (closed && t.state === 'revoked') {
      // The response had already left when the run was closed. A device that says it now HOLDS the item gets a card so
      // that the withdrawal below reaches it; nothing is recorded as delivered.
      // The card exists only if the target is STILL revoked at this commit; the final answer is given only once the card
      // (and with it the withdrawal) is on record, so the device keeps its journal entry until then.
      if (r.stage === 'reflected') {
        let done = false; try { done = changed((await batch(db, [cardUpsert(db, g, t, device, now, `EXISTS (SELECT 1 FROM ${T} WHERE distribution_id=? AND seat_id=? AND state='revoked' AND ${IDENTITY_GUARD})`, [t.distribution_id, t.seat_id, ...identityArgs]), ...coverageStatements(db, 'class_run_id=? AND seat_id=?', seatArgs, now)], o.meter))[0]) || !!(await all(db.prepare(`SELECT 1 AS x FROM ${C} WHERE class_run_id=? AND seat_id=? AND student_id=? AND object_id=?`).bind(...seatArgs, g.student_id, t.object_id), o.meter))[0]; }
        catch (err) { console.error('distribution in-flight card not recorded:', err); }
        ack(false, 'revoked', done); continue;
      }
      ack(false, 'revoked'); continue;
    }
    if (t.state === r.stage || (t.state === 'reflected' && r.stage === 'received')) { ack(true, 'recorded'); continue; } // a resend of what is already known
    const step = nextDistState(t.state, r.stage);
    if (!step.ok) { ack(false, t.state === 'target_changed' ? 'target_changed' : t.state === 'expired' ? 'expired' : step.reason); continue; }
    // A late truthful `reflected` is accepted after expiry only for an offer that went out BEFORE the intent expired.
    if (t.state === 'unconfirmed' && !(t.first_offered_at !== null && t.first_offered_at < t.expires_at)) { ack(false, 'expired'); continue; }
    const stmts = [db.prepare(`UPDATE ${T} SET state=?,result_code=?,pending=?,received_at=COALESCE(received_at,?),reflected_at=CASE WHEN ?='reflected' THEN ? ELSE reflected_at END,updated_at=? WHERE distribution_id=? AND seat_id=? AND state=? AND offer_key=? AND ${IDENTITY_GUARD}`).bind(step.state, r.result_code, step.state === 'received' ? 1 : 0, now, step.state, now, now, t.distribution_id, t.seat_id, t.state, t.offer_key, ...identityArgs)];
    // The card and the audit row exist only if THIS transition won: a batch that succeeds says nothing about a CAS that
    // changed zero rows (a withdrawal, a rebind or another receipt may have moved the row since it was read).
    const won = `EXISTS (SELECT 1 FROM ${T} WHERE distribution_id=? AND seat_id=? AND state=? AND offer_key=? AND updated_at=?)`, wonArgs = [t.distribution_id, t.seat_id, step.state, t.offer_key, now];
    if (step.state === 'reflected') stmts.push(cardUpsert(db, g, t, device, now, won, wonArgs));
    if (step.state !== 'received') stmts.push(db.prepare(`INSERT INTO ops_audit(class_run_id,seat_id,actor_kind,actor_id,action,detail_json,at) SELECT ?,?,'device',?,?,?,? WHERE ${won}`).bind(g.class_run_id, g.seat_id, device || g.id, 'distribution_' + step.state, JSON.stringify({ distribution_id: t.distribution_id, object_id: t.object_id, revision: t.revision, result_code: r.result_code }), now, ...wonArgs));
    // A target that leaves the effective set may have been the only thing keeping an older card of this object.
    if (step.state === 'failed' || step.state === 'superseded') stmts.push(...coverageStatements(db, 'class_run_id=? AND seat_id=?', seatArgs, now));
    let results; try { results = await batch(db, stmts, o.meter); } catch (err) { console.error('distribution receipt not stored:', err); ack(false, 'storage', false); continue; }
    // Lost the CAS: nothing was recorded and the answer is NOT final — the device keeps the receipt and the next sync reads the row as it is now.
    ack(changed(results[0]), changed(results[0]) ? 'recorded' : 'changed', changed(results[0]));
  }

  for (const raw of withdrawIn.slice(0, MAX_SYNC_WITHDRAWS)) {
    const v = validateWithdrawReceipt(raw), key = String((raw as any)?.withdraw_key ?? '').slice(0, 32);
    const ack = (recorded: boolean, reason: string, final = true) => block.withdraw_acks.push({ withdraw_key: key, recorded, reason, final });
    if (!v.ok) { ack(false, 'schema'); continue; }
    const r = v.value, card = (await all<{ state: string; withdraw_key: string; withdraw_seq: number | null }>(db.prepare(`SELECT state,withdraw_key,withdraw_seq FROM ${C} WHERE class_run_id=? AND seat_id=? AND student_id=? AND object_id=?`).bind(...seatArgs, g.student_id, r.object_id), o.meter))[0];
    if (!card || card.withdraw_key !== r.withdraw_key || card.withdraw_seq !== r.seq) { ack(false, 'stale_withdraw'); continue; }
    if (card.state === 'withdrawn') { ack(true, 'recorded'); continue; }
    if (card.state !== 'withdraw_pending') { ack(false, 'stale_withdraw'); continue; }
    // `stale` = the device holds something newer than this withdrawal. The card is not marked removed on that word alone.
    if (r.result === 'stale') { ack(false, 'device_holds_newer'); continue; }
    try {
      const res = await batch(db, [db.prepare(`UPDATE ${C} SET state='withdrawn',pending=0,updated_at=? WHERE class_run_id=? AND seat_id=? AND student_id=? AND object_id=? AND state='withdraw_pending' AND withdraw_key=? AND EXISTS (SELECT 1 FROM class_run_seats x WHERE x.class_run_id=${C}.class_run_id AND x.seat_id=${C}.seat_id AND x.seat_revision=? AND x.student_id=${C}.student_id AND x.replaced_at IS NULL) AND EXISTS (SELECT 1 FROM ops_grants gg WHERE gg.id=? AND gg.kind='connection' AND gg.state='active' AND gg.connection_epoch=? AND gg.expires_at>?) AND EXISTS (SELECT 1 FROM ops_seat_leases l WHERE l.grant_id=? AND l.app_instance_id=?)`).bind(now, ...seatArgs, g.student_id, r.object_id, r.withdraw_key, g.seat_revision, g.id, g.connection_epoch, now, g.id, o.instance), db.prepare(`INSERT INTO ops_audit(class_run_id,seat_id,actor_kind,actor_id,action,detail_json,at) SELECT ?,?,'device',?,'distribution_withdrawn',?,? WHERE EXISTS (SELECT 1 FROM ${C} WHERE class_run_id=? AND seat_id=? AND student_id=? AND object_id=? AND state='withdrawn' AND withdraw_key=? AND updated_at=?)`).bind(g.class_run_id, g.seat_id, device || g.id, JSON.stringify({ object_id: r.object_id, seq: r.seq, result: r.result }), now, ...seatArgs, g.student_id, r.object_id, r.withdraw_key, now)], o.meter);
      ack(changed(res[0]), changed(res[0]) ? 'recorded' : 'changed', changed(res[0]));
    } catch (err) { console.error('distribution withdraw receipt not stored:', err); ack(false, 'storage', false); }
  }

  await batch(db, settleStatements(db, { scope: 'class_run_id=? AND seat_id=? AND pending=1', args: seatArgs, cardScope: 'class_run_id=? AND seat_id=?', cardArgs: seatArgs, runEnded: o.runEnded, now }), o.meter);

  // Withdrawals owed to THIS device. A card that lived on another device of this learner cannot be confirmed from here.
  const owed = await all<{ object_id: string; revision: number; withdraw_seq: number; withdraw_reason: string; withdraw_offers: number; device_registration_id: string }>(db.prepare(`SELECT object_id,revision,withdraw_seq,withdraw_reason,withdraw_offers,device_registration_id FROM ${C} WHERE class_run_id=? AND seat_id=? AND pending=1 AND state='withdraw_pending' AND student_id=? AND next_withdraw_at<=? ORDER BY withdraw_seq LIMIT ?`).bind(...seatArgs, g.student_id, now, MAX_SYNC_WITHDRAWS + 1), o.meter);
  if (owed.length > MAX_SYNC_WITHDRAWS) block.more = true;
  // A withdrawal is put into the answer only if the row that records its delivery key really changed: the card may have
  // been confirmed by another window, or brought back by a newer reflected receipt, since it was read.
  const GRANT_NOW = "EXISTS (SELECT 1 FROM ops_grants gg WHERE gg.id=? AND gg.kind='connection' AND gg.state='active' AND gg.connection_epoch=? AND gg.expires_at>?)";
  const cardWrites: Stmt[] = [], tombstones: Array<Record<string, unknown> | null> = [];
  for (const c of owed.slice(0, MAX_SYNC_WITHDRAWS)) {
    if (c.device_registration_id !== device) { cardWrites.push(db.prepare(`UPDATE ${C} SET state='withdraw_unconfirmed',pending=0,updated_at=? WHERE class_run_id=? AND seat_id=? AND student_id=? AND object_id=? AND state='withdraw_pending' AND withdraw_seq=?`).bind(now, ...seatArgs, g.student_id, c.object_id, c.withdraw_seq)); tombstones.push(null); continue; }
    const key = await deliveryKey(withdrawKeyInput({ class_run_id: g.class_run_id, seat_id: g.seat_id, student_id: g.student_id, object_id: c.object_id, withdraw_seq: c.withdraw_seq, grant_id: g.id, connection_epoch: g.connection_epoch, device_registration_id: device }));
    cardWrites.push(db.prepare(`UPDATE ${C} SET withdraw_key=?,withdraw_offers=withdraw_offers+1,next_withdraw_at=?,updated_at=? WHERE class_run_id=? AND seat_id=? AND student_id=? AND object_id=? AND state='withdraw_pending' AND pending=1 AND withdraw_seq=? AND device_registration_id=? AND ${GRANT_NOW}`).bind(key, now + offerDelayMs(c.withdraw_offers + 1), now, ...seatArgs, g.student_id, c.object_id, c.withdraw_seq, device, g.id, g.connection_epoch, now));
    tombstones.push({ withdraw_key: key, object_id: c.object_id, seq: c.withdraw_seq, revision: c.revision, reason: c.withdraw_reason || 'revoked' });
  }
  if (cardWrites.length) { const res = await batch(db, cardWrites, o.meter); tombstones.forEach((w, n) => { if (w && changed(res[n])) block.withdraw.push(w); }); }

  if (o.flagOn && !o.runEnded) {
    const rows = await all<TargetRow & { kind: string; title: string; payload_json: string; content_schema: string; created_at: number; card_revision: number | null; card_hash: string | null; card_state: string | null; card_device: string | null }>(db.prepare(`SELECT t.*,d.content_hash,d.seq,d.expires_at,d.created_at,r.kind,r.title,r.payload_json,r.content_schema,
 c.revision AS card_revision,c.content_hash AS card_hash,c.state AS card_state,c.device_registration_id AS card_device
 FROM ${T} t JOIN ${D} d ON d.id=t.distribution_id JOIN ${O} ob ON ob.object_id=t.object_id JOIN classroom_content_revisions r ON r.object_id=t.object_id AND r.revision=t.revision
 LEFT JOIN ${C} c ON c.class_run_id=t.class_run_id AND c.seat_id=t.seat_id AND c.student_id=t.student_id AND c.object_id=t.object_id
 WHERE t.class_run_id=? AND t.seat_id=? AND t.pending=1 AND t.state IN ${OPEN} AND t.seat_revision=? AND t.student_id=? AND t.next_offer_at<=? AND d.revoked_at IS NULL AND ob.retired_at IS NULL AND d.expires_at>?
 ORDER BY d.seq,d.created_at LIMIT ?`).bind(...seatArgs, g.seat_revision, g.student_id, now, now, MAX_SYNC_ITEMS + 2), o.meter);
    // What was read above is only a CANDIDATE list. Every statement below carries the whole eligibility (OFFER_GUARD) and,
    // where it depends on the card, the card's state as well; the answer is assembled from the statements that changed a row.
    const guardArgs = [g.seat_revision, g.student_id, now, now, g.id, g.connection_epoch, now, g.id, o.instance];
    const CARD = `EXISTS (SELECT 1 FROM ${C} c WHERE c.class_run_id=${T}.class_run_id AND c.seat_id=${T}.seat_id AND c.student_id=${T}.student_id AND c.object_id=${T}.object_id AND c.state='present' AND c.device_registration_id=?`;
    const writes: Stmt[] = [], offers: Array<Record<string, unknown> | null> = []; let bytes = 0, count = 0;
    for (const t of rows) {
      // Same revision, same hash, on THIS device, not withdrawn since: nothing to send, and nothing new is claimed.
      if (t.card_state === 'present' && t.card_device === device && t.card_revision === t.revision && t.card_hash === t.content_hash) {
        writes.push(db.prepare(`UPDATE ${T} SET state='no_change',result_code='same_revision_held',pending=0,grant_id=?,device_registration_id=?,connection_epoch=?,updated_at=? WHERE distribution_id=? AND seat_id=? AND ${OFFER_GUARD} AND ${CARD} AND c.revision=? AND c.content_hash=?)`).bind(g.id, device, g.connection_epoch, now, t.distribution_id, t.seat_id, ...guardArgs, device, t.revision, t.content_hash)); offers.push(null); continue;
      }
      if (t.card_state === 'present' && t.card_device === device && (t.card_revision ?? 0) > t.revision) {
        writes.push(db.prepare(`UPDATE ${T} SET state='superseded',result_code='newer_revision',pending=0,updated_at=? WHERE distribution_id=? AND seat_id=? AND ${OFFER_GUARD} AND ${CARD} AND c.revision>?)`).bind(now, t.distribution_id, t.seat_id, ...guardArgs, device, t.revision)); offers.push(null); continue;
      }
      const within = applyWithinMs(Math.min(t.expires_at, o.runEndsAt) - now);
      if (within <= 0) continue; // too close to the end to apply honestly; settlement will call it expired or unconfirmed
      if (count >= MAX_SYNC_ITEMS) { block.more = true; break; }
      let payload: { body?: unknown; links?: unknown }; try { payload = JSON.parse(t.payload_json); } catch { continue; }
      const item = { offer_key: '', distribution_id: t.distribution_id, seq: t.seq, object_id: t.object_id, revision: t.revision, kind: t.kind, schema: t.content_schema, title: t.title, body: payload.body, links: payload.links ?? [], content_hash: t.content_hash, from: 'instructor', issued_at: t.created_at, expires_at: t.expires_at, apply_within_ms: within };
      item.offer_key = await deliveryKey(offerKeyInput({ distribution_id: t.distribution_id, seat_id: t.seat_id, device_generation: t.device_generation, grant_id: g.id, connection_epoch: g.connection_epoch, object_id: t.object_id, revision: t.revision, content_hash: t.content_hash }));
      const size = new TextEncoder().encode(JSON.stringify(item)).length;
      if (bytes + size > MAX_SYNC_ITEM_BYTES) { block.more = true; break; }
      bytes += size; count++;
      writes.push(db.prepare(`UPDATE ${T} SET state=CASE WHEN state='accepted' THEN 'offered' ELSE state END,offers=offers+1,next_offer_at=?,first_offered_at=COALESCE(first_offered_at,?),grant_id=?,connection_epoch=?,device_registration_id=?,offer_key=?,updated_at=? WHERE distribution_id=? AND seat_id=? AND device_generation=? AND ${OFFER_GUARD}`).bind(now + offerDelayMs(t.offers + 1), now, g.id, g.connection_epoch, device, item.offer_key, now, t.distribution_id, t.seat_id, t.device_generation, ...guardArgs));
      offers.push(item);
    }
    // No offer leaves without its ledger row. A storage failure sends nothing; a guard that did not hold sends nothing for
    // THAT item — it was not offered, so there is nothing to withdraw later, and its row says exactly that.
    if (writes.length) {
      try { const res = await batch(db, writes, o.meter); offers.forEach((item, n) => { if (item && changed(res[n])) block.items.push(item); }); }
      catch (err) { console.error('distribution offer not recorded; nothing offered:', err); block.items = []; }
    }
  }
  return block.items.length || block.withdraw.length || block.receipt_acks.length || block.withdraw_acks.length ? block : null;
}
/** `cond` ties the card to the transition that justifies it: it is written only if that row is what this request made it. */
function cardUpsert(db: Db, g: SyncGrant, t: { object_id: string; revision: number; content_hash: string; seq: number }, device: string, now: number, cond: string, condArgs: unknown[]): Stmt {
  // Never backwards: a late report of an older revision cannot replace the record of a newer one.
  return db.prepare(`INSERT INTO ${C}(class_run_id,seat_id,student_id,object_id,seat_revision,device_registration_id,revision,content_hash,seq,state,updated_at) SELECT ?,?,?,?,?,?,?,?,?,'present',? WHERE ${cond}
 ON CONFLICT(class_run_id,seat_id,student_id,object_id) DO UPDATE SET seat_revision=excluded.seat_revision,device_registration_id=excluded.device_registration_id,revision=excluded.revision,content_hash=excluded.content_hash,seq=excluded.seq,state='present',pending=0,withdraw_seq=NULL,withdraw_key='',withdraw_reason='',withdraw_offers=0,next_withdraw_at=0,updated_at=excluded.updated_at
 WHERE excluded.revision>${C}.revision OR (excluded.revision=${C}.revision AND (excluded.seq>=${C}.seq OR ${C}.device_registration_id<>excluded.device_registration_id))`).bind(g.class_run_id, g.seat_id, g.student_id, t.object_id, g.seat_revision, device, t.revision, t.content_hash, t.seq, now, ...condArgs);
}

/**
 * A learner paired a new device. Intents that are still valid go to it again (a new device generation, so the old
 * device's late receipts are refused); what the old device held is no longer what this learner sees.
 */
export function deviceRebindStatements(db: Db, g: { class_run_id: string; seat_id: string; seat_revision: number; student_id: string }, newDevice: string, now: number): Stmt[] {
  return [
    db.prepare(`UPDATE ${T} SET state='accepted',result_code='',device_generation=device_generation+1,offers=0,next_offer_at=0,offer_key='',pending=1,updated_at=?
 WHERE class_run_id=? AND seat_id=? AND seat_revision=? AND student_id=? AND device_registration_id<>'' AND device_registration_id<>? AND state IN ('offered','received','reflected','no_change','unsupported')
 AND EXISTS (SELECT 1 FROM ${D} d JOIN ${O} o ON o.object_id=d.object_id WHERE d.id=${T}.distribution_id AND d.revoked_at IS NULL AND o.retired_at IS NULL AND d.expires_at>?)`).bind(now, g.class_run_id, g.seat_id, g.seat_revision, g.student_id, newDevice, now),
    db.prepare(`UPDATE ${C} SET state=CASE WHEN state='withdraw_pending' THEN 'withdraw_unconfirmed' ELSE 'detached' END,pending=0,updated_at=? WHERE class_run_id=? AND seat_id=? AND student_id=? AND device_registration_id<>? AND state IN ('present','withdraw_pending')`).bind(now, g.class_run_id, g.seat_id, g.student_id, newDevice),
  ];
}
/** Folded into the grant read of /sync as a subquery: two partial-index probes, no extra statement, nothing scanned when idle. */
export const PENDING_PROBE = `(EXISTS (SELECT 1 FROM ${T} p WHERE p.class_run_id=g.class_run_id AND p.seat_id=g.seat_id AND p.pending=1) OR EXISTS (SELECT 1 FROM ${C} q WHERE q.class_run_id=g.class_run_id AND q.seat_id=g.seat_id AND q.pending=1))`;
export const declaresInbox = (caps: unknown) => Array.isArray(caps) && caps.includes(DIST_CLIENT_CAPABILITY);
