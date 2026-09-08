// Generate a pinned consumer copy. No network, deployment or participant data.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [target, sourceRef] = process.argv.slice(2);
if (!target || !sourceRef || !/^[0-9a-f]{40}$/.test(sourceRef)) throw new Error('Usage: node worker/scripts/export-trial.mjs TARGET_DIR SOURCE_COMMIT_SHA');
const output = resolve(target);
const paths = { 'evidence.ts': 'worker/src/lib/trial-evidence.ts', 'program.json': 'docs/curriculum/studio-trial/program.json', 'personas.json': 'docs/curriculum/studio-trial/personas.json' };
mkdirSync(output, { recursive: true });
const files = {};
for (const [name, source] of Object.entries(paths)) {
  const content = readFileSync(resolve(root, source));
  writeFileSync(resolve(output, name), content);
  files[name] = { source, sha256: createHash('sha256').update(content).digest('hex') };
}
writeFileSync(resolve(output, 'source.json'), JSON.stringify({ repository: 'jayleekr/hypeproof-studio', sourceRef, format: 'hps-trial/1', files }, null, 2) + '\n');
console.log('Exported 3 pinned trial files and source manifest. Consumer copies must not be edited.');
