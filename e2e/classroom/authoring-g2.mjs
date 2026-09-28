// #751 G2 · #1012 — the teacher journey in a real browser: edit a reusable curriculum (audience, example, step help, work
// surface, allowed features) → concrete difference review → freeze a candidate → learner-condition rehearsal → deliberate
// confirmation → the class setting picker offers only the confirmed version.
//
// Real here: the Chalk /authoring and /manage pages and their scripts in Chromium (the teacher clicks everything), the
// Service router + SQLite, the BUILT Studio webview in Chromium drawing the rehearsal lesson (help choices, work surface) and
// reading back what it drew, the App's own pure rules (lessonFocus.ts: which step/help a turn carries, the report) and its
// SDK tool mapping (permittedToolsFor) for the tools a request carries.
// Controlled here: the model provider (a recorder answering a protocol-complete message — nothing about a real model) and
// the wire requests (sent with the headers the App builds). Synthetic accounts. No real Studio window (that is the Mac run).
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

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), out = path.join(repo, 'e2e/test-results/classroom-authoring-g2'); mkdirSync(out, { recursive: true });
const dist = path.join(repo, 'extensions/hypeproof-chat/webview-ui/dist'); assert.ok(existsSync(path.join(dist, 'index.html')), 'build the webview first: npm --prefix extensions/hypeproof-chat/webview-ui run build');
const local = await localOps(), { default: chalk } = await import('../../chalk/src/index.ts'), { setRoster } = await import('../../worker/src/lib/kv.ts'), { issueIssuer } = await import('../../worker/src/lib/tokens.ts');
local.env.HPS_LESSON_BINDINGS = 'enforce'; local.env.ANTHROPIC_API_KEY = 'test-anthropic-key'; local.env.HPS_LESSON_CONFIRMATION = 'require';
const realFetch = globalThis.fetch, toService = (url, init) => local.app.fetch(new Request(url, init), local.env, makeCtx());
globalThis.fetch = (url, init) => String(url).startsWith('https://service.test') ? toService(url, init) : realFetch(url, init);
const serve = async (handler) => { const s = createServer(handler); s.listen(0, '127.0.0.1'); await once(s, 'listening'); return s; };
const chalkServer = await serve(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts); const r = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); } catch (e) { res.writeHead(500); res.end(String(e)); } });
const webviewServer = await serve((req, res) => { const name = new URL(req.url, 'http://x').pathname.replace(/^\/$/, '/index.html'), file = path.resolve(dist, '.' + name); if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(readFileSync(file)); });
let n = 0; const ok = (name) => { n++; console.log('PASS ' + name); }; let browser; const results = {};
try {
  const course = local.lesson.course_id, V1 = local.lesson.version;
  const seats = ['a', 'b', 'c'].map((x, i) => ({ seat_id: 'A' + (i + 1), student_id: 'student-' + x }));
  await setRoster(local.env.HPS_KV, local.cohort, [...seats.map((s) => s.student_id), 'rehearsal-t1']);
  await local.freeze(course, V1, ['intro', 'build', 'review']);
  assert.equal((await local.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_distribute: true, ops_lesson_settings: true } })).status, 201);
  // The course owner (teacher-a) with the operations capabilities, long enough for the whole journey.
  const teacher = (await issueIssuer({ issuer: 'teacher-a', scopes: [{ cohort: local.cohort, profiles: [local.profile], ops: [...OPS_ALL, 'distribute', 'lesson_settings'] }] }, 6, TEST_SECRET)).token;

  browser = await chromium.launch(); const origin = 'http://127.0.0.1:' + chalkServer.address().port;
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } }), errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('dialog', (d) => d.accept());
  const status = () => page.locator('#status').innerText(), shot = (name) => page.screenshot({ path: path.join(out, name), fullPage: false });
  const waitStatus = async (re) => { await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('status').textContent), re.source); };

  // ── 1. connect, open the class's course, reuse V1 as the body, then EDIT it into curriculum A with the ordinary controls ──
  await page.goto(origin + '/authoring'); await page.locator('#token').fill(teacher); await page.locator('#connect').click();
  await page.locator('#connection-status').filter({ hasText: '연결되었습니다' }).waitFor();
  await page.locator('summary', { hasText: '저장한 강의 열기' }).click(); await page.locator('#course').fill(course); await page.locator('#load').click(); await waitStatus(/저장본을 열었습니다/);
  await page.locator('#versions-load').click(); await waitStatus(/버전 1개를 불러왔습니다/);
  await page.locator('#base-version').selectOption(V1); await page.locator('#reuse-step option').nth(1).waitFor({ state: 'attached' });
  await page.locator('#reuse-all').click(); await waitStatus(/의 내용으로 초안을 채웠습니다/);
  await page.locator('#title').fill('첫 시제품 — 예약 안내 페이지'); await page.locator('#audience').fill('처음 만들어 보는 원장님'); await page.locator('#objective').fill('예약 안내 페이지의 첫 판을 만들고 확인 기준을 스스로 정한다'); await page.locator('#starter').fill('예약 안내 페이지 예제 폴더');
  const step0 = page.locator('.step').nth(0);
  await step0.locator('[data-field="title"]').fill('확인 기준 정하기'); await step0.locator('[data-field="acceptance"]').fill('저장한 확인 기준 한 줄이 있다');
  for (const m of ['hint', 'independent']) await step0.locator(`[data-help-mode="${m}"]`).check();
  await step0.locator('[data-help-default]').selectOption('hint'); await step0.locator('[data-ui]').selectOption('criterion_form');
  await page.locator('summary', { hasText: '추가 자료 · AI 설정' }).click();
  await page.locator('#features-load').click(); await page.locator('#features-status').filter({ hasText: '이 코호트가 가진 기능' }).waitFor();
  await page.locator('#feature-mode').selectOption('narrow'); for (const box of await page.locator('#feature-allowed input').all()) { if ((await box.getAttribute('value')) !== 'read') await box.uncheck(); }
  await step0.scrollIntoViewIfNeeded(); await shot('g2-01-authoring-step-help-surface-1280x720.png');
  await page.locator('#save').click(); await waitStatus(/저장했습니다/);
  const saved = (await local.request(`/admin/cohorts/${local.cohort}/authoring/${course}`, 'GET', undefined, teacher)).json.content;
  assert.deepEqual([saved.steps[0].help, saved.steps[0].ui, saved.features.allowed, saved.audience], [{ default: 'hint', allowed: ['hint', 'independent'] }, 'criterion_form', ['read'], '처음 만들어 보는 원장님'], 'the controls saved help, surface, narrowing and audience');
  assert.deepEqual(saved.steps.map((s) => s.id), ['intro', 'build', 'review'], 'reuse kept the version\'s steps');
  ok('authoring: a confirmed version reused as the body, then help/surface/features/audience edited with ordinary controls and saved');

  // ── 2. concrete difference review against V1 ──
  await page.locator('#impact').click(); await page.locator('#impact-view li').first().waitFor();
  const impact = await page.locator('#impact-view li').allInnerTexts(); results.impact = impact;
  assert.ok(impact.some((l) => /^대상: ‘합성 사용자’ → ‘처음 만들어 보는 원장님’/.test(l)), impact.join('\n'));
  assert.ok(impact.some((l) => /단계 intro: .*도움 방식 도움 방식 선택 없음 → 힌트 받기·직접 해보기 \(처음: 힌트 받기\).*작업 화면 대화로 진행 \(기본\) → 확인 기준 적기 양식/.test(l)), impact.join('\n'));
  assert.ok(impact.some((l) => /^허용 기능: 코호트 기본 → read/.test(l)), impact.join('\n'));
  await page.locator('#review').scrollIntoViewIfNeeded(); await shot('g2-02-difference-review-1280x720.png');
  ok('review: the differences are named in teacher words — audience, per-step help and work surface, allowed features');

  // ── 3. candidate A → rehearsal code → running (not ready) ──
  await page.locator('#version').evaluate((e) => { e.closest('details').open = true; }); await page.locator('#version').fill('m2026.09.22-21');
  await page.locator('#freeze').click(); await page.locator('#completion').filter({ hasText: '리허설 후보' }).waitFor({ timeout: 8000 }).catch(async (e) => { throw Error('freeze: ' + await status() + ' / ' + e.message); });
  assert.match(await page.locator('#readiness').innerText(), /후보 m2026\.09\.22-21 · 리허설 전/);
  assert.equal(await page.locator('#confirm-go').isDisabled(), true, 'a candidate that was not rehearsed cannot be confirmed');
  await page.locator('#rehearsal-learner').fill('rehearsal-t1'); await page.locator('#rehearsal-issue').click(); await waitStatus(/리허설 코드를 발급했습니다/);
  const code = await page.locator('#rehearsal-token').inputValue(); assert.ok(code.length > 40);
  assert.match(await page.locator('#readiness').innerText(), /리허설 중 — 코드를 발급했고 Studio의 결과를 기다립니다 \(준비 완료 아님\)/);
  assert.equal(await page.locator('#confirm-go').isDisabled(), true, 'issuing the code is not readiness');
  await page.locator('#rehearsal').scrollIntoViewIfNeeded(); await shot('g2-03-rehearsal-running-1280x720.png');

  // In-flight edit: the teacher changes the draft while A's rehearsal runs.
  await step0.locator('[data-help-mode="demonstrate"]').check(); await page.locator('#save').click(); await waitStatus(/저장했습니다/);
  await page.locator('#readiness-load').click(); await page.locator('#readiness').filter({ hasText: '초안이 바뀌었습니다' }).waitFor({ timeout: 6000 }).catch(async (e) => { throw Error('readiness: ' + await page.locator('#readiness').innerText() + ' | status: ' + await status() + ' | ' + JSON.stringify(await page.locator('#readiness-detail').innerText()).slice(0, 400)); });
  ok('candidate + code: freezing and issuing are shown as "not ready"; an edit during the rehearsal is named, not absorbed');

  // ── 4. the learner side of the rehearsal: the BUILT webview draws A, the App's rules carry step/help, the report goes out ──
  const profile = await (await toService('https://service.test/v1/profile', { headers: { authorization: 'Bearer ' + code } })).json();
  assert.equal(profile.rehearsal.version, 'm2026.09.22-21'); assert.equal(profile.sdk_tools.write, false, 'A is read-only on the served profile');
  const app = await browser.newPage({ viewport: { width: 420, height: 900 } }); const appErrors = []; app.on('pageerror', (e) => appErrors.push(e.message));
  await app.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.sent.push(m), getState: () => undefined, setState: () => {} }); });
  await app.goto('http://127.0.0.1:' + webviewServer.address().port + '/'); await app.waitForFunction(() => window.sent.some((m) => m.type === 'ready'));
  const host = (msg) => app.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), msg);
  await host({ type: 'config', config: { proxyUrl: 'http://controlled-host.invalid/v1', model: 'controlled-host-only', hasToken: true, coach: { name: '코치', personality: '', configured: true }, profile } });
  const panel = app.locator('[data-lesson-step-panel]'); await panel.waitFor();
  assert.deepEqual(await panel.locator('input[name="hp-help-mode"]').evaluateAll((xs) => xs.map((x) => [x.value, x.checked])), [['hint', true], ['independent', false]], 'the step offers exactly its help modes, the lesson default checked');
  assert.equal(await panel.locator('[data-surface="criterion_form"]').count(), 1, 'the criterion work surface opens');
  await panel.locator('input[name="hp-help-mode"][value="independent"]').check();
  await app.screenshot({ path: path.join(out, 'g2-04-learner-rehearsal-panel-A.png') });
  const focusMsg = await app.evaluate(() => window.sent.filter((m) => m.type === 'lessonFocus').at(-1));
  const turn = turnLesson(profile.lesson, acceptFocus(profile.lesson, focusMsg)); assert.deepEqual(turn, { step: 'intro', helpMode: 'independent' });
  const ask = async (t) => { const ctx = makeCtx(); return withMockUpstream(() => new Response(JSON.stringify(anthropicJsonBody({ text: 'ok' })), { status: 200, headers: { 'content-type': 'application/json' } }), async (calls) => {
    const r = await local.app.fetch(new Request('https://service.test/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + code, 'content-type': 'application/json', 'x-hps-lesson-step': t.step, ...(t.helpMode ? { 'x-hps-help-mode': t.helpMode } : {}) },
      body: JSON.stringify({ model: 'claude-mock', max_tokens: 64, tools: permittedToolsFor(profile).map((name) => ({ name, description: name, input_schema: { type: 'object' } })), messages: [{ role: 'user', content: '합성 질문' }] }) }), local.env, ctx);
    const body = await r.text(); await ctx.settle(); return { status: r.status, help: r.headers.get('x-hps-help-mode'), system: calls.map((c) => String(c.init.body)).join('\n'), body }; }); };
  const first = await ask(turn); assert.equal(first.status, 200, first.body); assert.match(first.help, /mode=independent; source=student; step=intro/); assert.match(first.system, /직접 해보기/); assert.match(first.system, /처음 만들어 보는 원장님/);
  assert.doesNotMatch(first.system, /"name":"(Write|Edit|MultiEdit)"/, 'no write tool reached the model for read-only A');
  // First try: the learner stays on step 1 and sends. The report says only what was drawn, so this must NOT pass.
  await app.locator('[data-rehearsal-send]').click();
  const sent = await app.evaluate(() => window.sent.filter((m) => m.type === 'rehearsalSend').at(-1)); assert.ok(sent, 'the webview sent its read-back');
  const report = rehearsalReport(profile.lesson, sent.steps, { extension_version: 'webview-dist', host: 'chromium (browser suite)', runtime: 'agent-sdk', os: process.platform, arch: process.arch });
  const judged = await (await toService('https://service.test/v1/classroom/rehearsal/report', { method: 'POST', headers: { authorization: 'Bearer ' + code, 'content-type': 'application/json' }, body: JSON.stringify(report) })).json();
  results.first_report = { steps: report.steps, verdict: judged.verdict, reasons: judged.reasons };
  await host({ type: 'rehearsalState', state: 'sent', verdict: judged.verdict, reasons: judged.reasons });
  await app.locator('[data-rehearsal-result]').waitFor(); await app.screenshot({ path: path.join(out, 'g2-05-learner-rehearsal-result-first.png') });
  ok('learner side: the built webview draws exactly A\'s help modes and criterion surface; the chosen mode travels as the next turn\'s header; the report is a read-back');
  results.first_verdict = judged.verdict;

  // ── 5. the teacher sees the Service's judgement ──
  await page.locator('#readiness-load').click(); await page.waitForTimeout(200);
  const afterFirst = await page.locator('#readiness').innerText(); results.readiness_after_first = afterFirst;
  assert.deepEqual([judged.verdict, judged.reasons], ['failed', ['steps_not_visited']], 'a rehearsal that never opened steps 2–3 is not a pass');
  {
    assert.match(afterFirst, /통과하지 못함 — .*Studio에서 열어 보지 않은 단계가 있습니다/, afterFirst);
    await shot('g2-06-rehearsal-failed-1280x720.png');
    // A second rehearsal of the same candidate, this time every step opened on the learner's screen.
    await page.locator('#rehearsal-issue').click(); await waitStatus(/리허설 코드를 발급했습니다/);
    const code2 = await page.locator('#rehearsal-token').inputValue(); const p2 = await (await toService('https://service.test/v1/profile', { headers: { authorization: 'Bearer ' + code2 } })).json();
    const app2 = await browser.newPage({ viewport: { width: 420, height: 900 } });
    await app2.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.sent.push(m), getState: () => undefined, setState: () => {} }); });
    await app2.goto('http://127.0.0.1:' + webviewServer.address().port + '/'); await app2.waitForFunction(() => window.sent.some((m) => m.type === 'ready'));
    await app2.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), { type: 'config', config: { proxyUrl: 'http://controlled-host.invalid/v1', model: 'controlled-host-only', hasToken: true, coach: { name: '코치', personality: '', configured: true }, profile: p2 } });
    await app2.locator('[data-lesson-step-panel]').waitFor();
    // The learner's own step navigation: the quiet "next step" buttons of the mission header (MissionHeader.tsx).
    for (const id of ['build', 'review']) { await app2.locator('.hp-mission-actions .hp-cta-quiet', { hasText: id }).click(); await app2.locator(`[data-lesson-step-panel="${id}"]`).waitFor(); }
    const code2ask = async (t) => { const ctx = makeCtx(); return withMockUpstream(() => new Response(JSON.stringify(anthropicJsonBody({ text: 'ok' })), { status: 200, headers: { 'content-type': 'application/json' } }), async () => { const r = await local.app.fetch(new Request('https://service.test/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + code2, 'content-type': 'application/json', 'x-hps-lesson-step': t.step }, body: JSON.stringify({ model: 'claude-mock', max_tokens: 64, tools: permittedToolsFor(p2).map((name) => ({ name, description: name, input_schema: { type: 'object' } })), messages: [{ role: 'user', content: '합성 질문' }] }) }), local.env, ctx); await r.text(); await ctx.settle(); return r.status; }); };
    assert.equal(await code2ask({ step: 'intro' }), 200);
    await app2.locator('[data-rehearsal-send]').click(); const s2 = await app2.evaluate(() => window.sent.filter((m) => m.type === 'rehearsalSend').at(-1));
    const rep2 = rehearsalReport(p2.lesson, s2.steps, { extension_version: 'webview-dist', host: 'chromium (browser suite)', runtime: 'agent-sdk', os: process.platform, arch: process.arch });
    const j2 = await (await toService('https://service.test/v1/classroom/rehearsal/report', { method: 'POST', headers: { authorization: 'Bearer ' + code2, 'content-type': 'application/json' }, body: JSON.stringify(rep2) })).json();
    results.second_report = { steps: rep2.steps, verdict: j2.verdict, reasons: j2.reasons }; assert.equal(j2.verdict, 'passed', JSON.stringify(j2));
    await app2.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), { type: 'rehearsalState', state: 'sent', verdict: j2.verdict, reasons: j2.reasons });
    await app2.locator('[data-rehearsal-result="passed"]').waitFor(); await app2.screenshot({ path: path.join(out, 'g2-07-learner-rehearsal-passed.png') });
    await page.locator('#readiness-load').click(); await page.waitForTimeout(200);
  }
  assert.match(await page.locator('#readiness').innerText(), /통과 — 학생 조건에서 설계대로 실행됐습니다/);
  assert.match(await page.locator('#readiness').innerText(), /초안이 바뀌었습니다/, 'the pass is for the candidate; the edited draft is named as untested');
  await page.locator('#readiness-detail').evaluate((e) => { e.closest('details').open = true; });
  await page.locator('#rehearsal').scrollIntoViewIfNeeded(); await shot('g2-08-rehearsal-passed-1280x720.png');
  ok('teacher: failed and passed are the Service\'s judgements in words, with the evidence under detail');

  // ── 6. confirm A; freeze the edited draft as B — B inherits nothing and cannot be confirmed ──
  assert.equal(await page.locator('#confirm-go').isDisabled(), false);
  await page.locator('#confirm-go').click(); await page.locator('#confirm-status').filter({ hasText: '확정했습니다' }).waitFor();
  await page.locator('#confirm').scrollIntoViewIfNeeded(); await shot('g2-09-confirmed-1280x720.png');
  await page.locator('#version').fill('m2026.09.22-22'); await page.locator('#freeze').click(); await page.locator('#completion').filter({ hasText: 'm2026.09.22-22' }).waitFor();
  assert.match(await page.locator('#readiness').innerText(), /후보 m2026\.09\.22-22 · 리허설 전/); assert.equal(await page.locator('#confirm-go').isDisabled(), true);
  await shot('g2-10-edited-candidate-untested-1280x720.png');
  ok('confirmation: only the passed candidate; the draft edited during its rehearsal becomes its own untested candidate');

  // ── 7. the class setting picker on /manage offers the confirmed version and names why the other cannot be picked ──
  const manage = await browser.newPage({ viewport: { width: 1280, height: 720 } }); manage.on('pageerror', (e) => errors.push(e.message));
  await manage.goto(origin + '/manage'); await manage.locator('#token').fill(teacher); await manage.locator('#cohort').fill(local.cohort); await manage.locator('#prefix').fill('student-');
  await manage.locator('#connect button').first().click(); await manage.locator('#status').filter({ hasText: '연결됨' }).waitFor();
  if (!(await manage.locator('#ops-dist').evaluate((d) => d.open))) await manage.locator('#ops-dist-summary').click();
  await manage.locator('#ops-dist-kind').selectOption('setting'); await manage.locator('#ops-dist-setting option[value="m2026.09.22-21"]').waitFor({ state: 'attached' });
  const options = await manage.locator('#ops-dist-setting option').evaluateAll((os) => os.map((o) => [o.value, o.textContent, o.disabled])); results.setting_options = options;
  assert.ok(options.some(([v, t, d]) => v === 'm2026.09.22-21' && /리허설 통과·확정됨/.test(t) && !d), JSON.stringify(options));
  assert.ok(options.some(([v, t, d]) => v === 'm2026.09.22-22' && /고를 수 없음 \(리허설 통과 뒤 확정 전\)/.test(t) && d), JSON.stringify(options));
  await manage.screenshot({ path: path.join(out, 'g2-11-manage-setting-picker-1280x720.png') });
  ok('distribution entry: the U3 picker offers the confirmed version and disables the unconfirmed one with its reason');

  assert.deepEqual(errors, [], 'no page errors'); assert.deepEqual(appErrors, [], 'no webview errors');
  writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: n, ...results }, null, 2));
} finally { await browser?.close(); chalkServer.close(); webviewServer.close(); globalThis.fetch = realFetch; local.close(); }
console.log(`${n} authoring G2 browser checks passed`);
