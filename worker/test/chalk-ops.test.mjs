// #1468 — chalk-ops.ts pure function unit tests.
// Tests buildAutoMaterials, buildAutoConsent, consentPendingKeys, diffAutoMaterials.
// No HTTP, no DB, no side effects. Uses minimal Profile stubs.
import assert from 'node:assert/strict';

const {
  buildAutoMaterials,
  buildAutoConsent,
  consentPendingKeys,
  diffAutoMaterials,
} = await import('../src/lib/chalk-ops.ts');

// Known skills for this test suite (avoids wrangler .md text-rule import)
const KNOWN_SKILLS = new Set(['quiz', 'story']);
const knownSkillValidator = (name) => KNOWN_SKILLS.has(name);

// ── Profile stubs ─────────────────────────────────────────────────────────────

/** Minor cohort, 2 skills, log_user_messages=false, publishing disabled */
const MINOR_PROFILE = {
  id: 'test-minor',
  minor_cohort: true,
  model: { default: 'claude-haiku-4-5-20251001', allowed: ['claude-haiku-4-5-20251001'] },
  skills: ['quiz', 'story'],
  analytics: { log_user_messages: false, log_metadata: false },
  publishing: { enabled: false, strategy: 'local_only' },
};

/** Adult cohort, no skills, log_user_messages=true, publishing enabled */
const ADULT_PROFILE = {
  id: 'test-adult',
  minor_cohort: false,
  model: { default: 'claude-sonnet-5', allowed: ['claude-sonnet-5'] },
  skills: [],
  analytics: { log_user_messages: true, log_metadata: true },
  publishing: { enabled: true, strategy: 'per_user_github_pages' },
};

/** Profile with individual trial seat */
const TRIAL_PROFILE = {
  id: 'test-trial',
  minor_cohort: false,
  model: { default: 'claude-haiku-4-5-20251001', allowed: ['claude-haiku-4-5-20251001'] },
  skills: [],
  analytics: { log_user_messages: false, log_metadata: false },
  publishing: { enabled: false, strategy: 'local_only' },
  trial: { individual: true },
};

/** Profile with an unregistered skill name */
const UNKNOWN_SKILL_PROFILE = {
  id: 'test-unknown-skill',
  minor_cohort: false,
  model: { default: 'claude-haiku-4-5-20251001', allowed: ['claude-haiku-4-5-20251001'] },
  skills: ['nonexistent-skill-xyz'],
  analytics: { log_user_messages: false, log_metadata: false },
  publishing: { enabled: false, strategy: 'local_only' },
};

// ── T-O1: buildAutoMaterials — 2 skills ──────────────────────────────────────

{
  const items = buildAutoMaterials(MINOR_PROFILE, knownSkillValidator);
  assert.ok(items.find(m => m.id === 'auto-token'), 'T-O1a: auto-token present');
  assert.equal(items.find(m => m.id === 'auto-token')?.owner, 'instructor', 'T-O1b: auto-token owner=instructor');
  assert.equal(items.find(m => m.id === 'auto-token')?.kind, 'account', 'T-O1c: auto-token kind=account');
  assert.equal(items.find(m => m.id === 'auto-token')?.text, '학생 토큰 발급(참가 인원만큼)', 'T-O1d: token text uses fixed phrase, no invented N');
  assert.ok(items.find(m => m.id === 'auto-skill-quiz'), 'T-O1e: auto-skill-quiz present');
  assert.ok(items.find(m => m.id === 'auto-skill-story'), 'T-O1f: auto-skill-story present');
  assert.equal(items.filter(m => m.id.startsWith('auto-skill-')).length, 2, 'T-O1g: exactly 2 skill items');
  assert.ok(items.find(m => m.id === 'auto-studio'), 'T-O1h: auto-studio present');
  assert.equal(items.find(m => m.id === 'auto-studio')?.owner, 'learner', 'T-O1i: auto-studio owner=learner');
  assert.ok(items.every(m => m.auto === true), 'T-O1j: all items have auto:true');
  console.log('ok T-O1: buildAutoMaterials with 2 skills');
}

// ── T-O1b: no skills → no skill lines ────────────────────────────────────────

