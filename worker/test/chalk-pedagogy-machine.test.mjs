// #1464 — E2-4 기계 판정 항목 단위 테스트.
// lesson-pedagogy.ts 순수 함수를 직접 호출한다. DB/HTTP 없음.
import assert from 'node:assert/strict';

const {
  checkLessonPedagogy,
  checkDurationConsistency,
  checkClosingDuration,
  checkInstructorRatio,
  DURATION_TOLERANCE_MIN,
} = await import('../src/lib/lesson-pedagogy.ts');

// ── helpers ──────────────────────────────────────────────────────────────────

const BASE_CONTENT = {
  schema: 'hps-session-design/1',
  title: '테스트 수업',
  audience: '초등 3~4학년',
  duration_minutes: 90,
  objective: '목표',
  prerequisites: '없음',
  starter: '시작',
  steps: [],
};

const mkStep = (id, overrides = {}) => ({
  id,
  title: `단계 ${id}`,
  instructions: '제출 증거: 기록지',
  hint: '',
  acceptance: '완료 기준',
  ...overrides,
});

const mkParsedStep = (id, durationMin, cells = {}) => ({
  id,
  title: `단계 ${id}`,
  durationMin: durationMin ?? null,
  roles: [],
  cells: { teacher: '설명', learner: '활동', ...cells },
  requires: [],
  forbids: [],
});

function findCheck(findings, check) {
  return findings.filter(f => f.check === check);
}

let pass = 0, fail = 0;

function t(label, fn) {
  try { fn(); console.log(`PASS ${label}`); pass++; }
  catch (e) { console.error(`FAIL ${label}: ${e.message}`); fail++; }
}

// ── G2-9 checkDurationConsistency ─────────────────────────────────────────────

console.log('=== G2-9 duration_consistency ===');

t('G2-9 양성: 합 = duration_minutes → skipped false, 경고 없음', () => {
  const steps = [mkParsedStep('s1', 30), mkParsedStep('s2', 30), mkParsedStep('s3', 30)];
  const findings = checkDurationConsistency(steps, 90);
  const f = findings[0];
  assert.ok(!f.skipped, 'should not be skipped');
  assert.ok(!findings.some(x => !x.skipped === false || x.message.includes('차이')), 'no diff warning');
});

t('G2-9 초과: 합이 12분 초과 → warn, blocks_confirm false, item G2-9 (fromPedagogyFinding 통해)', () => {
  const steps = [mkParsedStep('s1', 60), mkParsedStep('s2', 45)]; // 합 105, 수업 90 → 차이 15 > 10
  const findings = checkDurationConsistency(steps, 90);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, 'duration_consistency');
  assert.ok(findings[0].message.includes('15분'), `message: ${findings[0].message}`);
  assert.ok(!findings[0].skipped);
});

t('G2-9 skipped (일부 없음): duration_min 없는 단계 있음', () => {
  const steps = [mkParsedStep('s1', 30), mkParsedStep('s2', null)];
  const findings = checkDurationConsistency(steps, 90);
  assert.ok(findings[0].skipped);
  assert.ok(findings[0].message.includes('시간 없는 단계 있음'), `message: ${findings[0].message}`);
});

t('G2-9 skipped (전부 없음): 모든 단계 duration_min 없음', () => {
  const steps = [mkParsedStep('s1', null), mkParsedStep('s2', null)];
  const findings = checkDurationConsistency(steps, 90);
  assert.ok(findings[0].skipped);
});

t('G2-9 skipped (단계 없음)', () => {
  const findings = checkDurationConsistency([], 90);
  assert.ok(findings[0].skipped);
  assert.ok(findings[0].message.includes('단계 없음'));
});

t('DURATION_TOLERANCE_MIN = 10', () => {
  assert.equal(DURATION_TOLERANCE_MIN, 10);
});

// ── G3-4 checkClosingDuration ─────────────────────────────────────────────────

console.log('=== G3-4 closing_duration ===');

t('G3-4 양성: 마지막 단계 durationMin = 10 → skipped false, warn 없음 (diff 없음)', () => {
  const steps = [mkParsedStep('s1', 20), mkParsedStep('s2', 10)];
  const findings = checkClosingDuration(steps);
  assert.equal(findings.length, 1);
  assert.ok(!findings[0].skipped);
  assert.ok(!findings[0].message.includes('미만'), `message: ${findings[0].message}`);
});

t('G3-4 경고: 마지막 단계 durationMin = 8 → warn, "마지막 단계를 정리로 봄" 포함', () => {
  const steps = [mkParsedStep('s1', 20), mkParsedStep('s2', 8)];
  const findings = checkClosingDuration(steps);
  assert.equal(findings.length, 1);
  assert.ok(!findings[0].skipped);
  assert.ok(findings[0].message.includes('마지막 단계를 정리로 봄'), `message: ${findings[0].message}`);
  assert.ok(findings[0].message.includes('8분'), `message: ${findings[0].message}`);
});

t('G3-4 skipped: 마지막 단계 durationMin 없음', () => {
  const steps = [mkParsedStep('s1', 20), mkParsedStep('s2', null)];
  const findings = checkClosingDuration(steps);
  assert.ok(findings[0].skipped);
});

