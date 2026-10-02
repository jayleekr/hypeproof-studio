// Pure-function tests for chalk-plan/1 HTML parser. No DB, no network.
import './harness/loader.mjs';
import assert from 'node:assert/strict';

const { parsePlan } = await import('../src/lib/chalk-plan/parser.ts');

// ─── 양성 대조군: 정상 지도안 HTML ─────────────────────────────────────────
const BIOPHARM_SAMPLE = `<!DOCTYPE html>
<html lang="ko" data-chalk-plan="1" data-chalk-kind="lesson">
<head>
  <meta name="chalk:course" content="sk-biopharm-kids-s1">
  <meta name="chalk:knowledge-version" content="3">
  <meta name="chalk:format" content="workshop">
  <meta name="chalk:audience-tier" content="lv1">
  <meta name="chalk:family-session" content="true">
  <meta name="chalk:duration-min" content="240">
  <meta name="chalk:methods" content="m-002 m-007">
  <title>SK바이오팜 키즈 1회차</title>
  <style>body { font-family: sans-serif; }</style>
</head>
<body>
  <section data-chalk-section="meta"><p>메타 정보</p></section>
  <section data-chalk-section="objectives">
    <li data-chalk-objective="obj-1">첫 번째 목표</li>
    <li data-chalk-objective="obj-2">두 번째 목표</li>
  </section>
  <section data-chalk-section="essential-question">
    <p data-chalk-question>과학자는 어떻게 문제를 정의하나요?</p>
  </section>
  <section data-chalk-section="evidence">
    <li data-chalk-evidence="ev-1">관찰 노트</li>
  </section>
  <section data-chalk-section="flow">
    <table data-chalk-flow>
      <tr data-chalk-step="s-1" data-duration-min="30" data-chalk-requires="" data-chalk-forbids="">
        <th data-chalk-field="title">오프닝</th>
        <td data-chalk-role="teacher">환영 인사를 한다</td>
        <td data-chalk-role="learner">듣기</td>
        <td data-chalk-role="parent" data-chalk-parent-role="인터뷰어">관찰</td>
      </tr>
      <tr data-chalk-step="s-2" data-duration-min="40" data-chalk-requires="" data-chalk-forbids="">
        <th data-chalk-field="title">규칙 정하기</th>
        <td data-chalk-role="teacher">규칙 소개를 한다</td>
        <td data-chalk-role="learner">토론</td>
        <td data-chalk-role="parent" data-chalk-parent-role="관찰자">지켜보기</td>
      </tr>
    </table>
  </section>
  <section data-chalk-section="key-questions">
    <li data-chalk-key-question data-chalk-step="s-1">왜 규칙이 필요할까?</li>
    <li data-chalk-key-question>함께 정하면 어떤 점이 좋을까?</li>
  </section>
  <section data-chalk-section="prohibited-moves">
    <li data-chalk-move="P1" data-chalk-step="s-2">정답을 바로 알려준다</li>
    <li data-chalk-move="P2">학생 대신 카드를 채운다</li>
  </section>
  <section data-chalk-section="materials"><p>준비물 목록</p></section>
  <section data-chalk-section="safety" data-chalk-safety="none"><p>안전 항목 없음</p></section>
  <section data-chalk-section="bridging"><p>지난 시간과 이어지는 내용</p></section>
  <section data-chalk-section="support">
    <div data-chalk-stuck="st-1" data-chalk-step="s-2">
      <p data-chalk-field="expected-stuck">규칙을 못 정한다</p>
      <p data-chalk-field="signal">5분 넘게 카드가 비어 있다</p>
      <p data-chalk-field="min-support">지금 게임에서 제일 쉬운 부분이 어디였어?</p>
      <p data-chalk-field="expected-response">정답을 주지 않고 되묻는다</p>
    </div>
  </section>
</body>
</html>`;

