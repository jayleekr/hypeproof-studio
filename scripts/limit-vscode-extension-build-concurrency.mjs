#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const target = process.argv[2] || path.join('vscodium-base', 'vscode', 'build', 'lib', 'extensions.ts');
const limit = process.env.HPS_EXTENSION_BUNDLE_CONCURRENCY || '2';

if (!/^[1-9][0-9]*$/.test(limit)) {
  throw new Error(`HPS_EXTENSION_BUNDLE_CONCURRENCY must be a positive integer, got: ${limit}`);
}

let source = fs.readFileSync(target, 'utf8');

if (source.includes('function mergeExtensionStreamsWithConcurrency(')) {
  console.log(`Extension build concurrency patch already applied to ${target}`);
  process.exit(0);
}

const helperAnchor = 'function doPackageLocalExtensionsStream(forWeb: boolean, disableMangle: boolean, native: boolean): Stream {';
const helper = `function mergeExtensionStreamsWithConcurrency(streamFactories: (() => Stream)[]): Stream {
\tconst result = es.through();
\tconst concurrency = Math.max(1, Number(process.env['HPS_EXTENSION_BUNDLE_CONCURRENCY'] || '${limit}'));
\tlet index = 0;
\tlet active = 0;

\tfunction pump(): void {
\t\twhile (active < concurrency && index < streamFactories.length) {
\t\t\tconst stream = streamFactories[index++]();
\t\t\tactive++;
\t\t\tstream.on('error', err => result.emit('error', err));
\t\t\tstream.on('end', () => {
\t\t\t\tactive--;
\t\t\t\tif (index >= streamFactories.length && active === 0) {
\t\t\t\t\t(result as any).end();
\t\t\t\t} else {
\t\t\t\t\tpump();
\t\t\t\t}
\t\t\t});
\t\t\tstream.pipe(result as any, { end: false });
\t\t}
\t}

\tprocess.nextTick(pump);
\treturn result;
}

`;

if (!source.includes(helperAnchor)) {
  throw new Error(`Could not find helper insertion point in ${target}`);
}

source = source.replace(helperAnchor, helper + helperAnchor);

const oldBlock = `\tes.merge(
\t\t\t...localExtensionsDescriptions.map(extension => {
\t\t\t\treturn fromLocal(extension.path, forWeb, disableMangle)
\t\t\t\t\t.pipe(rename(p => p.dirname = \`extensions/\${extension.name}/\${p.dirname}\`));
\t\t\t})
\t\t)`;

const newBlock = `\tmergeExtensionStreamsWithConcurrency(
\t\t\tlocalExtensionsDescriptions.map(extension => () => {
\t\t\t\treturn fromLocal(extension.path, forWeb, disableMangle)
\t\t\t\t\t.pipe(rename(p => p.dirname = \`extensions/\${extension.name}/\${p.dirname}\`));
\t\t\t})
\t\t)`;

if (!source.includes(oldBlock)) {
  throw new Error(`Could not find extension stream merge block in ${target}`);
}

source = source.replace(oldBlock, newBlock);
fs.writeFileSync(target, source);
console.log(`Limited VS Code extension bundle concurrency to ${limit} in ${target}`);
