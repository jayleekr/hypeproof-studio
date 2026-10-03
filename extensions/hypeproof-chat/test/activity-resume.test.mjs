import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const bundle = await build({
  stdin: {
    contents: "export { shouldResumeActivity, resolveActivateBranch } from './src/extension.ts';",
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
const { shouldResumeActivity, resolveActivateBranch } = mod.exports;

const ID = 'a'.repeat(64);

// === shouldResumeActivity ===

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

// === resolveActivateBranch ===

// issuer 없음, 플래그 없음 → "show"
assert.equal(resolveActivateBranch(undefined, undefined, ID), 'show', 'no issuer no resume → show');

// issuer 있음, 플래그 없음 → "skip" (#1298: 강사 PC 시작 페이지 건너뜀)
// 2-part token: base64url({"role":"issuer"}).sig — decodeTokenPayloadUnverified reads parts[0]
const ISSUER_JWT = 'eyJyb2xlIjogImlzc3VlciJ9.fakesig';
assert.equal(resolveActivateBranch(ISSUER_JWT, undefined, ID), 'skip', 'issuer + no resume → skip');

// issuer 있음 + 유효 플래그 → "resume" (학생이 이긴다, #1298 원칙)
assert.equal(
  resolveActivateBranch(ISSUER_JWT, { id: ID, at: Date.now() }, ID),
  'resume',
  'issuer + valid resume → resume (student wins)',
);

// 유효 플래그 + issuer 없음 → "resume"
assert.equal(
  resolveActivateBranch(undefined, { id: ID, at: Date.now() }, ID),
  'resume',
  'no issuer + valid resume → resume',
);

// 만료 플래그 + issuer 없음 → "show"
assert.equal(
  resolveActivateBranch(undefined, { id: ID, at: OLD }, ID),
  'show',
  'expired resume + no issuer → show',
);

// 만료 플래그 + issuer 있음 → "skip" (만료이므로 resume 아님)
assert.equal(
  resolveActivateBranch(ISSUER_JWT, { id: ID, at: OLD }, ID),
  'skip',
  'expired resume + issuer → skip',
);

console.log('PASS resolveActivateBranch: show/skip/resume/student-wins/expired six cases');
