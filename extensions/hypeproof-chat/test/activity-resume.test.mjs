import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const bundle = await build({
  stdin: {
    contents: "export { shouldResumeActivity } from './src/extension.ts';",
    resolveDir: new URL('..', import.meta.url).pathname,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  write: false,
});
const mod = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, {
  module: mod, exports: mod.exports,
  require: id => id === 'vscode' ? {} : require(id),
  process, console, Buffer,
});
const { shouldResumeActivity } = mod.exports;

const ID = 'a'.repeat(64);
const NOW = Date.now;

// 1. 표시 없으면 false
assert.equal(shouldResumeActivity(undefined, ID), false, '표시 없는데 true');

// 2. 표시 있고 같은 id, 60초 이내 → true
assert.equal(shouldResumeActivity({ id: ID, at: Date.now() }, ID), true, '정상 케이스가 false');

// 3. id 다르면 false
assert.equal(shouldResumeActivity({ id: ID, at: Date.now() }, 'b'.repeat(64)), false, 'id 다른데 true');

// 4. 시간 지나면 false
const OLD = Date.now() - 61_000;
assert.equal(shouldResumeActivity({ id: ID, at: OLD }, ID), false, '60초 지났는데 true');

// 5. id 비어있으면 false (serverId undefined 포함)
assert.equal(shouldResumeActivity({ id: '', at: Date.now() }, ID), false, 'id 비었는데 true');
assert.equal(shouldResumeActivity({ id: ID, at: Date.now() }, undefined), false, 'serverId undefined인데 true');

console.log('PASS shouldResumeActivity: undefined/valid/wrong-id/expired/empty-id five cases');
