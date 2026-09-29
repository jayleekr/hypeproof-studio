// Real render of the report page a recipient reads, and of its PDF (#751 R5/R6).
// Chromium renders the Service's own HTML (renderReportHtml ∘ composeReport) for a synthetic draft.
// Not a real recipient, a real mail client or a real printer.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import '../../worker/test/harness/loader.mjs';
const { composeReport } = await import('../../worker/src/lib/classroom-report.ts');
const { renderReportHtml } = await import('../../worker/src/lib/classroom-report-html.ts');
const { CANDIDATE_CAPABILITY_V1: M } = await import('../../worker/src/lib/measurement-core/index.ts');
const { renderReportPdf } = await import('../../scripts/classroom-report-pdf.mjs');
const out = new URL('../test-results/classroom-report/', import.meta.url).pathname; mkdirSync(out, { recursive: true });

const keys = M.capabilities.map((c) => c.key), hostile = '<img src=x onerror="document.title=\'pwned\'"> "따옴표"와\n줄바꿈';
const draft = { format: 'hps-classroom-report-draft/1', versions: { capability_model: { id: M.id, revision: M.revision }, rubric: 'capability-definitions-synthetic', evaluator: 'service-anthropic:1', renderer_revision: 'observation-report/1' }, next_experiment: '다음에는 확인 조건을 두 개 적어 보기',
  findings: [{ capability: keys[0], status: 'observed', claim: '확인할 조건을 먼저 정하고 결과를 본 뒤 요청을 바꿨습니다.', assistance: 'assisted', change: { before: '버튼 위치 유지', after: '390px 확인 뒤 위치 변경' },
    evidence: [{ locator: { line: 1 }, quote: hostile, actor: 'student', source_state: 'real' }, { event_id: 'r1', quote: 'AI가 버튼을 크게 만들었습니다', actor: 'ai', source_state: 'unverified' }, { event_id: 's1', quote: '가상 사례에서 한 말', actor: 'student', source_state: 'simulated' }] },
    ...keys.slice(1).map((capability) => ({ capability, status: 'unobserved', claim: '', evidence: [] }))] };
const html = renderReportHtml(composeReport(draft, { class_runs_with_evidence: 1, coverage: 'sequence_unavailable', model: M }), { student_label: 'student-a', class_label: '2026-09-19 수업', approved_at: Date.now(), expires_at: Date.now() + 7 * 864e5 });
writeFileSync(out + 'report.html', html);

const browser = await chromium.launch(); let n = 0; const ok = (name) => { n++; console.log('PASS ' + name); };
try {
  for (const [name, viewport, zoom] of [['desktop', { width: 1280, height: 900 }, 1], ['phone-360', { width: 360, height: 740 }, 1], ['zoom-200', { width: 640, height: 450 }, 1]]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: zoom }); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent(html, { waitUntil: 'load' });
    assert.equal(await page.title(), '수업 관찰 보고서 · student-a', 'the hostile quote did not run'); assert.deepEqual(errors, []);
    assert.equal(await page.locator('img').count(), 0, 'learner text is text, never markup'); assert.ok((await page.locator('blockquote').first().innerText()).includes('<img src=x'));
    const titles = await page.locator('h2:visible').allInnerTexts(); assert.deepEqual(titles, ['이 보고서가 본 범위', '이번 수업에서 관찰된 행동', '판단이 바뀐 과정', '아직 충분히 보지 못함', '다음에 실험해볼 것']);
    assert.equal(await page.locator('section').nth(3).locator('.names span').count(), keys.length - 1); assert.equal((await page.locator('section').nth(3).innerText()).split('아직 충분히 보지 못함').length - 1, 1, 'said once, with the capability names');
    assert.deepEqual(await page.locator('figure').evaluateAll((els) => els.map((e) => e.classList.contains('context'))), [false, true, true], 'only the learner\'s own real words carry the accent'); assert.ok((await page.locator('section').nth(3).innerText()).includes('점수나 미달이 아닙니다'));
    const captions = await page.locator('figcaption').allInnerTexts(); assert.deepEqual(captions, ['학생이 직접 쓴 말 · 실제 수업 중', 'AI의 응답', '학생이 직접 쓴 말 · 가상 사례(연습)'], 'whose words, and whether real, stays next to each quote');
    assert.ok((await page.locator('.assist').innerText()).includes('도움을 받아'), 'assisted work is not shown as independent');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, name + ': no horizontal scroll');
    // Numbers never lead: the method is folded, and closed by default.
    assert.equal(await page.locator('details').getAttribute('open'), null); await page.locator('summary').focus(); await page.keyboard.press('Enter'); assert.notEqual(await page.locator('details').getAttribute('open'), null, 'keyboard opens the method details');
    // WCAG contrast of body text and muted text on the panel.
    const contrast = await page.evaluate(() => { const lum = (c) => { const [r, g, b] = c.match(/\d+/g).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }; const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }; const panel = getComputedStyle(document.querySelector('section')).backgroundColor; return { text: ratio(getComputedStyle(document.querySelector('section p')).color, panel), muted: ratio(getComputedStyle(document.querySelector('figcaption')).color, panel), heading: ratio(getComputedStyle(document.querySelector('h2')).color, panel) }; });
    assert.ok(contrast.text >= 7 && contrast.muted >= 4.5 && contrast.heading >= 4.5, JSON.stringify(contrast));
    await page.screenshot({ path: `${out}${name}.png`, fullPage: true }); await page.close(); ok(`report page renders: ${name}`);
  }
  const pdf = await renderReportPdf({ html, out: out + 'report.pdf', chromium }), text = pdf.toString('latin1');
  // The PDF is the print layout of the same page: the method block, folded on screen, is printed.
  { const p = await browser.newPage(); await p.setContent(html); assert.equal(await p.locator('.print-only').isVisible(), false); await p.emulateMedia({ media: 'print' }); assert.equal(await p.locator('.print-only').isVisible(), true); assert.equal(await p.locator('details').isVisible(), false); await p.close(); }
  assert.equal(text.slice(0, 5), '%PDF-'); const pages = (text.match(/\/Type\s*\/Page\b/g) ?? []).length; assert.ok(pages >= 1 && pages <= 3, 'pages=' + pages); assert.ok(pdf.byteLength > 8000);
  ok(`report PDF rendered from the same page: ${pages} page(s), ${pdf.byteLength} bytes`);
} finally { await browser.close(); }
console.log(`${n} report render checks passed → ${out}`);
