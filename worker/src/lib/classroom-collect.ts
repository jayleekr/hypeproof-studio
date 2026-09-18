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
export const ITEM_STATES = ['consent_missing', 'guardian_consent_missing', 'withdrawn', 'not_connected', 'requested', 'uploading', 'verified', 'incomplete', 'quarantined'] as const;

export interface ManifestFile { name: string; bytes: number; sha256: string }
export interface SnapshotManifest { schema: string; files: ManifestFile[] }
export type Coverage = 'complete' | 'gaps' | 'sequence_unavailable';

export function validateManifest(m: unknown): { ok: true; value: SnapshotManifest } | { ok: false; error: string } {
  if (!m || typeof m !== 'object') return { ok: false, error: 'manifest must be an object' };
  const o = m as Record<string, unknown>;
  if (o.schema !== SNAPSHOT_SCHEMA || !Array.isArray(o.files) || !o.files.length || o.files.length > Object.keys(SNAPSHOT_FILES).length) return { ok: false, error: 'schema and files[] required' };
  const seen = new Set<string>();
  for (const f of o.files as Array<Record<string, unknown>>) {
    if (!f || typeof f.name !== 'string' || !(f.name in SNAPSHOT_FILES) || seen.has(f.name) || !Number.isSafeInteger(f.bytes) || typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)) return { ok: false, error: 'each file needs an allowed name, bytes and sha256' };
    seen.add(f.name);
  }
  if (!seen.has('events.jsonl')) return { ok: false, error: 'events.jsonl is required' };
  return { ok: true, value: { schema: SNAPSHOT_SCHEMA, files: o.files as ManifestFile[] } };
}

/**
 * Behavioural coverage is a separate answer from byte integrity. A legacy spool has
 * no seq: that is reported as `sequence_unavailable`, never invented and never "complete".
 * Also rejects a line that names another owner — one learner's file must not carry another's events.
 */
export function eventCoverage(jsonl: string, owner: { student: string }): { coverage: Coverage; lines: number; foreign: boolean } {
  const seqs: number[] = []; let lines = 0, foreign = false, unsequenced = 0;
  for (const raw of jsonl.split('\n')) {
    if (!raw.trim()) continue; lines++;
    let e: Record<string, unknown>; try { e = JSON.parse(raw); } catch { continue; }
    const who = e.user ?? e.u ?? e.student_id;
    if (typeof who === 'string' && who !== owner.student) foreign = true;
    if (Number.isSafeInteger(e.seq)) seqs.push(e.seq as number); else unsequenced++;
  }
  if (!seqs.length || unsequenced) return { coverage: 'sequence_unavailable', lines, foreign };
  const sorted = [...seqs].sort((a, b) => a - b);
  const contiguous = sorted.every((s, i) => i === 0 || s === sorted[i - 1]! + 1) && new Set(sorted).size === sorted.length;
  return { coverage: contiguous ? 'complete' : 'gaps', lines, foreign };
}

export async function sha256Bytes(b: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export const snapshotKey = (cohort: string, run: string, student: string, batch: string, revision: number, file: string) => `classroom-snapshots/${cohort}/${run}/${student}/${batch}/r${revision}/${file}`;