// ─── T-P1: 메타 추출 ────────────────────────────────────────────────────────
{
  const r = parsePlan(BIOPHARM_SAMPLE);
  assert.equal(r.meta.kind, 'lesson', 'T-P1: kind');
  assert.equal(r.meta.course, 'sk-biopharm-kids-s1', 'T-P1: course');
  assert.equal(r.meta.knowledgeVersion, 3, 'T-P1: knowledgeVersion');
  assert.equal(r.meta.format, 'workshop', 'T-P1: format');
  assert.equal(r.meta.audienceTier, 'lv1', 'T-P1: audienceTier');
  assert.equal(r.meta.familySession, true, 'T-P1: familySession');
  assert.equal(r.meta.durationMin, 240, 'T-P1: durationMin');
  assert.deepEqual(r.meta.methods, ['m-002', 'm-007'], 'T-P1: methods');
  console.log('T-P1 PASS: 메타 추출');
}

// ─── T-P2: 단계 추출 (title·durationMin·roles) ─────────────────────────────
{
  const r = parsePlan(BIOPHARM_SAMPLE);
  assert.equal(r.steps.length, 2, 'T-P2: 단계 2개');
  assert.equal(r.steps[0].id, 's-1', 'T-P2: s-1 id');
  assert.equal(r.steps[0].durationMin, 30, 'T-P2: s-1 duration');
  assert.equal(r.steps[0].title, '오프닝', 'T-P2: s-1 title');
  assert.ok(r.steps[0].roles.includes('teacher'), 'T-P2: teacher role');
  assert.ok(r.steps[0].roles.includes('parent'), 'T-P2: parent role');
  assert.equal(r.steps[1].id, 's-2', 'T-P2: s-2 id');
  assert.equal(r.steps[1].durationMin, 40, 'T-P2: s-2 duration');
  console.log('T-P2 PASS: 단계 추출');
}

// ─── T-P3: 칸 내용 추출 ─────────────────────────────────────────────────────
{
  const r = parsePlan(BIOPHARM_SAMPLE);
  const s1 = r.steps[0];
  assert.equal(s1.cells.teacher, '환영 인사를 한다', 'T-P3: teacher cell text');
  assert.equal(s1.cells.learner, '듣기', 'T-P3: learner cell text');
  assert.ok(s1.cells.parent, 'T-P3: parent cell exists');
  assert.equal(s1.cells.parent?.text, '관찰', 'T-P3: parent cell text');
  assert.equal(s1.cells.parent?.role, '인터뷰어', 'T-P3: parent-role value');
  console.log('T-P3 PASS: 칸 내용 추출');
}

// ─── T-P4: 막힘 추출 ────────────────────────────────────────────────────────
{
  const r = parsePlan(BIOPHARM_SAMPLE);
  assert.equal(r.stucks.length, 1, 'T-P4: 막힘 1개');
  assert.equal(r.stucks[0].id, 'st-1', 'T-P4: id');
  assert.equal(r.stucks[0].stepId, 's-2', 'T-P4: stepId');
  assert.equal(r.stucks[0].expectedStuck, '규칙을 못 정한다', 'T-P4: expectedStuck');
  assert.equal(r.stucks[0].signal, '5분 넘게 카드가 비어 있다', 'T-P4: signal');
  assert.equal(r.stucks[0].minSupport, '지금 게임에서 제일 쉬운 부분이 어디였어?', 'T-P4: minSupport');
  assert.equal(r.stucks[0].expectedResponse, '정답을 주지 않고 되묻는다', 'T-P4: expectedResponse');
  console.log('T-P4 PASS: 막힘 추출');
}

// ─── T-P5: 절 내용 추출 (objectives·evidence·essentialQuestion·keyQuestions) ─
{
  const r = parsePlan(BIOPHARM_SAMPLE);
  assert.equal(r.objectives.length, 2, 'T-P5: objectives 2개');
  assert.equal(r.objectives[0].id, 'obj-1', 'T-P5: obj-1 id');
  assert.equal(r.objectives[0].text, '첫 번째 목표', 'T-P5: obj-1 text');
  assert.equal(r.evidence.length, 1, 'T-P5: evidence 1개');
  assert.equal(r.evidence[0].id, 'ev-1', 'T-P5: ev-1 id');
  assert.equal(r.essentialQuestion, '과학자는 어떻게 문제를 정의하나요?', 'T-P5: essentialQuestion');
  assert.equal(r.keyQuestions.length, 2, 'T-P5: keyQuestions 2개');
  assert.equal(r.keyQuestions[0].stepId, 's-1', 'T-P5: kq stepId');
  assert.equal(r.keyQuestions[0].text, '왜 규칙이 필요할까?', 'T-P5: kq text');
  assert.equal(r.keyQuestions[1].stepId, null, 'T-P5: kq no stepId');
  console.log('T-P5 PASS: 절 내용 추출');
}

