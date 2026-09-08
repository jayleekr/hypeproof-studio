import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// This reuses start-page/run.mjs's built React + controlled extension-host
// boundary. Outbound messages are assertions, not real API/OS operations.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(repo, 'extensions/hypeproof-chat/webview-ui/dist');
const out = path.resolve(process.env.HPS_TRIAL_UX_OUT || path.join(repo, 'e2e/test-results/trial-ux', new Date().toISOString().replace(/[:.]/g, '-')));
await fs.mkdir(out, { recursive: true });
const bundled = await build({ entryPoints: [path.join(repo, 'worker/src/profiles/studio-native-trial.ts')], bundle: true, write: false, platform: 'node', format: 'esm', loader: { '.md': 'text' } });
const { profile: sourceProfile } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const native = {
  ...sourceProfile, profile_id: sourceProfile.id,
  observation: { format: 'hps-observation/1', scope: 'synthetic-scope-a' },
  series_index: 1, series_total: 1,
};
const config = (profile = native, extra = {}) => ({ proxyUrl: 'http://controlled-host.invalid/v1', model: 'controlled-host-only', hasToken: true, coach: { name: '다른 수업 이름', personality: '', configured: true }, profile, ...extra });
const course = { id: 'studio-native-trial', name: native.display_name, coach: '코치', series: '1 / 1', workspace: '~/SyntheticTrial' };
const event = (id, kind, text, extra = {}) => ({ id, seq: Number(id.slice(1)), kind, text, task: 'synthetic-task', at: '2026-09-08T00:00:00.000Z', assistance: 'unknown', ...extra });
const batch = { format: 'hps-observation/1', scope: 'synthetic-scope-a', session: 'synthetic-session', program: 'studio-native-trial', events: [event('e1', 'user', '대상을 확인하고 내용을 수정해주세요.'), event('e2', 'artifact', '<h1>첫 저장</h1>', { sha256: 'a'.repeat(64) }), event('e3', 'artifact', '<h1>최근 저장</h1>', { sha256: 'b'.repeat(64) })] };
const findings = ['TASTE', 'INTENT', 'CONTEXT', 'VERIFY', 'DELEGATE', 'ITERATE', 'OWNERSHIP'].map((asset, i) => ({ asset, status: i ? 'unobserved' : 'observed', interpretation: i ? '이 기록에서 확인하지 못했습니다.' : '대상을 먼저 확인하도록 요청했습니다.', assistance: 'unknown', evidence: i ? [] : [{ event_id: 'e1', quote: batch.events[0].text }], next: '다음 작업의 확인 기준을 적어보세요.' }));
const learningPath = { title: '강의에서 계속하기', reason: '다음 학습에서 기준을 적용해보세요.', url: 'https://hypeproof-ai.xyz/training' };
const history = [{ id: 'u1', role: 'user', content: '가상 안내 페이지를 만들어주세요.', createdAt: 1 }, { id: 'a1', role: 'assistant', content: '초안입니다.\n```html\n<!doctype html><html><body><h1>합성 초안</h1></body></html>\n```', createdAt: 2, citations: [{ url: 'https://example.org/source', title: '합성 출처', domain: 'example.org', tier: 4 }] }];