{
  const items = buildAutoMaterials(ADULT_PROFILE, knownSkillValidator);
  assert.equal(items.filter(m => m.id.startsWith('auto-skill-')).length, 0, 'T-O1b: no skill lines when skills=[]');
  assert.ok(items.find(m => m.id === 'auto-token'), 'T-O1b: auto-token still present');
  assert.ok(items.find(m => m.id === 'auto-studio'), 'T-O1b: auto-studio still present');
  console.log('ok T-O1b: buildAutoMaterials with no skills');
}

// ── T-O2: lesson model policy overrides profile model ────────────────────────

{
  const lessonPolicy = { default: 'claude-opus-5', allowed: ['claude-opus-5'] };
  const items = buildAutoConsent(MINOR_PROFILE, lessonPolicy);
  const model = items.find(c => c.key === 'model');
  assert.ok(model?.text?.includes('claude-opus-5'), 'T-O2a: lesson model policy default wins');
  assert.ok(!model?.text?.includes('claude-haiku'), 'T-O2b: profile model.default is overridden');
  console.log('ok T-O2: lesson model policy overrides profile model');
}

// ── T-O3: log_user_messages=false → "저장하지 않습니다" ──────────────────────

{
  const items = buildAutoConsent(MINOR_PROFILE);
  const log = items.find(c => c.key === 'log-collection');
  assert.ok(log?.text?.includes('저장하지 않습니다'), 'T-O3a: false → 저장하지 않습니다');
  // minor cohort: should NOT say "저장합니다"
  assert.ok(!log?.text?.includes('저장합니다'), 'T-O3b: false never says 저장합니다');
  console.log('ok T-O3: log_user_messages=false produces 저장하지 않습니다');
}

// ── T-O3b: log_user_messages=true → "저장합니다" ─────────────────────────────

{
  const items = buildAutoConsent(ADULT_PROFILE);
  const log = items.find(c => c.key === 'log-collection');
  assert.ok(log?.text?.includes('저장합니다'), 'T-O3b: true → 저장합니다');
  assert.ok(!log?.text?.includes('저장하지 않습니다'), 'T-O3b: true never says 저장하지 않습니다');
  console.log('ok T-O3b: log_user_messages=true produces 저장합니다');
}

// ── minor_cohort: "보호자 동의 필요" suffix on log-collection and publishing ──

{
  const minorItems = buildAutoConsent(MINOR_PROFILE);
  const log = minorItems.find(c => c.key === 'log-collection');
  const pub = minorItems.find(c => c.key === 'publishing');
  // MINOR_PROFILE: log=false, publishing=disabled — no "보호자 동의 필요" for disabled
  assert.ok(!log?.text?.includes('보호자 동의 필요'), 'minor+log=false → no 보호자 suffix (저장 안 함)');
  assert.ok(!pub?.text?.includes('보호자 동의 필요'), 'minor+pub=false → no 보호자 suffix (공개 안 함)');
  console.log('ok minor disabled: 보호자 동의 필요 not added when disabled');
}

{
  // Minor + log=true → 보호자 동의 필요
  const minorLogging = { ...MINOR_PROFILE, analytics: { log_user_messages: true, log_metadata: false } };
  const items = buildAutoConsent(minorLogging);
  const log = items.find(c => c.key === 'log-collection');
  assert.ok(log?.text?.includes('보호자 동의 필요'), 'minor+log=true → 보호자 동의 필요');
  console.log('ok minor+log=true: 보호자 동의 필요 appended');
}

{
  // Minor + publishing=true → 보호자 동의 필요
  const minorPub = { ...MINOR_PROFILE, publishing: { enabled: true, strategy: 'hypeproof_gallery' } };
  const items = buildAutoConsent(minorPub);
  const pub = items.find(c => c.key === 'publishing');
  assert.ok(pub?.text?.includes('보호자 동의 필요'), 'minor+pub=true → 보호자 동의 필요');
  assert.ok(pub?.text?.includes('hypeproof_gallery'), 'minor+pub=true: strategy name present');
  console.log('ok minor+pub=true: 보호자 동의 필요 appended');
}

