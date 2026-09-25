#!/usr/bin/env node
// Remote classroom operations (#751) — which of the additive migrations does a D1 database actually have?
//
// This repository applies migrations with `wrangler d1 execute --file` (deploy-worker.yml), not `wrangler d1 migrations`,
// so there is NO d1_migrations table to ask. The only truthful record of what was applied is the schema itself. This
// script reads it (SELECT on sqlite_master — it never writes) and compares it with what each migration file creates.
//
//   node scripts/classroom-ops-d1-check.mjs --database <name> --expect-id <uuid> [--env <env>] [--require all|none]
//   node scripts/classroom-ops-d1-check.mjs --from-json <wrangler --json output>       # offline / tests
//
// --database has no default on purpose: the operator names the target every time. --expect-id makes the script refuse
// when the name resolves to another database (wrong account, wrong environment).
// Exit: 0 report only / requirement met · 1 requirement not met or partially applied migration · 2 wrong target or usage.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
export const FIRST = 11;
/** migration file → the objects it creates (all of them are CREATE … IF NOT EXISTS; anything else would not be additive). */
export function expectedObjects(first = FIRST) {
  return readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f) && Number(f.slice(0, 4)) >= first).sort().map((file) => {
    const sql = readFileSync(path.join(dir, file), 'utf8').replace(/--.*$/gm, '');
    const other = sql.split(';').map((s) => s.trim()).filter((s) => s && !/^CREATE\s+(TABLE|(UNIQUE\s+)?INDEX)\s+IF\s+NOT\s+EXISTS\s/i.test(s));
    return { file, objects: [...sql.matchAll(/CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1]), not_additive: other.map((s) => s.slice(0, 60)) };
  });
}
export function compare(present, first = FIRST) {
  const have = new Set(present);
  const rows = expectedObjects(first).map((m) => { const missing = m.objects.filter((o) => !have.has(o)); return { file: m.file, state: !missing.length ? 'applied' : missing.length === m.objects.length ? 'not_applied' : 'partial', missing, not_additive: m.not_additive }; });
  // Additive files may be applied in any order and re-applied, but later ones assume earlier tables exist: a gap is reported.
  const firstMissing = rows.findIndex((r) => r.state !== 'applied'), gap = firstMissing >= 0 && rows.slice(firstMissing).some((r) => r.state === 'applied');
  return { rows, all: rows.every((r) => r.state === 'applied'), none: rows.every((r) => r.state === 'not_applied'), partial: rows.filter((r) => r.state === 'partial').map((r) => r.file), out_of_order: gap, next: rows.filter((r) => r.state !== 'applied').map((r) => r.file) };
}
const namesFrom = (jsonText) => { const parsed = JSON.parse(jsonText), results = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((r) => r.results ?? []); return results.map((r) => r.name).filter((n) => typeof n === 'string'); };

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const database = arg('--database'), env = arg('--env'), expectId = arg('--expect-id'), requirement = arg('--require'), fromJson = arg('--from-json');
  if ((!database && !fromJson) || (requirement && !['all', 'none'].includes(requirement)) || (database && !fromJson && !expectId)) { console.error('usage: --database <name> --expect-id <uuid> [--env <env>] [--require all|none]   |   --from-json <file> [--require all|none]'); process.exit(2); }
  let names;
  if (fromJson) names = namesFrom(readFileSync(fromJson, 'utf8'));
  else {
    const wrangler = (args) => execFileSync('npx', ['wrangler', ...args, ...(env ? ['--env', env] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    const info = JSON.parse(wrangler(['d1', 'info', database, '--json']));
    if (info.uuid !== expectId) { console.error(`REFUSED: "${database}" resolves to ${info.uuid}, not the expected ${expectId}. Wrong account or environment?`); process.exit(2); }
    names = namesFrom(wrangler(['d1', 'execute', database, '--remote', '--json', '--command', "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"]));
  }
  const r = compare(names);
  for (const row of r.rows) console.log(`${row.state.padEnd(12)} ${row.file}${row.missing.length && row.state === 'partial' ? '  missing: ' + row.missing.join(', ') : ''}${row.not_additive.length ? '  NOT ADDITIVE: ' + row.not_additive.join(' | ') : ''}`);
  console.log(JSON.stringify({ target: fromJson ? 'json' : { database, id: expectId, env: env ?? null }, all_applied: r.all, none_applied: r.none, partial: r.partial, out_of_order: r.out_of_order, apply_next_in_this_order: r.next }));
  const unmet = (requirement === 'all' && !r.all) || (requirement === 'none' && !r.none);
  process.exit(unmet || r.partial.length || r.out_of_order ? 1 : 0);
}
