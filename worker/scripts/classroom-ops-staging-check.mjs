#!/usr/bin/env node
// Remote classroom operations (#751) — is the staging target really its own?
//
// A staging rehearsal that writes into production's D1, KV or R2 is worse than no rehearsal. This script reads the four
// wrangler files (it runs no wrangler command and touches no account) and refuses the staging pair unless every
// resource is staging's own.
//
//   node scripts/classroom-ops-staging-check.mjs            # worker/ + chalk/ production and staging files
//   node scripts/classroom-ops-staging-check.mjs --json
//
// Exit: 0 independent and provisioned · 2 not provisioned yet (a REPLACE_ placeholder remains — nothing can be deployed
// from it) · 1 UNSAFE: something is shared with production, staging answers on a production host, or the two staging
// files disagree. Exit 1 always wins over exit 2.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The subset of TOML these files use: tables, arrays of tables, `key = "string" | true | [..]`. Inline tables stay raw text. */
export function parseToml(text) {
  const root = {}; let at = root;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim(); if (!line) continue;
    const arr = line.match(/^\[\[([^\]]+)\]\]$/), tab = line.match(/^\[([^\]]+)\]$/);
    if (arr) { (root[arr[1]] ??= []).push(at = {}); continue; }
    if (tab) { at = tab[1].split('.').reduce((o, k) => (o[k] ??= {}), root); continue; }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/); if (!kv) continue;
    const v = kv[2].trim(); at[kv[1]] = /^".*"$/.test(v) ? v.slice(1, -1) : v === 'true' ? true : v === 'false' ? false : v;
  }
  return root;
}
const resources = (c) => ({
  name: c.name, routes: c.routes ?? null, environment: c.vars?.ENVIRONMENT,
  d1: (c.d1_databases ?? []).map((d) => d.database_id), d1_names: (c.d1_databases ?? []).map((d) => d.database_name),
  kv: (c.kv_namespaces ?? []).flatMap((k) => [k.id, k.preview_id].filter(Boolean)), r2: (c.r2_buckets ?? []).map((b) => b.bucket_name),
  analytics: (c.analytics_engine_datasets ?? []).map((a) => a.dataset),
});
const PRODUCTION_HOSTS = /hypeproof-ai\.xyz/;

/** `files` = { workerProd, workerStaging, chalkProd, chalkStaging } as TOML text. */
export function checkStaging(files) {
  const wp = resources(parseToml(files.workerProd)), ws = resources(parseToml(files.workerStaging)), cp = resources(parseToml(files.chalkProd)), cs = resources(parseToml(files.chalkStaging));
  const wsRaw = parseToml(files.workerStaging), csRaw = parseToml(files.chalkStaging), unsafe = [], pending = [];
  const prod = { d1: new Set([...wp.d1, ...cp.d1]), d1_names: new Set([...wp.d1_names, ...cp.d1_names]), kv: new Set([...wp.kv, ...cp.kv]), r2: new Set([...wp.r2, ...cp.r2]), analytics: new Set(wp.analytics), names: new Set([wp.name, cp.name]) };
  for (const [label, s, raw] of [['worker', ws, wsRaw], ['chalk', cs, csRaw]]) {
    if (!s.name || prod.names.has(s.name) || !/-staging$/.test(s.name)) unsafe.push(`${label}: name must be its own and end with -staging (got ${s.name})`);
    if (s.routes) unsafe.push(`${label}: staging declares routes; it must be reachable on workers.dev only`);
    if (s.environment !== 'staging') unsafe.push(`${label}: vars.ENVIRONMENT must be "staging" (got ${s.environment})`);
    for (const kind of ['d1', 'd1_names', 'kv', 'r2', 'analytics']) for (const id of s[kind]) if (prod[kind].has(id)) unsafe.push(`${label}: ${kind} ${id} is PRODUCTION's`);
    if (!s.d1.length || !s.kv.length || !s.r2.length) unsafe.push(`${label}: staging must declare its own D1, KV and R2 (a missing binding is not inherited, and a copied one would be production's)`);
    for (const [k, v] of Object.entries(raw.vars ?? {})) if (typeof v === 'string' && PRODUCTION_HOSTS.test(v)) unsafe.push(`${label}: vars.${k} points at a production host (${v})`);
    const text = label === 'worker' ? files.workerStaging : files.chalkStaging;
    for (const m of text.replace(/^\s*#.*$/gm, '').matchAll(/"(REPLACE_[A-Z0-9_]+)"/g)) pending.push(`${label}: ${m[1]}`);
  }
  // Chalk reads the same ledgers the Service writes: the staging pair has to share staging's resources with each other.
  for (const kind of ['d1', 'kv', 'r2']) if (JSON.stringify([...ws[kind]].sort()) !== JSON.stringify([...cs[kind]].sort())) unsafe.push(`staging worker and chalk disagree on ${kind}: ${ws[kind]} vs ${cs[kind]}`);
  return { status: unsafe.length ? 'unsafe' : pending.length ? 'not_provisioned' : 'independent', unsafe, pending: [...new Set(pending)], staging: { worker: ws, chalk: cs } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'), read = (p) => readFileSync(path.join(root, p), 'utf8');
  const result = checkStaging({ workerProd: read('worker/wrangler.toml'), workerStaging: read('worker/wrangler.staging.toml'), chalkProd: read('chalk/wrangler.toml'), chalkStaging: read('chalk/wrangler.staging.toml') });
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else { console.log(`staging target: ${result.status}`); for (const u of result.unsafe) console.log('  UNSAFE  ' + u); for (const p of result.pending) console.log('  pending ' + p); if (result.status === 'independent') console.log('  every staging resource is its own; next: DEPLOY.md "Remote classroom operations" step 1'); }
  process.exit(result.status === 'unsafe' ? 1 : result.status === 'not_provisioned' ? 2 : 0);
}
