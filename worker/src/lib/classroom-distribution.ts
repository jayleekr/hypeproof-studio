// Remote classroom operations (#751, U2) — targeted distribution of notices and materials: the pure contract.
// No imports, no bindings, no clock reads (callers pass `now`), so the tests load this file directly and the App's
// inbox reducer can be checked against the same tables. Contract: docs/requirements/classroom-admin.md
// #remote-management-u2-20260921.
//
// Words that must not blur: DELIVERY (`ops_delivery`, `deliver`) is sending an approved REPORT to a recipient after
// class. DISTRIBUTION (`ops_distribute`, `distribute`) is putting an instructor's notice or material into the inbox of
// the learners the instructor selected, during class. Nothing here touches the first.

export const CONTENT_SCHEMA = 'hps-classroom-content/1';
/**
 * `prompt` (U3): a text the learner may IMPORT INTO THEIR DRAFT by their own press — inbox content like a notice.
 * `setting` (U3): a reference to a frozen lesson version of the run's course (or `base`: back to the token's lesson). It
 * carries no values of its own, and one class run has ONE setting object whose revisions are the successive choices.
 */
export const CONTENT_KINDS = ['notice', 'material', 'prompt', 'setting'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];
export const DIST_CLIENT_CAPABILITY = 'distribution_inbox';
/** Declared per kind: an app that can hold notices is not thereby able to import a prompt or switch a lesson binding. */
export const KIND_CLIENT_CAPABILITY: Record<ContentKind, string> = { notice: 'distribution_inbox', material: 'distribution_inbox', prompt: 'inbox_prompt', setting: 'lesson_binding' };
export const declaresKind = (caps: unknown, kind: string) => Array.isArray(caps) && caps.includes(DIST_CLIENT_CAPABILITY) && caps.includes(KIND_CLIENT_CAPABILITY[kind as ContentKind] ?? '\u0000');
const VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/;

export const MAX_TITLE_CHARS = 80;
export const MAX_BODY_CHARS = 2000;
export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_LINKS = 5;
export const MAX_LINK_LABEL_CHARS = 60;
export const MAX_LINK_URL_CHARS = 500;
export const MAX_OBJECTS_PER_RUN = 50;
export const MAX_REVISIONS_PER_OBJECT = 20;
export const MAX_DISTRIBUTIONS_PER_RUN = 200;
export const MAX_DISTRIBUTIONS_PER_MINUTE = 20;
export const MAX_SYNC_ITEMS = 2;
export const MAX_SYNC_ITEM_BYTES = 24 * 1024;
export const MAX_SYNC_WITHDRAWS = 10;
/** Each receipt costs one read and one write, so this bounds the queries one sync may spend here. */
export const MAX_SYNC_RECEIPTS = 6;
export const LIST_PAGE = 50;
/** A new application must be committed on the device within this long of the REQUEST that fetched it. */
export const APPLY_WITHIN_MS = 30_000;
/** The device's own request limit: a response may arrive this late and still be the one the server just answered. */
export const SYNC_TIMEOUT_MS = 4_000;
const APPLY_MARGIN_MS = 1_000;

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const KEY_RE = /^[A-Za-z0-9-]{8,64}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
export const OFFER_KEY_RE = /^[a-f0-9]{32}$/;
// C0 controls except tab/newline/carriage return, DEL, and the bidi/zero-width characters that can make text read as
// something it is not. Text is only ever drawn as text, so nothing else needs refusing.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string; detail: string; field?: string };
const bad = (reason: string, detail: string, field?: string): Verdict<never> => ({ ok: false, reason, detail, ...(field ? { field } : {}) });
const exact = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).find((k) => !allowed.includes(k));

export interface ContentLink { label: string; url: string }
export interface LessonRef { course_id: string; version: string; sha256: string }
/** `lesson` exists on a setting only: a frozen version, or `'base'` = the lesson the participant's own token pins. */
export interface Content { kind: ContentKind; title: string; body: string; links: ContentLink[]; lesson?: LessonRef | 'base' }