// ─── T-P6: 7절 금지 개입 단계 연결 ─────────────────────────────────────────
{
  const r = parsePlan(BIOPHARM_SAMPLE);
  assert.equal(r.prohibitedMoves.length, 2, 'T-P6: prohibitedMoves 2개');
  assert.equal(r.prohibitedMoves[0].family, 'P1', 'T-P6: P1 family');
  assert.equal(r.prohibitedMoves[0].stepId, 's-2', 'T-P6: P1 stepId');
  assert.equal(r.prohibitedMoves[0].text, '정답을 바로 알려준다', 'T-P6: P1 text');
  assert.equal(r.prohibitedMoves[1].family, 'P2', 'T-P6: P2 family');
  assert.equal(r.prohibitedMoves[1].stepId, null, 'T-P6: P2 no stepId');
  // 없는 단계를 가리키지 않으므로 step_ref_unknown 위반 없어야 함
  const refViol = r.violations.filter(v => v.item === 'spec.step_ref_unknown');
  assert.equal(refViol.length, 0, `T-P6: step_ref_unknown 없음. 실제: ${JSON.stringify(refViol)}`);
  console.log('T-P6 PASS: 7절 금지 개입 단계 연결');
}

// ─── T-P7: 정상 지도안 violations 없음 ─────────────────────────────────────
{
  const r = parsePlan(BIOPHARM_SAMPLE);
  assert.equal(r.violations.length, 0, `T-P7: violations 없음. 실제: ${JSON.stringify(r.violations)}`);
  console.log('T-P7 PASS: violations 없음 (양성 대조군)');
}

// ─── T-P8: severity 모두 warn ───────────────────────────────────────────────
{
  // 위반이 있는 케이스에서 severity 확인
  const withScript = BIOPHARM_SAMPLE.replace('</body>', '<script>alert(1)</script></body>');
  const r = parsePlan(withScript);
  for (const v of r.violations) {
    assert.equal(v.severity, 'warn', `T-P8: severity=warn for ${v.item}`);
  }
  console.log('T-P8 PASS: severity 모두 warn');
}

// ─── T-P9: 13절 없음 → spec.support_missing, refs에 GEN-04 ──────────────────
{
  const noSupport = BIOPHARM_SAMPLE.replace(/<section data-chalk-section="support">[\s\S]*?<\/section>/, '');
  const r = parsePlan(noSupport);
  const v = r.violations.find(v => v.item === 'spec.support_missing');
  assert.ok(v, 'T-P9: spec.support_missing 있음');
  assert.ok(v.refs.includes('GEN-04'), 'T-P9: refs includes GEN-04');
  console.log('T-P9 PASS: 13절 없음 → spec.support_missing');
}

// ─── T-P10: 필수 절 없음 → spec.section_missing + at.section 키 ─────────────
{
  const noEvidence = BIOPHARM_SAMPLE.replace(/<section data-chalk-section="evidence">[\s\S]*?<\/section>/, '');
  const r = parsePlan(noEvidence);
  const v = r.violations.find(v => v.item === 'spec.section_missing' && v.at.section === 'evidence');
  assert.ok(v, `T-P10: spec.section_missing evidence. violations: ${JSON.stringify(r.violations.filter(v=>v.item==='spec.section_missing'))}`);
  assert.equal(v.at.section, 'evidence', 'T-P10: at.section=evidence');
  console.log('T-P10 PASS: 필수 절 없음 → spec.section_missing');
}

