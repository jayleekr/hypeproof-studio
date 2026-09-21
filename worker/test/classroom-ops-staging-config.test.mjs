// Remote classroom operations (#751) — the staging target must be its own. Controls for the checker itself:
// the committed placeholder pair is "not provisioned" (never "independent"), a filled pair of its own passes, and every
// way of leaning on production is refused.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { checkStaging, parseToml } from '../scripts/classroom-ops-staging-check.mjs';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const committed = { workerProd: read('worker/wrangler.toml'), workerStaging: read('worker/wrangler.staging.toml'), chalkProd: read('chalk/wrangler.toml'), chalkStaging: read('chalk/wrangler.staging.toml') };
const fill = (t) => t.replaceAll('REPLACE_WITH_STAGING_KV_ID', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').replaceAll('REPLACE_WITH_STAGING_D1_ID', '11111111-2222-4333-8444-555555555555').replaceAll('REPLACE_WITH_STAGING_CHALK_ORIGIN', 'https://hypeproof-chalk-staging.example.workers.dev').replaceAll('REPLACE_WITH_STAGING_SERVICE_ORIGIN', 'https://hypeproof-studio-api-staging.example.workers.dev');
const filled = { ...committed, workerStaging: fill(committed.workerStaging), chalkStaging: fill(committed.chalkStaging) };
const prodD1 = parseToml(committed.workerProd).d1_databases[0].database_id, prodKv = parseToml(committed.workerProd).kv_namespaces[0].id;

test('the committed staging pair cannot be deployed by accident and shares nothing with production', () => {
  const r = checkStaging(committed); assert.equal(r.status, 'not_provisioned'); assert.deepEqual(r.unsafe, []);
  assert.deepEqual(r.pending.sort(), ['chalk: REPLACE_WITH_STAGING_D1_ID', 'chalk: REPLACE_WITH_STAGING_KV_ID', 'chalk: REPLACE_WITH_STAGING_SERVICE_ORIGIN', 'worker: REPLACE_WITH_STAGING_CHALK_ORIGIN', 'worker: REPLACE_WITH_STAGING_D1_ID', 'worker: REPLACE_WITH_STAGING_KV_ID']);
});
test('positive control: a provisioned pair with its own resources is independent', () => { const r = checkStaging(filled); assert.equal(r.status, 'independent', JSON.stringify(r.unsafe)); });
test('negative controls: every way of leaning on production is unsafe, and unsafe wins over pending', () => {
  const bad = (edit, expected) => { const r = checkStaging(edit(structuredClone(filled))); assert.equal(r.status, 'unsafe'); assert.ok(r.unsafe.some((u) => u.includes(expected)), expected + ' ← ' + JSON.stringify(r.unsafe)); };
  bad((f) => ({ ...f, workerStaging: f.workerStaging.replace('11111111-2222-4333-8444-555555555555', prodD1) }), "PRODUCTION's");
  bad((f) => ({ ...f, chalkStaging: f.chalkStaging.replace('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', prodKv) }), "PRODUCTION's");
  bad((f) => ({ ...f, workerStaging: f.workerStaging.replace('bucket_name = "hps-traces-staging"', 'bucket_name = "hps-traces"') }), 'r2 hps-traces');
  bad((f) => ({ ...f, workerStaging: f.workerStaging.replace('workers_dev = true', 'routes = [{ pattern = "api.hypeproof-ai.xyz", custom_domain = true }]') }), 'routes');
  bad((f) => ({ ...f, workerStaging: f.workerStaging.replace('ENVIRONMENT = "staging"', 'ENVIRONMENT = "production"') }), 'ENVIRONMENT');
  bad((f) => ({ ...f, chalkStaging: f.chalkStaging.replace('https://hypeproof-studio-api-staging.example.workers.dev', 'https://api.hypeproof-ai.xyz') }), 'production host');
  bad((f) => ({ ...f, workerStaging: f.workerStaging.replace('name = "hypeproof-studio-api-staging"', 'name = "hypeproof-studio-api"') }), 'name must be its own');
  bad((f) => ({ ...f, chalkStaging: f.chalkStaging.replace('11111111-2222-4333-8444-555555555555', '99999999-2222-4333-8444-555555555555') }), 'disagree on d1');
  bad((f) => ({ ...f, workerStaging: f.workerStaging.replace(/\[\[r2_buckets\]\]\nbinding = "HPS_TRACES"\nbucket_name = "hps-traces-staging"\n/, '') }), 'must declare its own');
  assert.equal(checkStaging({ ...committed, workerStaging: committed.workerStaging.replace('REPLACE_WITH_STAGING_D1_ID', prodD1) }).status, 'unsafe', 'a half-filled file that names production is unsafe, not merely pending');
});
