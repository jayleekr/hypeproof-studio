// Instructor UI integration captures (#751) — the screens the U4 + UI pass 2 integration fixes changed: help while the share read
// fails, a share read capped at the Service limit, and a seat handed to another learner while a question is unsent.
// Desktop 1280x720 and phone 390x844. The share failure and the cap are answered by page.route in this browser only; the seat
// hand-over is a real roster change through the Service API on the SYNTHETIC preview (it changes that preview's roster, then
// puts it back).
//
//   HPS_UI_PREVIEW_PORT=<port> node --experimental-strip-types --experimental-sqlite e2e/classroom/ui-review-preview.mjs &
//   HPS_UI_REVIEW_OUT=<fresh dir> node e2e/classroom/ui-review-capture-integration.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), pre = path.join(repo, 'e2e/test-results/ui-review-preview');
const info = JSON.parse(readFileSync(path.join(pre, 'preview.json'), 'utf8')), token = readFileSync(info.token_file, 'utf8').trim(), origin = new URL(info.url).origin;
const out = path.resolve(process.env.HPS_UI_REVIEW_OUT || path.join(pre, 'captures-integration')); mkdirSync(out, { recursive: true });
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const source = { head: git('rev-parse', 'HEAD'), dirty_product: !!git('status', '--porcelain', '--', 'chalk/src', 'worker/src', 'extensions/hypeproof-chat/src') };
const shots = [], facts = {};
const badge = (label) => { const add = () => { if (document.getElementById('hps-synthetic-badge')) return; const b = document.createElement('div'); b.id = 'hps-synthetic-badge'; b.textContent = label; b.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99;pointer-events:none;background:#7A2E2E;color:#fff;font:600 12px/1.4 system-ui;padding:4px 8px;border-radius:4px;max-width:70vw'; document.body.append(b); }; document.readyState === 'loading' ? addEventListener('DOMContentLoaded', add) : add(); };
const LABEL = '합성 데이터 · 로컬 미리보기 (실제 수업 아님) · ' + source.head.slice(0, 7);
const browser = await chromium.launch();
async function newPage(viewport) { const p = await browser.newPage({ viewport }); await p.addInitScript(badge, LABEL); p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message)); return p; }
const measure = (p) => p.evaluate((tok) => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, primaries: [...document.querySelectorAll('.primary')].filter((b) => b.checkVisibility()).map((b) => b.tagName.toLowerCase() + ': ' + b.textContent.trim()), tokenOnPage: document.documentElement.outerHTML.includes(tok) }), token);
async function shot(p, name, route, caption, change, made) {
  const m = await measure(p); assert.equal(m.tokenOnPage, false, name + ': token on the page'); assert.equal(m.overflow, false, name + ': horizontal overflow'); assert.ok(m.primaries.length <= 1, name + ': more than one primary ' + m.primaries);
  const vp = p.viewportSize(), file = name + '.png'; await p.screenshot({ path: path.join(out, file) });
  shots.push({ file, route, viewport: `${vp.width}x${vp.height}`, browser_zoom: '100%', caption, change, made_here: made, scope: 'synthetic', source_head: source.head, primary_ctas: m.primaries, horizontal_overflow: m.overflow, token_on_page: m.tokenOnPage });
}
async function connect(p) {
  await p.goto(origin + '/manage'); await p.fill('#token', token); await p.fill('#cohort', info.cohort); await p.fill('#prefix', info.seat_prefix); await p.click('#connect-go');
  await p.locator('#status').filter({ hasText: '연결됨' }).waitFor(); await p.locator('#ops-seats .ops-seat').nth(info.seats - 1).waitFor(); await p.waitForTimeout(600);
}
const seat = (p, id) => p.locator(`#ops-seats .ops-seat[data-seat="${id}"]`);
const open = async (p, id) => { if (await p.locator('#ops-detail').evaluate((e) => !e.hidden && getComputedStyle(e).position === 'fixed')) await p.keyboard.press('Escape'); await seat(p, id).getByRole('button', { name: '근거·조치' }).click(); await p.locator('#ops-detail-title').filter({ hasText: id }).waitFor(); };
const SHARES = /\/classroom\/shares(\?|$)/;
const api = async (p, method, body) => { const r = await fetch(origin + p, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
try {
  for (const [w, h, tag] of [[1280, 720, 'desktop'], [390, 844, '390']]) {
    const p = await newPage({ width: w, height: h }); await connect(p);
    let mode = 'fail'; await p.route(SHARES, async (route) => { if (mode === 'fail') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"[합성] 공유 기록 일시 장애"}' }); if (mode === 'cap') { const r = await route.fetch(), j = await r.json(); j.limit = j.shares.length; return route.fulfill({ response: r, json: j }); } return route.continue(); });
    await p.click('#refresh'); await p.locator('#ops-help-state').filter({ hasText: '알 수 없습니다' }).waitFor(); await p.evaluate(() => document.getElementById('ops-help-title').scrollIntoView());
    facts['unknown_' + tag] = { help_state: await p.locator('#ops-help-state').innerText(), summary: await p.locator('#ops-summary').innerText(), select_help: (await p.locator('#ops-select-help').innerText()).trim(), select_help_disabled: await p.locator('#ops-select-help').isDisabled(), seats: await p.locator('#ops-seats .ops-seat').count() };
    await shot(p, `I-01-help-unknown-${tag}`, '/manage (공유 기록 조회 실패)', '공유 기록을 못 읽은 동안 — 도움 요청은 ‘없음’이 아니라 ‘확인 불가’. 집계·선택 버튼·좌석 카드가 같은 말을 하고, 명단과 선택은 그대로입니다.', 'Codex P2 #1 실패=확인 불가', 'shares 목록 요청 503 (page.route)');
    if (tag === 'desktop') {
      mode = 'cap'; await p.click('#refresh'); await p.locator('#ops-help-state').filter({ hasText: '한도에 닿아' }).waitFor(); await p.evaluate(() => document.getElementById('ops-help-title').scrollIntoView());
      facts.capped = { help_state: await p.locator('#ops-help-state').innerText(), select_help: (await p.locator('#ops-select-help').innerText()).trim() };
      await shot(p, 'I-02-help-capped-desktop', '/manage (공유 기록 한도 도달)', '공유 기록이 Service 한도(행 수)에 닿은 경우 — 도움 요청 수는 하한(‘n 이상’)으로 표시합니다.', 'Codex P2 #1 일부만 읽힘=하한', 'shares 응답의 limit을 행 수로 바꿈 (page.route)');
    }
    mode = 'ok'; await p.click('#refresh'); await p.locator('#ops-select-help').filter({ hasNotText: /이상|확인 불가/ }).waitFor(); await p.locator('#ops-help-state').filter({ hasNotText: /한도|알 수 없습니다/ }).waitFor(); facts['recovered_' + tag] = await p.locator('#ops-help-state').innerText(); await p.unroute(SHARES);
    if (tag === 'desktop') {
      // A1 → another learner while an unsent question for A1's learner is open.
      await open(p, 'A1'); await p.fill('#ops-question', '[합성] 어디까지 확인했나요?');
      const run = await p.evaluate(() => ({ id: board.session.session_id, rev: opsData.run.roster_revision, seats: opsData.seats.map((s) => ({ seat_id: s.seat_id, student_id: s.student_id })), lesson: opsData.run.lesson && { course_id: opsData.run.lesson.course_id, version: opsData.run.lesson.version }, flags: opsData.run.flags }));
      const base = `/admin/cohorts/${info.cohort}/classroom/runs/${run.id}`, holder = run.seats.find((s) => s.seat_id === 'A1').student_id, spare = run.seats.find((s) => s.seat_id === 'D6').student_id;
      const put = (seats, rev) => api(base, 'PUT', { expected_roster_revision: rev, seats, flags: run.flags, lesson: run.lesson });
      const moved = await put(run.seats.map((s) => s.seat_id === 'A1' ? { ...s, student_id: spare } : s.seat_id === 'D6' ? { ...s, student_id: holder } : s), run.rev);
      facts.handover_put = moved.status;
      if (moved.status === 200) {
        await p.click('#refresh'); await p.locator('#ops-detail-title').filter({ hasText: 'A1 · ' + spare }).waitFor();
        facts.handover = { title: await p.locator('#ops-detail-title').innerText(), question: await p.locator('#ops-question').inputValue(), note: await p.locator('#ops-detail-status').innerText() };
        await p.evaluate(() => document.getElementById('ops-detail-status').scrollIntoView({ block: 'center' }));
        await shot(p, 'I-03-seat-handover-desktop', '/manage (A1 좌석 주인 변경)', '질문을 쓰던 중 좌석이 다른 학생에게 넘어간 경우 — 새 학생 앞으로 쓰던 질문을 옮기지 않고 그 사실을 알립니다.', 'Codex P2 #2 초안=수업·학생·좌석', '합성 미리보기의 명단을 Service API로 바꿈 (뒤에 되돌림)');
        const back = await put(run.seats, run.rev + 1); facts.handback_put = back.status;
      }
    }
    facts['page_errors_' + tag] = p.errors; await p.close();
  }
} finally { await browser.close(); }
writeFileSync(path.join(out, 'capture-facts.json'), JSON.stringify({ captured_at: new Date().toISOString(), origin, synthetic: true, source, shots, facts }, null, 2) + '\n');
console.log(JSON.stringify(facts, null, 1));
