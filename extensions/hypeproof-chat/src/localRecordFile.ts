import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { StoragePort } from '../../../worker/src/lib/measurement-core/local-record.ts';

/** The local record's directory under the extension's global storage: the local review
 * (localReviewPanel.ts) and CR-10's browser-result bytes (chatPanelProvider.ts) share it. */
export const LOCAL_RECORD_DIR = 'local-review-v1';

/** In-process writers of one directory, chained: two callers in the same extension host
 * (the local review and CR-10's browser-result bytes) wait for each other instead of the
 * second one failing `storage_busy` against its own pid. Other processes still fail closed,
 * and so does a call made from INSIDE a held lock (waiting there would deadlock). */
const chains = new Map<string, Promise<unknown>>();
const held = new AsyncLocalStorage<ReadonlySet<string>>();

/** Private flat namespace. Complete files are fsynced before atomic publication.
 * Interrupted temporary writes are never listed as records. No network or eviction. */
export class FileRecordStorage implements StoragePort {
  readonly root: string;
  private sizes: Map<string, number> | undefined;
  /** File name → its key and value length, valid while the file's size and mtime are
   * unchanged. A file name is the hash of its key, so a name never changes key; this only
   * spares re-reading every record (screenshots included) to rebuild the size map. */
  private readonly seen = new Map<string, { key: string; length: number; size: number; mtimeMs: number }>();
  constructor(root: string) { this.root = resolve(root); }
  async initialize() {
    if (this.sizes) return;
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const st = await fs.lstat(this.root);
    if (!st.isDirectory() || st.isSymbolicLink()) throw Error('unsafe_storage_directory');
    await fs.chmod(this.root, 0o700);
  }
  private file(key: string) {
    if (!key || key.length > 2000 || key.includes('\\') || key.split('/').some(p => !p || p === '.' || p === '..')) throw Error('invalid_storage_key');
    return join(this.root, createHash('sha256').update(key).digest('hex') + '.json');
  }
  private async readFile(file: string): Promise<{ key: string; value: string } | null> {
    let handle;
    try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    try {
      const data = JSON.parse(await handle.readFile('utf8'));
      if (typeof data.key !== 'string' || typeof data.value !== 'string' || this.file(data.key) !== file) throw Error('corrupt_record');
      return data;
    } finally { await handle.close(); }
  }
  async read(key: string) { await this.initialize(); return (await this.readFile(this.file(key)))?.value ?? null; }
  /** Every record's key and value length, re-reading only files that changed since last seen. */
  private async scan(): Promise<Map<string, number>> {
    await this.initialize();
    const out = new Map<string, number>();
    const names = new Set<string>();
    for (const name of await fs.readdir(this.root)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = join(this.root, name);
      let st;
      try { st = await fs.lstat(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
      names.add(name);
      const hit = this.seen.get(name);
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) { out.set(hit.key, hit.length); continue; }
      const entry = await this.readFile(file);
      if (!entry) continue;
      this.seen.set(name, { key: entry.key, length: entry.value.length, size: st.size, mtimeMs: st.mtimeMs });
      out.set(entry.key, entry.value.length);
    }
    for (const name of [...this.seen.keys()]) if (!names.has(name)) this.seen.delete(name);
    return out;
  }
  private async syncDirectory() {
    const dir = await fs.open(this.root, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
  async write(key: string, value: string, options: { ifAbsent?: boolean } = {}) {
    const target = this.file(key);
    await this.initialize();
    const temp = join(this.root, '.tmp-' + randomUUID());
    const file = await fs.open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ key, value }), 'utf8'); await file.sync(); }
    finally { await file.close(); }
    try {
      if (options.ifAbsent) await fs.link(temp, target);
      else await fs.rename(temp, target);
      await this.syncDirectory();
      this.sizes?.set(key, value.length);
      const st = await fs.lstat(target).catch(() => null);
      if (st) this.seen.set(basename(target), { key, length: value.length, size: st.size, mtimeMs: st.mtimeMs });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw Error('exists');
      throw e;
    } finally { await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async list(prefix: string) {
    const sizes = this.sizes ?? await this.scan();
    return [...sizes.keys()].filter(k => k.startsWith(prefix)).sort();
  }
  async remove(key: string) {
    await this.initialize();
    try { await fs.unlink(this.file(key)); this.seen.delete(basename(this.file(key))); await this.syncDirectory(); this.sizes?.delete(key); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  async usageBytes(): Promise<number> {
    return this.usageOf('');
  }
  async usageOf(prefix: string): Promise<number> {
    const sizes = this.sizes ?? await this.scan();
    let total = 0;
    for (const [key, n] of sizes) if (key.startsWith(prefix)) total += n;
    return total;
  }
  /** Fail closed on competing Studio windows. A crashed owner's lock can be recovered. */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const holding = held.getStore();
    if (holding?.has(this.root)) return this.locked(fn);
    const inLock = () => held.run(new Set([...(holding ?? []), this.root]), () => this.locked(fn));
    const prior = chains.get(this.root) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(inLock);
    const tail = run.catch(() => undefined);
    chains.set(this.root, tail);
    try { return await run; }
    finally { if (chains.get(this.root) === tail) chains.delete(this.root); }
  }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    await this.initialize();
    const lock = join(this.root, '.writer');
    // Publish the lock only after owner metadata exists. Atomic directory rename
    // also replaces an empty legacy lock left by a crash before its pid write.
    const candidate = join(this.root, '.writer-' + randomUUID());
    await fs.mkdir(candidate, { mode: 0o700 });
    try {
      await fs.writeFile(join(candidate, 'pid'), String(process.pid), { mode: 0o600 });
      await fs.rename(candidate, lock);
    }
    catch (e) {
      await fs.rm(candidate, { recursive: true, force: true });
      if (!['EEXIST', 'ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code || '')) throw e;
      const owner = Number(await fs.readFile(join(lock, 'pid'), 'utf8').catch(() => '0'));
      if (!Number.isSafeInteger(owner) || owner <= 0) throw Error('storage_busy');
      try { process.kill(owner, 0); throw Error('storage_busy'); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw Error('storage_busy'); }
      await fs.rm(lock, { recursive: true });
      return this.locked(fn);
    }
    try {
      this.sizes = await this.scan();
      return await fn();
    } finally { this.sizes = undefined; await fs.rm(lock, { recursive: true }); }
  }
}
