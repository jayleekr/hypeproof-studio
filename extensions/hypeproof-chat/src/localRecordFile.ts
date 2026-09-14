import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { StoragePort } from '../../../worker/src/lib/measurement-core/local-record.ts';

/** Private flat namespace. Complete files are fsynced before atomic publication.
 * Interrupted temporary writes are never listed as records. No network or eviction. */
export class FileRecordStorage implements StoragePort {
  readonly root: string;
  private sizes: Map<string, number> | undefined;
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
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw Error('exists');
      throw e;
    } finally { await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async list(prefix: string) {
    if (this.sizes) return [...this.sizes.keys()].filter(k => k.startsWith(prefix)).sort();
    await this.initialize();
    const keys: string[] = [];
    for (const name of await fs.readdir(this.root)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const entry = await this.readFile(join(this.root, name));
      if (entry?.key.startsWith(prefix)) keys.push(entry.key);
    }
    return keys.sort();
  }
  async remove(key: string) {
    await this.initialize();
    try { await fs.unlink(this.file(key)); await this.syncDirectory(); this.sizes?.delete(key); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  async usageBytes(): Promise<number> {
    if (this.sizes) return [...this.sizes.values()].reduce((sum, n) => sum + n, 0);
    let total = 0;
    for (const key of await this.list('')) total += (await this.read(key))?.length || 0;
    return total;
  }
  /** Fail closed on competing Studio windows. A crashed owner's lock can be recovered. */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.initialize();
    const lock = join(this.root, '.writer');
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const owner = Number(await fs.readFile(join(lock, 'pid'), 'utf8').catch(() => '0'));
      if (!Number.isSafeInteger(owner) || owner <= 0) throw Error('storage_busy');
      try { process.kill(owner, 0); throw Error('storage_busy'); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw Error('storage_busy'); }
      await fs.rm(lock, { recursive: true });
      return this.exclusive(fn);
    }
    try {
      await fs.writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
      const sizes = new Map<string, number>();
      for (const key of await this.list('')) sizes.set(key, (await this.read(key))?.length || 0);
      this.sizes = sizes;
      return await fn();
    } finally { this.sizes = undefined; await fs.rm(lock, { recursive: true }); }
  }
}