// ─── T-P11: 가족 수업 parent 없음 → spec.parent_role_missing ────────────────
{
  const noParent = BIOPHARM_SAMPLE
    .replace(/<td data-chalk-role="parent"[^>]*>[\s\S]*?<\/td>/g, '');
  const r = parsePlan(noParent);
  const v = r.violations.find(v => v.item === 'spec.parent_role_missing');
  assert.ok(v, `T-P11: spec.parent_role_missing. violations: ${JSON.stringify(r.violations)}`);
  assert.ok(v.refs.some(ref => ref.includes('PLAN-04') || ref.includes('결정 9')), 'T-P11: refs includes 결정 9 or PLAN-04');
  console.log('T-P11 PASS: parent 없음 → spec.parent_role_missing');
}

// ─── T-P12: <script> → markup.script, refs HTML-03 ──────────────────────────
{
  const withScript = BIOPHARM_SAMPLE.replace('</body>', '<script>alert(1)</script></body>');
  const r = parsePlan(withScript);
  const v = r.violations.find(v => v.item === 'markup.script');
  assert.ok(v, 'T-P12: markup.script 있음');
  assert.ok(v.refs.includes('HTML-03'), 'T-P12: refs HTML-03');
  console.log('T-P12 PASS: <script> → markup.script');
}

// ─── T-P13: 외부 이미지 URL → markup.external_resource ──────────────────────
{
  const withImg = BIOPHARM_SAMPLE.replace('</body>', '<img src="https://example.com/img.png"></body>');
  const r = parsePlan(withImg);
  const v = r.violations.find(v => v.item === 'markup.external_resource');
  assert.ok(v, 'T-P13: markup.external_resource 있음');
  assert.ok(v.message.includes('example.com'), 'T-P13: URL in message');
  console.log('T-P13 PASS: 외부 이미지 → markup.external_resource');
}

// ─── T-P14: 중첩 오류 <td><p></td> → markup.malformed ──────────────────────
{
  const badNesting = BIOPHARM_SAMPLE.replace(
    '<td data-chalk-role="teacher">규칙 소개를 한다</td>',
    '<td data-chalk-role="teacher"><p>규칙 소개를 한다</td>'
  );
  const r = parsePlan(badNesting);
  const v = r.violations.find(v => v.item === 'markup.malformed');
  assert.ok(v, `T-P14: markup.malformed. violations: ${JSON.stringify(r.violations.filter(v=>v.item==='markup.malformed'))}`);
  console.log('T-P14 PASS: 중첩 오류 → markup.malformed');
}

// ─── T-P15: 닫히지 않은 섹션 → markup.malformed ─────────────────────────────
{
  const unclosed = BIOPHARM_SAMPLE.replace(
    '<section data-chalk-section="bridging"><p>지난 시간과 이어지는 내용</p></section>',
    '<section data-chalk-section="bridging"><p>지난 시간과 이어지는 내용</p>'
  );
  const r = parsePlan(unclosed);
  const v = r.violations.find(v => v.item === 'markup.malformed');
  assert.ok(v, 'T-P15: markup.malformed 있음');
  console.log('T-P15 PASS: 닫히지 않은 섹션 → markup.malformed');
}

// ─── T-P16: 오류 후 파싱 계속 — 막힘 여전히 추출됨 ─────────────────────────
{
  const badNestingContinue = BIOPHARM_SAMPLE.replace(
    '<td data-chalk-role="teacher">환영 인사를 한다</td>',
    '<td data-chalk-role="teacher"><p>환영 인사를 한다</td>'
  );
  const r = parsePlan(badNestingContinue);
  assert.ok(r.violations.some(v => v.item === 'markup.malformed'), 'T-P16: markup.malformed 있음');
  assert.ok(r.stucks.length > 0, 'T-P16: 막힘 여전히 추출됨');
  console.log('T-P16 PASS: 오류 후 파싱 계속');
}

