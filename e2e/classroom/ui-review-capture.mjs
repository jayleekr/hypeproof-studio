// Instructor UI review captures (#751) — drives a FRESH ui-review-preview.mjs through the instructor's path and saves one
// screenshot per step plus machine-read facts (overflow, primary CTAs, token absence, first row position).
//
//   node --experimental-strip-types --experimental-sqlite e2e/classroom/ui-review-preview.mjs &   # fresh: the flows below change its state
//   HPS_UI_REVIEW_OUT=<dir> node e2e/classroom/ui-review-capture.mjs
//
// Every capture carries a small "합성 데이터" badge added by this script (not part of the product) so a synthetic seat is never
// read as a real class. Nothing here is a real student, device, model, mail or network.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), pre = path.join(repo, 'e2e/test-results/ui-review-preview');
const info = JSON.parse(readFileSync(path.join(pre, 'preview.json'), 'utf8')), token = readFileSync(info.token_file, 'utf8').trim(), origin = new URL(info.url).origin;
const out = path.resolve(process.env.HPS_UI_REVIEW_OUT || path.join(pre, 'captures')); mkdirSync(out, { recursive: true });
const shots = [], facts = {};
const badge = () => { const add = () => { if (document.getElementById('hps-synthetic-badge')) return; const b = document.createElement('div'); b.id = 'hps-synthetic-badge'; b.textContent = '합성 데이터 · 로컬 미리보기 (실제 수업 아님)'; b.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99;pointer-events:none;font:600 12px system-ui;background:#E6A373;color:#151D19;padding:3px 8px;border-radius:4px;opacity:.92'; document.body.append(b); }; if (document.body) add(); else addEventListener('DOMContentLoaded', add); };
const browser = await chromium.launch();
async function newPage(viewport = { width: 1280, height: 720 }, deviceScaleFactor = 1) { const p = await browser.newPage({ viewport, deviceScaleFactor }); p.dsf = deviceScaleFactor; await p.addInitScript(badge); p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message)); return p; }
async function measure(p) {
  return p.evaluate((tok) => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, primaries: [...document.querySelectorAll('button.primary')].filter((b) => b.checkVisibility()).map((b) => b.textContent.trim()), tokenOnPage: document.documentElement.outerHTML.includes(tok) || [...document.querySelectorAll('input,textarea')].some((i) => i.value.includes(tok)) }), token);
}
async function shot(p, name, route, caption, change, scope = 'synthetic', opts = {}) {
  const m = await measure(p); assert.equal(m.tokenOnPage, false, name + ': the token must never be on the page'); assert.equal(m.overflow, false, name + ': horizontal overflow');
  const vp = p.viewportSize(), file = name + '.png'; await p.screenshot({ path: path.join(out, file), ...opts });
  shots.push({ file, route, viewport: `${vp.width}x${vp.height}`, device_scale_factor: p.dsf ?? 1, browser_zoom: '100%', caption, change, scope, primary_ctas: m.primaries, horizontal_overflow: m.overflow, token_on_page: m.tokenOnPage });
}
async function connect(p) {
  await p.goto(origin + '/manage'); await p.fill('#token', token); await p.fill('#cohort', info.cohort); await p.fill('#prefix', info.seat_prefix); await p.click('#connect-go');
  await p.locator('#status').filter({ hasText: '연결됨' }).waitFor(); await p.click('#ops-check'); await p.locator(`#ops-seats .ops-seat`).nth(info.seats - 1).waitFor(); await p.waitForTimeout(600);
}
const seat = (p, id) => p.locator(`#ops-seats .ops-seat[data-seat="${id}"]`), pick = (p, id) => seat(p, id).getByLabel('선택');
try {
  const p = await newPage();
  await connect(p);
  facts.first_row_top_1280x720 = await p.evaluate(() => Math.round(document.querySelector('#ops-seats .ops-seat').getBoundingClientRect().top + scrollY));
  facts.connection_form_hidden_after_connect = await p.locator('#connect').isHidden();
  await shot(p, '01-manage-board', '/manage', '운영 보드 첫 화면 — 연결 뒤 접속 입력은 한 줄로 접히고, 집계·선택·조치 다음 바로 학생 목록.', '상단 3단계 동선(준비→진행→마무리), 연결 요약 한 줄, 상태 집계 칩(기호+문구), 좌석 행 2열 압축, 상태별 왼쪽 표식');

  // Detail of a confirmed fault: cause → recovery action (primary) → result → technical record.
  await seat(p, 'C1').getByRole('button', { name: '근거·조치' }).click(); await p.locator('#ops-detail').waitFor(); await p.waitForTimeout(300);
  await shot(p, '02-manage-detail-fault', '/manage (C1 근거·조치)', '확인된 장애(토큰 거부) 학생의 상세 — 원인과 먼저 할 조치가 맨 위, 복구 버튼이 화면의 유일한 주요 버튼.', '상세 패널 순서를 원인·조치 결과 → 조치 버튼 → 결과 → 연결·보고 기록으로 재배치');
  await p.keyboard.press('Escape'); facts.escape_returns_focus_to = await p.evaluate(() => document.activeElement?.closest('.ops-seat')?.dataset.seat ?? null);

  // Selected diagnosis over a mix: a fault, a runtime fault and a seat without a device. Not "done", not "resolved".
  for (const id of ['C1', 'C2', 'D3']) await pick(p, id).check();
  await p.click('#ops-bulk-diagnose'); await p.locator('#ops-bulk-result').filter({ hasText: /D3/ }).waitFor(); await p.waitForTimeout(5000); await p.click('#refresh'); await p.waitForTimeout(1500);
  facts.diagnose_result = (await p.locator('#ops-bulk-result').innerText()).trim();
  await p.locator('#ops-bulk').scrollIntoViewIfNeeded(); await p.evaluate(() => scrollTo(0, 0));
  await shot(p, '03-manage-diagnose-partial', '/manage (선택 진단)', '선택 3석 진단 — 성공·실패·전달 안 됨이 대상별로 남고 ‘진단 완료’를 ‘해결’로 적지 않음.', '선택 막대를 하나의 영역으로 묶고 대상 수·연결 여부를 먼저 보여 줌');
  await p.click('#ops-select-none');

  // Distribution: write → select A1 A3 A4 D2 (A2 is left alone) → confirm (targets, impact, cancel) → per-target result.
  await p.click('#ops-dist-summary'); await p.fill('#ops-dist-title', '[합성] 다음 시간 준비물'); await p.fill('#ops-dist-body', '[합성 공지] 노트북 충전기를 가져오세요.'); await p.click('#ops-dist-save'); await p.locator('#ops-dist-saved').filter({ hasText: '저장했습니다' }).waitFor();
  for (const id of ['A1', 'A3', 'A4', 'D2']) await pick(p, id).check();
  await p.click('#ops-dist-preview'); await p.locator('#ops-dist-confirm').waitFor(); await p.waitForTimeout(300);
  await p.locator('#ops-dist-confirm').evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await shot(p, '04-manage-dist-confirm', '/manage (공지 보내기 — 먼저 확인)', '선택 4석에 공지 보내기 확인 — 대상·연결 여부·영향과 취소가 보내기 전에 보임.', '작성 영역을 조치 줄 안으로 옮겨 ‘쓰기 → 확인’이 위에서 아래로 이어짐');
  // Cancel keeps what was written and the selection; nothing is sent.
  await p.click('#ops-dist-cancel'); facts.cancel_keeps_input = (await p.locator('#ops-dist-body').inputValue()).includes('충전기'); facts.cancel_keeps_selection = await pick(p, 'A3').isChecked();
  await p.click('#ops-dist-preview'); await p.locator('#ops-dist-confirm').waitFor(); await p.click('#ops-dist-go');
  await p.locator('#ops-dist-items p').first().waitFor({ timeout: 20000 });
  for (let i = 0; i < 12; i++) { await p.waitForTimeout(1500); if (await p.locator('#ops-dist-refresh').isVisible()) await p.click('#ops-dist-refresh'); if (/실패 [1-9]/.test(await p.locator('#ops-dist-state').innerText()) && /보관함 반영 [1-9]/.test(await p.locator('#ops-dist-state').innerText())) break; }
  facts.dist_items = (await p.locator('#ops-dist-items').innerText()).split('\n').filter(Boolean); facts.dist_untouched_A2 = !facts.dist_items.some((l) => l.startsWith('A2 '));
  await p.locator('#ops-dist-results').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await shot(p, '05-manage-dist-result', '/manage (배포 결과)', '배포 결과 — 반영(✓)·실패(✕, 디스크 거부 합성)·미지원(!)·오프라인 접수(…)가 학생별로 갈림. 선택하지 않은 A2에는 아무것도 가지 않음.', '결과를 학생별 한 줄 목록 + 기호로 정리, 실패는 빨강·확인 필요는 주황·진행 중은 회색');
  await p.click('#ops-select-none');

  // Selected collection: consented + connected, consented + no upload, not consented (stale), no device.
  for (const id of ['A1', 'B6', 'C6', 'D3']) await pick(p, id).check();
  await p.click('#ops-pick-collect'); await p.locator('#ops-pick-confirm').waitFor(); await p.click('#ops-pick-go');
  await p.locator('#ops-pick-items p').first().waitFor({ timeout: 20000 }); for (let i = 0; i < 6; i++) { await p.waitForTimeout(1500); if (await p.locator('#ops-pick-refresh').isVisible()) await p.click('#ops-pick-refresh'); }
  facts.collect_items = (await p.locator('#ops-pick-items').innerText()).split('\n').filter(Boolean);
  await p.locator('#ops-results').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await shot(p, '06-manage-collect-result', '/manage (선택 기록 회수 결과)', '선택 4석 기록 회수 — 서버 검증됨·도착 전·제외(동의 없음/기기 없음)가 학생별로 남고 ‘회수 완료’로 뭉치지 않음.', '회수 결과를 같은 한 줄 목록 형식으로 통일');
  await p.click('#ops-select-none');

  // Shared help / submission (the learner chose to share) — the separate record view.
  await p.locator('#shares .share button').first().click(); await p.locator('#detail').waitFor(); await p.waitForTimeout(300);
  await p.locator('#shares-title').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await shot(p, '07-manage-shares', '/manage#shares-title', '학생이 직접 공유한 도움 요청·결과물과 강사 피드백 — 운영 보드와 분리된 개별 열람.', '명단 밖 학생이 없으면 중복된 ‘학생 현황’ 패널을 숨기고 공유 패널을 넓게; 원문 없음 안내를 이 패널로 이동');
  facts.legacy_panel_hidden_when_no_outside = await p.locator('#students-panel').isHidden();
  facts.page_errors_1280 = p.errors; await p.close();

  // Narrow: phone width, and the detail as a drawer.
  const n = await newPage({ width: 390, height: 844 }, 1); await connect(n);
  await shot(n, '08-manage-phone-390', '/manage', '390px 폭 — 한 열로 읽히고 가로 넘침 없음(자동 측정).', '좁은 화면에서 동선 막대·연결 요약·좌석 행이 줄바꿈');
  await seat(n, 'C3').getByRole('button', { name: '근거·조치' }).click(); await n.locator('#ops-detail').waitFor(); await n.waitForTimeout(300);
  facts.phone_drawer = await n.evaluate(() => { const e = document.getElementById('ops-detail'), r = e.getBoundingClientRect(); return { position: getComputedStyle(e).position, top: Math.round(r.top), full_width: Math.round(r.width) === innerWidth }; });
  facts.page_errors_390 = n.errors; await n.close();
  for (const [label, vp, dsf] of [['1024x700', { width: 1024, height: 700 }, 1], ['zoom200-720x450', { width: 720, height: 450 }, 2]]) { const z = await newPage(vp, dsf); await connect(z); await seat(z, 'C1').getByRole('button', { name: '근거·조치' }).click(); await z.locator('#ops-detail').waitFor(); facts['drawer_' + label] = { ...(await measure(z)), position: await z.locator('#ops-detail').evaluate((e) => getComputedStyle(e).position) }; await z.close(); }

  // The other instructor pages: first screen before connecting (no token is entered in these captures).
  for (const [i, route, caption] of [['09', '/authoring', '강의 작성 — 기존 밝은 작성 화면 위에 같은 3단계 동선.'], ['10', '/console', '수업 열기·종료 — 브랜드 색으로 통일, 동선 막대 추가.'], ['11', '/issuer', '학생 초대·토큰 — 설명을 강사 용어로, 발급≠연결 완료 안내.'], ['12', '/budgets', 'AI 예산 — 같은 동선 막대(‘← 수업 관리’ 대체).']]) {
    const q = await newPage(); await q.goto(origin + route); await q.waitForTimeout(400);
    await shot(q, `${i}-page${route.replace('/', '-')}`, route, caption, '공통 동선 막대(현재 화면 표시) · 연결 전 첫 화면', 'page only (연결 전)');
    facts['page_errors' + route.replace('/', '_')] = q.errors; await q.close();
  }
} finally { await browser.close(); }
writeFileSync(path.join(out, 'capture-facts.json'), JSON.stringify({ captured_at: new Date().toISOString(), origin, shots, facts }, null, 2) + '\n');
console.log(JSON.stringify(facts, null, 1));
