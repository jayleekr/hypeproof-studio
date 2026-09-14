import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRecordStorage } from '../src/localRecordFile.ts';
const root = await mkdtemp(join(tmpdir(), 'hps-record-'));
try {
  const a = new FileRecordStorage(root);
  await a.write('tasks/one', '{"purpose":"real task"}', { ifAbsent: true });
  const reopened = new FileRecordStorage(root);
  assert.equal(await reopened.read('tasks/one'), '{"purpose":"real task"}');
  const race = await Promise.allSettled([a.write('receipts/one', 'first', {ifAbsent:true}), reopened.write('receipts/one', 'second', {ifAbsent:true})]);
  assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(race.find(r => r.status === 'rejected').reason.message, /exists/);
  await assert.rejects(a.write('../escape', 'no'), /invalid_storage_key/);
  assert.deepEqual(await a.list('tasks/'), ['tasks/one']);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  await reopened.remove('tasks/one');
  assert.equal(await a.read('tasks/one'), null);
  console.log('PASS file persistence, reopen, atomic create, private permissions and traversal denial');
} finally { await rm(root, {recursive:true, force:true}); }
