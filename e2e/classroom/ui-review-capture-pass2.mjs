// Instructor UI pass 2 captures (#751) — only the screens the four operating fixes changed: the board right after connect,
// a rejected-token detail, the help entry under "2 수업 진행", an opened help request, and the pairing / shared-outage first
// actions; desktop 1280x720 and phone 390x844. Reads nothing but the page; sends, collects and changes nothing.
//
//   node --experimental-strip-types --experimental-sqlite e2e/classroom/ui-review-preview.mjs &
//   HPS_UI_REVIEW_OUT=<dir> node e2e/classroom/ui-review-capture-pass2.mjs
//
// Every capture carries the same "합성 데이터" badge as ui-review-capture.mjs (added here, not part of the product).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), pre = path.join(repo, 'e2e/test-results/ui-review-preview');
const info = JSON.parse(readFileSync(path.join(pre, 'preview.json'), 'utf8')), token = readFileSync(info.token_file, 'utf8').trim(), origin = new URL(info.url).origin;
const out = path.resolve(process.env.HPS_UI_REVIEW_OUT || path.join(pre, 'captures-pass2')); mkdirSync(out, { recursive: true });
const shots = [], facts = {};
const badge = () => { const add = () => { if (document.getElementById('hps-synthetic-badge')) return; const b = document.createElement('div'); b.id = 'hps-synthetic-badge'; b.textContent = '합성 데이터 · 로컬 미리보기 (실제 수업 아님)'; b.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99;pointer-events:none;font:600 12px system-ui;background:#E6A373;color:#151D19;padding:3px 8px;border-radius:4px;opacity:.92'; document.body.append(b); }; if (document.body) add(); else addEventListener('DOMContentLoaded', add); };
const browser = await chromium.launch();
async function newPage(viewport) { const p = await browser.newPage({ viewport }); await p.addInitScript(badge); p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message)); return p; }
const measure = (p) => p.evaluate((tok) => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, primaries: [...document.querySelectorAll('.primary')].filter((b) => b.checkVisibility()).map((b) => b.tagName.toLowerCase() + ': ' + b.textContent.trim()), tokenOnPage: document.documentElement.outerHTML.includes(tok) || [...document.querySelectorAll('input,textarea')].some((i) => i.value.includes(tok)) }), token);
async function shot(p, name, route, caption, change) {
  const m = await measure(p); assert.equal(m.tokenOnPage, false, name + ': token on the page'); assert.equal(m.overflow, false, name + ': horizontal overflow'); assert.ok(m.primaries.length <= 1, name + ': more than one primary ' + m.primaries);
  const vp = p.viewportSize(), file = name + '.png'; await p.screenshot({ path: path.join(out, file) });
  shots.push({ file, route, viewport: `${vp.width}x${vp.height}`, browser_zoom: '100%', caption, change, scope: 'synthetic', primary_ctas: m.primaries, horizontal_overflow: m.overflow, token_on_page: m.tokenOnPage });
}
async function connect(p) {
  await p.goto(origin + '/manage'); await p.fill('#token', token); await p.fill('#cohort', info.cohort); await p.fill('#prefix', info.seat_prefix); await p.click('#connect-go');
  await p.locator('#status').filter({ hasText: '연결됨' }).waitFor(); facts['ops_state_when_connected_' + p.viewportSize().width] = await p.locator('#ops-state').innerText();
  await p.locator('#ops-seats .ops-seat').nth(info.seats - 1).waitFor(); await p.waitForTimeout(600); // no "준비 확인" click: the roster loads on connect
}
const seat = (p, id) => p.locator(`#ops-seats .ops-seat[data-seat="${id}"]`), open = async (p, id) => { if (await p.locator('#ops-detail').evaluate((e) => !e.hidden && getComputedStyle(e).position === 'fixed')) await p.keyboard.press('Escape'); /* the phone drawer covers the list */ await seat(p, id).getByRole('button', { name: '근거·조치' }).click(); await p.locator('#ops-detail').waitFor(); await p.waitForTimeout(300); };
const helpLink = (p) => p.locator('nav.flow .flow-step').nth(1).getByRole('link', { name: '도움 요청 응대' });
try {
  for (const [w, h, tag] of [[1280, 720, 'desktop'], [390, 844, '390']]) {
    const p = await newPage({ width: w, height: h }); await connect(p);
    if (tag === 'desktop') {
      facts.summary = await p.locator('#ops-summary').innerText(); facts.help_state = await p.locator('#ops-help-state').innerText(); facts.help_queue = (await p.locator('#ops-help-list li > span').allInnerTexts());
      facts.select_help_label = (await p.locator('#ops-select-help').innerText()).trim(); facts.select_fault_label = (await p.locator('#ops-select-fault').innerText()).trim();
      await p.click('#ops-select-help'); facts.select_help_result = await p.locator('#ops-selection').innerText(); await p.click('#ops-select-fault'); facts.select_fault_result = await p.locator('#ops-selection').innerText(); await p.click('#ops-select-none');
    }
    await shot(p, `P2-01-board-${tag}`, '/manage', '연결 직후 운영 보드 — 버튼을 누르지 않아도 이번 수업 명단을 불러옵니다. 집계에 ✋ 도움 요청이 따로 있고, 목록 위 ‘도움 요청 응대’에 학생이 직접 보낸 요청만 보입니다.', '#1 연결=명단 조회 일치 · #2 도움 요청/기술 문제 분리(선택 버튼 2개와 인원)');
    await open(p, 'C1');
    if (tag === 'desktop') { facts.c1_first_action = await p.locator('#ops-actions .primary').evaluate((a) => ({ tag: a.tagName, href: a.getAttribute('href'), target: a.getAttribute('target'), text: a.textContent })); facts.c1_diagnostics_primary = await p.getByRole('button', { name: '진단 다시 실행' }).evaluate((b) => b.classList.contains('primary')); }
    await shot(p, `P2-02-detail-token-${tag}`, '/manage (C1 근거·조치)', '토큰이 거부된 학생 — 서버가 정한 먼저 할 조치(재발급)가 유일한 주요 버튼. 고정 강의 수업이라 수업 참여 코드 발급 화면(/authoring)으로, 새 탭에서 엽니다.', '#3 원인별 첫 조치 = recommended.action (진단 다시 실행은 보조)');
    // Help entry from "2 수업 진행" with a seat detail open and a question being typed: nothing is lost.
    if (tag === '390') await p.keyboard.press('Escape');
    await seat(p, 'A2').getByLabel('선택').check(); await open(p, 'B2'); await p.fill('#ops-question', '[합성] 어디까지 확인했나요?');
    if (tag === '390') { await p.keyboard.press('Escape'); await p.evaluate(() => scrollTo(0, 0)); facts.help_link_in_view_390 = await helpLink(p).evaluate((a) => { const r = a.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }); } // the full-width drawer covers the flow bar on a phone
    await helpLink(p).click(); await p.waitForTimeout(300);
    facts['kept_after_help_link_' + tag] = { url_hash: new URL(p.url()).hash, detail_open: await p.locator('#ops-detail').isVisible(), a2_selected: await seat(p, 'A2').getByLabel('선택').isChecked(), status: await p.locator('#status').innerText(), question: tag === 'desktop' ? await p.locator('#ops-question').inputValue() : null };
    await shot(p, `P2-03-help-entry-${tag}`, '/manage#ops-help-title (상단 ‘2 수업 진행 › 도움 요청 응대’)', '수업 중 도움 응대 — 상단 동선의 ‘2 수업 진행’에서 바로 이동. 같은 화면 안 이동이라 열린 상세·작성 중인 질문·선택이 그대로입니다.', '#4 도움 응대 진입을 ‘2 수업 진행’으로 · ‘3 마무리’는 결과물·기록 회수·보고서');
    await p.locator('#ops-help-list li').filter({ hasText: 'synth-08' }).getByRole('button', { name: '요청 열기' }).click(); await p.locator('#detail').waitFor(); await p.fill('#feedback-text', '[합성] 작성 중인 답변'); await p.fill('#next-action', '[합성] 390px에서 버튼 위치 다시 보기'); await p.waitForTimeout(300);
    await shot(p, `P2-04-help-open-${tag}`, '/manage (B2 도움 요청 열기)', '도움 요청을 연 화면 — 학생이 고른 내용만 보이고, 작성 중인 답변은 10초 갱신에도 그대로입니다.', '#4 도움 요청 목록 → 요청 열기 (기존 공유 기록·피드백 계약 그대로)');
    if (tag === 'desktop') { await p.click('#refresh'); await p.waitForTimeout(800); facts.feedback_draft_after_refresh = await p.locator('#feedback-text').inputValue(); }
    await p.click('#close-detail');
    if (tag === '390') { await open(p, 'B2'); facts.question_after_drawer_closed_390 = await p.locator('#ops-question').inputValue(); await p.keyboard.press('Escape'); }
    if (tag === 'desktop') {
      await open(p, 'D2'); facts.d2_first_action = (await p.locator('#ops-actions .primary').innerText()).trim(); facts.d2_first_group = await p.locator('#ops-actions > .group').first().locator('h3').innerText();
      await shot(p, 'P2-05-detail-pairing-desktop', '/manage (D2 근거·조치)', '연결된 적 없는 학생 — 먼저 할 조치는 연결 코드 발급이고 그 묶음이 맨 위에 옵니다.', '#3 미연결 → 연결 코드 발급 먼저');
      await open(p, 'C3'); facts.c3_detail_primaries = await p.locator('#ops-detail .primary').count();
      await shot(p, 'P2-06-detail-shared-desktop', '/manage (C3 근거·조치)', '공통 원인(AI 제공자 529) 좌석 — 이 미리보기에선 3석뿐이라 공통 장애 기준(명단의 30%) 아래이고, 서버가 먼저 할 조치로 ‘진단 다시 실행’을 제시합니다. ‘PC 초기화로 해결되지 않음’ 안내가 복구 묶음 맨 위에 옵니다. (기준 이상이면 개별 첫 조치 없음 — ops-help.mjs가 시험)', '#3 공통 원인 → PC 초기화 유도 없음 · 서버 권장 조치 그대로');
    }
    facts['page_errors_' + tag] = p.errors; await p.close();
  }
} finally { await browser.close(); }
writeFileSync(path.join(out, 'capture-facts.json'), JSON.stringify({ captured_at: new Date().toISOString(), origin, synthetic: true, shots, facts }, null, 2) + '\n');
console.log(JSON.stringify(facts, null, 1));
