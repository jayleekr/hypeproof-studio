// Remote classroom operations (#751, U2) — the learner's inbox on disk. No `vscode` import: tests run this against a real
// directory, from one process or several.
//
//   rev/<object>.<revision>.<hash16>.json   immutable. Written once (tmp → link); never overwritten, so an update that
//                                           dies half way cannot damage the revision the learner already had.
//   index.<n>.json                          the only thing that changes, and it changes by CREATING the next number.
//                                           `link()` fails if that number exists, so two windows (each its own extension
//                                           host) or a writer that was paused and woke up late can never overwrite a
//                                           newer index: the loser re-reads and re-decides. There is no lock file to steal.
//   quarantine/                             anything whose hash did not match. Never shown, never deleted here.
//
// The current index is the highest number that parses. "Reflected" is reported only after the committed index was read
// back through `read()` — the same path the cards are drawn from. What this does NOT claim: durability across power loss
// was not tested (fsync is requested, best effort), and Windows rename/link behaviour under antivirus is NOT RUN.
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  type ApplyWindow, type Clock, type InboxCard, type InboxIndex, type InboxItem, type InboxLink, type InboxView, type JournalEntry, type OfferAck, type WithdrawAck,
  applyOffer, applyWithdraw, contentCanonical, decideOffer, decideWithdraw, emptyIndex, journalAck, journalAdd, parseIndex, pendingReceipts, validateItem, validateWithdraw, withinApplyWindow,
} from "./classroomInbox.ts";

const INDEX_RE = /^index\.(\d{1,12})\.json$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const safeSegment = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128) || "_";
export const inboxDir = (root: string, o: { cohort: string; run: string; seat: string; student: string }) => path.join(root, "classroom-inbox", safeSegment(o.cohort), safeSegment(o.run), `${safeSegment(o.seat)}.${safeSegment(o.student)}`);

export interface StoreHooks {
  /** Test seam: called at each boundary of a commit so a test can pause, kill or race a writer exactly there. */
  at?(point: "rev_tmp_written" | "rev_linked" | "index_tmp_written" | "index_linked", detail: string): Promise<void> | void;
  /** Test seam for storage faults. Throwing here is a disk that refused the write. */
  fault?(op: "write" | "link", file: string): void;
}
export class InboxCommitLost extends Error { constructor() { super("inbox index moved too many times"); } }

export class InboxStore {
  private readonly dir: string; private readonly hooks: StoreHooks;
  constructor(dir: string, hooks: StoreHooks = {}) { this.dir = dir; this.hooks = hooks; }
  get directory() { return this.dir; }

  private async writeOnce(target: string, text: string): Promise<"created" | "exists"> {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      this.hooks.fault?.("write", target);
      const fh = await fs.open(tmp, "wx"); try { await fh.writeFile(text, "utf8"); await fh.sync().catch(() => undefined); } finally { await fh.close(); }
      await this.hooks.at?.(target.includes(`${path.sep}rev${path.sep}`) ? "rev_tmp_written" : "index_tmp_written", path.basename(target));
      this.hooks.fault?.("link", target);
      // Atomic create-if-absent with the full content in place: the name appears only when the bytes are complete.
      try { await fs.link(tmp, target); } catch (err) { if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists"; throw err; }
      return "created";
    } finally { await fs.unlink(tmp).catch(() => undefined); }
  }

