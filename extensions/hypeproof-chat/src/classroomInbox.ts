// Remote classroom operations (#751, U2) — the learner's inbox of instructor notices and materials: pure rules.
// No `vscode`, no file system, no clock: the store (classroomInboxStore.ts) and the host pass everything in, and the tests
// load this file directly. Contract: docs/requirements/classroom-admin.md#remote-management-u2-20260921.
//
// What the rules protect: material the learner already has is never lost to an interrupted update; a late v1 never
// replaces v2; a withdrawal and an offer are ordered by the event number of their object, whichever arrives first; and
// nothing in here ever touches the learner's own files, conversation or input.

export const INBOX_SCHEMA = "hps-classroom-inbox/2";
export const CONTENT_SCHEMA = "hps-classroom-content/1";
export const INBOX_CAPABILITY = "distribution_inbox";
export const INBOX_KINDS = ["notice", "material"] as const;
export const MAX_INBOX_OBJECTS = 50;
export const MAX_INBOX_BYTES = 1024 * 1024;
export const MAX_JOURNAL = 200;
/** Same numbers as the Service (worker/src/lib/classroom-distribution.ts); a test compares the two files. */
export const MAX_TITLE_CHARS = 80, MAX_BODY_CHARS = 2000, MAX_BODY_BYTES = 8 * 1024, MAX_LINKS = 5, MAX_LINK_LABEL_CHARS = 60, MAX_LINK_URL_CHARS = 500, MAX_SYNC_RECEIPTS = 6, MAX_SYNC_WITHDRAWS = 10, APPLY_WITHIN_MS = 30_000;

const KEY_RE = /^[A-Za-z0-9-]{8,64}$/, SHA256_RE = /^[a-f0-9]{64}$/, DELIVERY_KEY_RE = /^[a-f0-9]{32}$/;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

export interface InboxLink { label: string; url: string }
export interface InboxItem { offer_key: string; distribution_id: string; seq: number; object_id: string; revision: number; kind: (typeof INBOX_KINDS)[number]; schema: string; title: string; body: string; links: InboxLink[]; content_hash: string; issued_at: number; expires_at: number; apply_within_ms: number }
export interface InboxWithdraw { withdraw_key: string; object_id: string; seq: number; revision: number; reason: string }
export type Verdict<T> = { ok: true; value: T } | { ok: false; code: "schema" | "unsupported_kind" };

