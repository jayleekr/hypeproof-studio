import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ReviewHost } from './localReviewProtocol.ts';

export interface LocalSession { path: string; host: ReviewHost; session: string; modified: number; bytes: number }
/** On-demand metadata discovery, scoped to one project. No transcript text is returned. */
export async function recentLocalSessions(home: string, project: string, now = Date.now(), options: { all?: boolean } = {}): Promise<LocalSession[]> {
  const candidates: Array<{ path: string; host: ReviewHost }> = [];
  const list = async (dir: string, host: ReviewHost) => {
    try {
      if ((await fs.lstat(dir)).isSymbolicLink()) return;
      for (const entry of await fs.readdir(dir, { withFileTypes: true }))
        if (entry.isFile() && entry.name.endsWith('.jsonl')) candidates.push({ path: join(dir, entry.name), host });
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  };
  await list(join(home, '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-')), 'claude-code');
  for (let day = 0; day < 7; day++) {
    const date = new Date(now - day * 86400000);
    await list(join(home, '.codex', 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')), 'codex');
  }
  if (options.all && candidates.length > 1000) throw Error('session_discovery_limit');
  const found: LocalSession[] = [];
  for (const item of candidates.slice(-1000)) {
    const handle = await fs.open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) continue;
      const buffer = Buffer.alloc(Math.min(stat.size, 65536));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      let session = '', cwd = '';
      for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (item.host === 'codex' && row.type === 'session_meta') { session = row.payload?.id; cwd = row.payload?.cwd; break; }
        if (item.host === 'claude-code' && row.sessionId && row.cwd) { session = row.sessionId; cwd = row.cwd; break; }
      }
      if (typeof session === 'string' && session && typeof cwd === 'string' && resolve(cwd) === resolve(project)) found.push({ ...item, session, modified: stat.mtimeMs, bytes: stat.size });
    } finally { await handle.close(); }
  }
  const sorted = found.sort((a, b) => b.modified - a.modified);
  return options.all ? sorted : sorted.slice(0, 30);
}