  /** The highest index that parses. A torn or foreign file with a higher number is skipped, not trusted. */
  async current(): Promise<{ n: number; index: InboxIndex }> {
    let names: string[]; try { names = await fs.readdir(this.dir); } catch { return { n: 0, index: emptyIndex() }; }
    const ns = names.map((f) => INDEX_RE.exec(f)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])).sort((a, b) => b - a);
    for (const n of ns) { try { const index = parseIndex(await fs.readFile(path.join(this.dir, `index.${n}.json`), "utf8")); if (index) return { n, index }; } catch { /* unreadable: try the one before */ } }
    return { n: 0, index: emptyIndex() };
  }

  /**
   * Compare-and-swap on the index. `change` sees the CURRENT index every time it is called and returns the next one, or
   * null for "nothing to write". If another writer got there first the change is re-decided against what they wrote.
   */
  async commit<R>(change: (index: InboxIndex) => { next: InboxIndex | null; result: R }): Promise<{ result: R; n: number }> {
    // Losing the create-if-absent is normal under contention and costs one re-read. The pause grows a little and is
    // randomised so that several writers do not keep colliding in step; a writer that still cannot get in gives up loudly.
    for (let attempt = 0; attempt < 40; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, Math.min(50, attempt * 2) * Math.random()));
      const cur = await this.current(), { next, result } = change(cur.index);
      if (!next || next === cur.index) return { result, n: cur.n };
      const doc = { ...next, index_revision: cur.n + 1 };
      const made = await this.writeOnce(path.join(this.dir, `index.${cur.n + 1}.json`), JSON.stringify(doc));
      if (made === "created") {
        await this.hooks.at?.("index_linked", String(cur.n + 1));
        // A writer that woke up late may have created a number that is no longer the highest. Only the highest counts.
        const seen = await this.current(); if (seen.n === cur.n + 1) return { result, n: seen.n };
      }
    }
    throw new InboxCommitLost();
  }

  revFile = (item: { object_id: string; revision: number; content_hash: string }) => `${safeSegment(item.object_id)}.${item.revision}.${item.content_hash.slice(0, 16)}.json`;
  /** Writes the immutable revision file. An existing file with the same content is reused; a different one is a conflict. */
  async writeRevision(item: InboxItem): Promise<{ ok: true; file: string; bytes: number } | { ok: false; code: "hash_conflict" | "store_failed" }> {
    const file = this.revFile(item), target = path.join(this.dir, "rev", file);
    const text = JSON.stringify({ schema: item.schema, object_id: item.object_id, revision: item.revision, kind: item.kind, title: item.title, body: item.body, links: item.links, content_hash: item.content_hash });
    try {
      if (await this.writeOnce(target, text) === "exists") {
        const held = await this.readRevision(file, item.content_hash);
        if (!held) { await this.quarantine(target); return { ok: false, code: "hash_conflict" }; }
      }
      await this.hooks.at?.("rev_linked", file);
      return { ok: true, file, bytes: Buffer.byteLength(text) };
    } catch { return { ok: false, code: "store_failed" }; }
  }
  private async quarantine(file: string) { try { await fs.mkdir(path.join(this.dir, "quarantine"), { recursive: true }); await fs.rename(file, path.join(this.dir, "quarantine", `${path.basename(file)}.${Date.now()}`)); } catch { /* best effort */ } }

  /** Re-hashes what is on disk. Null = missing, torn or not the content the index promised. */
  async readRevision(file: string, expectedHash: string): Promise<{ kind: string; title: string; body: string; links: InboxLink[] } | null> {
    try {
      const v = JSON.parse(await fs.readFile(path.join(this.dir, "rev", file), "utf8"));
      const c = { kind: String(v.kind), title: String(v.title), body: String(v.body), links: Array.isArray(v.links) ? v.links.map((l: InboxLink) => ({ label: String(l.label), url: String(l.url) })) : [] };
      return sha256(contentCanonical(c)) === expectedHash ? c : null;
    } catch { return null; }
  }

  /** THE read path: the cards are drawn from this, and "reflected" is reported only after an item came back through it. */
  async read(): Promise<{ n: number; index: InboxIndex; cards: InboxCard[] }> {
    const { n, index } = await this.current(), cards: InboxCard[] = [];
    for (const e of Object.values(index.objects).sort((a, b) => b.received_at - a.received_at || b.seq - a.seq)) {
      if (e.tombstone) { cards.push({ object_id: e.object_id, kind: e.kind, title: "", body: "", links: [], revision: e.revision, received_at: e.tombstone.at, is_new: false, withdrawn: true, unreadable: false }); continue; }
      const c = await this.readRevision(e.file, e.content_hash);
      cards.push(c ? { object_id: e.object_id, kind: c.kind, title: c.title, body: c.body, links: c.links, revision: e.revision, received_at: e.received_at, is_new: !e.opened, withdrawn: false, unreadable: false }
        : { object_id: e.object_id, kind: e.kind, title: e.title, body: "", links: [], revision: e.revision, received_at: e.received_at, is_new: false, withdrawn: false, unreadable: true });
    }
    return { n, index, cards };
  }

  /**
   * After a restart. Files the index does not point at are NEVER promoted into it: they were fetched under a deadline that
   * died with the process, and the class may have ended or the material been withdrawn since. They are removed; if the
   * intent is still valid the Service offers it again. `olderThanMs` protects a file another window is committing right now.
   */
  async reconcile(now: number, olderThanMs = 120_000): Promise<{ removed: string[]; unreadable: string[] }> {
    const { n, index } = await this.current(), removed: string[] = [], unreadable: string[] = [];
    const keep = new Set(Object.values(index.objects).filter((e) => !e.tombstone).map((e) => e.file));
    const old = async (f: string) => { try { return now - (await fs.stat(f)).mtimeMs >= olderThanMs; } catch { return false; } };
    for (const sub of ["rev", "."]) {
      let names: string[] = []; try { names = await fs.readdir(path.join(this.dir, sub)); } catch { continue; }
      for (const name of names) {
        const full = path.join(this.dir, sub, name), m = INDEX_RE.exec(name);
        const stale = name.endsWith(".tmp") || (sub === "rev" && !keep.has(name)) || (sub === "." && !!m && Number(m[1]) < n - 1);
        if (stale && await old(full)) { await fs.unlink(full).catch(() => undefined); removed.push(name); }
      }
    }
    for (const e of Object.values(index.objects)) if (!e.tombstone && !(await this.readRevision(e.file, e.content_hash))) unreadable.push(e.object_id);
    return { removed, unreadable };
  }
}