/** https only, no credentials — checked again here, not trusted from the wire, and again at the moment a learner clicks. */
export function safeLink(url: unknown): url is string {
  if (typeof url !== "string" || url.length > MAX_LINK_URL_CHARS || /\s/.test(url) || CONTROL_RE.test(url)) return false;
  try { const u = new URL(url); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; }
}
export function validateItem(raw: unknown): Verdict<InboxItem> {
  const bad = (code: "schema" | "unsupported_kind" = "schema"): Verdict<never> => ({ ok: false, code });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad();
  const o = raw as Record<string, unknown>;
  if (typeof o.offer_key !== "string" || !DELIVERY_KEY_RE.test(o.offer_key) || typeof o.distribution_id !== "string" || !KEY_RE.test(o.distribution_id) || typeof o.object_id !== "string" || !KEY_RE.test(o.object_id)) return bad();
  if (!Number.isSafeInteger(o.seq) || (o.seq as number) < 1 || !Number.isSafeInteger(o.revision) || (o.revision as number) < 1 || typeof o.content_hash !== "string" || !SHA256_RE.test(o.content_hash)) return bad();
  // A kind this build does not know (U3: prompt, setting) is refused as such — never stored, never guessed at.
  if (o.schema !== CONTENT_SCHEMA || !(INBOX_KINDS as readonly unknown[]).includes(o.kind)) return bad("unsupported_kind");
  if (typeof o.title !== "string" || !o.title || [...o.title].length > MAX_TITLE_CHARS || CONTROL_RE.test(o.title)) return bad();
  if (typeof o.body !== "string" || !o.body || [...o.body].length > MAX_BODY_CHARS || new TextEncoder().encode(o.body).length > MAX_BODY_BYTES || CONTROL_RE.test(o.body)) return bad();
  const links = o.links === undefined ? [] : o.links;
  if (!Array.isArray(links) || links.length > MAX_LINKS) return bad();
  for (const l of links) if (!l || typeof l !== "object" || Object.keys(l).some((k) => k !== "label" && k !== "url") || typeof (l as InboxLink).label !== "string" || !(l as InboxLink).label || [...(l as InboxLink).label].length > MAX_LINK_LABEL_CHARS || CONTROL_RE.test((l as InboxLink).label) || !safeLink((l as InboxLink).url)) return bad();
  if (!Number.isSafeInteger(o.apply_within_ms) || (o.apply_within_ms as number) <= 0 || (o.apply_within_ms as number) > APPLY_WITHIN_MS) return bad();
  return { ok: true, value: { offer_key: o.offer_key, distribution_id: o.distribution_id, seq: o.seq as number, object_id: o.object_id, revision: o.revision as number, kind: o.kind as InboxItem["kind"], schema: CONTENT_SCHEMA, title: o.title, body: o.body, links: (links as InboxLink[]).map((l) => ({ label: l.label, url: l.url })), content_hash: o.content_hash, issued_at: Number.isSafeInteger(o.issued_at) ? o.issued_at as number : 0, expires_at: Number.isSafeInteger(o.expires_at) ? o.expires_at as number : 0, apply_within_ms: o.apply_within_ms as number } };
}
export function validateWithdraw(raw: unknown): InboxWithdraw | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.withdraw_key !== "string" || !DELIVERY_KEY_RE.test(o.withdraw_key) || typeof o.object_id !== "string" || !KEY_RE.test(o.object_id) || !Number.isSafeInteger(o.seq) || (o.seq as number) < 1) return null;
  return { withdraw_key: o.withdraw_key, object_id: o.object_id, seq: o.seq as number, revision: Number.isSafeInteger(o.revision) ? o.revision as number : 0, reason: typeof o.reason === "string" && /^[a-z_]{1,32}$/.test(o.reason) ? o.reason : "revoked" };
}
/** Byte-for-byte what the Service hashed: schema, kind, title, body, links — nothing else, in this order. */
export const contentCanonical = (c: { kind: string; title: string; body: string; links: InboxLink[] }) => JSON.stringify([CONTENT_SCHEMA, c.kind, c.title, c.body, c.links.map((l) => [l.label, l.url])]);

// ── the index: the ONLY mutable document. It points at immutable revision files and carries the receipt journal. ──
export interface InboxSource { offer_key: string; distribution_id: string }
export interface InboxEntry { object_id: string; revision: number; content_hash: string; seq: number; file: string; bytes: number; kind: string; title: string; received_at: number; opened: boolean; sources: InboxSource[]; tombstone?: { seq: number; reason: string; at: number } }
export type JournalEntry =
  | { type: "offer"; key: string; stage: "received" | "reflected" | "failed" | "superseded"; distribution_id: string; object_id: string; revision: number; content_hash: string; seq: number; result_code: string; observed_at: number }
  | { type: "withdraw"; key: string; object_id: string; seq: number; result: "withdrawn" | "not_held" | "stale"; observed_at: number };
export interface InboxIndex { schema: typeof INBOX_SCHEMA; index_revision: number; objects: Record<string, InboxEntry>; journal: JournalEntry[] }
export const emptyIndex = (): InboxIndex => ({ schema: INBOX_SCHEMA, index_revision: 0, objects: {}, journal: [] });
export function parseIndex(text: string): InboxIndex | null {
  try {
    const v = JSON.parse(text);
    if (!v || v.schema !== INBOX_SCHEMA || !Number.isSafeInteger(v.index_revision) || !v.objects || typeof v.objects !== "object" || Array.isArray(v.objects) || !Array.isArray(v.journal)) return null;
    for (const e of Object.values(v.objects) as InboxEntry[]) if (!e || typeof e.object_id !== "string" || !Number.isSafeInteger(e.revision) || !Number.isSafeInteger(e.seq) || typeof e.file !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(e.file) || !Array.isArray(e.sources)) return null;
    return v as InboxIndex;
  } catch { return null; }
}
const lastSeq = (e: InboxEntry | undefined) => (e ? Math.max(e.seq, e.tombstone?.seq ?? 0) : 0);
const live = (e: InboxEntry | undefined) => !!e && !e.tombstone;