// ── adult cohort: no 보호자 동의 suffix ────────────────────────────────────────

{
  const items = buildAutoConsent(ADULT_PROFILE);
  assert.ok(!items.some(c => c.text?.includes('보호자 동의 필요')), 'adult → no 보호자 suffix anywhere');
  console.log('ok adult: no 보호자 동의 필요 in any consent item');
}

// ── trial.individual → 개인 체험 좌석 ─────────────────────────────────────────

{
  const items = buildAutoConsent(TRIAL_PROFILE);
  const account = items.find(c => c.key === 'account');
  assert.ok(account?.text?.includes('개인 체험 좌석'), 'trial.individual=true → 개인 체험 좌석');
  console.log('ok trial.individual: 개인 체험 좌석 in account text');
}

{
  // no trial → no 개인 체험 좌석
  const items = buildAutoConsent(ADULT_PROFILE);
  const account = items.find(c => c.key === 'account');
  assert.ok(!account?.text?.includes('개인 체험 좌석'), 'no trial → no 개인 체험 좌석');
  console.log('ok no trial: 개인 체험 좌석 absent');
}

// ── T-O4/T-O5: no profile → all consent items pending ────────────────────────
// analytics and publishing are required in Profile, so consent_pending
// only arises when no profile is available (profile=null).

{
  const items = buildAutoConsent(null);
  assert.ok(items.every(c => c.text === null), 'T-O4/O5: null profile → all items pending');
  const pending = consentPendingKeys(items);
  assert.deepEqual(pending.sort(), ['account', 'log-collection', 'model', 'publishing'], 'T-O4/O5: pending keys are all four');
  console.log('ok T-O4/T-O5: no profile → all 4 consent items pending');
}

// ── T-O6: diffAutoMaterials — setting change → live ids differ ────────────────

{
  // Same ids: no stale
  assert.equal(diffAutoMaterials(
    ['auto-token', 'auto-skill-quiz', 'auto-studio'],
    ['auto-token', 'auto-skill-quiz', 'auto-studio'],
  ), false, 'T-O6a: identical sets → not stale');

  // Profile skill removed: live has one fewer skill
  assert.equal(diffAutoMaterials(
    ['auto-token', 'auto-skill-quiz', 'auto-skill-story', 'auto-studio'],
    ['auto-token', 'auto-skill-quiz', 'auto-studio'],
  ), true, 'T-O6b: skill removed → stale');

  // Skill added
  assert.equal(diffAutoMaterials(
    ['auto-token', 'auto-studio'],
    ['auto-token', 'auto-skill-new', 'auto-studio'],
  ), true, 'T-O6c: skill added → stale');

  // Order difference should not matter
  assert.equal(diffAutoMaterials(
    ['auto-studio', 'auto-token'],
    ['auto-token', 'auto-studio'],
  ), false, 'T-O6d: order difference → not stale');

  console.log('ok T-O6: diffAutoMaterials');
}

// ── unknown skill warning ─────────────────────────────────────────────────────

{
  // validator rejects this name → warning
  const items = buildAutoMaterials(UNKNOWN_SKILL_PROFILE, knownSkillValidator);
  const skill = items.find(m => m.id === 'auto-skill-nonexistent-skill-xyz');
  assert.ok(skill, 'unknown skill still produces a material line');
  assert.ok(skill?.warning?.includes('spec.material_unknown_skill'), 'unknown skill carries warning code');
  console.log('ok unknown skill: warning attached');
}

// ── consentPendingKeys ────────────────────────────────────────────────────────

{
  // Partial pending (simulated: text is null for some)
  const mixed = [
    { key: 'model', text: 'claude-haiku', auto: true },
    { key: 'account', text: null, auto: true },
    { key: 'log-collection', text: '저장하지 않습니다', auto: true },
    { key: 'publishing', text: null, auto: true },
  ];
  const pending = consentPendingKeys(mixed);
  assert.deepEqual(pending.sort(), ['account', 'publishing'], 'consentPendingKeys returns only null items');
  console.log('ok consentPendingKeys: partial pending');
}

console.log('\nAll chalk-ops tests passed.');