/** `hosts` is the operator's allowlist. Empty (the default) refuses every link: no domain is trusted by default. */
export function normalizeLink(raw: unknown, hosts: readonly string[]): Verdict<ContentLink> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('content_invalid', 'a link is {label,url}', 'links');
  const o = raw as Record<string, unknown>;
  if (exact(o, ['label', 'url'])) return bad('content_invalid', 'a link carries label and url only', 'links');
  if (typeof o.label !== 'string' || !o.label.trim() || [...o.label].length > MAX_LINK_LABEL_CHARS || CONTROL_RE.test(o.label) || /[\r\n\t]/.test(o.label)) return bad('content_invalid', `link label is 1–${MAX_LINK_LABEL_CHARS} plain characters on one line`, 'links');
  if (typeof o.url !== 'string' || o.url.length > MAX_LINK_URL_CHARS || /\s/.test(o.url) || CONTROL_RE.test(o.url)) return bad('content_invalid', 'link url', 'links');
  let u: URL; try { u = new URL(o.url); } catch { return bad('content_invalid', 'link url does not parse', 'links'); }
  if (u.protocol !== 'https:') return bad('content_invalid', 'links are https only', 'links');
  if (u.username || u.password) return bad('content_invalid', 'a link carries no credentials', 'links');
  if (u.port && u.port !== '443') return bad('content_invalid', 'links use the default https port', 'links');
  const host = u.hostname.toLowerCase();
  if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host) || /^0x|^\d+$/.test(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.')) return bad('content_invalid', 'links name a public host, not an address or a local name', 'links');
  if (!hosts.map((h) => h.toLowerCase()).includes(host)) return bad('link_host_not_allowed', hosts.length ? 'this host is not on the allowed list for materials' : 'no link host is allowed yet; send the text without links', 'links');
  // The URL is stored exactly as the instructor typed it (what was reviewed is what is hashed), not as the parser re-wrote it.
  return { ok: true, value: { label: o.label.trim(), url: o.url } };
}

export function parseLinkHosts(setting: string | undefined | null): string[] {
  return (setting ?? '').split(',').map((h) => h.trim().toLowerCase()).filter((h) => /^[a-z0-9.-]{3,253}$/.test(h) && h.includes('.'));
}

/** Plain text only. Markup is not stripped or escaped here — it is stored as typed and DRAWN as text on both ends. */
export function normalizeContent(raw: unknown, hosts: readonly string[]): Verdict<Content> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('content_invalid', 'content must be an object');
  const o = raw as Record<string, unknown>;
  if (!(CONTENT_KINDS as readonly unknown[]).includes(o.kind)) return bad('content_invalid', `kind is one of ${CONTENT_KINDS.join(', ')}`, 'kind');
  if (typeof o.title !== 'string' || !o.title.trim() || [...o.title].length > MAX_TITLE_CHARS || CONTROL_RE.test(o.title) || /[\r\n\t]/.test(o.title)) return bad('content_invalid', `title is 1–${MAX_TITLE_CHARS} plain characters on one line`, 'title');
  if (typeof o.body !== 'string' || !o.body.trim() || [...o.body].length > MAX_BODY_CHARS || new TextEncoder().encode(o.body).length > MAX_BODY_BYTES || CONTROL_RE.test(o.body)) return bad('content_invalid', `body is 1–${MAX_BODY_CHARS} characters of plain text (≤ ${MAX_BODY_BYTES} bytes)`, 'body');
  const rawLinks = o.links === undefined ? [] : o.links;
  if (!Array.isArray(rawLinks) || rawLinks.length > MAX_LINKS) return bad('content_invalid', `links[] ≤ ${MAX_LINKS}`, 'links');
  if (o.kind !== 'material' && rawLinks.length) return bad('content_invalid', 'only a material carries links', 'links');
  const links: ContentLink[] = [];
  for (const l of rawLinks) { const v = normalizeLink(l, hosts); if (!v.ok) return v; links.push(v.value); }
  const base = { kind: o.kind as ContentKind, title: o.title.trim(), body: o.body.replace(/\r\n?/g, '\n'), links };
  if (o.kind !== 'setting') { if (o.lesson !== undefined || o.base !== undefined) return bad('content_invalid', 'only a setting names a lesson version', 'lesson'); return { ok: true, value: base }; }
  // A setting is a REFERENCE: a frozen version of the course, or an explicit return to the token's own lesson. No values.
  if (o.base !== undefined) { if (o.base !== true || o.lesson !== undefined) return bad('content_invalid', 'a return is {base:true} and nothing else', 'base'); return { ok: true, value: { ...base, lesson: 'base' } }; }
  const l = o.lesson as Record<string, unknown> | null | undefined;
  if (!l || typeof l !== 'object' || Array.isArray(l) || exact(l, ['course_id', 'version', 'sha256']) || typeof l.course_id !== 'string' || !ID_RE.test(l.course_id) || typeof l.version !== 'string' || !VERSION_RE.test(l.version) || typeof l.sha256 !== 'string' || !SHA256_RE.test(l.sha256)) return bad('content_invalid', 'a setting names lesson{course_id,version,sha256} or base:true', 'lesson');
  return { ok: true, value: { ...base, lesson: { course_id: l.course_id, version: l.version, sha256: l.sha256 } } };
}