// ─── T-P17: 없는 단계 참조 → spec.step_ref_unknown ──────────────────────────
{
  const unknownStepRef = BIOPHARM_SAMPLE.replace(
    '<li data-chalk-move="P1" data-chalk-step="s-2">정답을 바로 알려준다</li>',
    '<li data-chalk-move="P1" data-chalk-step="s-999">정답을 바로 알려준다</li>'
  );
  const r = parsePlan(unknownStepRef);
  const v = r.violations.find(v => v.item === 'spec.step_ref_unknown');
  assert.ok(v, 'T-P17: spec.step_ref_unknown 있음');
  assert.ok(v.message.includes('s-999'), 'T-P17: 없는 단계 ID 포함');
  console.log('T-P17 PASS: 없는 단계 참조 → spec.step_ref_unknown');
}

// ─── T-P18: ops schedule·risks 필수 절 검사 (E3-1) ─────────────────────────
// T-P18a: schedule·risks 없는 ops → section_missing 2건(schedule, risks), blocks 없음
//         lesson 전용 절(flow 등)은 ops에 요구되지 않는다
{
  const opsNoSections = `<html data-chalk-plan="1" data-chalk-kind="ops">
<head>
  <meta name="chalk:course" content="sk-biopharm-kids-s1">
</head>
<body><p>운영 계획안</p></body>
</html>`;
  const r = parsePlan(opsNoSections, 'ops');
  const sectionViol = r.violations.filter(v => v.item === 'spec.section_missing');
  assert.equal(sectionViol.length, 2, `T-P18a: ops schedule·risks 없음 → section_missing 2건. got: ${JSON.stringify(sectionViol)}`);
  assert.ok(sectionViol.some(v => v.at.section === 'schedule'), `T-P18a: at.section=schedule 없음`);
  assert.ok(sectionViol.some(v => v.at.section === 'risks'), `T-P18a: at.section=risks 없음`);
  assert.equal((r.blocks ?? []).length, 0, `T-P18a: schedule 없으면 blocks 없음(blocks_confirm false)`);
  const lessonOnlyViol = r.violations.filter(v =>
    v.item === 'spec.section_missing' && v.at.section !== 'schedule' && v.at.section !== 'risks'
  );
  assert.equal(lessonOnlyViol.length, 0, `T-P18a: lesson 전용 절은 ops에 요구 안 됨. got: ${JSON.stringify(lessonOnlyViol)}`);
  console.log('T-P18a PASS: ops schedule·risks 없음 → section_missing 2건, blocks 없음, lesson 절 불요');
}
// T-P18b: 5절 완비 ops → section_missing 0건
{
  const opsAllSections = `<html data-chalk-plan="1" data-chalk-kind="ops">
<head>
  <meta name="chalk:course" content="sk-biopharm-kids-s1">
</head>
<body>
  <section data-chalk-section="schedule"></section>
  <section data-chalk-section="materials"></section>
  <section data-chalk-section="risks"></section>
  <section data-chalk-section="consent"></section>
  <section data-chalk-section="post-deliverables"></section>
</body>
</html>`;
  const r = parsePlan(opsAllSections, 'ops');
  const sectionViol = r.violations.filter(v => v.item === 'spec.section_missing');
  assert.equal(sectionViol.length, 0, `T-P18b: ops 5절 완비 → section_missing 없음. got: ${JSON.stringify(sectionViol)}`);
  console.log('T-P18b PASS: ops 5절 완비 → section_missing 0건');
}