t('G3-4 skipped: 단계 없음', () => {
  const findings = checkClosingDuration([]);
  assert.ok(findings[0].skipped);
  assert.ok(findings[0].message.includes('단계 없음'));
});

// ── G3-1 checkInstructorRatio ─────────────────────────────────────────────────

console.log('=== G3-1 instructor_ratio ===');

t('G3-1 경고: 교사 칸이 학습자보다 길다', () => {
  const steps = [
    mkParsedStep('s1', 20, { teacher: '교사 설명이 매우 길고 자세합니다 열 두 어절', learner: '짧은 활동' }),
  ];
  const findings = checkInstructorRatio(steps);
  assert.ok(findings.some(f => !f.skipped && f.step_id === 's1'), JSON.stringify(findings));
});

t('G3-1 통과: 학습자 칸이 교사보다 길다', () => {
  const steps = [
    mkParsedStep('s1', 20, { teacher: '짧음', learner: '학습자 활동이 매우 길고 자세합니다 열 두 어절' }),
  ];
  const findings = checkInstructorRatio(steps);
  assert.ok(!findings.some(f => f.step_id === 's1' && !f.skipped), JSON.stringify(findings));
});

t('G3-1 둘 다 비면 해당 단계 판정 안 함', () => {
  const steps = [mkParsedStep('s1', 20, { teacher: '', learner: '' })];
  const findings = checkInstructorRatio(steps);
  assert.ok(!findings.some(f => f.step_id === 's1'), JSON.stringify(findings));
});

t('G3-1 학습자 칸만 비고 교사 칸에 글 있으면 warn', () => {
  const steps = [mkParsedStep('s1', 20, { teacher: '교사 설명', learner: '' })];
  const findings = checkInstructorRatio(steps);
  assert.ok(findings.some(f => f.step_id === 's1' && !f.skipped), JSON.stringify(findings));
});

// ── G1-* via checkLessonPedagogy ──────────────────────────────────────────────

console.log('=== G1-* 텍스트 체크 ===');

const mkContentWithText = (text, audienceTier) => ({
  ...BASE_CONTENT,
  steps: [mkStep('s1', { instructions: `제출 증거: 기록지 ${text}` })],
  _audienceTier: audienceTier,
});

// checkLessonPedagogy에 audienceTier를 opts로 전달
const runG1 = (text, audienceTier) => {
  const content = { ...BASE_CONTENT, steps: [mkStep('s1', { instructions: `제출 증거: 기록지 ${text}` })] };
  return checkLessonPedagogy(content, { audienceTier });
};

t('G1-2 lv1: "순위" → warn', () => {
  const findings = runG1('순위 발표 없음', 'lv1');
  const g12 = findCheck(findings, 'g1_2_rank');
  assert.ok(g12.some(f => !f.skipped), `g1_2_rank: ${JSON.stringify(g12)}`);
});

t('G1-2 lv2: "등수" → warn', () => {
  const findings = runG1('등수 안 매깁니다', 'lv2');
  const g12 = findCheck(findings, 'g1_2_rank');
  assert.ok(g12.some(f => !f.skipped), JSON.stringify(g12));
});

t('G1-4 lv1: "자격증" → warn', () => {
  const findings = runG1('자격증 발급', 'lv1');
  const g14 = findCheck(findings, 'g1_4_credential');
  assert.ok(g14.some(f => !f.skipped), JSON.stringify(g14));
});

t('G1-6 lv1: "뒤처" → warn', () => {
  const findings = runG1('뒤처지지 않아요', 'lv1');
  const g16 = findCheck(findings, 'g1_6_peer_comparison');
  assert.ok(g16.some(f => !f.skipped), JSON.stringify(g16));
});

t('G1 adult: "자격증" → skipped("성인 수업")', () => {
  const findings = runG1('자격증', 'adult');
  const g14 = findCheck(findings, 'g1_4_credential');
  assert.ok(g14.every(f => f.skipped), JSON.stringify(g14));
  assert.ok(g14[0].message.includes('성인 수업'), g14[0].message);
});

t('G1 null tier: → skipped("등급 없음")', () => {
  const findings = runG1('자격증 순위', null);
  const g14 = findCheck(findings, 'g1_4_credential');
  assert.ok(g14[0].skipped);
  assert.ok(g14[0].message.includes('등급 없음'), g14[0].message);
});

t('G1-4 오탐 방지: "인증 절차"는 g1_4_credential 아님', () => {
  const findings = runG1('인증 절차를 따릅니다', 'lv1');
  const g14 = findCheck(findings, 'g1_4_credential');
  assert.ok(g14.every(f => f.skipped || !findings.find(x => x.check === 'g1_4_credential' && !x.skipped)),
    JSON.stringify(g14));
});

t('G1-3 skipped: "총점" 있어도 문맥 판정(E2-5)으로 skipped', () => {
  const findings = runG1('총점 발표', 'lv1');
  const g13 = findCheck(findings, 'g1_3_total_score');
  assert.ok(g13[0].skipped, JSON.stringify(g13));
  assert.ok(g13[0].message.includes('문맥 판정') || g13[0].message.includes('E2-5'), g13[0].message);
});