// ── one connection's use of the inbox ────────────────────────────────────────
export interface InboxSessionDeps {
  store: InboxStore;
  /** False once the connection this session belongs to ended or changed. Checked after EVERY await: a late answer applies nothing. */
  alive(): boolean;
  clock: Clock;
  log?(line: string): void;
  /** Something the learner can see changed (a card appeared, was replaced or came down). */
  changed?(): void;
}
export interface DistributionBlockIn { items?: unknown[]; withdraw?: unknown[]; receipt_acks?: unknown[]; withdraw_acks?: unknown[]; more?: boolean }

/**
 * Applies what one /sync answer carried. Order inside an answer does not matter — every event is ordered by the number of
 * its object — so acknowledgements go first (they only shrink the journal), then withdrawals, then offers.
 */
export class InboxSession {
  private readonly d: InboxSessionDeps;
  /** One writer per object inside this process; other processes are handled by the index compare-and-swap. */
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(deps: InboxSessionDeps) { this.d = deps; }
  private serial<R>(objectId: string, fn: () => Promise<R>): Promise<R> {
    const run = (this.queues.get(objectId) ?? Promise.resolve()).then(fn, fn); this.queues.set(objectId, run.catch(() => undefined)); return run;
  }

  async pending(): Promise<{ receipts: unknown[]; withdraw_receipts: unknown[] } | undefined> {
    const p = pendingReceipts((await this.d.store.current()).index);
    return p.receipts.length || p.withdraw_receipts.length ? p : undefined;
  }

