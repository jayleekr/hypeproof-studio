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
  <section data-chalk-section="objectives"><p>목표</p></section>
  <section data-chalk-section="essential-question"><p>핵심 질문</p></section>
  <section data-chalk-section="evidence"><p>증거</p></section>
  <section data-chalk-section="flow">
    <table data-chalk-flow>
      <tr data-chalk-step="s-1" data-duration-min="30" data-chalk-requires="" data-chalk-forbids="">
        <th data-chalk-field="title">오프닝</th>
        <td data-chalk-role="teacher">환영 인사</td>
        <td data-chalk-role="learner">듣기</td>
        <td data-chalk-role="parent" data-chalk-parent-role="인터뷰어">관찰</td>
      </tr>
      <tr data-chalk-step="s-2" data-duration-min="40" data-chalk-requires="" data-chalk-forbids="">
        <th data-chalk-field="title">규칙 정하기</th>
        <td data-chalk-role="teacher">규칙 소개</td>
        <td data-chalk-role="learner">토론</td>
        <td data-chalk-role="parent" data-chalk-parent-role="인터뷰어">지켜보기</td>
      </tr>
    </table>
  </section>
  <section data-chalk-section="key-questions"><p>핵심 질문 목록</p></section>
  <section data-chalk-section="prohibited-moves"><p>금지 개입</p></section>
  <section data-chalk-section="materials"><p>준비물</p></section>
  <section data-chalk-section="safety" data-chalk-safety="none"><p>안전</p></section>
  <section data-chalk-section="bridging"><p>연결</p></section>
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

{
  // T-P1: 정상 지도안 메타 추출
  const result = parsePlan(BIOPHARM_SAMPLE);
  assert.equal(result.meta.kind, 'lesson', 'T-P1: kind=lesson');
  assert.equal(result.meta.course, 'sk-biopharm-kids-s1', 'T-P1: course');
  assert.equal(result.meta.knowledgeVersion, 3, 'T-P1: knowledgeVersion');
  assert.equal(result.meta.format, 'workshop', 'T-P1: format');
  assert.equal(result.meta.audienceTier, 'lv1', 'T-P1: audienceTier');
  assert.equal(result.meta.familySession, true, 'T-P1: familySession');
  assert.equal(result.meta.durationMin, 240, 'T-P1: durationMin');
  assert.deepEqual(result.meta.methods, ['m-002', 'm-007'], 'T-P1: methods');
  console.log('T-P1 PASS: 메타 추출');
}

{
  // T-P2: 단계 추출
  const result = parsePlan(BIOPHARM_SAMPLE);
  assert.equal(result.steps.length, 2, 'T-P2: 단계 2개');
  assert.equal(result.steps[0].id, 's-1', 'T-P2: s-1');
  assert.equal(result.steps[0].durationMin, 30, 'T-P2: s-1 duration');
  assert.equal(result.steps[0].title, '오프닝', 'T-P2: s-1 title');
  assert.ok(result.steps[0].roles.includes('teacher'), 'T-P2: teacher role');
  assert.ok(result.steps[0].roles.includes('parent'), 'T-P2: parent role');
  assert.equal(result.steps[1].id, 's-2', 'T-P2: s-2');
  assert.equal(result.steps[1].durationMin, 40, 'T-P2: s-2 duration');
  console.log('T-P2 PASS: 단계 추출');
}

{
  // T-P3: 막힘 추출
  const result = parsePlan(BIOPHARM_SAMPLE);
  assert.equal(result.stucks.length, 1, 'T-P3: 막힘 1개');
  assert.equal(result.stucks[0].id, 'st-1', 'T-P3: st-1');
  assert.equal(result.stucks[0].stepId, 's-2', 'T-P3: stepId');
  assert.equal(result.stucks[0].expectedStuck, '규칙을 못 정한다', 'T-P3: expectedStuck');
  assert.equal(result.stucks[0].signal, '5분 넘게 카드가 비어 있다', 'T-P3: signal');
  assert.equal(result.stucks[0].minSupport, '지금 게임에서 제일 쉬운 부분이 어디였어?', 'T-P3: minSupport');
  assert.equal(result.stucks[0].expectedResponse, '정답을 주지 않고 되묻는다', 'T-P3: expectedResponse');
  console.log('T-P3 PASS: 막힘 추출');
}