/** What is hashed is what a learner's device re-hashes: schema, kind, title, body, links — in this order, nothing else. */
export function contentCanonical(c: Content): string {
  const head = [CONTENT_SCHEMA, c.kind, c.title, c.body, c.links.map((l) => [l.label, l.url])];
  // A sixth element for a setting ONLY: the hash of a notice or material is byte-for-byte what it was before U3.
  return JSON.stringify(c.kind === 'setting' ? [...head, c.lesson === 'base' ? ['base'] : [c.lesson!.course_id, c.lesson!.version, c.lesson!.sha256]] : head);
}
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const contentHash = (c: Content) => sha256Hex(contentCanonical(c));

export interface ContentRequest { idempotency_key: string; content: Content; object_id: string | null; expected_latest_revision: number | null }
export function normalizeContentRequest(raw: unknown, hosts: readonly string[]): Verdict<ContentRequest> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('request_invalid', 'body must be an object');
  const o = raw as Record<string, unknown>, extra = exact(o, ['idempotency_key', 'kind', 'title', 'body', 'links', 'lesson', 'base', 'object_id', 'expected_latest_revision']);
  if (extra) return bad('unknown_field', `unknown field '${extra.slice(0, 40)}'`);
  if (typeof o.idempotency_key !== 'string' || !KEY_RE.test(o.idempotency_key)) return bad('request_invalid', 'idempotency_key');
  const c = normalizeContent({ kind: o.kind, title: o.title, body: o.body, links: o.links, ...(o.lesson !== undefined ? { lesson: o.lesson } : {}), ...(o.base !== undefined ? { base: o.base } : {}) }, hosts); if (!c.ok) return c;
  if (o.object_id === undefined) { if (o.expected_latest_revision !== undefined) return bad('request_invalid', 'expected_latest_revision belongs to a revision of an existing object'); return { ok: true, value: { idempotency_key: o.idempotency_key, content: c.value, object_id: null, expected_latest_revision: null } }; }
  if (typeof o.object_id !== 'string' || !KEY_RE.test(o.object_id)) return bad('request_invalid', 'object_id');
  if (!Number.isSafeInteger(o.expected_latest_revision) || (o.expected_latest_revision as number) < 1) return bad('request_invalid', 'a new revision names the latest revision it was written against');
  return { ok: true, value: { idempotency_key: o.idempotency_key, content: c.value, object_id: o.object_id, expected_latest_revision: o.expected_latest_revision as number } };
}

