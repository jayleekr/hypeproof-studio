// Controls for src/workspaceCheckpoint.ts (#673, AE-15 / WEB-05).
//
// config/requirement-work.json "recovery" names both controls, and they are
// the two directions that matter:
//
//   positive — "Read/Write/Edit/shell 뒤 지정 snapshot의 전체 파일 집합/해시 복원"
//   negative — "추적 밖 파일·삭제 파일·수동 편집을 누락하거나 외부 배포도
//              복구됐다고 표시하면 실패"
//
// The negative one is the expensive direction. A restore that silently misses a
// file, or a screen that reads as "everything is back", is worse than no restore
// at all: the child believes the work is recovered, keeps going, and overwrites
// what was actually still broken. So every case below that could pass by doing
// LESS work is asserted from the "did it actually change the disk" side, on a
// real temp filesystem — not against a model of one.
//
//   node --experimental-strip-types test/workspace-checkpoint.smoke.mjs

import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  captureCheckpoint, listCheckpoints, restoreCheckpoint, planRestore, scanWorkspace,
  checkpointId, checkpointLabel, restoreSummary, notCoveredNotice, isPreservedPath,
  pruneCheckpoints, WORLD_ARCHIVE_DIR_NAME, CHECKPOINT_LIMITS,
} from '../src/workspaceCheckpoint.ts';

const tmp = mkdtempSync(join(tmpdir(), 'hps-checkpoint-'));
const fresh = (name) => {
  const root = join(tmp, name, 'work');
  const store = join(tmp, name, 'store');
  mkdirSync(root, {recursive: true});
  mkdirSync(store, {recursive: true});
  return {root, store};
};
const write = (root, rel, body) => {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), {recursive: true});
  writeFileSync(abs, body);
};
const read = (root, rel) => readFileSync(join(root, ...rel.split('/')), 'utf8');
const has = (root, rel) => existsSync(join(root, ...rel.split('/')));

let failed = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { console.log(`  FAIL ${m}`); failed += 1; };
const check = (cond, m) => (cond ? ok(m) : bad(m));