export type OfferDecision =
  | { action: "apply" }
  | { action: "noop" }                                                          // same revision and hash already held: report, write nothing
  | { action: "superseded"; code: "newer_revision" | "withdrawn_newer" }
  | { action: "failed"; code: "hash_conflict" | "inbox_full" };
/**
 * One rule orders everything: an event of an object is applied only when its number is HIGHER than the last one this
 * index applied for that object (an offer additionally never lowers the revision). A late v1 after v2, a late offer
 * after a withdrawal and a late withdrawal after a newer offer all fall out of that.
 */
export function decideOffer(index: InboxIndex, item: Pick<InboxItem, "object_id" | "revision" | "content_hash" | "seq">, addBytes: number): OfferDecision {
  const e = index.objects[item.object_id];
  if (e) {
    if (e.tombstone && item.seq <= e.tombstone.seq) return { action: "superseded", code: "withdrawn_newer" };
    if (live(e) && item.revision < e.revision) return { action: "superseded", code: "newer_revision" };
    if (live(e) && item.revision === e.revision) return item.content_hash === e.content_hash ? { action: "noop" } : { action: "failed", code: "hash_conflict" };
    if (live(e) && item.seq <= e.seq) return { action: "superseded", code: "newer_revision" };
  }
  const others = Object.values(index.objects).filter((x) => live(x) && x.object_id !== item.object_id);
  if (others.length >= MAX_INBOX_OBJECTS || others.reduce((n, x) => n + x.bytes, 0) + addBytes > MAX_INBOX_BYTES) return { action: "failed", code: "inbox_full" };
  return { action: "apply" };
}
export function applyOffer(index: InboxIndex, item: InboxItem, file: string, bytes: number, serverTime: number): InboxIndex {
  const prev = index.objects[item.object_id], same = prev && live(prev) && prev.revision === item.revision;
  const entry: InboxEntry = { object_id: item.object_id, revision: item.revision, content_hash: item.content_hash, seq: Math.max(item.seq, same ? prev!.seq : 0), file, bytes, kind: item.kind, title: item.title, received_at: same ? prev!.received_at : serverTime, opened: same ? prev!.opened : false, sources: [...(same ? prev!.sources.filter((s) => s.offer_key !== item.offer_key) : []), { offer_key: item.offer_key, distribution_id: item.distribution_id }].slice(-8) };
  return { ...index, objects: { ...index.objects, [item.object_id]: entry } };
}
export type WithdrawDecision = "withdraw" | "stale" | "not_held" | "already";
export function decideWithdraw(index: InboxIndex, w: InboxWithdraw): WithdrawDecision {
  const e = index.objects[w.object_id];
  if (!e) return "not_held";
  if (e.tombstone && e.tombstone.seq >= w.seq) return "already";
  return lastSeq(e) > w.seq ? "stale" : "withdraw";
}
/** The body file is dropped from the index; what stays is a marker — and the event number, so a late offer stays out. */
export function applyWithdraw(index: InboxIndex, w: InboxWithdraw, serverTime: number): InboxIndex {
  const e = index.objects[w.object_id];
  const entry: InboxEntry = e ? { ...e, title: "", bytes: 0, file: "none", content_hash: "", sources: [], tombstone: { seq: w.seq, reason: w.reason, at: serverTime } } : { object_id: w.object_id, revision: w.revision, content_hash: "", seq: 0, file: "none", bytes: 0, kind: "notice", title: "", received_at: serverTime, opened: true, sources: [], tombstone: { seq: w.seq, reason: w.reason, at: serverTime } };
  return { ...index, objects: { ...index.objects, [w.object_id]: entry } };
}