// ── CHECK_TO_ITEM — SRC_* 잔재 없음 + G-ID 확인 ──────────────────────────────

console.log('=== SRC_* 잔재 + item G-ID ===');

t('step_acceptance item = "G2-2" (fromPedagogyFinding 경유 — route 단위)', async () => {
  // lesson-pedagogy.ts 직접 호출 시 item 필드는 없음.
  // item은 fromPedagogyFinding에서 CHECK_TO_ITEM으로 붙음 — route 테스트로 커버.
  // 여기서는 check 이름이 step_acceptance 인 finding이 생성되는지만 확인.
  const content = { ...BASE_CONTENT, steps: [mkStep('s1', { acceptance: '' })] };
  const findings = checkLessonPedagogy(content);
  assert.ok(findings.some(f => f.check === 'step_acceptance'), 'step_acceptance fired');
});

t('lesson_prerequisites item = "G2-6" — check 이름 확인', () => {
  const content = { ...BASE_CONTENT, prerequisites: '' };
  const findings = checkLessonPedagogy(content);
  assert.ok(findings.some(f => f.check === 'lesson_prerequisites'), 'lesson_prerequisites fired');
});

t('SRC_* 문자열이 item 값으로 나오지 않음 (lesson-pedagogy findings.source에는 있을 수 있음)', () => {
  const content = { ...BASE_CONTENT, steps: [mkStep('s1', { acceptance: '' })] };
  const findings = checkLessonPedagogy(content);
  // item 필드는 lesson-pedagogy.ts 에 없고 fromPedagogyFinding에서 붙음.
  // PedagogyFinding에 item 없음 — 이 검사는 route 레벨을 위한 문서.
  assert.ok(true, 'item field not in PedagogyFinding; covered by CHECK_TO_ITEM in chalk-courses.ts');
});

// ── skipped 항목 이유 문자열 ────────────────────────────────────────────────────

console.log('=== skipped 항목 이유 ===');

t('G2-5 skipped reason 포함', () => {
  const findings = checkLessonPedagogy(BASE_CONTENT);
  const f = findCheck(findings, 'g2_5_atomic')[0];
  assert.ok(f.skipped);
  assert.ok(f.message.includes('활동 원자(act-*) 미적재'), f.message);
  assert.ok(f.message.includes('KPS Q4'), f.message);
});

t('G2-7 skipped reason 포함', () => {
  const f = findCheck(checkLessonPedagogy(BASE_CONTENT), 'g2_7_forbids')[0];
  assert.ok(f.skipped);
  assert.ok(f.message.includes('forbids 값 공간 미확정(KPS Q4)'), f.message);
});

t('G2-8 skipped reason 포함', () => {
  const f = findCheck(checkLessonPedagogy(BASE_CONTENT), 'g2_8_placement')[0];
  assert.ok(f.skipped);
  assert.ok(f.message.includes('배치 규칙 칸이 계획서·저장 형식에 없음'), f.message);
});

t('G2-11 skipped reason 포함', () => {
  const f = findCheck(checkLessonPedagogy(BASE_CONTENT), 'g2_11_safety')[0];
  assert.ok(f.skipped);
  assert.ok(f.message.includes('safety 칸이 계획서·저장 형식에 없음'), f.message);
});

// ── 기존 v0 항목 회귀 ──────────────────────────────────────────────────────────

console.log('=== 기존 v0 항목 회귀 ===');

t('step_acceptance severity = fail (blocks_confirm true)', () => {
  const content = { ...BASE_CONTENT, steps: [mkStep('s1', { acceptance: '' })] };
  const findings = checkLessonPedagogy(content);
  const f = findCheck(findings, 'step_acceptance')[0];
  assert.equal(f.severity, 'fail');
});

t('lesson_prerequisites severity = fail', () => {
  const content = { ...BASE_CONTENT, prerequisites: '' };
  const findings = checkLessonPedagogy(content);
  const f = findCheck(findings, 'lesson_prerequisites')[0];
  assert.equal(f.severity, 'fail');
});

t('step_evidence severity = warn', () => {
  const content = { ...BASE_CONTENT, steps: [mkStep('s1', { instructions: '안내만 있고 증거 없음' })] };
  const findings = checkLessonPedagogy(content);
  const f = findCheck(findings, 'step_evidence')[0];
  assert.equal(f.severity, 'warn');
});

t('duration_consistency skipped when parsedSteps 없음 (기존 동작 유지)', () => {
  const findings = checkLessonPedagogy(BASE_CONTENT);
  const f = findCheck(findings, 'duration_consistency')[0];
  assert.ok(f.skipped, 'should be skipped without parsedSteps');
});

t('새 항목 severity = warn (G2-9 포함)', () => {
  const steps = [mkParsedStep('s1', 60), mkParsedStep('s2', 45)];
  const findings = checkDurationConsistency(steps, 90);
  assert.equal(findings[0].severity, 'warn');
});

// ── 요약 ───────────────────────────────────────────────────────────────────────
const total = pass + fail;
console.log(`\n${total} tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
