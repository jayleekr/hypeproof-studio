// #751 native help — the learner's help drafts and prepared/sending/unknown requests on this device. No `vscode` import: tests
// drive it against a real directory from one process or several (test/classroom-help-store.smoke.mjs).
//
// Why not globalState: VS Code keeps an extension's globalState as ONE object per window (extHostMemento `_value`), writes the
// whole object on every update (the window's storage flushes ~100 ms later) and replaces every other window's copy when that
// arrives. Two windows writing inside that delay erase each other's keys, whatever the key layout. So every record is its own
// family of files under the extension's globalStorageUri (shared by every window of the app, like the U2 inbox):
//
//   <root>/<d|e>/<sha256(key)[0:32]>/<n>.json   {v, key, value, at}; value null = removed (a tombstone, so a late writer
//                                               cannot bring it back). Version n+1 is CREATED (tmp → link), never
//                                               overwritten: link() fails if another window made n+1 first, and the loser
//                                               re-reads and re-decides — the same compare-and-swap as the U2 inbox index
//                                               (classroomInboxStore.ts). There is no lock to steal after a crash.
//
// Two windows writing different records never touch the same file. The same draft is last-write-wins; a request is
// compare-and-set inside `change`. A crash leaves the previous version or the new one, never half of one (a stray tmp file
// is swept). What this does NOT claim: durability across power loss (fsync is requested, best effort) and Windows link/rename
// under antivirus are NOT RUN.
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { LOCAL_RETENTION_MS, prune, type HelpDraft, type HelpEnvelope, type HelpStore } from "./classroomHelp.ts";

type Kinds = { draft: HelpDraft; envelope: HelpEnvelope };
export type HelpKind = keyof Kinds;
const DIR: Record<HelpKind, string> = { draft: "d", envelope: "e" };
const VERSION_RE = /^(\d{1,12})\.json$/;
const TMP_RE = /^\.\d+\..+\.tmp$/;
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
interface Rec<T> { v: 1; key: string; value: T | null; at: number }

export interface HelpStoreHooks {
  /** Test seam: called at each boundary of a commit so a test can pause, kill or race a writer exactly there. */
  at?(point: "tmp_written" | "linked", file: string): Promise<void> | void;
}
export class HelpCommitLost extends Error { constructor() { super("help record moved too many times"); } }
/** When a record was last touched by the learner — the same clock the 24-hour device retention has always used. */
const touched = (v: { updated_at?: number; prepared_at?: number }) => v.updated_at ?? v.prepared_at ?? 0;
const kept = (key: string, keep: string | null) => keep !== null && (key === keep || key.startsWith(keep + "|"));

export class HelpRecordStore {
  readonly root: string; private readonly hooks: HelpStoreHooks; private readonly now: () => number;
  constructor(root: string, hooks: HelpStoreHooks = {}, now: () => number = Date.now) { this.root = root; this.hooks = hooks; this.now = now; }
  private dirOf(kind: HelpKind, key: string) { return path.join(this.root, DIR[kind], sha(key)); }