  /** Returns true when there is more to say right away (a receipt was journaled, or the Service said `more`). */
  async onBlock(block: DistributionBlockIn | undefined, window: ApplyWindow, serverTime: number): Promise<boolean> {
    if (!block || typeof block !== "object" || !this.d.alive()) return false;
    const offers = (Array.isArray(block.receipt_acks) ? block.receipt_acks : []) as OfferAck[], withdraws = (Array.isArray(block.withdraw_acks) ? block.withdraw_acks : []) as WithdrawAck[];
    // A disk that refuses the index right now refuses everything below too: nothing is applied, nothing is claimed, the
    // journal keeps what it had, and the Service offers again. The learner's chat never waits on any of this.
    if (offers.length || withdraws.length) { try { await this.d.store.commit((index) => ({ next: journalAck(index, offers, withdraws), result: null })); } catch (err) { this.d.log?.(`[inbox] acknowledgements not stored: ${(err as Error).message}`); return false; } if (!this.d.alive()) return false; }
    let journaled = false;
    for (const raw of Array.isArray(block.withdraw) ? block.withdraw.slice(0, 10) : []) { if (!this.d.alive()) return false; journaled = (await this.withdraw(raw, serverTime)) || journaled; }
    for (const raw of Array.isArray(block.items) ? block.items.slice(0, 2) : []) { if (!this.d.alive()) return false; journaled = (await this.offer(raw, window, serverTime)) || journaled; }
    return journaled || block.more === true;
  }

  /** False = the receipt could not be made durable (journal full, or the disk refused). The caller then claims nothing. */
  private async journal(entry: JournalEntry): Promise<boolean> {
    try { const { result } = await this.d.store.commit((index) => { const next = journalAdd(index, entry); return { next, result: next !== null }; }); return result; }
    catch (err) { this.d.log?.(`[inbox] receipt not stored: ${(err as Error).message}`); return false; }
  }

  private async withdraw(raw: unknown, serverTime: number): Promise<boolean> {
    const w = validateWithdraw(raw); if (!w) return false;
    return this.serial(w.object_id, async () => {
      if (!this.d.alive()) return false;
      let result: { decision: ReturnType<typeof decideWithdraw>; file?: string } | null;
      try { ({ result } = await this.d.store.commit((index) => {
        const decision = decideWithdraw(index, w), result = decision === "withdraw" || decision === "already" ? "withdrawn" as const : decision;
        const base = decision === "withdraw" || decision === "not_held" ? applyWithdraw(index, w, serverTime) : index;
        const next = journalAdd(base, { type: "withdraw", key: w.withdraw_key, object_id: w.object_id, seq: w.seq, result, observed_at: serverTime });
        return { next, result: next ? { decision, file: index.objects[w.object_id]?.file } : null };
      })); } catch (err) { this.d.log?.(`[inbox] withdrawal not stored: ${(err as Error).message}`); return false; } // not reported as withdrawn: it will be sent again
      if (!result) return false;
      if (result.decision === "withdraw") {
        // The body leaves the disk now, not at the next clean-up. Only this object's own revision file — nothing of the learner's.
        if (result.file && result.file !== "none") await fs.unlink(path.join(this.d.store.directory, "rev", result.file)).catch(() => undefined);
        this.d.changed?.();
      }
      return true;
    });
  }

