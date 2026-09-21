// #751 review follow-up — the path the earlier browser test skipped, end to end with real parts:
//   built Studio webview (real click) → the provider's step mapping → the REAL ClassroomOpsHost (VS Code stubbed at the
//   bundle boundary) → real Service routes + SQLite → actual Chalk /manage in Chromium.
// Plus the 30-seat list + selected-student detail (side pane / drawer), a common incident, keyboard, 200 % zoom, small
// screens, "수업 마무리" → evaluation → review queue, and the explicit real-send step.
// Synthetic accounts; the evaluator and mail provider are replaced at their transport seams. NOT a real Studio app,
// SDK, school network, D1/R2, model or mailbox.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { localOps } from '../../worker/test/harness/classroom-ops.mjs';
import { SessionSpool } from '../../extensions/hypeproof-chat/src/sessionSpool.ts';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), out = path.join(repo, 'e2e/test-results/classroom-ops-roster'); mkdirSync(out, { recursive: true });
const local = await localOps(); const { default: chalk } = await import('../../chalk/src/index.ts');
const { setEvaluatorTransport } = await import('../../worker/src/routes/classroom-reports.ts'), { setResendFetch } = await import('../../worker/src/routes/classroom-delivery.ts'), { setRoster } = await import('../../worker/src/lib/kv.ts');
const { lessonStepSignal } = await import('../../extensions/hypeproof-chat/src/chatPanelHelpers.ts');
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => String(url).startsWith('https://service.test') ? local.app.fetch(new Request(url, init), local.env, { waitUntil() {} }) : realFetch(url, init);
const serve = (handler) => { const s = createServer(handler); s.listen(0, '127.0.0.1'); return once(s, 'listening').then(() => s); };
const chalkServer = await serve(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts); const r = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); } catch (e) { res.writeHead(500); res.end(String(e)); } });
const dist = path.join(repo, 'extensions/hypeproof-chat/webview-ui/dist'); assert.ok(existsSync(path.join(dist, 'index.html')), 'build the webview first: npm --prefix extensions/hypeproof-chat/webview-ui run build');
const webviewServer = await serve((req, res) => { const name = new URL(req.url, 'http://x').pathname.replace(/^\/$/, '/index.html'), file = path.resolve(dist, '.' + name); if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404); res.end(); return; } res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(readFileSync(file)); });
let n = 0; const ok = (name) => { n++; console.log('PASS ' + name); };
let browser;
try {
  // ── a 30-seat class run ──
  const seats = Array.from({ length: 30 }, (_, i) => ({ seat_id: 'S' + String(i + 1).padStart(2, '0'), student_id: 'student-' + String(i + 1).padStart(2, '0') }));
  await setRoster(local.env.HPS_KV, local.cohort, [...seats.map((s) => s.student_id), 'student-walk-in']); await local.freeze();
  assert.equal((await local.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true, ops_delivery: true } })).status, 201);
  browser = await chromium.launch();

  // ── leg 1: the learner's real click in the built webview ──
  const studentToken = await local.student('student-01'), profile = (await local.request('/v1/profile', 'GET', undefined, studentToken)).json; assert.ok(profile.profile_id, 'real /v1/profile serialization');
  const design = { schema: 'hps-session-design/1', title: '합성 수업', audience: '합성 사용자', duration_minutes: 60, objective: '원격 운영 시험', prerequisites: '코딩 경험 불필요', starter: '연습 폴더', steps: ['intro', 'build', 'review'].map((id) => ({ id, title: id, instructions: '합성 단계', hint: '', acceptance: '합성 기준' })) };
  const lesson = { course_id: local.lesson.course_id, version: local.lesson.version, sha256: 'a'.repeat(64), content: design }; // the confirmed lesson of this run (controlled: lesson delivery itself is not under test here)
  const app = await browser.newPage({ viewport: { width: 420, height: 900 } }); const appErrors = []; app.on('pageerror', (e) => appErrors.push(e.message));
  await app.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.sent.push(m), getState: () => undefined, setState: () => {} }); });
  await app.goto('http://127.0.0.1:' + webviewServer.address().port + '/'); await app.waitForFunction(() => window.sent.some((m) => m.type === 'ready'));
  await app.evaluate((config) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'config', config } })), { proxyUrl: 'http://controlled-host.invalid/v1', model: 'controlled-host-only', hasToken: true, coach: { name: '코치', personality: '', configured: true }, profile: { ...profile, lesson } });
  // The learning-first screen (#1170/#1178): pick the second step in the mission header, start it with the screen's ONE Primary, then report it.
  const mission = app.locator('.hp-mission'); await mission.locator('.hp-mission-actions').getByRole('button', { name: 'build' }).click();
  assert.equal(await app.locator('.hp-cta-primary').count(), 1, 'the class report does not add a second Primary to the learner screen');
  await mission.locator('.hp-cta-primary', { hasText: 'build' }).click(); const report = app.locator('.hp-rail-step-report'); await report.getByRole('button', { name: '이 단계를 마쳤어요' }).click();
  assert.equal(await report.getByRole('button', { name: '마쳤다고 표시함 · 강사 확인 전' }).isDisabled(), true, 'the learner sees it as their own statement, not as a pass');
  const stepMessages = (await app.evaluate(() => window.sent)).filter((m) => m.type === 'lessonStep'); assert.deepEqual(stepMessages.map((m) => [m.stepId, m.status]), [['build', 'in_progress'], ['build', 'submitted']]); assert.deepEqual(appErrors, []);
  await app.screenshot({ path: path.join(out, 'app-lesson-step.png'), fullPage: true }); await app.close(); ok('webview: the learner\'s own click produces the step messages');

  // ── leg 2: the real host, paired with a real ticket, reports what the provider would tell it ──
  const dir = mkdtempSync(path.join(tmpdir(), 'hps-ops-roster-')), bundled = path.join(dir, 'host.cjs');
  await build({ entryPoints: [path.join(repo, 'extensions/hypeproof-chat/src/classroomOpsHost.ts')], outfile: bundled, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{ name: 'vscode-stub', setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ loader: 'js', contents: 'const w={showInputBox:async()=>globalThis.__hpsTicket,showInformationMessage:async(_m,o,...items)=>(o&&o.modal?items[0]:undefined),showWarningMessage:async()=>undefined,showQuickPick:async()=>undefined};export const window=w;export const workspace={getConfiguration:()=>({get:()=>"https://service.test/v1"})};' })); } }] });
  const { ClassroomOpsHost } = createRequire(import.meta.url)(bundled);
  const state = new Map(), secrets = new Map();
  const context = { globalState: { get: (k) => state.get(k), update: async (k, v) => { v === undefined ? state.delete(k) : state.set(k, v); } }, secrets: { get: async (k) => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async (k) => secrets.delete(k) }, globalStorageUri: { fsPath: dir }, subscriptions: [], extension: { packageJSON: { version: '0.1.5-e2e' } } };
  // The learner's record is written by the REAL SessionSpool (its own seq and session metadata), and read the way the App reads it.
  const liveSpool = new SessionSpool({ root: path.join(dir, 'spool'), appVersion: '0.1.5-e2e', os: { platform: process.platform, release: 'e2e', arch: process.arch } }); liveSpool.noteIdentity({ u: 'student-01', c: local.cohort, p: local.profile });
  liveSpool.recordPrompt({ turnId: 't1', runtime: 'agent-sdk', text: '예약 버튼이 모바일에서 눌리는지 먼저 확인하고 싶어요' }); liveSpool.recordResponse({ turnId: 't1', runtime: 'agent-sdk', status: 'ok', text: 'AI 응답' }); liveSpool.recordTurnEnd({ turnId: 't1', status: 'ok', runtime: 'agent-sdk' }); await liveSpool.flush();
  const host = new ClassroomOpsHost(context, () => ({ idleMs: 0, status: 'idle' }), { hasActiveRun: () => false, probeProfile: async () => ({ ok: true }), refreshProfile: async () => true, recoverPreview: async () => ({ state: 'no_preview', healthy: false }), requestStop() {}, freezeInput: async () => {}, preservation: async () => ({ messages: 0, files: [] }), runtimeGeneration: () => 1, newGeneration: async () => 2, setHold() {}, readSpool: (sinceMs) => liveSpool.readForSnapshot(sinceMs) }, () => {});
  globalThis.__hpsTicket = (await local.request(local.base + '/pairings', 'POST', { seat_id: 'S01', roster_revision: 1 })).json.ticket; await host.connectInteractively();
  assert.ok(secrets.size === 1 && state.get('hypeproof.classroomOps.connection').student.u === 'student-01', 'paired; the binding scope came from the Service');
  host.profileResult({ ok: true }, studentToken); host.traceResult(200);
  for (const m of stepMessages) { const signal = lessonStepSignal(lesson, m); host.lessonStep(signal.lesson_version, signal.step_id, signal.status); } // exactly what chatPanelProvider does with the message
  host.turnResult({ ok: true, runtime: 'proxy', sdkFallback: true }); host.artifactChanged(undefined, 'b'.repeat(64));
  const seatOf = async (id) => (await local.request(local.base + '/status')).json.seats.find((s) => s.seat_id === id);
  const until = async (fn, what) => { for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } throw Error('timed out: ' + what); };
  const s01 = await until(async () => { const s = await seatOf('S01'); return s?.step?.status === 'submitted' && s.error?.class === 'sdk_not_ready' && s.entry_stage === 'runtime_ready' ? s : null; }, 'the host\'s own sync loop delivers the signals'); // the connect-time token check reports first; wait for the turn's own signals
  assert.deepEqual([s01.entry_stage, s01.step.step_id, s01.step.actor, s01.error.class, s01.error.blocking, s01.attention !== 'blocked'], ['runtime_ready', 'build', 'student', 'sdk_not_ready', false, true], 'SDK fallback is reported, and is not a red fault because the turn went on');
  assert.deepEqual(s01.observes, { step: true, runtime: true, evidence: true }); assert.deepEqual(s01.evidence.latest.map((e) => [e.evidence_type, e.source_state, e.actor]).sort(), [['change', 'real', 'ai'], ['decision', 'self_reported', 'student']]);
  assert.ok(!JSON.stringify(s01).includes('예약 버튼'), 'no learner text rides the status channel'); ok('host: real sync delivers step, runtime, SDK-fallback and evidence with provenance');
  // An older build (no observe_* capability) and nine seats hit by one provider outage.
  const old = (await local.pair('S02', 1, 2)).conn.json; await local.sync(old.credential, [local.event(1, 'activation', { stage: 'token_verified' })], 2);
  // A shared cause is called out at 30 % of the run (9 of 30): below that it could be individual PCs.
  for (let i = 3; i <= 11; i++) { const c = (await local.pair('S' + String(i).padStart(2, '0'), 1, i)).conn.json; await local.sync(c.credential, [local.event(1, 'error', { class: 'provider_5xx', code: 'http_503', blocking: true })], i); }

  // ── leg 3: what the instructor sees ──
  const origin = 'http://127.0.0.1:' + chalkServer.address().port, page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin + '/manage'); await page.locator('#token').fill(local.teacherToken); await page.locator('#cohort').fill(local.cohort); await page.locator('#prefix').fill('student-');
  await page.locator('#connect button').first().click(); await page.locator('#status').filter({ hasText: '연결됨' }).waitFor(); await page.locator('#ops-check').click(); await page.locator('#ops-seats .ops-seat').nth(29).waitFor({ timeout: 8000 }).catch(async (e) => { throw Error('roster did not render: ' + (await page.locator('#ops-state').innerText()) + ' | ' + errors.join(';') + ' | rows=' + (await page.locator('#ops-seats .ops-seat').count()), { cause: e }); });
  assert.equal(await page.locator('#ops-seats .ops-seat').count(), 30); const row = (id) => page.locator(`#ops-seats .ops-seat[data-seat="${id}"]`);
  assert.match(await row('S01').innerText(), /build · 제출함/); assert.match(await row('S01').innerText(), /AI 실행 환경이 준비되지 않았습니다/); assert.equal(await row('S01').locator('p.blocked').count(), 0, 'a non-blocking fallback is not red');
  assert.match(await row('S02').innerText(), /확인 불가 \(이 앱은 단계를 보고하지 않음\)/, 'an older build is unknown, not "nothing happened"'); assert.match(await row('S30').innerText(), /기기 연결 안 됨/);
  assert.match(await page.locator('#ops-incidents').innerText(), /AI 제공자 장애 · 영향 9명 · 공통 원인일 가능성이 높아 개별 PC 초기화를 권하지 않습니다/);
  // One list, not two: learners of this run are no longer repeated in the old panel; only someone outside the run stays there.
  assert.match(await page.locator('#merged').innerText(), /학생 30명은 위 ‘이번 수업 학생’ 목록 한 곳에/); assert.deepEqual([await page.locator('#seats .seat').count(), await page.locator('#seats .seat:visible').count(), (await page.locator('#seats .seat:visible').innerText()).includes('student-walk-in')], [31, 1, true], 'the 30 run learners are shown once; the one learner outside the run stays in the old panel');
  ok('chalk: 30 seats, real App signals, unknown vs none, shared incident, de-duplicated list');

  // list + detail: side by side when wide; keyboard in and out; the list scrolls on its own
  await row('S01').getByRole('button', { name: '근거·조치' }).focus(); await page.keyboard.press('Enter'); await page.locator('#ops-detail').waitFor();
  const boxes = await page.evaluate(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); return { list: r('ops-seats'), detail: r('ops-detail'), position: getComputedStyle(document.getElementById('ops-detail')).position }; });
  assert.ok(boxes.position === 'sticky' && boxes.detail.left >= boxes.list.right - 1 && boxes.detail.top < 900, 'wide: detail beside the list, in view — not at the bottom of a long page: ' + JSON.stringify(boxes));
  assert.equal(await row('S01').getAttribute('aria-current'), 'true'); assert.match(await page.locator('#ops-evidence').innerText(), /학생 자기보고/);
  assert.equal(await page.locator('.primary:visible').count(), 1, 'one primary CTA on the screen'); assert.ok(await page.evaluate(() => { const l = document.getElementById('ops-seats'); return l.scrollHeight > l.clientHeight; }), 'the 30-seat list scrolls inside its own region');
  await page.screenshot({ path: path.join(out, 'wide-1440.png') });
  // reviewed: the instructor records that they looked at the step the learner said they finished. The learner's status stays as reported.
  assert.match(await row('S01').innerText(), /build · 제출함 \(학생 자기보고 · 강사 확인 전\)/); await page.getByRole('button', { name: '결과를 확인했어요' }).click();
  await page.locator('#ops-detail-status').filter({ hasText: '확인 상태를 저장했습니다' }).waitFor(); await row('S01').getByText(/build · 제출함 \(강사 확인함\)/).waitFor();
  assert.equal(await page.getByRole('button', { name: '결과를 확인했어요' }).isDisabled(), true); assert.match(await page.locator('#ops-evidence').innerText(), /점수·수업 완료·발송 승인이 아닙니다/);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#ops-detail').isHidden(), true); assert.equal(await page.evaluate(() => document.activeElement?.closest('.ops-seat')?.dataset.seat), 'S01');
  for (const [name, viewport, scale] of [['laptop-1024', { width: 1024, height: 700 }, 1], ['zoom-200', { width: 720, height: 450 }, 2], ['phone-390', { width: 390, height: 800 }, 1]]) {
    const p = await browser.newPage({ viewport, deviceScaleFactor: scale }); await p.goto(origin + '/manage'); await p.locator('#token').fill(local.teacherToken); await p.locator('#cohort').fill(local.cohort); await p.locator('#connect button').first().click(); await p.locator('#status').filter({ hasText: '연결됨' }).waitFor(); await p.locator('#ops-check').click(); await p.locator('#ops-seats .ops-seat').nth(29).waitFor();
    await p.locator('#ops-seats .ops-seat[data-seat="S03"]').getByRole('button', { name: '근거·조치' }).click(); await p.locator('#ops-detail').waitFor();
    const d = await p.evaluate(() => { const e = document.getElementById('ops-detail'), r = e.getBoundingClientRect(); return { position: getComputedStyle(e).position, right: Math.round(r.right), top: Math.round(r.top), width: r.width, vw: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1 }; });
    assert.ok(d.position === 'fixed' && d.top === 0 && d.right === d.vw && d.width <= d.vw && !d.overflow, name + ': narrow screens get a drawer over the list, no horizontal scroll: ' + JSON.stringify(d));
    assert.equal(await p.locator('.primary:visible').count(), 1, name + ': one primary CTA'); assert.equal(await p.locator('#ops-detail .primary').count(), 0, 'S03 is in the shared provider outage → the Service names no per-PC first action, so the drawer offers none (UI pass 2)'); assert.match(await p.locator('#ops-actions').innerText(), /이 좌석에서 먼저 할 개별 조치는 없습니다/);
    for (const b of await p.locator('#ops-detail button:visible').all()) { const box = await b.boundingBox(); assert.ok(box.height >= 44, name + ': 44px targets'); }
    await p.screenshot({ path: path.join(out, name + '.png') }); await p.locator('#ops-backdrop').click({ position: { x: 5, y: 5 } }).catch(() => p.keyboard.press('Escape')); assert.equal(await p.locator('#ops-detail').isHidden(), true); await p.close();
  }
  ok('chalk: side pane when wide, reviewed input, drawer at 1024 / 200 % zoom / 390, keyboard open-close, focus return, 44px targets');

  // ── AT-37/38: one selection model → collect the class record of the SELECTED learners only (UI → Service → real host) ──
  await host.collectionConsentInteractively(); // the adult learner agrees in the app (modal stub answers "동의")
  let selectedEvaluatorCalls = 0; local.env.HPS_CLASSROOM_EVALUATOR = 'service-anthropic'; local.env.ANTHROPIC_API_KEY = 'synthetic-not-a-key'; setEvaluatorTransport(async () => { selectedEvaluatorCalls++; return Response.json({ content: [{ type: 'text', text: '{}' }] }); });
  const selection = () => page.locator('#ops-selection').innerText(), asked = () => local.db.prepare("SELECT count(*) n FROM ops_commands WHERE action='retry_evidence_upload'").get().n;
  for (const [button, expected] of [['ops-select-all', /선택 30 \/ 전체 30석 \(명단 1차\) · 기기 연결됨 11 · 기기 연결 없음 19/], ['ops-select-online', /선택 11 \/ 전체 30석/], ['ops-select-offline', /선택 19 \/ 전체 30석 .* 기기 연결됨 0/], ['ops-select-fault', /선택 (9|1\d|2\d) \/ 전체 30석/]]) { await page.locator('#' + button).click(); assert.match(await selection(), expected, button); }
  await page.locator('#ops-select-none').click(); assert.match(await selection(), /선택한 좌석이 없습니다\. 선택 없이 실행되는 조치는 없습니다/); assert.equal(await page.locator('#ops-pick-collect').isDisabled(), true, 'nothing selected → nothing can be requested; the default is never everybody');
  // S12 agreed to send the record and then went offline: selected, consenting, unreachable. (A seat that never connected has
  // never agreed either — the Service reports that as "동의 없음", which is the stronger reason.)
  const gone = (await local.pair('S12', 1, 12)).conn.json; assert.equal((await local.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, gone.credential)).status, 201); assert.equal((await local.request(local.base + '/grants/' + gone.grant_id, 'DELETE')).status, 200);
  await page.locator('#ops-check').click(); await page.waitForTimeout(800);
  for (const id of ['S01', 'S02', 'S12']) await row(id).getByLabel('선택').check();
  assert.match(await selection(), /선택 3 \/ 전체 30석 \(명단 1차\) · 기기 연결됨 2 · 기기 연결 없음 1 .*S01, S02, S12/);
  await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor();
  assert.match(await page.locator('#ops-pick-impact').innerText(), /선택 3명 중 1명에게 기록 회수를 요청합니다\. 제외 2명.*선택하지 않은 27명에게는 아무것도 요청·저장하지 않습니다\. 회수만 하며 평가 초안·발송은 시작하지 않습니다/);
  assert.match(await page.locator('#ops-pick-preview').innerText(), /S01 · student-01 — 요청 예정[\s\S]*S02 · student-02 — 동의 없음 · 회수하지 않음[\s\S]*S12 · student-12 — 기기 연결 없음 · 요청하지 못함/); assert.equal(asked(), 0, 'the preview asked no device');
  // Changing the selection after the preview withdraws the confirmation: what is confirmed is what was shown.
  await row('S12').getByLabel('선택').uncheck(); assert.equal(await page.locator('#ops-pick-confirm').isHidden(), true); assert.match(await page.locator('#ops-pick-note').innerText(), /선택이나 명단·연결 상태가 바뀌었습니다/);
  await row('S12').getByLabel('선택').check(); await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor();
  await page.locator('#ops-pick-go').dblclick(); // a double click is one request
  await page.locator('#ops-pick-items').filter({ hasText: /S01 · student-01 — 현재: 서버 검증됨 · 기록 순번 연속/ }).waitFor({ timeout: 30000 }).catch(async (e) => { throw Error('selected collection did not verify: ' + (await page.locator('#ops-pick-state').innerText()) + ' | ' + (await page.locator('#ops-pick-items').innerText()), { cause: e }); });
  await page.locator('#ops-pick-observed').filter({ hasText: /결과 확정/ }).waitFor({ timeout: 15000 });
  assert.match(await page.locator('#ops-pick-state').innerText(), /선택 회수 · 대상 3명 · 서버 검증됨 1 · 기기 수신 확인 전 0 · 전송·검증 진행 중 0 · 재전송 대기 0 · 최종 거부 0 · 전달 안 됨 1 · 결과 미확인 0 · 유예 종료 0 · 제외 1 · 선택하지 않은 27명은 요청 없음/);
  assert.match(await page.locator('#ops-pick-items').innerText(), /S02 · student-02 — 현재: 제외 · 동의 없음[\s\S]*S12 · student-12 — 현재: 기기에 전달되지 않음 · 기기 연결 없음/);
  const pickBatches = local.db.prepare("SELECT b.id FROM classroom_collect_batches b JOIN classroom_collect_scopes s ON s.batch_id=b.id WHERE s.scope='targets' AND b.dry_run=0").all(); assert.equal(pickBatches.length, 1, 'double click → one batch'); assert.equal(asked(), 1);
  const pickKeys = [...local.r2.keys()].filter((k) => k.includes(pickBatches[0].id)); assert.equal(pickKeys.length, 2); assert.ok(pickKeys.every((k) => k.includes('/student-01/')), 'objects only for the selected, consenting, connected learner: ' + pickKeys.join(' '));
  assert.equal([...local.r2.keys()].filter((k) => /student-(02|12)\//.test(k)).length, 0, 'the excluded and the unreachable learner have no object'); assert.equal(local.db.prepare("SELECT count(*) n FROM ops_command_targets t JOIN ops_commands c ON c.id=t.command_id WHERE c.action='retry_evidence_upload' AND t.seat_id<>'S01'").get().n, 0, 'no device but S01 was asked');
  assert.deepEqual([selectedEvaluatorCalls, local.db.prepare('SELECT count(*) n FROM classroom_report_jobs').get().n, local.db.prepare('SELECT count(*) n FROM classroom_job_outbox').get().n, await page.locator('#ops-reports').isHidden()], [0, 0, 0, true], 'collecting started no evaluation and opened no report or delivery UI');
  await page.locator('#ops-pick-retry').click(); await page.locator('#ops-pick-note').filter({ hasText: /다시 선택했습니다/ }).waitFor(); assert.match(await selection(), /선택 1 \/ 전체 30석 .*: S12$/, 'only the seat whose record did not arrive is selected again — not the excluded one, not everybody');
  await page.screenshot({ path: path.join(out, 'selected-collection.png'), fullPage: true }); await page.locator('#ops-select-none').click();
  // An instructor who may collect but not command still gets the selection — and only the collection action.
  { const p = await browser.newPage({ viewport: { width: 1200, height: 800 } }); await p.goto(origin + '/manage'); await p.locator('#token').fill(await local.teacher('collector', ['observe', 'collect'])); await p.locator('#cohort').fill(local.cohort); await p.locator('#connect button').first().click(); await p.locator('#status').filter({ hasText: '연결됨' }).waitFor(); await p.locator('#ops-check').click(); await p.locator('#ops-seats .ops-seat').nth(29).waitFor();
    assert.deepEqual([await p.locator('#ops-bulk').isVisible(), await p.locator('#ops-pick-collect').isVisible(), await p.locator('#ops-bulk-diagnose').isVisible()], [true, true, false]); await p.close(); }
  ok('chalk: all / technical-problems / connected / not-connected / manual selection → preview → selected collection through the real host; unselected and excluded learners get nothing; no evaluation');

  // ── "수업 마무리" once → collected from the real host → evaluated → waiting for review. Nothing is approved or sent. ──
  local.env.HPS_CLASSROOM_EVALUATOR = 'service-anthropic'; local.env.ANTHROPIC_API_KEY = 'synthetic-not-a-key'; let providerCalls = 0;
  setEvaluatorTransport(async (request) => { providerCalls++; const own = JSON.parse(request.messages[0].content).evidence_catalog.find((q) => q.basis); return Response.json({ content: [{ type: 'text', text: JSON.stringify({ findings: [{ capability: 'FRAMING', status: 'observed', claim: '확인할 조건을 먼저 정함', evidence: [{ quote_id: own.quote_id }], assistance: 'independent' }], next_experiment: '확인 조건을 두 개 적어 보기' }) }] }); });
  assert.equal(await page.locator('#ops-finish-dry').isChecked(), true, 'the safe default is a preview that requests and stores nothing'); await page.locator('#ops-finish-dry').uncheck();
  await page.locator('#ops-finish-go').click(); await page.locator('#ops-auto-state').filter({ hasText: /자동 단계가 끝났습니다 · 검수 대기 1건/ }).waitFor({ timeout: 30000 }).catch(async (e) => { throw Error('auto chain did not finish: ' + (await page.locator('#ops-auto-state').innerText()) + ' | ' + (await page.locator('#ops-finish-state').innerText()), { cause: e }); });
  assert.equal(providerCalls, 1); assert.match(await page.locator('#ops-reports-list').innerText(), /student-01 · 6개 후보 모델 — 검수 대기/); /* the real spool's record is sequence-complete, so the draft is not the 'partial' kind it was while the spool wrote no seq */ assert.match(await page.locator('#ops-auto-state').innerText(), /승인과 발송은 자동으로 일어나지 않습니다/);
  await page.locator('#ops-jobs-go').click(); await page.waitForTimeout(500); assert.equal(providerCalls, 1, 'continuing again evaluates nothing twice'); assert.equal(local.db.prepare("SELECT count(*) n FROM classroom_report_jobs WHERE state IN ('partial','review_required')").get().n, 1);
  await page.getByRole('button', { name: '초안 열기' }).click(); await page.getByRole('button', { name: '근거 확인하고 내용 승인' }).waitFor(); assert.match(await page.locator('#ops-report-view').innerText(), /예약 버튼이 모바일에서 눌리는지/);
  ok('chalk: one "수업 마무리" → real host upload → evaluation → review queue; re-running duplicates nothing');

  // ── real send is its own, confirmed step ──
  await page.getByRole('button', { name: '근거 확인하고 내용 승인' }).click(); await page.locator('#ops-reports-state').filter({ hasText: '검수 결과를 저장했습니다' }).waitFor();
  assert.equal((await local.request('/admin/classroom/recipients', 'POST', { class_run_id: local.run, source_ref: 'synthetic-import', recipients: [{ student_id: 'student-01', recipient_ref: 'guardian-01', channel: 'email', address: 'guardian01@example.invalid', viewer_check: { kind: 'phone_last4', value: '4821' } }] }, null, { authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') })).status, 201);
  Object.assign(local.env, { HPS_DELIVERY_PROVIDER: 'resend', RESEND_API_KEY: 'synthetic-not-a-key', HPS_DELIVERY_FROM: 'HypeProof <reports@example.invalid>', HPS_PUBLIC_BASE_URL: 'https://service.example.invalid' }); const mails = []; setResendFetch(async (_u, init) => { mails.push(JSON.parse(init.body)); return Response.json({ id: 'resend-e2e-000001' }); });
  await page.locator('#ops-recipients-go').click(); await page.locator('#ops-delivery-state').filter({ hasText: '보낼 메시지 1건' }).waitFor(); assert.match(await page.locator('#ops-delivery-list').innerText(), /g\*\*\*@example\.invalid/, 'the address is masked for the instructor');
  assert.equal(await page.locator('#ops-send-go').isDisabled(), true, 'nothing can be sent before approval'); await page.locator('#ops-approve-go').click(); await page.locator('#ops-delivery-state').filter({ hasText: '아직 아무것도 보내지 않았습니다' }).waitFor(); assert.equal(mails.length, 0);
  await page.locator('#ops-send-go').click(); assert.match(await page.locator('#ops-send-summary').innerText(), /회수할 수 없습니다/); assert.equal(mails.length, 0, 'asking is not sending'); await page.locator('#ops-send-yes').click();
  await page.locator('#ops-delivery-state').filter({ hasText: /발송 요청 1건 · 제공자 접수 1 · 접수는 전달이 아닙니다/ }).waitFor(); assert.equal(mails.length, 1); assert.deepEqual(mails[0].to, ['guardian01@example.invalid']);
  // What the guardian meets: the link asks for the agreed value first; the report only opens with it.
  { const link = mails[0].text.match(/https:\/\/service\.example\.invalid(\/v1\/classroom\/report-links\/[A-Za-z0-9-]+)/)[1], reader = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await reader.route('https://service.test/**', async (route) => { const q = route.request(), r = await local.app.fetch(new Request(q.url(), { method: q.method(), headers: q.headers(), ...(q.postData() ? { body: q.postData() } : {}) }), local.env, { waitUntil() {} }); await route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()) }); });
    await reader.goto('https://service.test' + link); assert.match(await reader.locator('label').innerText(), /보호자 휴대전화 번호 끝 4자리/); assert.equal(await reader.getByText('예약 버튼이 모바일에서').count(), 0, 'nothing of the report before the check');
    await reader.locator('#check').fill('0000'); await reader.keyboard.press('Enter'); await reader.locator('[role=alert]').filter({ hasText: '남은 시도 4회' }).waitFor();
    await reader.locator('#check').fill('4821'); await reader.keyboard.press('Enter'); await reader.getByRole('heading', { name: '이번 수업에서 관찰된 행동' }).waitFor(); assert.match(await reader.locator('blockquote').first().innerText(), /예약 버튼이 모바일에서/);
    await reader.screenshot({ path: path.join(out, 'reader-after-check.png') }); await reader.close(); }
  await page.locator('#ops-send-go').evaluate((b) => { b.disabled = false; }); await page.locator('#ops-send-go').click(); await page.locator('#ops-send-yes').click(); await page.locator('#ops-delivery-list').filter({ hasText: '다시 보내지 않음' }).waitFor(); assert.equal(mails.length, 1, 'pressing send again sends nothing again');
  assert.deepEqual(errors, []); await page.screenshot({ path: path.join(out, 'finish-and-send.png'), fullPage: true });
  ok('chalk: approval ≠ send; real send needs its own confirmation; accepted ≠ delivered; the reader passes the viewer check; a second press sends nothing');
  await host.disconnectInteractively();
  console.log(`${n} roster/round-trip checks passed → ${out}`);
} finally { setEvaluatorTransport(undefined); setResendFetch(undefined); globalThis.fetch = realFetch; await browser?.close(); chalkServer.close(); webviewServer.close(); local.close(); }