// ─── T-E1~T-E5: 잘못된 수치 참조 / 크기 초과 ──────────────────────────────
{
  // T-E1: 10진 범위 초과 → throw 없이 markup.bad_entity 위반
  const r = parsePlan('<!DOCTYPE html><html><head></head><body>&#1114112;</body></html>', 'f');
  assert.doesNotThrow(() => parsePlan('<!DOCTYPE html><html><head></head><body>&#1114112;</body></html>', 'f'));
  const v = r.violations.find(x => x.item === 'markup.bad_entity');
  assert.ok(v, `T-E1: markup.bad_entity 위반 없음. violations=${JSON.stringify(r.violations)}`);
  console.log('T-E1 PASS: &#1114112; → markup.bad_entity, throw 없음');
}
{
  // T-E2: 16진 범위 초과 → throw 없이 markup.bad_entity 위반
  const r = parsePlan('<!DOCTYPE html><html><head></head><body>&#x110000;</body></html>', 'f');
  assert.doesNotThrow(() => parsePlan('<!DOCTYPE html><html><head></head><body>&#x110000;</body></html>', 'f'));
  const v = r.violations.find(x => x.item === 'markup.bad_entity');
  assert.ok(v, `T-E2: markup.bad_entity 위반 없음. violations=${JSON.stringify(r.violations)}`);
  console.log('T-E2 PASS: &#x110000; → markup.bad_entity, throw 없음');
}
{
  // T-E3: 서로게이트 → throw 없이 markup.bad_entity 위반
  const r = parsePlan('<!DOCTYPE html><html><head></head><body>&#xD800;</body></html>', 'f');
  const v = r.violations.find(x => x.item === 'markup.bad_entity');
  assert.ok(v, `T-E3: markup.bad_entity 위반 없음 (surrogate). violations=${JSON.stringify(r.violations)}`);
  console.log('T-E3 PASS: &#xD800; → markup.bad_entity, throw 없음');
}
{
  // T-E4: 256KB 초과 → markup.too_large, throw 없음, 파싱 중단
  const big = '<!DOCTYPE html><html><head></head><body>' + 'x'.repeat(256 * 1024 + 1) + '</body></html>';
  let r;
  assert.doesNotThrow(() => { r = parsePlan(big, 'f'); });
  const v = r.violations.find(x => x.item === 'markup.too_large');
  assert.ok(v, `T-E4: markup.too_large 없음`);
  console.log('T-E4 PASS: 256KB 초과 → markup.too_large, throw 없음');
}
{
  // T-E5: 정상 범위 수치 참조는 문자로 변환되고 위반 없음
  const r = parsePlan('<!DOCTYPE html><html><head></head><body>&#65;&#x41;</body></html>', 'f');
  const v = r.violations.filter(x => x.item === 'markup.bad_entity');
  assert.equal(v.length, 0, `T-E5: 정상 참조에 bad_entity 위반 생김`);
  console.log('T-E5 PASS: &#65; &#x41; → 위반 없음');
}

// ─── T-P19~T-P23: chalk:prerequisites 파싱 ──────────────────────────────────
// evidence lesson.html (증거 파일): head에 chalk:prerequisites 없고 표에만 있음 — before-fix 시나리오
import { readFileSync } from 'node:fs';
const EVIDENCE_HTML = readFileSync(
  new URL('./fixtures/chalk-plan/evidence-1306-lesson.html', import.meta.url), 'utf8'
);
const EVIDENCE_TABLE_PREREQ = 'AI 사용 경험·바이오 지식 불필요 (선행지식 없이 시작 가능). 준비물: 짝당 AI 도구가 열린 기기 1대';

{
  // T-P19: head meta chalk:prerequisites 만 있을 때 → meta.prerequisites 채워짐, mismatch 없음
  const html = `<!DOCTYPE html><html data-chalk-kind="lesson"><head>
<meta name="chalk:course" content="c1">
<meta name="chalk:knowledge-version" content="1">
<meta name="chalk:format" content="workshop">
<meta name="chalk:audience-tier" content="lv1">
<meta name="chalk:duration-min" content="60">
<meta name="chalk:prerequisites" content="사전 지식 없음">
<meta name="chalk:methods" content="m-001">
</head><body><section data-chalk-section="meta"><table>
<tr><th>과목</th><td>테스트</td></tr>
</table></section></body></html>`;
  const r = parsePlan(html, 'test');
  assert.equal(r.meta.prerequisites, '사전 지식 없음', `T-P19: head meta 값 불일치. got=${r.meta.prerequisites}`);
  const mismatch = r.violations.filter(v => v.item === 'spec.meta_prerequisites_mismatch');
  assert.equal(mismatch.length, 0, `T-P19: 예상치 못한 mismatch 위반. got=${JSON.stringify(mismatch)}`);
  console.log('T-P19 PASS: head meta only → prerequisites 채워짐, mismatch 없음');
}

