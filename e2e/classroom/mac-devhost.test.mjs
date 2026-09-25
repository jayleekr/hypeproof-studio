import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { isolatedUserDataDir } from './mac-devhost.mjs';

test('deep checkouts get separate short runtime profiles that bind a Unix socket', { skip: process.platform === 'win32' }, async () => {
  const longHome = path.join('/tmp', 'hps-devhost-check-' + process.pid, 'deep-checkout-'.repeat(20));
  assert.ok(Buffer.byteLength(path.join(longHome, 'user-data', '0.1.-main.sock')) > 103);
  const userData = isolatedUserDataDir(longHome, '/tmp');
  assert.equal(userData, isolatedUserDataDir(longHome, '/tmp'));
  assert.notEqual(userData, isolatedUserDataDir(longHome + '-other', '/tmp'));
  mkdirSync(userData, { recursive: true });
  const server = createServer();
  try { server.listen(path.join(userData, '0.1.-main.sock')); await once(server, 'listening'); }
  finally { if (server.listening) await new Promise(r => server.close(r)); rmSync(userData, { recursive: true, force: true }); }
});
test('overlong temporary roots fail with a useful launch instruction', () => {
  assert.throws(() => isolatedUserDataDir('/tmp/a', '/tmp/' + 'long'.repeat(30)), /shorter TMPDIR/);
});
