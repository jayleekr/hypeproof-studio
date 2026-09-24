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

// ─── T-P18: ops 종류는 필수 절 검사 안 함 ───────────────────────────────────
{
  const opsHtml = `<html data-chalk-plan="1" data-chalk-kind="ops">
<head>
  <meta name="chalk:course" content="sk-biopharm-kids-s1">
</head>
<body><p>운영 계획안</p></body>
</html>`;
  const r = parsePlan(opsHtml, 'ops');
  const sectionViol = r.violations.filter(v =>
    v.item === 'spec.section_missing' || v.item === 'spec.support_missing'
  );
  assert.equal(sectionViol.length, 0, `T-P18: ops 절 검사 없음. violations: ${JSON.stringify(sectionViol)}`);
  console.log('T-P18 PASS: ops 종류 필수 절 검사 안 함');
}

console.log('\nchalk-plan-parser: 모든 테스트 통과 (18개)');