{
  // T-P4: 정상 지도안은 violations 없음
  const result = parsePlan(BIOPHARM_SAMPLE);
  const errors = result.violations.filter(v => v.severity === 'error');
  assert.equal(errors.length, 0, `T-P4: 오류 없음. 실제: ${JSON.stringify(errors)}`);
  console.log('T-P4 PASS: violations 없음');
}

{
  // T-P5: 13절 없으면 HTML-04 위반
  const noSupport = BIOPHARM_SAMPLE.replace(/<section data-chalk-section="support">[\s\S]*?<\/section>/, '');
  const result = parsePlan(noSupport);
  const v = result.violations.find(v => v.item === 'HTML-04');
  assert.ok(v, 'T-P5: HTML-04 위반 있음');
  assert.equal(v.severity, 'error', 'T-P5: severity=error');
  console.log('T-P5 PASS: 13절 없음 → HTML-04');
}

{
  // T-P6: 가족 수업인데 parent 칸 없는 단계 → PLAN-04
  const noParent = BIOPHARM_SAMPLE
    .replace(/<td data-chalk-role="parent"[^>]*>.*?<\/td>/g, '');
  const result = parsePlan(noParent);
  const v = result.violations.find(v => v.item === 'PLAN-04');
  assert.ok(v, `T-P6: PLAN-04 위반 있음. violations: ${JSON.stringify(result.violations)}`);
  console.log('T-P6 PASS: parent 없음 → PLAN-04');
}

{
  // T-P7: <script> 있으면 HTML-03 위반
  const withScript = BIOPHARM_SAMPLE.replace('</body>', '<script>alert(1)</script></body>');
  const result = parsePlan(withScript);
  const v = result.violations.find(v => v.item === 'HTML-03' && v.message.includes('script'));
  assert.ok(v, 'T-P7: script → HTML-03');
  console.log('T-P7 PASS: <script> → HTML-03');
}

{
  // T-P8: 외부 이미지 URL → HTML-03 external_resource
  const withImg = BIOPHARM_SAMPLE.replace('</body>', '<img src="https://example.com/img.png"></body>');
  const result = parsePlan(withImg);
  const v = result.violations.find(v => v.item === 'HTML-03' && v.message.includes('example.com'));
  assert.ok(v, 'T-P8: 외부 이미지 → HTML-03');
  console.log('T-P8 PASS: 외부 이미지 → HTML-03');
}

{
  // T-P9: 중첩 오류 <td><p></td> → HTML-02 malformed_markup
  const badNesting = BIOPHARM_SAMPLE.replace(
    '<td data-chalk-role="teacher">규칙 소개</td>',
    '<td data-chalk-role="teacher"><p>규칙 소개</td>'
  );
  const result = parsePlan(badNesting);
  const v = result.violations.find(v => v.item === 'HTML-02');
  assert.ok(v, `T-P9: 중첩 오류 → HTML-02. violations: ${JSON.stringify(result.violations.filter(v=>v.item==='HTML-02'))}`);
  console.log('T-P9 PASS: 중첩 오류 → HTML-02');
}

{
  // T-P10: 닫히지 않은 섹션 → HTML-02
  const unclosed = BIOPHARM_SAMPLE.replace(
    '<section data-chalk-section="bridging"><p>연결</p></section>',
    '<section data-chalk-section="bridging"><p>연결</p>'  // </section> 없음
  );
  const result = parsePlan(unclosed);
  const v = result.violations.find(v => v.item === 'HTML-02');
  assert.ok(v, 'T-P10: 닫히지 않은 섹션 → HTML-02');
  console.log('T-P10 PASS: 닫히지 않은 섹션 → HTML-02');
}

{
  // T-P11: 중첩 오류 후 파싱 계속 — 막힘은 여전히 추출됨
  const badNestingContinue = BIOPHARM_SAMPLE.replace(
    '<td data-chalk-role="teacher">환영 인사</td>',
    '<td data-chalk-role="teacher"><p>환영 인사</td>'
  );
  const result = parsePlan(badNestingContinue);
  // HTML-02 위반 있음
  assert.ok(result.violations.some(v => v.item === 'HTML-02'), 'T-P11: HTML-02 있음');
  // 막힘도 여전히 추출됨
  assert.ok(result.stucks.length > 0, 'T-P11: 막힘 여전히 추출됨');
  console.log('T-P11 PASS: 오류 후 파싱 계속');
}

console.log('chalk-plan-parser: 모든 테스트 통과');
