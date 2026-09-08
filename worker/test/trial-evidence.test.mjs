import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateTrial, validateCurriculum, parseTrialShare } from '../src/lib/trial-evidence.ts';
const program = JSON.parse(readFileSync(new URL('../../docs/curriculum/studio-trial/program.json', import.meta.url)));
const personas = JSON.parse(readFileSync(new URL('../../docs/curriculum/studio-trial/personas.json', import.meta.url)));
const events = (choices, mode = 'initial') => choices.map((choice, i) => ({ form: program.forms[mode === 'transfer' ? 1 : 0].id, item: program.forms[mode === 'transfer' ? 1 : 0].items[i].id, choice, mode }));
const session = (ev = [], approach = 'direction') => ({ format: program.format, version: program.version, approach, events: ev });
const full = ['c','a','b','c','a','b','c'];
const transfer = ['b','c','a','a','c','b','c'];
test('curriculum has two complete forms and no choice-position shortcut', () => {
  validateCurriculum(program);
  assert.notDeepEqual(full, transfer);
  const damaged = structuredClone(program); damaged.forms[1].items[0].asset = 'INTENT';
  assert.throws(() => validateCurriculum(damaged), /invalid item/);
});
for (const p of personas) test(`${p.id}: ${p.name}`, () => {
  const ev = [...events(p.initial), ...events(p.coached ?? [], 'coached'), ...events(p.transfer ?? [], 'transfer')];
  const result = evaluateTrial(session(ev, p.approach), program);
  assert.deepEqual(result.assets.map(a => a.level), p.expectedLevels);
  assert.equal(result.level, p.expectedOverall);
  assert.equal(result.observed, p.expectedLevels.filter(v => v !== null).length);
  assert.ok(result.assets.every(a => a.level === null || a.level <= 3));
});
test('missing and adverse observations remain distinguishable', () => {
  const empty = evaluateTrial(session(), program);
  const bad = evaluateTrial(session(events(['b'])), program);
  assert.equal(empty.assets[0].status, 'unobserved');
  assert.equal(bad.assets[0].status, 'needs-evidence');
  assert.equal(empty.level, null); assert.equal(bad.level, null);
});
test('coaching is visible without increasing independent levels', () => {
  const ev = [...events(Array(7).fill('skip')), ...events(full, 'coached')];
  const r = evaluateTrial(session(ev), program);
  assert.ok(r.assets.every(a => a.level === null && a.coached.signal === 'full'));
});
test('new task failure is retained even after earlier success', () => {
  const r = evaluateTrial(session([...events(full), ...events(Array(7).fill('skip'), 'transfer')]), program);
  assert.equal(r.level, 2); assert.ok(r.assets.every(a => a.transfer.signal === 'unobserved'));
});
test('unknown, repeated, out-of-order and cross-version observations fail closed', () => {
  const valid = session(events(full));
  for (const mutate of [
    s => { s.version = 'old'; }, s => { s.approach = 'admin'; },
    s => { s.events[0].choice = '<script>'; }, s => { s.events[0].item = 'missing'; },
    s => { s.events.push(s.events[0]); }, s => { s.events[0].mode = 'transfer'; },
    s => { s.events = events(transfer, 'transfer'); },
    s => { s.events.push(...events(transfer,'transfer'), ...events(full,'coached')); },
    s => { s.events.push(...events(full,'coached'), { ...s.events[0], item: 'new' }); },
  ]) { const s = structuredClone(valid); mutate(s); assert.throws(() => evaluateTrial(s, program)); }
});
test('all 4 approaches have identical capability results for identical evidence', () => {
  const results = program.approaches.map(a => evaluateTrial(session(events(full), a.id), program));
  for (const r of results) assert.deepEqual(r.assets, results[0].assets);
});
test('sharing parses only an allowlisted public type, without arbitrary payloads', () => {
  assert.equal(parseTrialShare('#approach=direction', program), 'direction');
  for (const hash of ['#approach=admin','#approach=direction&answers=abc','#approach=%64irection', '#approach=' + 'a'.repeat(500), '#t=secret']) assert.equal(parseTrialShare(hash, program), null);
});
