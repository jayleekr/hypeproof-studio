// Instructor UI integration follow-up captures (#751, Codex F1/F2) — on the SYNTHETIC preview:
//   F-01 a partial help read (the Service says older rows exist): exact open count from the Service, lower-bound student count,
//        and a next action;
//   F-02 an older Service without completeness or counts and no help visible: never "no requests";
//   F-03 an open seat detail while the class's remote actions are turned off and back on (flag), without reopening;
//   F-04 the same detail after that seat's device connection is revoked: send disabled in place, the typed question kept.
// Desktop 1280x720 and phone 390x844. F-01/F-02 answers are changed by page.route in this browser only. F-03/F-04 are real
// changes through the Service API on the synthetic preview (the flag is put back; the revoked seat stays revoked until the
// preview restarts).
//
//   HPS_UI_PREVIEW_PORT=<port> node --experimental-strip-types --experimental-sqlite e2e/classroom/ui-review-preview.mjs &
//   HPS_UI_REVIEW_OUT=<fresh dir> node e2e/classroom/ui-review-capture-followup.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), pre = path.join(repo, 'e2e/test-results/ui-review-preview');
const info = JSON.parse(readFileSync(path.join(pre, 'preview.json'), 'utf8')), token = readFileSync(info.token_file, 'utf8').trim(), origin = new URL(info.url).origin;
const out = path.resolve(process.env.HPS_UI_REVIEW_OUT || path.join(pre, 'captures-followup')); mkdirSync(out, { recursive: true });
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const source = { head: git('rev-parse', 'HEAD'), dirty_product: !!git('status', '--porcelain', '--', 'chalk/src', 'worker/src', 'extensions/hypeproof-chat/src') };
const shots = [], facts = {};
const badge = (label) => { const add = () => { if (document.getElementById('hps-synthetic-badge')) return; const b = document.createElement('div'); b.id = 'hps-synthetic-badge'; b.textContent = label; b.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99999;background:#fde68a;color:#1f2937;font:12px/1.3 system-ui;padding:4px 8px;border-radius:4px;pointer-events:none;max-width:70vw'; document.body.append(b); }; document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', add) : add(); };
const LABEL = '합성 데이터 · 로컬 미리보기 (실제 수업 아님) · ' + source.head.slice(0, 7) + (source.dirty_product ? '+작업본' : '');
const browser = await chromium.launch();
async function newPage(viewport) { const p = await browser.newPage({ viewport }); await p.addInitScript(badge, LABEL); p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message)); return p; }
const measure = (p) => p.evaluate((tok) => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, primaries: [...document.querySelectorAll('.primary')].filter((b) => b.checkVisibility()).map((b) => b.tagName.toLowerCase() + ': ' + b.textContent.trim()), tokenOnPage: document.body.innerText.includes(tok) }), token);
async function shot(p, name, route, caption, change, made) {
  const m = await measure(p); assert.equal(m.tokenOnPage, false, name + ': token on the page'); assert.equal(m.overflow, false, name + ': horizontal overflow'); assert.ok(m.primaries.length <= 1, name + ': more than one primary ' + m.primaries);
  const vp = p.viewportSize(), file = name + '.png'; await p.screenshot({ path: path.join(out, file) });
  shots.push({ file, route, viewport: `${vp.width}x${vp.height}`, browser_zoom: '100%', caption, change, made_here: made, scope: 'synthetic', source_head: source.head, dirty_product: source.dirty_product, primary_ctas: m.primaries, horizontal_overflow: m.overflow, token_on_page: m.tokenOnPage });
}
async function connect(p) {
  await p.goto(origin + '/manage'); await p.fill('#token', token); await p.fill('#cohort', info.cohort); await p.fill('#prefix', info.seat_prefix); await p.click('#connect-go');
  await p.locator('#status').filter({ hasText: '연결됨' }).waitFor(); await p.locator('#ops-seats .ops-seat').nth(info.seats - 1).waitFor(); await p.waitForTimeout(600);
}
const seat = (p, id) => p.locator(`#ops-seats .ops-seat[data-seat="${id}"]`);
const open = async (p, id) => { if (await p.locator('#ops-detail').evaluate((e) => !e.hidden && getComputedStyle(e).position === 'fixed')) await p.keyboard.press('Escape'); await seat(p, id).getByRole('button', { name: '근거·조치' }).click(); await p.locator('#ops-detail-title').filter({ hasText: id }).waitFor(); };
const SHARES = /\/classroom\/shares(\?|$)/;
const api = async (p, method, body) => { const r = await fetch(origin + p, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
// The page's own refresh (a click on 갱신 would move the focus that F-03/F-04 keep).
const tick = (p) => p.evaluate(() => refresh());
try {
  // ── F-01 / F-02 ──
  for (const [w, h, tag] of [[1280, 720, 'desktop'], [390, 844, '390']]) {
    const p = await newPage({ width: w, height: h }); await connect(p);
    let mode = 'partial'; await p.route(SHARES, async (route) => {
      const u = new URL(route.request().url()), help = u.searchParams.get('kind') === 'help';
      if (mode === 'partial') { const r = await route.fetch(), j = await r.json(); j.has_more = true; j.next_cursor = '1:synthetic-next'; return route.fulfill({ response: r, json: j }); }
      if (mode === 'legacy') { const r = await route.fetch(), j = await r.json(); delete j.has_more; delete j.next_cursor; delete j.counts; if (help) j.shares = []; return route.fulfill({ response: r, json: j }); }
      return route.continue();
    });
    await tick(p); await p.locator('#ops-help-state').filter({ hasText: '최근' }).waitFor(); await p.evaluate(() => document.getElementById('ops-help-title').scrollIntoView());
    facts['partial_' + tag] = { help_state: await p.locator('#ops-help-state').innerText(), select_help: (await p.locator('#ops-select-help').innerText()).trim(), more: await p.locator('#ops-help-list').getByRole('button', { name: '더 오래된 도움 요청 불러오기' }).count() };
    await shot(p, `F-01-help-partial-${tag}`, '/manage (이번 수업 도움 요청 일부만 읽음)', 'Service가 더 오래된 요청이 있다고 답한 경우 — 응답할 요청 수는 Service가 센 정확한 값, 학생 수는 하한, 그리고 ‘더 오래된 도움 요청 불러오기’.', 'Codex F2 완결성·커서 계약', 'shares 응답의 has_more를 true로 바꿈 (page.route)');
    mode = 'legacy'; await tick(p); await p.locator('#ops-help-state').filter({ hasText: '불러온 범위' }).waitFor(); await p.evaluate(() => document.getElementById('ops-help-title').scrollIntoView());
    facts['legacy_' + tag] = { help_state: await p.locator('#ops-help-state').innerText(), summary: await p.locator('#ops-summary').innerText() };
    assert.doesNotMatch(facts['legacy_' + tag].help_state, /지금 응답할 도움 요청이 없습니다/);
    await shot(p, `F-02-help-lower-bound-${tag}`, '/manage (완결성 표시가 없는 이전 Service)', '완결성·집계가 없는 응답에서 보이는 요청이 0건인 경우 — ‘요청 없음’이라고 하지 않고 확인하지 못한 범위를 말하며 ‘다시 확인’을 줍니다.', 'Codex F2 0건≠없음', 'shares 응답에서 has_more·counts를 지우고 도움 요청 행을 비움 (page.route)');
    mode = 'ok'; await tick(p); await p.locator('#ops-help-state').filter({ hasNotText: /최근|불러온 범위/ }).waitFor(); facts['recovered_' + tag] = await p.locator('#ops-help-state').innerText(); await p.unroute(SHARES);
    facts['page_errors_' + tag] = p.errors; await p.close();
  }
  // ── F-03 / F-04: one desktop page and one phone page watch the same seat while the Service changes ──
  const d = await newPage({ width: 1280, height: 720 }), m = await newPage({ width: 390, height: 844 }); await connect(d); await connect(m);
  const run = await d.evaluate(() => ({ id: board.session.session_id, rev: opsData.run.roster_revision, seats: opsData.seats.map((s) => ({ seat_id: s.seat_id, student_id: s.student_id })), lesson: opsData.run.lesson && { course_id: opsData.run.lesson.course_id, version: opsData.run.lesson.version }, flags: opsData.run.flags, target: opsData.seats.find((s) => s.connection?.state === 'active' && s.attention === 'ok') }));
  assert.ok(run.target, 'a connected, fine seat exists on the preview'); const id = run.target.seat_id, base = `/admin/cohorts/${info.cohort}/classroom/runs/${run.id}`;
  for (const p of [d, m]) { await open(p, id); await p.fill('#ops-question', '[합성] 어디까지 확인했나요?'); await p.locator('#ops-question').focus(); }
  const put = (flags, rev) => api(base, 'PUT', { expected_roster_revision: rev, seats: run.seats, flags, lesson: run.lesson });
  const off = await put({ ...run.flags, ops_commands: false }, run.rev); facts.commands_off_put = off.status; assert.equal(off.status, 200, JSON.stringify(off.json));
  for (const [p, tag] of [[d, 'desktop'], [m, '390']]) {
    await tick(p); await p.locator('#ops-actions').filter({ hasText: '조치가 꺼져 있습니다' }).waitFor();
    facts['commands_off_' + tag] = { title: await p.locator('#ops-detail-title').innerText(), question_present: await p.locator('#ops-question').count(), live_note: await p.locator('#ops-actions').innerText().then((t) => /다시 표시했습니다/.test(t)) };
    await p.locator('#ops-actions').evaluate((e) => e.scrollIntoView({ block: 'start' }));
    await shot(p, `F-03-actions-off-live-${tag}`, `/manage (${id} 상세를 연 채 수업의 원격 조치를 끔)`, '상세를 닫지 않아도 조치 영역이 바로 바뀝니다 — 원격 조치가 꺼지면 질문 입력과 보내기가 사라지고 그 사실을 알립니다.', 'Codex F1 권한·플래그 실시간 반영', '합성 미리보기의 수업 플래그를 Service API로 끔 (뒤에 되돌림)');
  }
  const on = await put(run.flags, run.rev + 1); facts.commands_on_put = on.status; assert.equal(on.status, 200);
  for (const p of [d, m]) { await tick(p); await p.getByRole('button', { name: '질문 보내기', exact: true }).and(p.locator(':enabled')).waitFor(); assert.equal(await p.locator('#ops-question').inputValue(), '[합성] 어디까지 확인했나요?', 'the same learner\'s question comes back'); }
  const grant = await d.evaluate((sid) => opsData.seats.find((s) => s.seat_id === sid).connection.grant_id, id);
  const revoked = await api(`${base}/grants/${encodeURIComponent(grant)}`, 'DELETE'); facts.revoke = revoked.status; assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
  for (const [p, tag] of [[d, 'desktop'], [m, '390']]) {
    await tick(p); await p.getByRole('button', { name: '질문 보내기', exact: true }).and(p.locator(':disabled')).waitFor();
    facts['revoked_' + tag] = { title: await p.locator('#ops-detail-title').innerText(), question: await p.locator('#ops-question').inputValue(), send_disabled: await p.getByRole('button', { name: '질문 보내기', exact: true }).isDisabled(), focus: await p.evaluate(() => document.activeElement?.id || document.activeElement?.tagName) };
    await p.locator('#ops-recovery').evaluate((e) => e.scrollIntoView({ block: 'start' }));
    await shot(p, `F-04-revoked-live-${tag}`, `/manage (${id} 상세를 연 채 기기 연결 해제)`, '상세를 연 채 기기 연결이 해제되면 보내기가 그 자리에서 비활성화되고 첫 조치가 연결 코드 발급으로 바뀝니다. 쓰던 질문은 그대로입니다.', 'Codex F1 연결→해제 실시간 반영', '합성 미리보기에서 그 좌석의 연결을 Service API로 해제 (미리보기 재시작 전까지 유지)');
  }
  facts.live_seat = id; facts.page_errors_live = [...d.errors, ...m.errors];
} finally { await browser.close(); }
writeFileSync(path.join(out, 'capture-facts.json'), JSON.stringify({ captured_at: new Date().toISOString(), origin, synthetic: true, source, shots, facts }, null, 2) + '\n');
console.log(JSON.stringify(facts, null, 1));