export interface DistributionRequest { idempotency_key: string; object_id: string; revision: number; content_hash: string; targets: string[]; roster_revision: number; expires_at: number | null; dry_run: boolean }
/** Refused, never widened: an empty, misspelt or malformed selection is an error — there is no way to say "everybody" here. */
export function normalizeDistributionRequest(raw: unknown, maxSeats: number): Verdict<DistributionRequest> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('request_invalid', 'body must be an object');
  const o = raw as Record<string, unknown>, extra = exact(o, ['idempotency_key', 'object_id', 'revision', 'content_hash', 'targets', 'expected_roster_revision', 'expires', 'dry_run']);
  if (extra) return bad('unknown_field', `unknown field '${extra.slice(0, 40)}'; the selection is targets[]`);
  if (typeof o.idempotency_key !== 'string' || !KEY_RE.test(o.idempotency_key)) return bad('request_invalid', 'idempotency_key');
  if (typeof o.object_id !== 'string' || !KEY_RE.test(o.object_id) || !Number.isSafeInteger(o.revision) || (o.revision as number) < 1 || typeof o.content_hash !== 'string' || !SHA256_RE.test(o.content_hash)) return bad('request_invalid', 'object_id, revision and the content_hash that was reviewed');
  if (!Number.isSafeInteger(o.expected_roster_revision) || (o.expected_roster_revision as number) < 0) return bad('request_invalid', 'expected_roster_revision');
  if (o.dry_run !== undefined && typeof o.dry_run !== 'boolean') return bad('request_invalid', 'dry_run is a boolean');
  if (!Array.isArray(o.targets)) return bad('targets_invalid', 'targets[] names the selected seats');
  if (!o.targets.length) return bad('targets_empty', 'select at least one seat');
  if (o.targets.length > maxSeats) return bad('targets_invalid', `targets[] ≤ ${maxSeats}`);
  if (o.targets.some((t) => typeof t !== 'string' || !ID_RE.test(t))) return bad('targets_invalid', 'each target is a seat id');
  if (new Set(o.targets).size !== o.targets.length) return bad('targets_duplicate', 'a seat is named once');
  let expires: number | null = null;
  if (o.expires !== undefined) {
    const e = o.expires as Record<string, unknown> | null;
    if (!e || typeof e !== 'object' || Array.isArray(e) || exact(e, ['at']) || !Number.isSafeInteger(e.at) || (e.at as number) <= 0) return bad('request_invalid', 'expires is {at: unix ms}');
    expires = e.at as number;
  }
  return { ok: true, value: { idempotency_key: o.idempotency_key, object_id: o.object_id, revision: o.revision as number, content_hash: o.content_hash, targets: [...(o.targets as string[])].sort(), roster_revision: o.expected_roster_revision as number, expires_at: expires, dry_run: o.dry_run === true } };
}
/** The same idempotency key may only ever mean this exact request. `expires_at` is the RESOLVED instant, not the input. */
export const distributionRequestCanonical = (r: { object_id: string; revision: number; content_hash: string; targets: string[]; expires_at: number; roster_revision: number }) =>
  JSON.stringify([r.object_id, r.revision, r.content_hash, r.targets, r.expires_at, r.roster_revision]);

// ── delivery evidence ────────────────────────────────────────────────────────
/** Still deliverable. `received` is included: a device that took the bytes and died before committing is offered again. */
export const DIST_OPEN_STATES = ['accepted', 'offered', 'received'] as const;
export const DIST_FINAL_STATES = ['reflected', 'no_change', 'failed', 'unsupported', 'superseded', 'revoked', 'expired', 'unconfirmed', 'target_changed'] as const;
/** The only stages a device may report. Everything else is the Service's own knowledge. */
export const RECEIPT_STAGES = ['received', 'reflected', 'failed', 'superseded'] as const;
export const FAILURE_CODES = ['hash_mismatch', 'store_failed', 'inbox_full', 'schema', 'unsupported_kind', 'hash_conflict', 'apply_deadline', 'store_corrupt', 'journal_full'] as const;
export const SUPERSEDED_CODES = ['', 'newer_revision', 'withdrawn_newer'] as const;
export const WITHDRAW_RESULTS = ['withdrawn', 'not_held', 'stale'] as const;
/** A target counts towards keeping a card on a device while it is one of these (and its run is not revoked, its object not retired). */
export const DIST_EFFECTIVE_STATES = ['reflected', 'no_change', 'accepted', 'offered', 'received'] as const;
const isOpen = (s: string) => (DIST_OPEN_STATES as readonly string[]).includes(s);

/**
 * Forward only, within one device generation. `unconfirmed` (expired without a final receipt) is the one closed state a
 * late, truthful `reflected` may still move: what is on the device is a fact, whenever the Service hears of it.
 */
export function nextDistState(current: string, stage: string): { ok: true; state: string } | { ok: false; reason: 'final' | 'unknown_stage' | 'backwards' } {
  if (!(RECEIPT_STAGES as readonly string[]).includes(stage)) return { ok: false, reason: 'unknown_stage' };
  if (current === 'unconfirmed') return stage === 'reflected' ? { ok: true, state: 'reflected' } : { ok: false, reason: 'final' };
  if (!isOpen(current)) return { ok: false, reason: 'final' };
  if (stage === 'received') return current === 'received' ? { ok: false, reason: 'backwards' } : { ok: true, state: 'received' };
  return { ok: true, state: stage };
}