{
  // T-P20: 표 행만 있을 때 (head meta 없음) → meta.prerequisites = 표 행 값
  const html = `<!DOCTYPE html><html data-chalk-kind="lesson"><head>
<meta name="chalk:course" content="c1">
<meta name="chalk:knowledge-version" content="1">
<meta name="chalk:format" content="workshop">
<meta name="chalk:audience-tier" content="lv1">
<meta name="chalk:duration-min" content="60">
<meta name="chalk:methods" content="m-001">
</head><body><section data-chalk-section="meta"><table>
<tr><th>선행 조건</th><td>경험 필요 없음</td></tr>
</table></section></body></html>`;
  const r = parsePlan(html, 'test');
  assert.equal(r.meta.prerequisites, '경험 필요 없음', `T-P20: 표 행 값 읽기 실패. got=${r.meta.prerequisites}`);
  const mismatch = r.violations.filter(v => v.item === 'spec.meta_prerequisites_mismatch');
  assert.equal(mismatch.length, 0, `T-P20: 예상치 못한 mismatch 위반`);
  console.log('T-P20 PASS: table-only → prerequisites 표 행에서 채워짐');
}

{
  // T-P21: head meta 와 표 행이 불일치 → spec.meta_prerequisites_mismatch 위반 발생
  const html = `<!DOCTYPE html><html data-chalk-kind="lesson"><head>
<meta name="chalk:course" content="c1">
<meta name="chalk:knowledge-version" content="1">
<meta name="chalk:format" content="workshop">
<meta name="chalk:audience-tier" content="lv1">
<meta name="chalk:duration-min" content="60">
<meta name="chalk:prerequisites" content="A">
<meta name="chalk:methods" content="m-001">
</head><body><section data-chalk-section="meta"><table>
<tr><th>선행 조건</th><td>B</td></tr>
</table></section></body></html>`;
  const r = parsePlan(html, 'test');
  const mismatch = r.violations.filter(v => v.item === 'spec.meta_prerequisites_mismatch');
  assert.equal(mismatch.length, 1, `T-P21: mismatch 위반 없음. violations=${JSON.stringify(r.violations)}`);
  // head meta wins
  assert.equal(r.meta.prerequisites, 'A', `T-P21: head meta 값이 우선이어야 함. got=${r.meta.prerequisites}`);
  console.log('T-P21 PASS: head≠표 → spec.meta_prerequisites_mismatch 발생, head meta 우선');
}

{
  // T-P22: evidence lesson.html (수정 전 — head meta 없음) → 표에서 읽어 prerequisites 채워짐
  const r = parsePlan(EVIDENCE_HTML, 'evidence-1306');
  assert.equal(
    r.meta.prerequisites, EVIDENCE_TABLE_PREREQ,
    `T-P22: 표 행 읽기 실패. got=${r.meta.prerequisites}`
  );
  const mismatch = r.violations.filter(v => v.item === 'spec.meta_prerequisites_mismatch');
  assert.equal(mismatch.length, 0, `T-P22: 예상치 못한 mismatch. got=${JSON.stringify(mismatch)}`);
  console.log('T-P22 PASS: evidence lesson.html (head meta 없음) → 표 행에서 prerequisites 채워짐');
}

{
  // T-P23: evidence lesson.html + head meta 추가 버전 (수정 후 skeleton 생성 시나리오) → 동일 값 → mismatch 없음
  const htmlWithMeta = EVIDENCE_HTML.replace(
    '<meta name="chalk:methods" content="m-001">',
    `<meta name="chalk:methods" content="m-001">\n  <meta name="chalk:prerequisites" content="${EVIDENCE_TABLE_PREREQ}">`
  );
  const r = parsePlan(htmlWithMeta, 'evidence-1306-with-meta');
  assert.equal(r.meta.prerequisites, EVIDENCE_TABLE_PREREQ, `T-P23: prerequisites 불일치. got=${r.meta.prerequisites}`);
  const mismatch = r.violations.filter(v => v.item === 'spec.meta_prerequisites_mismatch');
  assert.equal(mismatch.length, 0, `T-P23: 예상치 못한 mismatch. got=${JSON.stringify(mismatch)}`);
  console.log('T-P23 PASS: head meta = 표 행 → mismatch 없음');
}

console.log('\nchalk-plan-parser: 모든 테스트 통과 (28개)');
