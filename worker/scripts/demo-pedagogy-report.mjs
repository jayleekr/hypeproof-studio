// 데모용 복제 픽스처를 관문에 태우고 **실제 판정을 사람이 읽을 형태로** 출력한다 (#1116).
//
// 테스트(worker/test/lesson-pedagogy-demo.test.mjs)는 심어 둔 정답과 맞는지를 세고,
// 이 스크립트는 그 판정이 실제로 무엇이라고 말하는지를 보인다. 위클리에 들어가는 것은
// 이 출력이다 — 통과/차단만이 아니라 **무엇을 채우면 열리는가(remedy)**까지.
//
//   node --experimental-strip-types scripts/demo-pedagogy-report.mjs
//   node --experimental-strip-types scripts/demo-pedagogy-report.mjs --json
//
// 아무것도 쓰지 않는다. 네트워크도 쓰지 않는다.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { checkLessonPedagogy, blockingPedagogyFindings } = await import('../src/lib/lesson-pedagogy.ts');
const { validateSessionDesign } = await import('../src/lib/session-design.ts');

const dir = new URL('../test/fixtures/lesson-pedagogy/', import.meta.url);
const files = readdirSync(fileURLToPath(dir)).filter(f => f.endsWith('.demo.json')).sort();
const asJson = process.argv.includes('--json');

const report = files.map(file => {
  const fx = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
  const courses = fx.courses.map(c => {
    const shape = validateSessionDesign(c.content, true);
    const findings = shape ? [] : checkLessonPedagogy(c.content);
    return {
      course_id: c.course_id,
      title: c.content.title,
      steps: c.content.steps.length,
      shape_error: shape,
      blocked: blockingPedagogyFindings(findings).length > 0,
      findings,
    };
  });
  return { file, id: fx.id, title: fx.title, expect: fx.expect, resolves: fx.resolves ?? null, source: fx.source, courses };
});

if (asJson) {
  console.log(JSON.stringify({ generated_for: '#1116 데모 — 데모용 복제, 운영 기록·실적 아님', report }, null, 2));
} else {
  const LABEL = { fail: '차단', warn: '경고', skip: '미확인' };
  console.log('# 관문 판정 — 데모용 복제 픽스처\n');
  console.log('> 이 자료는 데모용 복제다. 운영 데이터가 아니고 실적으로 인용할 수 없다.');
  console.log('> 참가자 산출물의 기록이 아니며, 산출물은 설계상 만들기로 한 것이다.\n');
  for (const r of report) {
    console.log(`## ${r.title}  \`${r.id}\``);
    console.log(`출처: \`${r.source.path}\` · 원본 상태: ${r.source.status} · 저작 귀속: ${r.source.ip_owner}`);
    if (r.resolves) console.log(`해소 대상: \`${r.resolves}\``);
    console.log();
    for (const c of r.courses) {
      if (c.shape_error) { console.log(`- **${c.course_id}** — 형태 검증 실패: ${c.shape_error}\n`); continue; }
      const mark = c.blocked ? '⛔ 차단' : '✅ 통과';
      console.log(`### ${mark} — ${c.title} (\`${c.course_id}\`, ${c.steps}단계)`);
      if (!c.findings.length) { console.log('판정 없음.\n'); continue; }
      for (const f of c.findings) {
        const kind = f.skipped ? LABEL.skip : LABEL[f.severity];
        console.log(`- **[${kind}] ${f.check}**${f.step_id ? ` (단계 \`${f.step_id}\`)` : ''} — ${f.message}`);
        console.log(`  - 무엇을 채우면 열리나: ${f.remedy}`);
        console.log(`  - 정본: ${f.source}`);
      }
      console.log();
    }
  }
  const blocked = report.flatMap(r => r.courses).filter(c => c.blocked).length;
  const total = report.flatMap(r => r.courses).length;
  console.log(`---\n수업 ${total}개 중 ${blocked}개 차단 · 픽스처 ${files.length}개.`);
  console.log('`미확인`은 통과가 아니다 — 스키마에 칸이 없어 검사하지 못한 것이다.');
}