/** Re-offer spacing: 5 → 10 → 20 → 60 s for ten offers, then once every five minutes until the intent expires. */
export function offerDelayMs(offersSoFar: number): number {
  if (offersSoFar >= 10) return 300_000;
  return [5_000, 10_000, 20_000][offersSoFar - 1] ?? 60_000;
}

/**
 * How long the device may take to COMMIT an item, counted on its own monotonic clock from the moment it SENT the request
 * that fetched it. The Service measures what is left at a time that is never earlier than that send, so
 * `send + apply_within_ms` can never pass the true expiry; the request limit and a margin are taken off on top.
 * 0 means "do not offer": there is not enough of the intent left to apply it honestly.
 */
export function applyWithinMs(remainingMs: number): number {
  const left = Math.floor(remainingMs) - SYNC_TIMEOUT_MS - APPLY_MARGIN_MS;
  return left <= 0 ? 0 : Math.min(APPLY_WITHIN_MS, left);
}

/** Bound to the connection it was offered under: a changed grant, login generation or device makes a different key. */
export const offerKeyInput = (t: { distribution_id: string; seat_id: string; device_generation: number; grant_id: string; connection_epoch: number; object_id: string; revision: number; content_hash: string }) =>
  ['offer', t.distribution_id, t.seat_id, t.device_generation, t.grant_id, t.connection_epoch, t.object_id, t.revision, t.content_hash].join('|');
/** A different namespace on purpose: an acknowledgement of a withdrawal can never match an offer's journal entry, or the other way round. */
export const withdrawKeyInput = (c: { class_run_id: string; seat_id: string; student_id: string; object_id: string; withdraw_seq: number; grant_id: string; connection_epoch: number; device_registration_id: string }) =>
  ['withdraw', c.class_run_id, c.seat_id, c.student_id, c.object_id, c.withdraw_seq, c.grant_id, c.connection_epoch, c.device_registration_id].join('|');
export const deliveryKey = async (input: string) => (await sha256Hex(input)).slice(0, 32);

export interface OfferReceipt { offer_key: string; distribution_id: string; object_id: string; revision: number; content_hash: string; seq: number; stage: (typeof RECEIPT_STAGES)[number]; result_code: string; observed_at: number }
export function validateOfferReceipt(raw: unknown): Verdict<OfferReceipt> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('schema', 'receipt must be an object');
  const o = raw as Record<string, unknown>;
  if (exact(o, ['offer_key', 'distribution_id', 'object_id', 'revision', 'content_hash', 'seq', 'stage', 'result_code', 'observed_at'])) return bad('schema', 'unsupported receipt field');
  if (typeof o.offer_key !== 'string' || !OFFER_KEY_RE.test(o.offer_key) || typeof o.distribution_id !== 'string' || !KEY_RE.test(o.distribution_id) || typeof o.object_id !== 'string' || !KEY_RE.test(o.object_id)) return bad('schema', 'offer_key, distribution_id, object_id');
  if (!Number.isSafeInteger(o.revision) || !Number.isSafeInteger(o.seq) || !Number.isSafeInteger(o.observed_at) || typeof o.content_hash !== 'string' || !SHA256_RE.test(o.content_hash)) return bad('schema', 'revision, seq, observed_at, content_hash');
  if (!(RECEIPT_STAGES as readonly unknown[]).includes(o.stage)) return bad('schema', 'stage');
  const code = o.result_code === undefined ? '' : o.result_code;
  if (typeof code !== 'string') return bad('schema', 'result_code');
  if (o.stage === 'failed' ? !(FAILURE_CODES as readonly string[]).includes(code) : o.stage === 'superseded' ? !(SUPERSEDED_CODES as readonly string[]).includes(code) : code !== '') return bad('schema', 'result_code does not belong to this stage');
  return { ok: true, value: { offer_key: o.offer_key, distribution_id: o.distribution_id, object_id: o.object_id, revision: o.revision as number, content_hash: o.content_hash, seq: o.seq as number, stage: o.stage as OfferReceipt['stage'], result_code: code, observed_at: o.observed_at as number } };
}
export interface WithdrawReceipt { withdraw_key: string; object_id: string; seq: number; result: (typeof WITHDRAW_RESULTS)[number]; observed_at: number }
export function validateWithdrawReceipt(raw: unknown): Verdict<WithdrawReceipt> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('schema', 'receipt must be an object');
  const o = raw as Record<string, unknown>;
  if (exact(o, ['withdraw_key', 'object_id', 'seq', 'result', 'observed_at'])) return bad('schema', 'unsupported receipt field');
  if (typeof o.withdraw_key !== 'string' || !OFFER_KEY_RE.test(o.withdraw_key) || typeof o.object_id !== 'string' || !KEY_RE.test(o.object_id) || !Number.isSafeInteger(o.seq) || !Number.isSafeInteger(o.observed_at) || !(WITHDRAW_RESULTS as readonly unknown[]).includes(o.result)) return bad('schema', 'withdraw_key, object_id, seq, result, observed_at');
  return { ok: true, value: { withdraw_key: o.withdraw_key, object_id: o.object_id, seq: o.seq as number, result: o.result as WithdrawReceipt['result'], observed_at: o.observed_at as number } };
}

