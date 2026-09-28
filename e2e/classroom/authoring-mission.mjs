// #751 G2 mission — the teacher edits the lesson's mission, week and completion conditions with ordinary controls on /authoring,
// reviews the concrete difference, freezes a candidate, rehearses it in the BUILT Studio webview (whose mission header is read
// back from the rendered DOM), confirms it, and finds it by its mission in the /manage setting picker.
//
// Real here: the Chalk /authoring and /manage pages in Chromium (the teacher clicks and types), the Service router + SQLite, the
// built webview drawing the rehearsal lesson and reading back its own mission header, the App's pure report builder.
// Controlled: the model provider (a recorder) and the wire requests (sent with the headers the App builds). Synthetic accounts.
// No real Studio window here — that is the Mac run (mac-curriculum.mjs).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { localOps, OPS_ALL } from '../../worker/test/harness/classroom-ops.mjs';
import { makeCtx, withMockUpstream, anthropicJsonBody, TEST_SECRET } from '../../worker/test/harness/index.mjs';
import { rehearsalReport, turnLesson, acceptFocus } from '../../extensions/hypeproof-chat/src/lessonFocus.ts';
import { permittedToolsFor } from '../../extensions/hypeproof-chat/src/sdkCoachHelpers.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), out = path.join(repo, 'e2e/test-results/classroom-authoring-mission'); mkdirSync(out, { recursive: true });
const dist = path.join(repo, 'extensions/hypeproof-chat/webview-ui/dist'); assert.ok(existsSync(path.join(dist, 'index.html')), 'build the webview first: npm --prefix extensions/hypeproof-chat/webview-ui run build');
const local = await localOps(), { default: chalk } = await import('../../chalk/src/index.ts'), { setRoster } = await import('../../worker/src/lib/kv.ts'), { issueIssuer } = await import('../../worker/src/lib/tokens.ts');
local.env.HPS_LESSON_BINDINGS = 'enforce'; local.env.ANTHROPIC_API_KEY = 'test-anthropic-key'; local.env.HPS_LESSON_CONFIRMATION = 'require';
const realFetch = globalThis.fetch, toService = (url, init) => local.app.fetch(new Request(url, init), local.env, makeCtx());
globalThis.fetch = (url, init) => String(url).startsWith('https://service.test') ? toService(url, init) : realFetch(url, init);
const serve = async (handler) => { const s = createServer(handler); s.listen(0, '127.0.0.1'); await once(s, 'listening'); return s; };
const chalkServer = await serve(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts); const r = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); } catch (e) { res.writeHead(500); res.end(String(e)); } });
const webviewServer = await serve((req, res) => { const name = new URL(req.url, 'http://x').pathname.replace(/^\/$/, '/index.html'), file = path.resolve(dist, '.' + name); if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(readFileSync(file)); });
let n = 0; const ok = (name) => { n++; console.log('PASS ' + name); }; let browser; const results = {};
const MISSION = '예약 버튼이 첫 화면에서 보이게 만든다', EDITED = '고친 이유를 한 줄로 남긴다';
const COMPLETION = [['확인 기준을 먼저 적었다', 'criterion_set'], ['직접 눌러 확인했다', 'test_observed']];
try {
  const course = local.lesson.course_id, V1 = local.lesson.version, VA = 'm2026.09.22-51', VB = 'm2026.09.22-52';
  await setRoster(local.env.HPS_KV, local.cohort, ['student-a', 'rehearsal-t1']);
  await local.freeze(course, V1, ['intro', 'build', 'review']);
  assert.equal((await local.configure([{ seat_id: 'A1', student_id: 'student-a' }], 0, { flags: { ops_observe: true, ops_commands: true, ops_distribute: true, ops_lesson_settings: true } })).status, 201);
  const teacher = (await issueIssuer({ issuer: 'teacher-a', scopes: [{ cohort: local.cohort, profiles: [local.profile], ops: [...OPS_ALL, 'distribute', 'lesson_settings'] }] }, 6, TEST_SECRET)).token;
  const draft = async () => (await local.request(`/admin/cohorts/${local.cohort}/authoring/${course}`, 'GET', undefined, teacher)).json;

  browser = await chromium.launch(); const origin = 'http://127.0.0.1:' + chalkServer.address().port;
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } }), errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('dialog', (d) => d.accept());
  const shot = (name, p = page) => p.screenshot({ path: path.join(out, name), fullPage: false });
  const waitStatus = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('status').textContent), re.source);
  const statusText = () => page.locator('#status').innerText();
  await page.goto(origin + '/authoring'); await page.locator('#token').fill(teacher); await page.locator('#connect').click();
  await page.locator('#connection-status').filter({ hasText: '연결되었습니다' }).waitFor();
  await page.locator('summary', { hasText: '저장한 강의 열기' }).click(); await page.locator('#course').fill(course); await page.locator('#load').click(); await waitStatus(/저장본을 열었습니다/);
  await page.locator('#versions-load').click(); await waitStatus(/버전 1개를 불러왔습니다/);
  await page.locator('#base-version').selectOption(V1); await page.locator('#reuse-step option').nth(1).waitFor({ state: 'attached' });
  await page.locator('#reuse-all').click(); await waitStatus(/의 내용으로 초안을 채웠습니다/);

  // ── 1. legacy: V1 has no mission; the page says so and invents none from the title or objective ──
  assert.equal(await page.locator('#learning-on').isChecked(), false); assert.equal(await page.locator('#learning-fields').isHidden(), true);
  assert.match(await page.locator('#learning-off-note').innerText(), /미션이 정해지지 않았습니다/);
  assert.equal(await page.evaluate(() => 'learning' in content()), false, 'no mission → no learning block in the body');
  ok('legacy: a lesson without a mission opens with the mission off; the body carries no learning block and nothing is derived');

  // ── 2. edit with ordinary controls: turn the mission on, week, sentence, two completion conditions ──
  await page.locator('#title').fill('첫 시제품 — 예약 안내 페이지'); await page.locator('#objective').fill('예약 안내 페이지의 첫 판을 만들고 확인 기준을 스스로 정한다');
  await page.locator('#learning-on').check(); await page.locator('#learning-fields').waitFor();
  await page.locator('#learning-week').fill('2'); await page.locator('#learning-mission').fill(MISSION);
  for (const [text, event] of COMPLETION) { await page.locator('#completion-add').click(); const row = page.locator('#learning-completion li').last(); await row.locator('[data-completion-text]').fill(text); await row.locator('[data-completion-event]').selectOption(event); }
  const step0 = page.locator('.step').nth(0); await step0.locator('[data-help-mode="hint"]').check(); await step0.locator('[data-ui]').selectOption('criterion_form');
  // Invalid first: an empty sentence is refused in the teacher's words and nothing is saved.
  const rev0 = (await draft()).revision; await page.locator('#learning-mission').fill('  '); await page.locator('#save').click(); await waitStatus(/미션 문장을 적으세요/);
  assert.equal((await draft()).revision, rev0, 'nothing was saved'); assert.equal(await page.evaluate(() => document.activeElement.id), 'learning-mission', 'focus goes to the field to fix');
  await page.locator('#learning-completion li').last().locator('[data-completion-event]').selectOption(''); await page.locator('#learning-mission').fill(MISSION); await page.locator('#save').click(); await waitStatus(/근거가 되는 기록을 고르세요/);
  await page.locator('#learning-completion li').last().locator('[data-completion-event]').selectOption('test_observed');
  await page.locator('#learning').scrollIntoViewIfNeeded(); await shot('m-01-mission-editing-1280x720.png');
  await page.locator('#save').click(); await waitStatus(/저장했습니다/);
  const saved = (await draft()).content.learning; results.saved = saved;
  assert.deepEqual([saved.week, saved.mission, saved.completion.map((c) => [c.text, c.event])], [2, MISSION, COMPLETION]); assert.ok(saved.completion.every((c) => /^c-[0-9a-f]{8}$/.test(c.id)));
  ok('edit: week, mission and completion (text + record kind) saved from ordinary controls; empty or incomplete input is refused before sending');

  // ── 3. reopen, export/import: the edited fields come back; fields this page does not edit (observe, never) survive ──
  await page.locator('#load').click(); await waitStatus(/저장본을 열었습니다/);
  assert.deepEqual([await page.locator('#learning-on').isChecked(), await page.locator('#learning-week').inputValue(), await page.locator('#learning-mission').inputValue(), await page.locator('#learning-completion [data-completion-text]').evaluateAll((xs) => xs.map((x) => x.value))], [true, '2', MISSION, COMPLETION.map((c) => c[0])]);
  const exported = await page.evaluate(() => ({ course_id: document.getElementById('course').value, content: content() })); assert.deepEqual(exported.content.learning, saved, 'export carries the learning block as saved');
  const withAdvanced = { course_id: 'course-imported', content: { ...exported.content, learning: { ...saved, observe: ['기대 조건을 먼저 정하는가'], never: ['측정을 위해 고의 오류를 넣지 않는다'] } } };
  const file = path.join(out, 'import-with-advanced.json'); writeFileSync(file, JSON.stringify(withAdvanced));
  await page.locator('#import').setInputFiles(file); await page.locator('#courses option').nth(1).waitFor({ state: 'attached' }); await page.locator('#courses').selectOption('0');
  assert.match(await page.locator('#learning-advanced').innerText(), /그대로 보존하는 학습 설계 항목.*관찰 항목\(학생에게 보이지 않음\) 1개 · 코치 금지 사항 1개/);
  await page.locator('#learning-mission').fill(MISSION + '!'); // an edit: the preserved fields must still be in the body
  const reimported = await page.evaluate(() => content().learning); assert.deepEqual([reimported.mission, reimported.observe, reimported.never], [MISSION + '!', ['기대 조건을 먼저 정하는가'], ['측정을 위해 고의 오류를 넣지 않는다']]);
  await page.locator('#learning').scrollIntoViewIfNeeded(); await shot('m-02-import-preserved-fields-1280x720.png');
  await page.locator('#course').fill(course); await page.locator('#load').click(); await waitStatus(/저장본을 열었습니다/);
  ok('reopen/export/import: the edited mission round-trips; observe/never have no control, are named, and survive an edit');

  // ── 4. the concrete difference review names the mission and the conditions ──
  await page.locator('#base-version').selectOption(V1); await page.locator('#impact').click(); await page.locator('#impact-view li').first().waitFor();
  const impact = await page.locator('#impact-view li').allInnerTexts(); results.impact = impact;
  assert.ok(impact.includes('학생 미션: 미션 없음 → 2주차 ‘' + MISSION + '’'), impact.join('\n'));
  assert.ok(impact.includes('완료 조건: 없음 → ‘확인 기준을 먼저 적었다’(기대 조건 적기), ‘직접 눌러 확인했다’(직접 확인하기)'), impact.join('\n'));
  await page.locator('#review').scrollIntoViewIfNeeded(); await shot('m-03-difference-review-1280x720.png');
  ok('review: the Service-computed difference is shown as the mission and conditions the learner will see');

  // ── 5. candidate identity: the frozen candidate is shown with its mission ──
  await page.locator('#version').evaluate((e) => { e.closest('details').open = true; }); await page.locator('#version').fill(VA);
  await page.locator('#freeze').click(); await page.locator('#completion').filter({ hasText: VA }).waitFor();
  assert.match(await page.locator('#readiness').innerText(), new RegExp('이 후보의 학생 미션: 2주차 ‘' + MISSION + '’ · 완료 조건 2개'));
  // ── 6. rehearsal 1: the learner's header is STALE (tampered to another mission) → the Service fails it ──
  await page.locator('#rehearsal-learner').fill('rehearsal-t1');
  const learnerSide = async (tamper) => {
    // The status line reads the same for every issue: wait for a NEW code, not for the words (the first draft of this suite
    // read the previous, already-judged code here).
    const previous = await page.locator('#rehearsal-token').inputValue(); await page.locator('#rehearsal-issue').click();
    await page.waitForFunction((p) => { const v = document.getElementById('rehearsal-token').value; return v && v !== p; }, previous); const code = await page.locator('#rehearsal-token').inputValue();
    const profile = await (await toService('https://service.test/v1/profile', { headers: { authorization: 'Bearer ' + code } })).json(); assert.equal(profile.lesson.content.learning.mission, MISSION);
    const app = await browser.newPage({ viewport: { width: 420, height: 900 } }); const appErrors = []; app.on('pageerror', (e) => appErrors.push(e.message));
    await app.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.sent.push(m), getState: () => undefined, setState: () => {} }); });
    await app.goto('http://127.0.0.1:' + webviewServer.address().port + '/'); await app.waitForFunction(() => window.sent.some((m) => m.type === 'ready'));
    await app.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), { type: 'config', config: { proxyUrl: 'http://controlled-host.invalid/v1', model: 'controlled-host-only', hasToken: true, coach: { name: '코치', personality: '', configured: true }, profile } });
    await app.locator('[data-lesson-step-panel]').waitFor();
    const header = await app.locator('header.hp-mission').evaluate((h) => ({ week: h.querySelector('.hp-mission-week')?.textContent, sentence: h.querySelector('.hp-mission-sentence').textContent, completion: [...h.querySelectorAll('.hp-mission-completion-text')].map((e) => e.textContent), marks: [...h.querySelectorAll('.hp-mission-completion li:not(.hp-mission-completion-note) .hp-mark')].map((e) => e.textContent) }));
    assert.deepEqual(header, { week: '2주차', sentence: MISSION, completion: COMPLETION.map((c) => c[0]), marks: ['☐', '☐'] }, 'the header draws the candidate\'s mission, every condition unchecked');
    // The first step's criterion form, as the learner sees it before moving on (theme tokens, not a platform-white strip).
    const field = await app.locator('[data-surface="criterion_form"] textarea').evaluate((e) => { const s = getComputedStyle(e); return { bg: s.backgroundColor, color: s.color, border: s.borderTopColor }; });
    if (!tamper) { await app.locator('[data-surface="criterion_form"] textarea').fill('예약 버튼이 첫 화면에서 바로 보인다'); await app.locator('[data-surface="criterion_form"] textarea').focus(); await shot('m-05-learner-mission-and-form-420x900.png', app); }
    const turn = turnLesson(profile.lesson, acceptFocus(profile.lesson, await app.evaluate(() => window.sent.filter((m) => m.type === 'lessonFocus').at(-1))));
    const asked = await withMockUpstream(() => new Response(JSON.stringify(anthropicJsonBody({ text: 'ok' })), { status: 200, headers: { 'content-type': 'application/json' } }), async (calls) => { const ctx = makeCtx();
      const r = await local.app.fetch(new Request('https://service.test/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + code, 'content-type': 'application/json', 'x-hps-lesson-step': turn.step }, body: JSON.stringify({ model: 'claude-mock', max_tokens: 64, tools: permittedToolsFor(profile).map((name) => ({ name, description: name, input_schema: { type: 'object' } })), messages: [{ role: 'user', content: '합성 질문' }] }) }), local.env, ctx);
      await r.text(); await ctx.settle(); return { status: r.status, system: calls.map((c) => String(c.init.body)).join('\n') }; });
    assert.equal(asked.status, 200); assert.match(asked.system, new RegExp('이번 주 미션: \\\\"' + MISSION)); // the request context carries the candidate's mission
    for (const id of ['build', 'review']) { await app.locator('.hp-mission-actions .hp-cta-quiet', { hasText: id }).click(); await app.locator(`[data-lesson-step-panel="${id}"]`).waitFor(); }
    if (tamper) await app.locator('.hp-mission-sentence').evaluate((e, t) => { e.textContent = t; }, tamper);
    await app.locator('[data-rehearsal-send]').click(); const sent = await app.evaluate(() => window.sent.filter((m) => m.type === 'rehearsalSend').at(-1));
    const report = rehearsalReport(profile.lesson, sent.steps, { extension_version: 'webview-dist', host: 'chromium (browser suite)', runtime: 'agent-sdk', os: process.platform, arch: process.arch }, sent.mission);
    const judged = await (await toService('https://service.test/v1/classroom/rehearsal/report', { method: 'POST', headers: { authorization: 'Bearer ' + code, 'content-type': 'application/json' }, body: JSON.stringify(report) })).json();
    await app.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), { type: 'rehearsalState', state: 'sent', verdict: judged.verdict, reasons: judged.reasons });
    await app.locator('[data-rehearsal-result]').waitFor(); assert.deepEqual(appErrors, []);
    return { app, report, judged, field };
  };
  const bad = await learnerSide(EDITED); results.tampered = { mission: bad.report.mission, verdict: bad.judged.verdict, reasons: bad.judged.reasons };
  assert.deepEqual([bad.report.mission.sentence, bad.judged.verdict, bad.judged.reasons], [EDITED, 'failed', ['mission_mismatch']], 'the report is the DOM read-back, and a wrong header cannot pass');
  await page.locator('#readiness-load').click(); await page.locator('#readiness').filter({ hasText: '학생 화면의 미션이 이 후보와 다릅니다' }).waitFor();
  assert.match(await page.locator('#readiness').innerText(), new RegExp('리허설 학생 화면의 미션: 이 후보와 달랐습니다 — ‘' + EDITED + '’'));
  await page.locator('#rehearsal').scrollIntoViewIfNeeded(); await shot('m-04-rehearsal-wrong-mission-1280x720.png'); await bad.app.close();
  ok('rehearsal: a learner header showing another mission (DOM read-back) fails with mission_mismatch, in the teacher\'s words');

  // ── 7. rehearsal 2: the honest header passes; the teacher sees the mission check; the work form uses the dark theme ──
  const good = await learnerSide(null); results.passed = { mission: good.report.mission, verdict: good.judged.verdict };
  assert.equal(good.judged.verdict, 'passed', JSON.stringify(good.judged)); assert.equal(good.judged.checks.mission.result, 'match');
  const field = good.field; results.criterion_field = field; assert.notEqual(field.bg, 'rgb(255, 255, 255)', 'the criterion field is not a platform-white strip'); assert.notEqual(field.bg, field.color); await good.app.close();
  await page.locator('#readiness-load').click(); await page.locator('#readiness').filter({ hasText: '통과 — 학생 조건에서 설계대로 실행됐습니다' }).waitFor();
  assert.match(await page.locator('#readiness').innerText(), /리허설 학생 화면의 미션: 이 후보와 같았습니다/);
  await page.locator('#rehearsal').scrollIntoViewIfNeeded(); await shot('m-06-rehearsal-mission-passed-1280x720.png');
  ok('rehearsal: the honest header passes with a matching mission; the criterion field is themed, not a white strip');

  // ── 8. edit the mission after the pass: a new candidate, untested; confirmation names the mission; the picker shows it ──
  await page.locator('#confirm-go').click(); await page.locator('#confirm-status').filter({ hasText: '확정했습니다' }).waitFor();
  await page.locator('#learning-mission').fill(EDITED); await page.locator('#save').click(); await waitStatus(/저장했습니다/);
  assert.match(await page.locator('#readiness').innerText(), /초안이 바뀌었습니다/);
  await page.locator('#versions-load').click(); await page.locator(`#base-version option[value="${VA}"]`).waitFor({ state: 'attached' });
  await page.locator('#base-version').selectOption(VA); await page.waitForTimeout(300); await page.locator('#impact').click(); await page.locator('#impact-view li').first().waitFor();
  assert.ok((await page.locator('#impact-view li').allInnerTexts()).includes('학생 미션: 2주차 ‘' + MISSION + '’ → 2주차 ‘' + EDITED + '’'));
  await page.locator('#version').fill(VB); await page.locator('#freeze').click(); await page.locator('#completion').filter({ hasText: VB }).waitFor();
  const rb = await page.locator('#readiness').innerText(); assert.match(rb, /후보 m2026\.09\.22-52 · 리허설 전/); assert.match(rb, new RegExp('이 후보의 학생 미션: 2주차 ‘' + EDITED + '’')); assert.equal(await page.locator('#confirm-go').isDisabled(), true);
  await page.locator('#rehearsal').scrollIntoViewIfNeeded(); await shot('m-07-edited-mission-new-candidate-1280x720.png');
  const manage = await browser.newPage({ viewport: { width: 1280, height: 720 } }); manage.on('pageerror', (e) => errors.push(e.message));
  await manage.goto(origin + '/manage'); await manage.locator('#token').fill(teacher); await manage.locator('#cohort').fill(local.cohort); await manage.locator('#prefix').fill('student-');
  await manage.locator('#connect button').first().click(); await manage.locator('#status').filter({ hasText: '연결됨' }).waitFor();
  if (!(await manage.locator('#ops-dist').evaluate((d) => d.open))) await manage.locator('#ops-dist-summary').click();
  await manage.locator('#ops-dist-kind').selectOption('setting'); await manage.locator(`#ops-dist-setting option[value="${VA}"]`).waitFor({ state: 'attached' });
  const options = await manage.locator('#ops-dist-setting option').evaluateAll((os) => os.map((o) => [o.value, o.textContent, o.disabled])); results.setting_options = options;
  assert.ok(options.some(([v, t, d]) => v === VA && t.includes('미션 ‘' + MISSION + '’') && /확정됨/.test(t) && !d), JSON.stringify(options));
  await manage.locator('#ops-dist-setting').selectOption(VA);
  assert.match(await manage.locator('#ops-dist-setting-impact').innerText(), new RegExp('미션: 미션 없음 → 2주차 ‘' + MISSION + '’'));
  await manage.screenshot({ path: path.join(out, 'm-08-manage-picker-mission-1280x720.png') });
  ok('after the pass: an edited mission is its own untested candidate; the confirmed one is picked by its mission and the send review names it');

  assert.deepEqual(errors, [], 'no page errors');
  writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: n, ...results }, null, 2));
} finally { await browser?.close(); chalkServer.close(); webviewServer.close(); globalThis.fetch = realFetch; local.close(); }
console.log(`${n} authoring mission browser checks passed`);
