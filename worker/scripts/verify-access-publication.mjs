// Read-only release preparation: verify the exact Lab source before approving a digest.
// No network, runtime activation, payment or source-file contents in output.
import '../test/harness/loader.mjs';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const {validateAccessPlan,accessDigest}=await import('../src/lib/access-contracts.ts');
const [artifact,labCheckout]=process.argv.slice(2);
if(!artifact||!labCheckout)throw Error('usage: node --experimental-strip-types scripts/verify-access-publication.mjs PLAN.json LAB_CHECKOUT');
const plan=validateAccessPlan(JSON.parse(readFileSync(artifact,'utf8')));
const source=execFileSync('git',['-C',labCheckout,'show',`${plan.source.commit}:${plan.source.path}`],{encoding:'utf8',maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
if(createHash('sha256').update(source).digest('hex')!==plan.source.content_sha256)throw Error('Lab source content hash mismatch');
const version=source.match(/export const PRICING_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];
if(version!==plan.source.pricing_version)throw Error('Lab pricing version mismatch');
console.log(JSON.stringify({revision:plan.revision,digest:await accessDigest(plan),source_verified:true,commercial_terms_review:'required',activated:false}));