// ── what the instructor is told ──────────────────────────────────────────────
export const CARD_STATES = ['present', 'withdraw_pending', 'withdrawn', 'withdraw_unconfirmed', 'detached'] as const;
export interface CardFacts { state: string; revision: number; content_hash: string }
export interface TargetFacts { state: string; result_code: string; revision: number; content_hash: string; offers: number; distribution_revoked: boolean; connected: boolean }
export type CardView = 'none' | 'present' | 'replaced' | 'covered' | 'withdraw_pending' | 'withdrawn' | 'withdraw_unconfirmed' | 'detached';
/**
 * Two different facts, never merged into one "success": what this run of the distribution PROVED about delivery
 * (`phase`), and whether that material is on the learner's device NOW (`card`). Withdrawing changes the second and
 * leaves the first as the history it is.
 */
export function distStatus(t: TargetFacts, card: CardFacts | null, ctx: { new_request_allowed: boolean }): { phase: string; card: CardView; in_progress: boolean; can_change: boolean; reselectable: boolean } {
  const known = [...DIST_OPEN_STATES, ...DIST_FINAL_STATES] as readonly string[];
  if (!known.includes(t.state)) return { phase: 'unknown', card: 'none', in_progress: false, can_change: true, reselectable: false };
  const delivered = t.state === 'reflected' || t.state === 'no_change';
  // A run withdrawn while its recorded offer was in flight never proves delivery, yet the device may hold the material: the
  // Service tracks that card to take it down. The instructor is shown that withdrawal, not "nothing was ever there".
  const recalled = t.state === 'revoked' && t.offers > 0 && !!card && card.state !== 'present';
  let view: CardView = 'none';
  if (delivered || recalled || card?.state === 'detached') {
    if (!card) view = 'none';
    else if (card.state === 'detached') view = 'detached';
    else if (card.revision !== t.revision || card.content_hash !== t.content_hash) view = card.state === 'present' ? 'replaced' : 'none';
    else if (card.state === 'present') view = t.distribution_revoked ? 'covered' : 'present';
    else view = card.state as CardView;
  }
  const open = isOpen(t.state);
  const phase = t.state === 'accepted' ? (t.connected ? 'accepted' : 'accepted_offline') : t.state;
  const cardMoving = view === 'withdraw_pending';
  return {
    phase, card: view, in_progress: open && t.connected,
    can_change: open || t.state === 'unconfirmed' || cardMoving || (t.state === 'unsupported'),
    reselectable: ctx.new_request_allowed && ['failed', 'unconfirmed', 'expired', 'unsupported'].includes(t.state),
  };
}
/** `all_reflected` never rounds up: every target must have the material, and an open, failed or unknown one is not that. */
export function summarizeDistribution(rows: Array<{ phase: string; card: CardView; in_progress: boolean; can_change: boolean; reselectable: boolean }>) {
  const by: Record<string, number> = {}; for (const r of rows) by[r.phase] = (by[r.phase] ?? 0) + 1;
  const cards: Record<string, number> = {}; for (const r of rows) cards[r.card] = (cards[r.card] ?? 0) + 1;
  const reflected = rows.filter((r) => r.phase === 'reflected' || r.phase === 'no_change').length;
  return { total: rows.length, by_phase: by, by_card: cards, reflected, in_progress: rows.filter((r) => r.in_progress).length, may_change: rows.filter((r) => r.can_change).length, reselectable: rows.filter((r) => r.reselectable).length, all_reflected: rows.length > 0 && reflected === rows.length, settled: rows.every((r) => !r.can_change) };
}
