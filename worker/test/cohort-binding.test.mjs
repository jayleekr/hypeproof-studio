// #1006 IC-B — pure decision behind every participant-token cohort check.
// No I/O: legacy cohorts, class openings and each rejection reason.
import assert from 'node:assert/strict';
import './harness/loader.mjs';
const { decideCohort, isClassCohort } = await import('../src/lib/cohort-binding.ts');
const { listProfiles } = await import('../src/profiles/index.ts');

const NOW = 1_800_000_000_000;
const template = { id: 'tpl', session: { cohort_id: 'tpl-cohort' }, execution_template: true };
const legacy = { id: 'kids', session: { cohort_id: 'kids-cohort' } };
const binding = (over = {}) => ({ class_cohort: 'class-a', template_cohort: 'tpl-cohort', profile_id: 'tpl', course_id: 'course-a', version: 'm2026.09.14-1', starts_at: NOW - 1000, ends_at: NOW + 1000, revoked: 0, ...over });
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };

check('shipped registry has no compiled cohort in the class namespace', () => {
  assert.deepEqual(listProfiles().filter(p => isClassCohort(p.session.cohort_id)).map(p => p.id), []);
});
check('legacy: matching compiled cohort passes and keeps its own lesson cohort', () => {
  assert.deepEqual(decideCohort(legacy, { c: 'kids-cohort' }, null, NOW), { ok: true, lessonCohort: 'kids-cohort' });
});
check('legacy: any other cohort is a mismatch, and a stray binding is ignored', () => {
  assert.deepEqual(decideCohort(legacy, { c: 'other' }, binding(), NOW), { ok: false, reason: 'cohort_mismatch' });
});
const lessonA = { course_id: 'course-a', version: 'm2026.09.14-1' };
check('class: live opening on its reviewed template passes; lessons read from the template cohort', () => {
  assert.deepEqual(decideCohort(template, { c: 'class-a', lesson: lessonA }, binding(), NOW), { ok: true, lessonCohort: 'tpl-cohort' });
});
check('negative: class token without a lesson reference is refused (X2 on #1037)', () => {
  assert.equal(decideCohort(template, { c: 'class-a' }, binding(), NOW).reason, 'opening_lesson_required');
});
check('negative: unbound class cohort (no opening row)', () => {
  assert.equal(decideCohort(template, { c: 'class-a' }, null, NOW).reason, 'opening_missing');
  assert.equal(decideCohort(template, { c: 'class-a' }, binding({ class_cohort: 'class-b' }), NOW).reason, 'opening_missing');
});
check('negative: expired or not-yet-started opening', () => {
  assert.equal(decideCohort(template, { c: 'class-a' }, binding({ ends_at: NOW }), NOW).reason, 'opening_expired');
  assert.equal(decideCohort(template, { c: 'class-a' }, binding({ starts_at: NOW + 1 }), NOW).reason, 'opening_expired');
});
check('negative: token carries another opening\'s course', () => {
  assert.equal(decideCohort(template, { c: 'class-a', lesson: { course_id: 'course-b', version: 'm2026.09.14-1' } }, binding(), NOW).reason, 'opening_course_mismatch');
});
check('negative: token carries another frozen version of the same course (X2 P2 on #1037)', () => {
  const bound = binding();
  assert.deepEqual(decideCohort(template, { c: 'class-a', lesson: { course_id: 'course-a', version: bound.version } }, bound, NOW), { ok: true, lessonCohort: 'tpl-cohort' });
  assert.equal(decideCohort(template, { c: 'class-a', lesson: { course_id: 'course-a', version: 'm2026.09.14-2' } }, bound, NOW).reason, 'opening_version_mismatch');
});
check('negative: opening bound to a different profile or template cohort', () => {
  assert.equal(decideCohort(legacy, { c: 'class-a' }, binding(), NOW).reason, 'opening_profile_mismatch');
  assert.equal(decideCohort(template, { c: 'class-a' }, binding({ template_cohort: 'elsewhere' }), NOW).reason, 'opening_profile_mismatch');
});
check('negative: revoked opening, and a template that lost review', () => {
  assert.equal(decideCohort(template, { c: 'class-a' }, binding({ revoked: 1 }), NOW).reason, 'opening_revoked');
  assert.equal(decideCohort({ ...template, execution_template: false }, { c: 'class-a' }, binding(), NOW).reason, 'template_not_reviewed');
});
check('class-prefix branch: prefix with no row, bare prefix, case variant and empty cohort are all refused', () => {
  assert.equal(decideCohort(template, { c: 'class-does-not-exist' }, null, NOW).reason, 'opening_missing');
  assert.equal(decideCohort(template, { c: 'class-' }, null, NOW).reason, 'opening_missing');
  // Not the class namespace → legacy equality, which a template's own cohort does not match.
  assert.equal(decideCohort(template, { c: 'Class-a' }, binding({ class_cohort: 'Class-a' }), NOW).reason, 'cohort_mismatch');
  assert.equal(decideCohort(template, { c: '' }, null, NOW).reason, 'cohort_mismatch');
});
check('shipped registry has no empty compiled cohort (empty token cohort can never match)', () => {
  assert.deepEqual(listProfiles().filter(p => !p.session.cohort_id).map(p => p.id), []);
});
check('acceptance shape: one template, two openings, no copy — each resolves independently', () => {
  const a = decideCohort(template, { c: 'class-a', lesson: lessonA }, binding(), NOW);
  const b = decideCohort(template, { c: 'class-b', lesson: { ...lessonA, course_id: 'course-b' } }, binding({ class_cohort: 'class-b', course_id: 'course-b' }), NOW);
  assert.ok(a.ok && b.ok);
  assert.equal(decideCohort(template, { c: 'class-b', lesson: lessonA }, binding({ class_cohort: 'class-b', course_id: 'course-b' }), NOW).reason, 'opening_course_mismatch');
});

console.log(`${passed} cohort-binding checks passed`);