  private async offer(raw: unknown, window: ApplyWindow, serverTime: number): Promise<boolean> {
    const v = validateItem(raw), key = (raw as { offer_key?: unknown })?.offer_key;
    const report = (item: Pick<InboxItem, "offer_key" | "distribution_id" | "object_id" | "revision" | "content_hash" | "seq">, stage: "received" | "failed" | "superseded", code = "") =>
      this.journal({ type: "offer", key: item.offer_key, stage, distribution_id: item.distribution_id, object_id: item.object_id, revision: item.revision, content_hash: item.content_hash, seq: item.seq, result_code: code, observed_at: serverTime });
    if (!v.ok) {
      // Reported only when the item is identifiable enough for the Service to match it; otherwise it is simply not taken.
      const o = raw as Record<string, any> | null;
      if (o && typeof key === "string" && /^[a-f0-9]{32}$/.test(key) && typeof o.distribution_id === "string" && typeof o.object_id === "string" && Number.isSafeInteger(o.revision) && Number.isSafeInteger(o.seq) && typeof o.content_hash === "string" && /^[a-f0-9]{64}$/.test(o.content_hash)) return report(o as InboxItem, "failed", v.code);
      return false;
    }
    const item = v.value;
    return this.serial(item.object_id, async () => {
      const within = () => this.d.alive() && withinApplyWindow(window, this.d.clock, item.apply_within_ms);
      // Too late, or the connection moved on: the attempt is dropped without a word. If the intent is still valid the
      // Service offers it again; if it is not, nothing new appears here. No receipt is a truthful "not applied".
      if (!within()) { this.d.log?.("[inbox] offer dropped: outside its apply window or connection ended"); return false; }
      if (sha256(contentCanonical(item)) !== item.content_hash) return report(item, "failed", "hash_mismatch");
      // No durable "received" = no further step. An item is never applied on a disk that cannot even record that it came.
      if (!(await report(item, "received"))) return false;
      if (!within()) return true;
      const before = decideOffer((await this.d.store.current()).index, item, 0);
      let file = "", bytes = 0;
      if (before.action === "apply") {
        const w = await this.d.store.writeRevision(item);
        if (!w.ok) return report(item, "failed", w.code);
        file = w.file; bytes = w.bytes;
        if (!within()) return true; // the revision file is unreferenced and harmless; reconcile removes it
      }
      let result: { decision: ReturnType<typeof decideOffer>; applied: boolean } | null;
      try {
        ({ result } = await this.d.store.commit((index) => {
          // Re-decided against whatever is current NOW: another window, or an older writer of this one, may have moved it.
          const decision = decideOffer(index, item, bytes), entry = (stage: "reflected" | "failed" | "superseded", code = ""): JournalEntry => ({ type: "offer", key: item.offer_key, stage, distribution_id: item.distribution_id, object_id: item.object_id, revision: item.revision, content_hash: item.content_hash, seq: item.seq, result_code: code, observed_at: serverTime });
          if (decision.action === "apply" && !file) return { next: null, result: null };                     // it became applicable only now: take it on the next offer
          if (decision.action === "apply" && !within()) return { next: null, result: null };
          const base = decision.action === "apply" || decision.action === "noop" ? applyOffer(index, item, decision.action === "apply" ? file : index.objects[item.object_id]!.file, decision.action === "apply" ? bytes : index.objects[item.object_id]!.bytes, serverTime) : index;
          const next = journalAdd(base, decision.action === "apply" || decision.action === "noop" ? entry("reflected") : decision.action === "superseded" ? entry("superseded", decision.code) : entry("failed", decision.code));
          return { next, result: next ? { decision, applied: decision.action === "apply" } : null };
        }));
      } catch (err) { this.d.log?.(`[inbox] index not committed: ${(err as Error).message}`); return report(item, "failed", "store_failed"); }
      if (!result) return true;
      if (result.decision.action === "apply" || result.decision.action === "noop") {
        // "Reflected" is only true if the item comes back through the path the cards are drawn from.
        const seen = (await this.d.store.read()).cards.find((c) => c.object_id === item.object_id);
        if (!seen || seen.unreadable || seen.withdrawn || seen.revision < item.revision) {
          await this.d.store.commit((index) => ({ next: { ...index, journal: index.journal.filter((j) => !(j.type === "offer" && j.key === item.offer_key && j.stage === "reflected")) }, result: null }));
          return report(item, "failed", "store_corrupt");
        }
        if (result.applied) this.d.changed?.();
      }
      return true;
    });
  }

  async markOpened(objectId: string): Promise<void> {
    await this.d.store.commit((index) => { const e = index.objects[objectId]; return { next: e && !e.tombstone && !e.opened ? { ...index, objects: { ...index.objects, [objectId]: { ...e, opened: true } } } : null, result: null }; });
  }
}
export async function inboxView(store: InboxStore, o: { run: string; student: string; generation: number; ended: boolean; offline?: boolean }): Promise<InboxView> {
  // A withdrawal marker is shown only for something the learner actually had (a tombstone kept only for ordering has seq 0).
  const { index, cards } = await store.read(), shown = cards.filter((c) => !c.withdrawn || (index.objects[c.object_id]?.seq ?? 0) > 0);
  return { run: o.run, student: o.student, generation: o.generation, ended: o.ended, offline: !o.ended && !!o.offline, cards: shown, unread: shown.filter((c) => c.is_new).length };
}
