// D1 nightly backup → R2 (S-06 / #52).
//
// Cloudflare D1 has no native point-in-time backup as of 2026 (snapshot
// export requires the local `wrangler d1 export` CLI). For the dental teaser
// session and the SK kids workshop, we need the usage_log + trial trail to
// survive a configuration mistake, a quota wipe, or human error.
//
// Approach: every day at 02:00 KST (17:00 UTC), iterate the known tables,
// dump to newline-delimited JSON, gzip via Web Streams, upload to R2 under
// `backup/d1-YYYYMMDD.ndjson.gz`. Retain 14 days; delete older snapshots in
// the same cron pass (no R2 lifecycle policy required).
//
// Restore is intentionally manual: download the .gz, gunzip, replay via
// `wrangler d1 execute --command "..."`. Automating restore is too dangerous
// without a human review.

import type { Env } from "../env.ts";

const BACKUP_PREFIX = "backup/d1-";
const RETAIN_DAYS = 14;

// Order matters for forward-compatibility: keep this in sync with schema.sql.
// New tables ADDED here are written, but existing dumps still gunzip fine.
const TABLES = [
  "cohorts",
  "users",
  "sessions",
  "usage_log",
  "trials",
  "turns",
  "validations",
  "human_actions",
] as const;

export interface BackupResult {
  ok: boolean;
  ts: string;
  object_key?: string;
  tables: Record<string, { rows: number; bytes: number } | { error: string }>;
  total_rows: number;
  total_bytes: number;
  retain_deleted: string[];
  error?: string;
}

export async function runD1Backup(env: Env): Promise<BackupResult> {
  const ts = new Date().toISOString();
  const dateStr = ts.slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const result: BackupResult = {
    ok: false,
    ts,
    tables: {},
    total_rows: 0,
    total_bytes: 0,
    retain_deleted: [],
  };

  // Build NDJSON: one JSON object per line, prefixed with a header line per
  // table for self-describing restore.
  const lines: string[] = [];
  lines.push(JSON.stringify({ __meta: true, ts, tables: TABLES }));

  for (const table of TABLES) {
    try {
      // SELECT * — D1 result rows are plain JS objects.
      const { results } = await env.HPS_DB.prepare(`SELECT * FROM ${table}`).all();
      const rows = results as Array<Record<string, unknown>>;
      let bytes = 0;
      for (const row of rows) {
        const ln = JSON.stringify({ __table: table, row });
        lines.push(ln);
        bytes += ln.length + 1; // +1 for "\n"
      }
      result.tables[table] = { rows: rows.length, bytes };
      result.total_rows += rows.length;
      result.total_bytes += bytes;
    } catch (err) {
      result.tables[table] = { error: (err as Error).message };
    }
  }

  const ndjson = lines.join("\n") + "\n";

  // Gzip via Web Streams API (available in Workers runtime).
  let gzippedSize = 0;
  let body: ReadableStream<Uint8Array>;
  try {
    const stream = new Response(ndjson).body;
    if (!stream) throw new Error("could not get readable stream from ndjson");
    // Tee so we can both measure and upload — R2.put accepts a stream.
    body = stream.pipeThrough(new CompressionStream("gzip"));
  } catch (err) {
    result.error = `compression: ${(err as Error).message}`;
    return result;
  }

  const objectKey = `${BACKUP_PREFIX}${dateStr}.ndjson.gz`;
  try {
    // Materialize to ArrayBuffer to get accurate size + idempotent upload.
    // For our scale (<10 MB even at full workshop volume) this is fine.
    const buf = await new Response(body).arrayBuffer();
    gzippedSize = buf.byteLength;
    await env.HPS_TRACES.put(objectKey, buf, {
      httpMetadata: { contentType: "application/x-ndjson+gzip" },
      customMetadata: {
        backup_ts: ts,
        total_rows: String(result.total_rows),
        total_bytes_uncompressed: String(result.total_bytes),
      },
    });
    result.object_key = objectKey;
    result.ok = true;
  } catch (err) {
    result.error = `upload: ${(err as Error).message}`;
    return result;
  }

  result.total_bytes = gzippedSize; // overwrite with compressed size (more useful)

  // Retention sweep: delete backup/d1-YYYYMMDD.* older than RETAIN_DAYS.
  // Calculate cutoff inline so a fixed test date works deterministically.
  try {
    const cutoff = new Date(Date.parse(ts) - RETAIN_DAYS * 24 * 60 * 60 * 1000);
    const cutoffStr = cutoff.toISOString().slice(0, 10).replace(/-/g, "");
    const listed = await env.HPS_TRACES.list({ prefix: BACKUP_PREFIX, limit: 1000 });
    for (const obj of listed.objects) {
      // Extract YYYYMMDD from key shape backup/d1-YYYYMMDD.ndjson.gz
      const m = obj.key.match(/d1-(\d{8})\./);
      if (!m) continue;
      if (m[1]! < cutoffStr) {
        await env.HPS_TRACES.delete(obj.key);
        result.retain_deleted.push(obj.key);
      }
    }
  } catch (err) {
    // Retention failure shouldn't fail the backup itself.
    console.error("d1-backup retention sweep failed:", err);
  }

  return result;
}