  private async versions(dir: string): Promise<{ ns: number[]; tmps: string[] }> {
    let names: string[]; try { names = await fs.readdir(dir); } catch (e) { if (code(e) === "ENOENT") return { ns: [], tmps: [] }; throw e; }
    return { ns: names.map((f) => VERSION_RE.exec(f)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])).sort((a, b) => b - a), tmps: names.filter((f) => TMP_RE.test(f)) };
  }
  /**
   * The highest version that parses and belongs to `key` (null key = whatever the directory holds, for the sweep). `top` is
   * the highest number present at all, so the next version never collides with a torn or foreign file. A version removed
   * while it was being read (the sweep behind another writer) makes the whole read start again.
   */
  private async current<T>(dir: string, key: string | null): Promise<{ n: number; top: number; rec: Rec<T> | null }> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { ns } = await this.versions(dir); let gone = false;
      for (const n of ns) {
        let text: string; try { text = await fs.readFile(path.join(dir, `${n}.json`), "utf8"); } catch (e) { if (code(e) === "ENOENT") { gone = true; break; } continue; }
        try {
          const rec = JSON.parse(text) as Rec<T>;
          if (rec?.v === 1 && typeof rec.key === "string" && (key === null ? sha(rec.key) === path.basename(dir) : rec.key === key) && typeof rec.at === "number") return { n, top: ns[0], rec };
        } catch { /* torn or foreign: the one before */ }
      }
      if (!gone) return { n: 0, top: ns[0] ?? 0, rec: null };
    }
    throw new HelpCommitLost();
  }

  /** Atomic create-if-absent with the complete bytes in place: the name appears only when the content is whole. */
  private async writeOnce(target: string, text: string): Promise<"created" | "exists" | "retry"> {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = path.join(path.dirname(target), `.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
    try {
      let fh; try { fh = await fs.open(tmp, "wx", 0o600); } catch (e) { if (code(e) === "ENOENT") return "retry"; throw e; } // the sweep removed an empty directory
      try { await fh.writeFile(text, "utf8"); await fh.sync().catch(() => undefined); } finally { await fh.close(); }
      await this.hooks.at?.("tmp_written", path.basename(target));
      try { await fs.link(tmp, target); } catch (e) { if (code(e) === "EEXIST") return "exists"; if (code(e) === "ENOENT") return "retry"; throw e; }
      await this.hooks.at?.("linked", path.basename(target));
      return "created";
    } finally { await fs.unlink(tmp).catch(() => undefined); }
  }

  async get<K extends HelpKind>(kind: K, key: string): Promise<Kinds[K] | null> { return (await this.current<Kinds[K]>(this.dirOf(kind, key), key)).rec?.value ?? null; }

  /**
   * Compare-and-swap on one record. `change` sees the record as it is NOW every time it is called (`existed` = any version,
   * even a removal, was ever written) and returns the next value, null to remove, or undefined for "leave it". If another
   * window wrote first, `change` is decided again against what that window wrote.
   */
  async update<K extends HelpKind>(kind: K, key: string, change: (cur: Kinds[K] | null, existed: boolean) => Kinds[K] | null | undefined): Promise<{ value: Kinds[K] | null; changed: boolean }> {
    const dir = this.dirOf(kind, key);
    for (let attempt = 0; attempt < 40; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, Math.min(50, attempt * 2) * Math.random()));
      const cur = await this.current<Kinds[K]>(dir, key), was = cur.rec?.value ?? null, next = change(was, cur.n > 0);
      if (next === undefined || (next === null && was === null)) return { value: was, changed: false };
      const target = cur.top + 1, rec: Rec<Kinds[K]> = { v: 1, key, value: next, at: this.now() };
      if ((await this.writeOnce(path.join(dir, `${target}.json`), JSON.stringify(rec))) !== "created") continue;
      // A writer that woke up late may have created a number that is no longer the highest. Only the highest counts.
      const seen = await this.current(dir, key);
      if (seen.n === target) { await this.collect(dir, target); return { value: next, changed: true }; }
    }
    throw new HelpCommitLost();
  }

  /** Versions below the one that is current now are history nobody reads. Best effort: a racing writer's file is kept. */
  private async collect(dir: string, below: number, tmpOlderThan = 10 * 60_000): Promise<void> {
    const { ns, tmps } = await this.versions(dir).catch(() => ({ ns: [] as number[], tmps: [] as string[] }));
    for (const n of ns) if (n < below) await fs.unlink(path.join(dir, `${n}.json`)).catch(() => undefined);
    for (const t of tmps) { const f = path.join(dir, t); const st = await fs.stat(f).catch(() => null); if (st && this.now() - st.mtimeMs > tmpOlderThan) await fs.unlink(f).catch(() => undefined); }
  }

  /**
   * The 24-hour device retention (LOCAL_RETENTION_MS, unchanged): a draft or request the learner has not touched for that long
   * is removed through the same compare-and-swap (so one touched meanwhile in another window is kept), and a removal older than
   * that is deleted from disk. `keep` = the learner here now, whose own records are never swept. Returns how many were removed.
   */
  async sweep(keep: string | null, retentionMs = LOCAL_RETENTION_MS): Promise<number> {
    let removed = 0; const now = this.now();
    for (const kind of Object.keys(DIR) as HelpKind[]) {
      let dirs: string[]; try { dirs = await fs.readdir(path.join(this.root, DIR[kind])); } catch { continue; }
      for (const d of dirs) {
        if (!/^[a-f0-9]{32}$/.test(d)) continue;
        const dir = path.join(this.root, DIR[kind], d);
        try {
          const cur = await this.current<{ updated_at?: number; prepared_at?: number }>(dir, null);
          if (!cur.rec) { await this.collect(dir, cur.top + 1, 0); await fs.rmdir(dir).catch(() => undefined); continue; }
          const { key, value, at } = cur.rec;
          if (value !== null) {
            if (kept(key, keep) || now - touched(value) < retentionMs) { await this.collect(dir, cur.n); continue; }
            const r = await this.update(kind, key, (v) => (v && !kept(key, keep) && now - touched(v) >= retentionMs ? null : undefined));
            if (r.changed) removed++;
          } else if (now - at >= retentionMs) {
            // A removal this old has nothing left to protect; a writer that comes back makes a new first version.
            await this.collect(dir, cur.n + 1, 0); await fs.rmdir(dir).catch(() => undefined);
          } else await this.collect(dir, cur.n);
        } catch { /* one unreadable record never stops the sweep of the others */ }
      }
    }
    return removed;
  }

  /**
   * One-time move of the pre-2026-09-22 globalState store. Each record is created only if it was never written here (a
   * record already written, or removed, by any window wins), so running it again, from several windows, or after a partial
   * failure is safe. Records past the 24-hour retention are not brought over. Counts only — never content.
   */
  async importLegacy(legacy: HelpStore): Promise<{ imported: number; present: number; expired: number; failed: number }> {
    const fresh = prune(legacy, this.now(), null), out = { imported: 0, present: 0, expired: 0, failed: 0 };
    out.expired = Object.keys(legacy.drafts).length + Object.keys(legacy.envelopes).length - Object.keys(fresh.drafts).length - Object.keys(fresh.envelopes).length;
    const one = async <K extends HelpKind>(kind: K, key: string, value: Kinds[K]) => {
      try { const r = await this.update(kind, key, (_cur, existed) => (existed ? undefined : value)); r.changed ? out.imported++ : out.present++; } catch { out.failed++; }
    };
    for (const [k, v] of Object.entries(fresh.drafts)) await one("draft", k, v);
    for (const [k, v] of Object.entries(fresh.envelopes)) await one("envelope", k, v);
    return out;
  }
}