// A new verdict gets positive/negative controls before browser execution.
const emitted = (messages, type) => messages.filter(m => m.type === type);
const containsRequest = (messages, expected) => emitted(messages, expected.type).some(m => Object.entries(expected).every(([k, v]) => JSON.stringify(m[k]) === JSON.stringify(v)));
assert.equal(containsRequest([{ type: 'sendMessage', text: 'known' }], { type: 'sendMessage', text: 'known' }), true);
assert.equal(containsRequest([{ type: 'sendMessage', text: 'wrong' }], { type: 'sendMessage', text: 'known' }), false);
assert.equal(containsRequest([], { type: 'sendMessage' }), false);
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const target = path.resolve(dist, name);
    if (!target.startsWith(`${dist}/`)) throw Error('outside dist');
    let body = await fs.readFile(target);
    if (name === 'index.html' && url.searchParams.get('surface') === 'start') body = Buffer.from(body.toString().replace('<html', '<html data-surface="start"'));
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const results = [];
const url = `http://127.0.0.1:${server.address().port}`;
const host = (p, data) => p.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
const startState = (p, state) => host(p, { type: 'startState', state: { checking: false, version: 'synthetic', ...state } });
const observe = (p, state = {}) => host(p, { type: 'observationState', batch, error: null, findings: [], learningPath, ...state });
const requests = p => p.evaluate(() => window.sent);
const request = async (p, expected) => expect.poll(async () => containsRequest(await requests(p), expected)).toBe(true);
const draft = p => p.locator('.hps-input textarea');
const btn = (p, name) => p.getByRole('button', { name, exact: true });
const openObservation = async p => { await p.getByText('내 작업 돌아보기', { exact: true }).click(); };
async function test(id, title, fn, { surface = 'chat', profile = native, cfg = {}, expectedCrash = false } = {}) {
  if (process.env.HPS_TRIAL_UX_CASE && !id.includes(process.env.HPS_TRIAL_UX_CASE)) return;
  const p = await browser.newPage({ viewport: { width: 390, height: 900 } });
  p.setDefaultTimeout(4000);
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.addInitScript(() => {
    window.sent = [];
    window.acquireVsCodeApi = () => ({ postMessage: m => window.sent.push(m), getState: () => undefined, setState: () => { throw Error('unexpected webview persistence'); } });
  });
  const row = { id, title, status: 'FAIL', scope: 'built React + controlled host messages', screenshots: [] };
  try {
    await p.goto(`${url}/?surface=${surface}`);
    await request(p, { type: surface === 'start' ? 'startReady' : 'ready' });
    if (surface === 'start') await startState(p, {});
    else await host(p, { type: 'config', config: config(profile, cfg) });
    await fn(p);
    if (!expectedCrash) assert.deepEqual(errors, []);
    assert.deepEqual(await p.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
    row.status = 'PASS';
  } catch (e) { row.error = e.stack; }
  row.layout = await p.evaluate(() => ({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(e=>({tag:e.tagName,cls:e.className,right:e.getBoundingClientRect().right,width:e.getBoundingClientRect().width}))}));
  const shot = `${id}.png`;
  await p.screenshot({ path: path.join(out, shot), fullPage: true }).catch(() => {});
  row.screenshots.push(shot);
  row.requests = await requests(p).catch(() => []);
  row.pageErrors = errors;
  results.push(row);
  await fs.writeFile(path.join(out, `${id}.json`), JSON.stringify(row, null, 2));
  console.log(`${row.status} ${id} ${title}${row.error ? `: ${row.error.split('\n')[0]}` : ''}`);
  await p.close();
}

try {
  await test('TUX-SP-01', 'Code masking, whitespace disable, keyboard submission clears credential', async p => {
    const input = p.locator('#course-code'), submit = btn(p, '수업 확인하기');
    await expect(input).toHaveAttribute('type', 'password');
    await expect(submit).toBeDisabled(); await input.fill('   '); await expect(submit).toBeDisabled();
    await input.fill('synthetic-not-a-secret'); await input.press('Enter');
    await request(p, { type: 'connectCourse', token: 'synthetic-not-a-secret' });
    await expect(input).toHaveValue(''); await expect(input).toBeDisabled();
  }, { surface: 'start' });
  await test('TUX-SP-02', 'Connection pending prevents duplicate submit and announces progress', async p => {
    await p.locator('#course-code').fill('synthetic'); await btn(p, '수업 확인하기').dblclick();
    await expect(p.locator('.studio-connect')).toHaveAttribute('aria-busy', 'true');
    assert.equal(emitted(await requests(p), 'connectCourse').length, 1);
    await expect(btn(p, '수업 확인 중…')).toBeDisabled();
  }, { surface: 'start' });
  await test('TUX-SP-03', 'Start and continue route to coach; begin pending disables course actions', async p => {
    await startState(p, { profile: course }); await btn(p, '수업 시작하기').press('Enter');
    await request(p, { type: 'beginCourse' });
    await expect(btn(p, '수업 여는 중…')).toBeDisabled(); await expect(btn(p, '다른 수업에 연결')).toBeDisabled(); await expect(btn(p, '연결 해제')).toBeDisabled();
    await startState(p, { profile: course, started: true }); await btn(p, '코치와 계속 작업하기').click();
    assert.equal(emitted(await requests(p), 'beginCourse').length, 2);
  }, { surface: 'start' });
  await test('TUX-SP-04', 'Change course focuses code and back restores old course', async p => {
    await startState(p, { profile: course }); await btn(p, '다른 수업에 연결').click();
    await expect(p.locator('#course-code')).toBeFocused(); await p.locator('#course-code').fill('unsubmitted-synthetic');
    await btn(p, '기존 수업으로 돌아가기').click(); await expect(p.getByText(course.name, { exact: true })).toBeVisible();
    assert.equal(emitted(await requests(p), 'connectCourse').length, 0);
  }, { surface: 'start' });
  await test('TUX-SP-05', 'Invalid code and expired trial permit recovery without stale begin', async p => {
    await startState(p, { profile: course }); await btn(p, '다른 수업에 연결').click(); await p.locator('#course-code').fill('bad'); await btn(p, '수업 확인하기').click();
    await startState(p, { profile: course, error: '인증에 실패했습니다.' }); await expect(p.getByRole('alert')).toContainText('기존 수업 연결은 유지됩니다.');
    await btn(p, '기존 수업으로 돌아가기').click(); await expect(btn(p, '수업 시작하기')).toBeEnabled();
    await startState(p, { error: '개인 체험 시간이 끝났습니다.' }); await expect(btn(p, '수업 시작하기')).toHaveCount(0); await expect(p.locator('#course-code')).toBeEnabled();
  }, { surface: 'start' });
  await test('TUX-SP-06', 'Disconnect delegates host request and disconnected host state replaces course', async p => {
    await startState(p, { profile: course }); await btn(p, '연결 해제').click(); await request(p, { type: 'disconnectCourse' });
    await startState(p, {}); await expect(p.locator('#course-code')).toBeVisible(); await expect(p.getByText(course.name, { exact: true })).toHaveCount(0);
  }, { surface: 'start' });
  for (const [id, label, type] of [['07', '파일', 'openStudioFiles'], ['08', '설정', 'openStudioSettings'], ['09', '작업 폴더 열기', 'openLocalFolder']]) {
    await test(`TUX-SP-${id}`, `${label}: keyboard action emits correct host request`, async p => { await btn(p, label).focus(); await expect(btn(p, label)).toBeFocused(); await btn(p, label).press('Enter'); await request(p, { type }); }, { surface: 'start' });
  }
  await test('TUX-SP-10', 'Disconnected coach has start-page CTA', async p => { await btn(p, '시작 화면 열기').click(); await request(p, { type: 'setToken' }); await expect(draft(p)).toHaveCount(0); }, { profile: null });
  await test('TUX-CHAT-01', 'All three real profile suggestions fill and focus draft without sending', async p => {
    for (const chip of native.ux.suggestions.initial) { const button = p.getByRole('button', { name: new RegExp(chip.text) }); await button.click(); await expect(draft(p)).toHaveValue(chip.text); await expect(draft(p)).toBeFocused(); }
    assert.equal(emitted(await requests(p), 'sendMessage').length, 0); await expect(p.getByTitle('이 수업의 코치', { exact: true })).toHaveText('코치');
    await expect(p.getByRole('button', { name: '코치 이름 바꾸기' })).toHaveCount(0);
  });
  await test('TUX-CHAT-02', 'Send rejects empty/space and sends trimmed text once', async p => {
    await expect(btn(p, 'Send')).toBeDisabled(); await draft(p).fill('  '); await expect(btn(p, 'Send')).toBeDisabled();
    await draft(p).fill('  실제 요청  '); await btn(p, 'Send').click(); await request(p, { type: 'sendMessage', text: '실제 요청' }); await expect(draft(p)).toHaveValue(''); await expect(btn(p, 'Send')).toBeDisabled();
  });
  await test('TUX-CHAT-03', 'Enter sends, Shift+Enter preserves newline, IME Enter does not send', async p => {
    await draft(p).fill('첫 줄'); await draft(p).press('Shift+Enter'); await draft(p).press('a'); await expect(draft(p)).toHaveValue('첫 줄\na');
    await draft(p).dispatchEvent('compositionstart'); await draft(p).press('Enter'); assert.equal(emitted(await requests(p), 'sendMessage').length, 0);
    await draft(p).dispatchEvent('compositionend'); await draft(p).press('Enter'); await request(p, { type: 'sendMessage', text: '첫 줄\na' });
  });
  await test('TUX-CHAT-04', 'Stop routes actual stream ID and preserves queued plus current draft', async p => {
    await host(p, { type: 'streamStart', streamId: 'synthetic-stream', messageId: 'a1' });
    await draft(p).fill('예약 문장'); await draft(p).press('Enter'); await draft(p).fill('추가 문장'); await btn(p, 'Stop').click();
    await request(p, { type: 'cancelStream', streamId: 'synthetic-stream' });
    await expect(draft(p)).toHaveValue(/예약 문장/); await expect(draft(p)).toHaveValue(/추가 문장/);
    await host(p, { type: 'streamStopped' }); await expect(btn(p, 'Stop')).toHaveCount(0); await expect(p.getByText('답변 생성이 중지되었습니다. 다시 채팅을 입력해주세요.', { exact: false })).toBeVisible();
    assert.equal(emitted(await requests(p), 'sendMessage').length, 0);
  });
  await test('TUX-CHAT-05', 'Queue cancel restores draft; normal completion flushes exactly once', async p => {
    await host(p, { type: 'streamStart', streamId: 's1', messageId: 'a1' }); await draft(p).fill('보존할 예약'); await draft(p).press('Enter');
    await btn(p, '예약 취소').click(); await expect(draft(p)).toHaveValue('보존할 예약'); assert.equal(emitted(await requests(p), 'sendMessage').length, 0);
    await draft(p).press('Enter'); await host(p, { type: 'streamEnd' }); await request(p, { type: 'sendMessage', text: '보존할 예약' }); await host(p, { type: 'streamEnd' }); assert.equal(emitted(await requests(p), 'sendMessage').length, 1);
  });
  await test('TUX-CHAT-06', 'Host image attachment enables image-only send and removal disables it', async p => {
    const dataUrl = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 10; return c.toDataURL('image/png'); });
    await host(p, { type: 'attachImage', dataUrl }); await expect(btn(p, '이미지 제거')).toBeVisible(); await expect(btn(p, 'Send')).toBeEnabled();
    await btn(p, '이미지 제거').click(); await expect(btn(p, 'Send')).toBeDisabled();
    await host(p, { type: 'attachImage', dataUrl }); await expect(btn(p, '이미지 제거')).toBeVisible(); await btn(p, 'Send').click();
    await request(p, { type: 'sendMessage', text: '' }); assert.equal(emitted(await requests(p), 'sendMessage')[0].images.length, 1); await expect(btn(p, '이미지 제거')).toHaveCount(0);
  });
  for (const [id, label, type] of [['07', '수업 연결', 'setToken'], ['08', '대화 지우기', 'clearHistory'], ['09', '설정', 'openSettings']]) {
    await test(`TUX-CHAT-${id}`, `${label}: request delegates to host; Clear waits for host confirmation/result`, async p => {
      await host(p, { type: 'history', messages: history }); await btn(p, label).click(); await request(p, { type });
      if (type === 'clearHistory') { await expect(p.getByText(history[0].content, { exact: true })).toBeVisible(); await host(p, { type: 'history', messages: [] }); await expect(p.getByText(history[0].content, { exact: true })).toHaveCount(0); }
    });
  }
  await test('TUX-CHAT-10', 'Retry reuses preceding prompt and hides during streaming', async p => {
    assert.equal(native.ux.retry_button.enabled, true); await host(p, { type: 'history', messages: history }); await p.locator('.hps-msg-retry').click(); await request(p, { type: 'retryMessage', prompt: history[0].content });
    await host(p, { type: 'streamStart', streamId: 's1', messageId: 'a2' }); await expect(p.locator('.hps-msg-retry')).toHaveCount(0);
  });
  await test('TUX-CHAT-11', 'Run emits exact HTML; plain response has no Run', async p => {
    await host(p, { type: 'history', messages: [{ ...history[1], content: '텍스트만 있습니다.' }] }); await expect(p.locator('.hps-msg-run')).toHaveCount(0);
    await host(p, { type: 'history', messages: history }); await p.locator('.hps-msg-run').click(); await request(p, { type: 'runCode', html: '<!doctype html><html><body><h1>합성 초안</h1></body></html>' });
  });
  await test('TUX-CHAT-12', 'Code disclosure toggles without executing code', async p => {
    await host(p, { type: 'history', messages: history }); await expect(p.locator('.hps-codepill-body')).toHaveCount(0); await p.locator('.hps-codepill-toggle').press('Enter'); await expect(p.locator('.hps-codepill-body')).toContainText('합성 초안'); await p.locator('.hps-codepill-toggle').press('Enter'); await expect(p.locator('.hps-codepill-body')).toHaveCount(0); assert.equal(emitted(await requests(p), 'runCode').length, 0);
  });
  await test('TUX-CHAT-13', 'Citation emits exact external URL', async p => { await host(p, { type: 'history', messages: history }); await p.locator('.hps-cit-chip').click(); await request(p, { type: 'openExternal', url: 'https://example.org/source' }); });
  await test('TUX-CHAT-14', 'Error retry/report/close preserve draft and expose request/runbook', async p => {
    await host(p, { type: 'history', messages: history }); await draft(p).fill('작성 중인 문장');
    await host(p, { type: 'streamError', error: '연결이 끊겼습니다.', requestId: 'synthetic-request-id', runbookUrl: 'https://example.org/runbook' });
    await expect(p.getByRole('alert')).toContainText('synthetic-request-id'); await expect(p.getByRole('link', { name: /강사 안내/ })).toHaveAttribute('href', 'https://example.org/runbook');
    await btn(p, '다시 보내기').click(); await request(p, { type: 'retryMessage', prompt: history[0].content }); await btn(p, '🚨 신고하기').click(); await request(p, { type: 'openReportModal' }); await btn(p, '닫기').click(); await expect(p.getByRole('alert')).toHaveCount(0); await expect(draft(p)).toHaveValue('작성 중인 문장');
    await host(p, { type: 'history', messages: [] }); await host(p, { type: 'streamError', error: '인증에 실패했습니다.' }); await expect(btn(p, '다시 보내기')).toHaveCount(0);
  });
  await test('TUX-OBS-01', 'Observation disclosure and record refresh do not assess automatically', async p => { await openObservation(p); await btn(p, '이 작업의 기록 확인').click(); await request(p, { type: 'observationOpen' }); assert.equal(emitted(await requests(p), 'observationAssess').length, 0); await observe(p); await expect(p.getByText('3건 · 도움 사용 범위는 확인 전까지 미확인입니다.')).toBeVisible(); });
  await test('TUX-OBS-02', 'Artifact disclosure shows first/latest content and SHA without execution', async p => { await openObservation(p); await observe(p); await p.getByText('보존된 산출물 비교', { exact: true }).click(); await expect(p.locator('.hps-observation-compare section')).toHaveCount(2); await expect(p.locator('.hps-observation-compare')).toContainText('a'.repeat(64)); await expect(p.locator('.hps-observation-compare')).toContainText('최근 저장'); assert.equal(emitted(await requests(p), 'runCode').length, 0); });
  await test('TUX-OBS-03', 'Record disclosure shows exact source without allowing HTML execution', async p => { await openObservation(p); await observe(p); await p.getByText('평가에 보낼 기록 보기', { exact: true }).click(); await expect(p.locator('.hps-native-observation ol li')).toHaveCount(3); await expect(p.locator('.hps-native-observation ol')).toContainText('<h1>첫 저장</h1>'); await expect(p.locator('.hps-native-observation ol h1')).toHaveCount(0); });
  await test('TUX-OBS-04', 'Consent defaults off; empty events cannot be assessed even with consent', async p => { await openObservation(p); await observe(p); await expect(btn(p, '관찰 받기')).toBeDisabled(); await p.getByRole('checkbox').check(); await expect(btn(p, '관찰 받기')).toBeEnabled(); await observe(p, { batch: { ...batch, events: [] } }); await p.getByRole('checkbox').check(); await expect(btn(p, '관찰 받기')).toBeDisabled(); });
  await test('TUX-OBS-05', 'Assessment sends reviewed IDs once and locks while busy; new records reset consent', async p => { await openObservation(p); await observe(p); await p.getByRole('checkbox').check(); await btn(p, '관찰 받기').click(); await request(p, { type: 'observationAssess', scope: batch.scope, eventIds: batch.events.map(e => e.id) }); await expect(btn(p, '관찰 중…')).toBeDisabled(); await observe(p, { batch: { ...batch, events: [...batch.events, event('e4', 'user', '추가 기록')] } }); await expect(p.getByRole('checkbox')).not.toBeChecked(); await expect(btn(p, '관찰 받기')).toBeDisabled(); });
  await test('TUX-OBS-06', 'Cancel delegates and host cancellation unlocks with honest error', async p => { await openObservation(p); await observe(p); await p.getByRole('checkbox').check(); await btn(p, '관찰 받기').click(); await btn(p, '관찰 취소').click(); await request(p, { type: 'observationCancel' }); await observe(p, { error: '관찰을 취소했습니다.' }); await expect(p.getByRole('alert')).toHaveText('관찰을 취소했습니다.'); await expect(btn(p, '관찰 취소')).toHaveCount(0); await expect(p.getByRole('checkbox')).not.toBeChecked(); });
  await test('TUX-OBS-07', 'Seven controlled findings retain evidence IDs, unknown status and assessed count', async p => { await openObservation(p); await observe(p, { findings, assessedEventCount: 2 }); await expect(p.locator('.hps-native-observation article')).toHaveCount(7); await expect(p.locator('.hps-native-observation blockquote')).toContainText('e1'); await expect(p.getByText('이 관찰은 2개 기록 기준입니다.', { exact: false })).toBeVisible(); await expect(p.getByText('도움 사용 범위 미확인', { exact: true })).toHaveCount(7); });
  await test('TUX-OBS-08', 'Correction whitespace disabled, bounded and scoped; draft clears after send', async p => { await openObservation(p); await observe(p, { findings }); const input = p.getByLabel('내가 다르게 보는 점'); await expect(input).toHaveAttribute('maxLength', '2000'); await expect(btn(p, '정정 기록 남기기')).toBeDisabled(); await input.fill('  '); await expect(btn(p, '정정 기록 남기기')).toBeDisabled(); await input.fill('근거를 제가 직접 확인한 것은 아닙니다.'); await btn(p, '정정 기록 남기기').click(); await request(p, { type: 'observationCorrect', scope: batch.scope, text: '근거를 제가 직접 확인한 것은 아닙니다.' }); await expect(input).toHaveValue(''); });
  await test('TUX-OBS-09', 'Learning link available before assessment and emits exact approved URL', async p => { await openObservation(p); await observe(p); await btn(p, learningPath.title).click(); await request(p, { type: 'openExternal', url: learningPath.url }); assert.equal(emitted(await requests(p), 'observationAssess').length, 0); });
  await test('TUX-OBS-10', 'Config scope switch clears prior errors, learning link and unsubmitted correction', async p => {
    await openObservation(p); await observe(p, { findings, error: '이전 사용자 오류' }); await p.getByLabel('내가 다르게 보는 점').fill('이전 사용자 개인 정정');
    await host(p, { type: 'config', config: config({ ...native, observation: { format: 'hps-observation/1', scope: 'synthetic-scope-b' } }) });
    await expect(p.getByText('이전 사용자 오류', { exact: true })).toHaveCount(0); await expect(btn(p, learningPath.title)).toHaveCount(0);
    await observe(p, { batch: { ...batch, scope: 'synthetic-scope-b' }, findings, learningPath: null }); await expect(p.getByLabel('내가 다르게 보는 점')).toHaveValue('');
  });
  const update = { version: '9.9.9', notes: '합성 변경 내용', sizeBytes: 1048576, releaseUrl: 'https://example.org/synthetic-release' };
  await test('TUX-COND-01', 'Update notes disclosure preserves draft', async p => { await draft(p).fill('보존 문장'); await btn(p, '자세히 보기').click(); await expect(p.locator('.hps-update-banner-notes')).toHaveText(update.notes); await btn(p, '접기').click(); await expect(p.locator('.hps-update-banner-notes')).toHaveCount(0); await expect(draft(p)).toHaveValue('보존 문장'); }, { cfg: { update } });
  await test('TUX-COND-02', 'Update action delegates; browser never installs actual App', async p => { await btn(p, '업데이트').click(); await request(p, { type: 'installUpdate' }); }, { cfg: { update } });
  await test('TUX-COND-03', 'Postpone identifies offered version and host removes banner', async p => { await btn(p, '나중에').click(); await request(p, { type: 'dismissUpdate', version: update.version }); await host(p, { type: 'config', config: config() }); await expect(p.locator('.hps-update-banner')).toHaveCount(0); }, { cfg: { update } });
  await test('TUX-COND-04', 'Fatal boundary reports error and settings action; transient bad config recovers', async p => {
    await host(p, { type: 'config', config: config({ ...native, ux: { ...native.ux, suggestions: null } }) });
    await expect(btn(p, '다시 열기')).toBeVisible(); await request(p, { type: 'webviewError' }); await btn(p, '설정 열기').click(); await request(p, { type: 'openSettings' });
    await host(p, { type: 'config', config: config() }); await btn(p, '다시 열기').click(); await expect(draft(p)).toBeVisible(); await expect(btn(p, '다시 열기')).toHaveCount(0);
  }, { expectedCrash: true });
  await test('TUX-COND-04B', 'Crash injection resets and reloads saved host state without looping', async p => {
    await host(p, { type: 'webviewTestCrash' });
    await expect(btn(p, '다시 열기')).toBeVisible();
    await btn(p, '다시 열기').click();
    await expect(draft(p)).toBeVisible();
    await expect(btn(p, '다시 열기')).toHaveCount(0);
    await expect.poll(async()=>emitted(await requests(p),'ready').length).toBe(2);
  }, { expectedCrash: true });
  await test('TUX-COND-05', 'Native profile excludes unrelated naming/world/gallery/roll/lesson/followup surfaces', async p => {
    for (const selector of ['.hps-naming', '.hps-world-strip', '.hps-gallery-btn', '.hps-btn-roll', '.hps-lesson']) await expect(p.locator(selector)).toHaveCount(0);
    await host(p, { type: 'history', messages: history }); await expect(p.locator('.hps-chips')).toHaveCount(0);
    await host(p, { type: 'config', config: config({ ...native, observation: undefined }) }); await expect(p.getByText('현재 연결은 작업 관찰을 지원하지 않습니다.', { exact: false })).toBeVisible(); await expect(p.locator('.hps-native-observation')).toHaveCount(0);
  });
  await test('TUX-A11Y-01', 'Visible controls have names and keyboard focus including citation and settings', async p => {
    await expect(p.getByRole('textbox',{name:'코치에게 보낼 메시지'})).toBeVisible();
    await expect(btn(p,'설정')).toBeVisible();
    await host(p,{type:'history',messages:history});
    const citation=p.locator('.hps-cit-chip').first();
    await expect(citation).toHaveRole('button');
    await citation.focus();await expect(citation).toBeFocused();await citation.press('Enter');
    await request(p,{type:'openExternal',url:history[1].citations[0].url});
    for(const button of await p.getByRole('button').all()) {
      if(await button.isVisible())expect(await button.getAttribute('aria-label')||await button.innerText()||await button.getAttribute('title')).toBeTruthy();
    }
  });
  await test('TUX-LAYOUT-01', 'Start surface 390/768/1280 has no horizontal overflow', async p => { for (const width of [390, 768, 1280]) { await p.setViewportSize({ width, height: 900 }); assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await p.screenshot({ path: path.join(out, `start-${width}.png`), fullPage: true }); } }, { surface: 'start' });
  await test('TUX-LAYOUT-02', 'Chat + expanded observation 390/768/1280 has no horizontal overflow', async p => { await openObservation(p); await observe(p, { findings }); await p.getByText('보존된 산출물 비교', { exact: true }).click(); for (const width of [390, 768, 1280]) { await p.setViewportSize({ width, height: 900 }); assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await p.screenshot({ path: path.join(out, `chat-${width}.png`), fullPage: true }); } });
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  const assets = (await fs.readdir(path.join(dist, 'assets'))).filter(f => f.endsWith('.js'));
  const hashes = Object.fromEntries(await Promise.all(assets.map(async f => [f, createHash('sha256').update(await fs.readFile(path.join(dist, 'assets', f))).digest('hex')])));
  const report = { schema: 'hps-trial-ux/1', executedAt: new Date().toISOString(), codeSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), sourceDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), browser: 'Chromium', platform: process.platform, arch: process.arch, bundleSha256: hashes, profileSource: 'worker/src/profiles/studio-native-trial.ts (actual bundled registry profile)', scope: 'Built React. Host messages, findings, artifacts and API outcomes are controlled synthetic fixtures. No real authentication, provider, native dialog, URL open, update, disk restore or deployment is claimed.', evaluatorControls: { positive: 'PASS', negativeMismatch: 'PASS', negativeMissing: 'PASS' }, counts: { pass: results.filter(r => r.status === 'PASS').length, fail: results.filter(r => r.status === 'FAIL').length }, results };
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${path.join(out, 'report.json')}`);
  if (report.counts.fail) process.exitCode = 1;
}
