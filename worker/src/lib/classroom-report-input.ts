// G3: read the immutable, verified snapshot pinned by a report job. Never merge
// restarted spools into a fabricated session or fall back to the latest upload.
import type { Env } from '../env';
import { snapshotKey, sha256Bytes, V3_FILE_RE } from './classroom-collect';
import type { ReportInput } from './classroom-report';

type InputJob = { cohort_id: string; class_run_id: string; student_id: string; batch_id: string; snapshot_revision: number; input_manifest_digest: string };
export async function reportInputFiles(env: Env, j: InputJob): Promise<Array<{ name: string; bytes: number; sha256: string }>> {
  const row = await env.HPS_DB.prepare("SELECT files_json FROM classroom_snapshots WHERE batch_id=? AND student_id=? AND revision=? AND manifest_digest=? AND state='sealed' AND integrity='verified'").bind(j.batch_id, j.student_id, j.snapshot_revision, j.input_manifest_digest).first<{ files_json: string }>();
  if (!row) throw Error('input_missing');
  const files = JSON.parse(row.files_json) as Array<{ name: string; bytes: number; sha256: string }>;
  if (!Array.isArray(files) || !files.length || files.some((f) => !['session.meta.json', 'events.jsonl'].includes(f.name) && !V3_FILE_RE.test(f.name))) throw Error('input_manifest_invalid');
  return files;
}
export async function readReportInput(env: Env, j: InputJob): Promise<ReportInput> {
  const files = await reportInputFiles(env, j);
  const read = async (name: string) => {
    const f = files.find((f) => f.name === name); if (!f) throw Error('input_missing');
    const o = await env.HPS_TRACES.get(snapshotKey(j.cohort_id, j.class_run_id, j.student_id, j.batch_id, j.snapshot_revision, name));
    if (!o) throw Error('input_missing'); const bytes = await o.arrayBuffer();
    if (bytes.byteLength !== f.bytes || await sha256Bytes(bytes) !== f.sha256) throw Error('input_hash_mismatch');
    return new TextDecoder().decode(bytes);
  };
  if (files.some((f) => f.name === 'events.jsonl')) return read('events.jsonl');
  const parts = files.filter((f) => /^p[1-8]\.meta\.json$/.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (!parts.length) throw Error('input_missing');
  const sessions = [];
  for (const p of parts) {
    const meta = JSON.parse(await read(p.name));
    if (typeof meta.session_id !== 'string' || meta.user?.u !== j.student_id || meta.user?.c !== j.cohort_id) throw Error('input_identity_mismatch');
    const name = p.name.replace('.meta.json', '.events.jsonl');
    sessions.push({ session_id: meta.session_id, part: Number(p.name[1]), text: files.some((f) => f.name === name) ? await read(name) : '' });
  }
  if (new Set(sessions.map((s) => s.session_id)).size !== sessions.length) throw Error('input_identity_mismatch');
  const binding = await env.HPS_DB.prepare('SELECT range_json FROM classroom_snapshot_bindings WHERE batch_id=? AND student_id=? AND revision=?').bind(j.batch_id, j.student_id, j.snapshot_revision).first<{ range_json: string }>();
  if (!binding) throw Error('input_missing');
  const range = JSON.parse(binding.range_json);
  return { sessions, omitted: range.omitted ?? { unreadable: 0, over_limit: 0 }, reasons: range.reasons ?? [] };
}