// ── journal: written BEFORE a receipt is sent, removed only by the acknowledgement of exactly that key and stage ──
const sameEntry = (a: JournalEntry, b: JournalEntry) => a.type === b.type && a.key === b.key && (a.type === "offer" ? a.stage === (b as typeof a).stage : true);
export function journalAdd(index: InboxIndex, entry: JournalEntry): InboxIndex | null {
  if (index.journal.some((j) => sameEntry(j, entry))) return index;
  if (index.journal.length >= MAX_JOURNAL) return null; // full: the caller takes no new item rather than lose a receipt
  return { ...index, journal: [...index.journal, entry] };
}
export interface OfferAck { offer_key: string; stage: string; recorded: boolean; reason: string; final?: boolean }
export interface WithdrawAck { withdraw_key: string; recorded: boolean; reason: string; final?: boolean }
/** An acknowledgement clears only the entry with ITS key (and stage). A refusal that is final clears it too; `storage` does not. */
export function journalAck(index: InboxIndex, offers: OfferAck[], withdraws: WithdrawAck[]): InboxIndex {
  const settled = (a: { recorded: boolean; final?: boolean }) => a.recorded === true || a.final !== false;
  const journal = index.journal.filter((j) => j.type === "offer"
    ? !offers.some((a) => a && a.offer_key === j.key && a.stage === j.stage && settled(a))
    : !withdraws.some((a) => a && a.withdraw_key === j.key && settled(a)));
  return journal.length === index.journal.length ? index : { ...index, journal };
}
export function pendingReceipts(index: InboxIndex): { receipts: unknown[]; withdraw_receipts: unknown[] } {
  const offers = index.journal.filter((j): j is Extract<JournalEntry, { type: "offer" }> => j.type === "offer").slice(0, MAX_SYNC_RECEIPTS);
  const withdraws = index.journal.filter((j): j is Extract<JournalEntry, { type: "withdraw" }> => j.type === "withdraw").slice(0, MAX_SYNC_WITHDRAWS);
  return {
    receipts: offers.map((j) => ({ offer_key: j.key, distribution_id: j.distribution_id, object_id: j.object_id, revision: j.revision, content_hash: j.content_hash, seq: j.seq, stage: j.stage, result_code: j.result_code, observed_at: j.observed_at })),
    withdraw_receipts: withdraws.map((j) => ({ withdraw_key: j.key, object_id: j.object_id, seq: j.seq, result: j.result, observed_at: j.observed_at })),
  };
}

// ── the apply deadline ───────────────────────────────────────────────────────
/**
 * A new application must COMMIT within `apply_within_ms` of the moment this device SENT the request that fetched the
 * item — not of the moment the answer arrived, so a slow answer buys no time. The Service computed that budget from
 * what was left of the intent at a time that is never earlier than the send, which is why no device wall clock is ever
 * compared with `expires_at`. Two elapsed-time readings are taken and the stricter one wins: the monotonic clock can
 * stand still while the machine sleeps, the wall clock can be set. A clock that ran backwards proves nothing, so it fails.
 * Nothing survives a restart: a deadline is held in memory only, so an item fetched before a restart is never applied after it.
 */
export interface Clock { mono(): number; wall(): number }
export interface ApplyWindow { monoStart: number; wallStart: number }
export function withinApplyWindow(w: ApplyWindow, clock: Clock, applyWithinMs: number): boolean {
  const mono = clock.mono() - w.monoStart, wall = clock.wall() - w.wallStart;
  return mono >= 0 && wall >= 0 && mono <= applyWithinMs && wall <= applyWithinMs;
}

// ── what the learner sees ────────────────────────────────────────────────────
export interface InboxCard { object_id: string; kind: string; title: string; body: string; links: InboxLink[]; revision: number; received_at: number; is_new: boolean; withdrawn: boolean; unreadable: boolean }
export interface InboxView { run: string; student: string; generation: number; ended: boolean; cards: InboxCard[]; unread: number }
export const emptyView = (generation = 0): InboxView => ({ run: "", student: "", generation, ended: false, cards: [], unread: 0 });
