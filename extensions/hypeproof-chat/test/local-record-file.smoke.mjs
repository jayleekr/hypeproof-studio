import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
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
  await a.exclusive(async () => {
    const baseline = await a.usageBytes();
    await a.write('usage/test', 'abc'); assert.equal(await a.usageBytes(), baseline + 3);
    await a.write('usage/test', 'x'); assert.equal(await a.usageBytes(), baseline + 1);
    assert.deepEqual(await a.list('usage/'), ['usage/test']);
    await a.remove('usage/test'); assert.equal(await a.usageBytes(), baseline);
    await a.write('probe/readback', 'original');
    const file = join(root, createHash('sha256').update('probe/readback').digest('hex') + '.json');
    await writeFile(file, JSON.stringify({key:'probe/readback',value:'tampered'}));
    assert.equal(await a.read('probe/readback'), 'tampered', 'Receipt reads always see disk, even inside the writer lock');
  });
  assert.equal(await a.usageBytes(), (await a.read('receipts/one')).length + 'tampered'.length);
  // usageOf counts one prefix only (CR-10: browser-result bytes have their own bound).
  await a.write('blobs/x', '12345');
  assert.equal(await a.usageOf('blobs/'), 5);
  assert.equal(await a.usageBytes(), (await a.read('receipts/one')).length + 'tampered'.length + 5);
  // Two writers of the same directory in ONE process (the local review and CR-10's bytes)
  // wait for each other instead of the second failing storage_busy against its own pid.
  const order = [];
  const slow = a.exclusive(async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 50)); order.push('a-end'); });
  const fast = reopened.exclusive(async () => { order.push('b'); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b'], 'serialized, never overlapping');
  // A failing writer does not wedge the next one.
  await assert.rejects(a.exclusive(async () => { throw Error('boom'); }), /boom/);
  assert.equal(await reopened.exclusive(async () => 'next'), 'next');
  console.log('PASS file persistence, reopen, atomic create, private permissions and traversal denial');
} finally { await rm(root, {recursive:true, force:true}); }