try {

// ---------------------------------------------------------------------------
console.log('=== 1. positive control — the whole file set comes back, by hash ===');
// ---------------------------------------------------------------------------
// The #673 scenario, end to end: the coach edits in place, adds junk and
// deletes a file. One restore must undo all three.
{
  const {root, store} = fresh('positive');
  write(root, 'index.html', '<html><body>아이가 만든 세상</body></html>');
  write(root, 'engine.js', 'const S_PENG = 1;');
  write(root, 'assets/note.txt', '메모');

  const before = captureCheckpoint({root, store, reason: 'before_turn'});
  check(before.files.length === 3, `checkpoint holds every file (${before.files.length}, expected 3)`);
  check(before.skipped.length === 0, 'nothing was skipped in the ordinary case');

  // The coach breaks it: in-place Edit, a new file, and a shell `rm`.
  write(root, 'index.html', '<html><body>망가짐</body></html>');
  write(root, 'junk.tmp', 'coach scratch');
  rmSync(join(root, 'engine.js'));

  const r = restoreCheckpoint({root, store, id: before.id});
  check(r.ok === true, 'restore reports ok');
  check(read(root, 'index.html').includes('아이가 만든 세상'), 'MODIFIED file is back to its exact bytes');
  check(has(root, 'engine.js') && read(root, 'engine.js') === 'const S_PENG = 1;', 'DELETED file is restored');
  check(!has(root, 'junk.tmp'), 'ADDED file is removed');
  check(read(root, 'assets/note.txt') === '메모', 'untouched file in a subfolder survives');

  // Hash-level equality, not "looks right".
  const after = scanWorkspace(root);
  const sig = (s) => s.files.map((f) => `${f.path}:${f.sha256}`).sort().join('|');
  check(sig(after) === sig(before), 'the restored file set is hash-identical to the checkpoint');
}

// ---------------------------------------------------------------------------
console.log('');
console.log('=== 2. the restore is itself undoable (AE-15: 복구 직전 상태도 보존) ===');
// ---------------------------------------------------------------------------
// A recovery you cannot back out of is not a recovery; it is a second
// overwrite. "그거 말고 아까 거" has to have somewhere to go.
{
  const {root, store} = fresh('safety');
  write(root, 'index.html', 'v1');
  const first = captureCheckpoint({root, store, reason: 'before_turn'});
  write(root, 'index.html', 'v2-손으로-고친-것');

  const r = restoreCheckpoint({root, store, id: first.id});
  check(read(root, 'index.html') === 'v1', 'restored to v1');
  check(r.safety !== null, 'a pre-restore checkpoint was taken');

  const back = restoreCheckpoint({root, store, id: r.safety.id});
  check(back.ok && read(root, 'index.html') === 'v2-손으로-고친-것',
    'the manual edit that the restore overwrote can itself be recovered');
}

// ---------------------------------------------------------------------------
console.log('');
console.log('=== 3. manual edits are captured — the disk is the source, not the app ===');
// ---------------------------------------------------------------------------
// The child edits index.html by hand between turns. Nothing tells the app.
// The next capture must still hold it, or the "restore" hands back a file the
// child never had.
{
  const {root, store} = fresh('manual');
  write(root, 'index.html', 'coach wrote this');
  captureCheckpoint({root, store, reason: 'before_turn'});
  write(root, 'index.html', 'child edited this by hand');
  write(root, 'child-notes.md', '내가 쓴 메모');

  const second = captureCheckpoint({root, store, reason: 'before_turn'});
  const paths = second.files.map((f) => f.path).sort();
  check(paths.includes('child-notes.md'), 'a file the app never wrote is captured');
  const idx = second.files.find((f) => f.path === 'index.html');
  const expected = scanWorkspace(root).files.find((f) => f.path === 'index.html');
  check(idx.sha256 === expected.sha256, "the hand-edited content is what got captured, not the app's idea of it");
}

// ---------------------------------------------------------------------------
console.log('');
console.log('=== 4. NEGATIVE controls — the ways a restore lies ===');
// ---------------------------------------------------------------------------
{
  // 4a. A restore that only rewrites and never deletes leaves the coach's
  // junk behind. planRestore must name the deletions.
  const plan = planRestore(
    [{path: 'index.html', sha256: 'b', size: 1}, {path: 'junk.tmp', sha256: 'z', size: 1}],
    [{path: 'index.html', sha256: 'a', size: 1}],
  );
  check(plan.write.length === 1 && plan.delete.length === 1,
    'added files are planned for deletion, not silently left (rewrite-only would pass everything else)');
}
{
  // 4b. An unchanged file must NOT be counted as restored. Otherwise the
  // summary inflates and "12개 되돌림" means nothing.
  const same = [{path: 'a.txt', sha256: 'x', size: 1}];
  const plan = planRestore(same, same);
  check(plan.write.length === 0 && plan.unchanged === 1, 'identical files are counted as unchanged, not as work done');
}
{
  // 4c. Skipped files must survive into the message. A checkpoint that could
  // not hold a 20 MB asset must never be described as a full restore.
  const {root, store} = fresh('skipped');
  write(root, 'index.html', 'small');
  write(root, 'huge.bin', 'x'.repeat(4096));
  const m = captureCheckpoint({root, store, reason: 'before_turn', limits: {...CHECKPOINT_LIMITS, maxFileBytes: 100}});
  check(m.skipped.some((s) => s.path === 'huge.bin' && s.why === 'too_large'),
    'an oversized file is recorded as skipped, with the reason');
  check(!m.files.some((f) => f.path === 'huge.bin'), '…and is not claimed as captured');

  const line = restoreSummary({write: ['index.html'], delete: [], preserved: [], unchanged: 0}, m.skipped);
  check(/담기지 않았어요/.test(line), 'the summary says out loud that something was not captured');
}
{
  // 4d. External delivery is NOT recovered, and the copy has to say so. This
  // is the failure the work item calls out by name: a screen that reads as
  // "everything is back" while the published site still shows the broken page.
  const line = restoreSummary({write: ['index.html'], delete: [], preserved: [], unchanged: 0}, []);
  check(line.includes(notCoveredNotice()), 'every restore summary carries the not-covered sentence');
  check(/인터넷에 올린/.test(notCoveredNotice()), '…and that sentence actually names published copies');
  check(!/전부|모두 되돌/.test(line), 'the summary never claims a total rollback');
}
{
  // 4e. A symlink is not followed. Following one would let a restore write
  // outside the workspace, which is not a thing this feature may do.
  const {root, store} = fresh('symlink');
  const outside = join(tmp, 'symlink', 'outside');
  mkdirSync(outside, {recursive: true});
  writeFileSync(join(outside, 'secret.txt'), 'not ours');
  write(root, 'index.html', 'mine');
  try {
    symlinkSync(outside, join(root, 'link'));
    const m = captureCheckpoint({root, store, reason: 'before_turn'});
    check(!m.files.some((f) => f.path.startsWith('link')), 'a symlinked directory is not walked into');
    check(m.skipped.some((s) => s.path === 'link'), '…and the skip is recorded rather than silent');
  } catch (e) {
    if (e?.code === 'EPERM') ok('symlink case skipped (no permission on this host)');
    else throw e;
  }
}
{
  // 4f. Recovery must not eat recovery. `이전 세상/` is the OTHER backup
  // surface; restoring to a point before an archive existed must not delete
  // the archived world.
  const {root, store} = fresh('preserved');
  write(root, 'index.html', 'v1');
  const first = captureCheckpoint({root, store, reason: 'before_turn'});
  write(root, `${WORLD_ARCHIVE_DIR_NAME}/초코 세상.html`, '<html>보관본</html>');
  write(root, 'index.html', 'v2');

  const r = restoreCheckpoint({root, store, id: first.id});
  check(has(root, `${WORLD_ARCHIVE_DIR_NAME}/초코 세상.html`), 'an archived world is NOT deleted by a restore');
  check(r.plan.preserved.length === 1, '…and the plan reports what it deliberately left alone');
  check(/그대로 뒀어요/.test(r.message), '…and says so, instead of leaving the child to notice');
  check(isPreservedPath(`${WORLD_ARCHIVE_DIR_NAME}/x.html`) && !isPreservedPath('index.html'),
    'the preserve rule is scoped to the archive folder only');
}
{
  // 4g. An unknown id must fail loudly and change nothing. A "restore" that
  // silently no-ops while reporting success is the worst shape of all.
  const {root, store} = fresh('missing');
  write(root, 'index.html', 'v1');
  const r = restoreCheckpoint({root, store, id: 'nope-nope'});
  check(r.ok === false && /찾지 못했어요/.test(r.message), 'unknown checkpoint -> ok:false with a reason');
  check(read(root, 'index.html') === 'v1' && r.safety === null, '…and nothing on disk moved');
}

// ---------------------------------------------------------------------------
console.log('');
console.log('=== 5. housekeeping — it must not fill a child laptop ===');
// ---------------------------------------------------------------------------
{
  const {root, store} = fresh('dedupe');
  write(root, 'index.html', 'same bytes every turn');
  const a = captureCheckpoint({root, store, reason: 'before_turn'});
  const b = captureCheckpoint({root, store, reason: 'before_turn'});
  check(a.id !== b.id, 'two captures in the same run get distinct ids');
  const blobs = readdirSync(join(store, readdirSync(store)[0], 'blobs'));
  check(blobs.length === 1, `identical content is stored once, not per checkpoint (blobs=${blobs.length})`);
}
{
  const {root, store} = fresh('prune');
  for (let i = 0; i < 5; i++) {
    write(root, 'index.html', `v${i}`);
    captureCheckpoint({root, store, reason: 'before_turn'});
  }
  check(listCheckpoints(store, root).length === 5, 'all five are listed before pruning');
  pruneCheckpoints(store, root, 2);
  const kept = listCheckpoints(store, root);
  check(kept.length === 2, 'prune keeps the requested number');
  check(kept[0].createdAt >= kept[1].createdAt, '…the newest ones');
  const blobs = readdirSync(join(store, readdirSync(store)[0], 'blobs'));
  check(blobs.length === 2, `blobs no checkpoint references any more are collected (blobs=${blobs.length})`);
  // Positive control on the pruning: what survived must still restore.
  write(root, 'index.html', 'broken');
  const r = restoreCheckpoint({root, store, id: kept[kept.length - 1].id});
  check(r.ok && read(root, 'index.html') !== 'broken', 'a surviving checkpoint still restores after a prune');
}
{
  const {root, store} = fresh('excluded');
  write(root, 'index.html', 'mine');
  write(root, '.git/config', 'not the child\'s work');
  write(root, 'node_modules/pkg/index.js', 'vendor');
  const m = captureCheckpoint({root, store, reason: 'before_turn'});
  check(m.files.length === 1 && m.files[0].path === 'index.html',
    'tool/vendor directories are excluded from the checkpoint');
  // And excluded means excluded on the way back too: restoring must not
  // delete node_modules just because it is not in the manifest.
  const plan = planRestore(scanWorkspace(root).files, m.files);
  check(plan.delete.length === 0, 'excluded paths are invisible to the restore plan, so they are never deleted');
}

// ---------------------------------------------------------------------------
console.log('');
console.log('=== 6. labels and ids ===');
// ---------------------------------------------------------------------------
{
  const at = new Date('2026-08-22T14:47:00');
  check(checkpointId(at, () => 'abcdef') === '20260822-144700000-abcdef', 'id sorts lexicographically by time');
  check(/코치가 고치기 전/.test(checkpointLabel('before_turn', at)), 'turn label is in words a child can act on');
  check(/되돌리기 직전/.test(checkpointLabel('before_restore', at)), 'the safety point is labelled as such');
  const a = checkpointId(new Date('2026-08-22T14:47:00'));
  const b = checkpointId(new Date('2026-08-22T14:48:00'));
  check(a < b, 'later time sorts later');
}

} finally {
  rmSync(tmp, {recursive: true, force: true});
}

console.log('');
if (failed === 0) {
  console.log('PASS workspace-checkpoint: file sets restore by hash; a restore is undoable; what it cannot do, it says.');
} else {
  console.log(`FAIL: ${failed} check(s) failed.`);
  process.exit(1);
}
