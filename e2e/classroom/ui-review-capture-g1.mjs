// G1 instructor operating surface (#751) — acceptance captures on the SYNTHETIC 24-seat preview (ui-review-preview.mjs).
//
//   HPS_UI_PREVIEW_PORT=<port> node --experimental-strip-types --experimental-sqlite e2e/classroom/ui-review-preview.mjs &
//   HPS_UI_REVIEW_OUT=<fresh dir> node e2e/classroom/ui-review-capture-g1.mjs
//
// Every picture carries a "합성 데이터" badge with the source head. Each shot records the viewport (browser zoom 100%), the primary
// CTAs on screen, horizontal overflow, whether the token text appears, and — for the default boards — the measured row boxes.
// The instructor steps are clicks on the real Chalk page against the real Service router + in-memory SQLite and the REAL device
// client code running in the preview process (sync loop, command runner, inbox store). What is changed here is listed per shot
// under `made_here`. Screenshots are acceptance pictures for a person; they do not replace e2e/classroom/ops-g1-layout.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), pre = path.join(repo, 'e2e/test-results/ui-review-preview');
const info = JSON.parse(readFileSync(path.join(pre, 'preview.json'), 'utf8')), token = readFileSync(info.token_file, 'utf8').trim(), origin = new URL(info.url).origin;
const out = path.resolve(process.env.HPS_UI_REVIEW_OUT || path.join(pre, 'captures-g1')); mkdirSync(out, { recursive: true });
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const source = { head: git('rev-parse', 'HEAD'), dirty_product: !!git('status', '--porcelain', '--', 'chalk/src', 'worker/src', 'extensions/hypeproof-chat/src') };
const LABEL = '합성 데이터 · 로컬 미리보기 (실제 수업 아님) · ' + source.head.slice(0, 7) + (source.dirty_product ? '+작업본' : '');
const badge = (label) => { const add = () => { if (document.getElementById('hps-synthetic-badge')) return; const b = document.createElement('div'); b.id = 'hps-synthetic-badge'; b.textContent = label; b.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99999;background:#fde68a;color:#1f2937;font:12px/1.3 system-ui;padding:4px 8px;border-radius:4px;pointer-events:none;max-width:70vw'; document.body.append(b); }; document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', add) : add(); };
const shots = [], facts = {}; const browser = await chromium.launch();
async function newPage(viewport) { const p = await browser.newPage({ viewport }); await p.addInitScript(badge, LABEL); p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message)); return p; }
const rows = (p) => p.evaluate(() => { const list = document.getElementById('ops-seats').getBoundingClientRect(), bottom = Math.min(innerHeight, list.bottom), r = [...document.querySelectorAll('#ops-seats .ops-seat')].filter((x) => !x.hidden).map((x) => x.getBoundingClientRect()); return { complete_rows: r.filter((b) => b.top >= list.top && b.bottom <= bottom + 0.5).length, first_row_top: Math.round(r[0]?.top ?? -1), row_heights: r.slice(0, 10).map((b) => Math.round(b.height)) }; });
const measure = (p) => p.evaluate((tok) => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, primaries: [...document.querySelectorAll('.primary')].filter((b) => b.checkVisibility()).map((b) => b.tagName.toLowerCase() + ': ' + b.textContent.trim()), tokenOnPage: document.body.innerText.includes(tok) }), token);
async function shot(p, name, caption, made = [], extra = {}) {
  const m = await measure(p); assert.equal(m.tokenOnPage, false, name + ': token on the page'); assert.equal(m.overflow, false, name + ': horizontal overflow'); assert.ok(m.primaries.length <= 1, name + ': more than one primary ' + m.primaries);
  const vp = p.viewportSize(), file = name + '.png'; await p.screenshot({ path: path.join(out, file) });
  shots.push({ file, route: '/manage', viewport: `${vp.width}x${vp.height}`, browser_zoom: '100%', caption, made_here: made, scope: 'synthetic', source_head: source.head, dirty_product: source.dirty_product, primary_ctas: m.primaries, horizontal_overflow: m.overflow, token_on_page: m.tokenOnPage, ...extra });
}
async function connect(p) { await p.goto(origin + '/manage'); await p.fill('#token', token); await p.fill('#cohort', info.cohort); await p.fill('#prefix', info.seat_prefix); await p.click('#connect-go'); await p.locator('#status').filter({ hasText: '연결됨' }).waitFor(); await p.locator('#ops-seats .ops-seat').nth(info.seats - 1).waitFor(); await p.waitForTimeout(800); }
const seat = (p, id) => p.locator(`#ops-seats .ops-seat[data-seat="${id}"]`);
const top = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); window.scrollBy(0, e.getBoundingClientRect().top - 8); }, sel);
try {
  // ── default boards ──
  const p = await newPage({ width: 1280, height: 720 }); await connect(p);
  const d1280 = await rows(p); facts.default_1280x720 = d1280; assert.ok(d1280.complete_rows >= 8, JSON.stringify(d1280));
  await shot(p, 'G1-01-default-1280x720', '기본 운영 보드(펼침 없음) — 왼쪽 메뉴·집계(누르면 보기만 좁힘)·찾기·도움 요청 한 줄·선택 도구·학생 표.', [], d1280);
  { const q = await newPage({ width: 1024, height: 640 }); await connect(q); const d = await rows(q); facts.default_1024x640 = d; assert.ok(d.complete_rows >= 4, JSON.stringify(d));
    await shot(q, 'G1-02-default-1024x640', '1024×640 기본 보드 — 메뉴는 ‘메뉴’ 버튼의 서랍으로 접힘.', [], d);
    await q.locator('#side-open').click(); await shot(q, 'G1-03-nav-drawer-1024x640', '1024×640 메뉴 서랍 — 뒤 화면은 조작 불가(inert), Esc로 닫히고 포커스는 ‘메뉴’로 돌아감. 수업 전체 ‘새 AI 실행’ 제어도 여기.'); await q.keyboard.press('Escape');
    await seat(q, 'C2').getByRole('button', { name: '근거·조치' }).click(); await q.locator('#ops-detail-title').filter({ hasText: 'C2' }).waitFor(); await shot(q, 'G1-04-detail-drawer-1024x640', '1024×640 학생 상세 서랍 — Esc·배경으로 닫고 연 행으로 포커스 복귀.'); await q.close(); }

  // ── selected student with a technical error: detail beside the list ──
  await seat(p, 'C1').getByLabel('선택').check(); await seat(p, 'C1').getByRole('button', { name: '근거·조치' }).click(); await p.locator('#ops-detail-title').filter({ hasText: 'C1' }).waitFor();
  facts.detail_1280 = await rows(p); await shot(p, 'G1-05-selected-error-detail-1280x720', 'C1(토큰 거부) 선택 + 상세 — 목록·선택·현재 행 표시는 유지, 상세는 오른쪽. 원인·앱 보고·먼저 할 조치(재발급)가 주요 버튼.', [], facts.detail_1280);
  await p.keyboard.press('Escape');

  // ── bulk collection confirmation: kinds chosen, exclusions shown before any request ──
  await p.locator('#ops-select-none').click(); for (const id of ['A1', 'A2', 'B6', 'C1', 'D2']) await seat(p, id).getByLabel('선택').check();
  await p.locator('#ops-pick-collect').click(); await p.locator('#ops-pick-confirm').waitFor(); await p.locator('#ops-pick-kind-record').check(); await p.waitForTimeout(400);
  await top(p, '#ops-bulk'); await shot(p, 'G1-06-bulk-collect-confirm-1280x720', '선택 5명 회수 확인 — 종류는 강사가 직접 고름(기본 선택 없음). 동의 없음·기기 없음은 제외 사유로 먼저 보임. 이 단계까지 요청 없음.');
  await p.locator('#ops-pick-go').click(); await p.locator('#ops-ledger-list .ledger-card').first().waitFor();
  await p.locator('#ops-pick-items').filter({ hasText: /A1 · .* — 현재: 서버 검증됨/ }).waitFor({ timeout: 90000 }); await p.waitForTimeout(1500);
  await top(p, '#ops-results'); await shot(p, 'G1-07-collect-result-brief-1280x720', '회수 결과 카드(접힌 상태) — 첫 줄은 조치·확정/미확인/진행 중·다음 행동. 학생별 짧은 상태 — 서버 검증·기록 범위, 최종 거부(기록 없음), 동의 없음 제외. 펼치기 전에도 확정과 실패·제외가 구분됨.');
  facts.collect_card = { h4: await p.locator('#ops-ledger-list .ledger-card').first().locator('h4').innerText(), lines: await p.locator('#ops-ledger-list .ledger-card').first().locator('.ledger-items > p').allInnerTexts() };
  await p.locator('#ops-ledger-list .ledger-card').first().locator('.ledger-full').click(); await top(p, '#ops-results'); await shot(p, 'G1-08-collect-result-expanded-1280x720', '같은 카드의 ‘세부 근거 펼치기’ — 세션 범위·시작/끝 증명·받은 종류·확인 불가 사유.');
  // A1's copy as an app that stopped mid-write with a cut artifact would report it (the U1b /3 shape: a torn tail, an unproven end, one
  // artifact kept only up to the storage limit). The Service answer is rewritten in THIS browser only, and the shot says so.
  await p.route(/\/report-batches\/[^/?]+$/, async (route) => { if (route.request().method() !== 'GET') return route.continue(); const r = await route.fetch(), j = await r.json(); for (const i of j.items || []) if (i.seat_id === 'A1' && i.extent?.parts) { i.coverage = 'range_unknown'; i.extent.reasons = ['torn_tail_dropped', 'artifact_truncated']; i.extent.received = { ...i.extent.received, artifact_approved: 1, truncated_artifacts: 1 }; i.extent.parts = i.extent.parts.map((x) => ({ ...x, end_proven: false, torn_tail: true, truncated_artifacts: 1 })); } return route.fulfill({ response: r, json: j }); });
  await p.locator('#ops-ledger-list .ledger-card').first().locator('.ledger-more').click(); await p.waitForFunction(() => /잘린 결과물/.test(document.querySelector('#ops-ledger-list .ledger-card .ledger-items')?.textContent || '')); await p.locator('#ops-ledger-list .ledger-card').first().locator('.ledger-full').click();
  await top(p, '#ops-results'); await shot(p, 'G1-08b-collect-truncated-unknown-brief-1280x720', '끝을 확인할 수 없는 세션과 잘린 결과물이 있는 회수 — 접힌 카드에서도 ‘수업 전체의 기록이 아님 · 잘린 결과물 1개 · 세션 끝 확인 불가’. 완전한 기록으로 표시하지 않음.', ['A1의 회수 조회 응답을 이 브라우저에서만 잘린 꼬리·잘린 결과물 형태로 바꿈 (page.route)']);
  facts.collect_truncated = { lines: await p.locator('#ops-ledger-list .ledger-card').first().locator('.ledger-items > p').allInnerTexts() }; await p.locator('#ops-ledger-list .ledger-card').first().locator('.ledger-full').click(); await top(p, '#ops-results'); await shot(p, 'G1-08c-collect-truncated-unknown-expanded-1280x720', '같은 카드 펼침 — 사유별로 다시 요청해도 돌아오지 않는 것(잘린 꼬리·잘린 결과물)을 명시.', ['위와 같은 응답 가공 (page.route)']); await p.unroute(/\/report-batches\/[^/?]+$/);

  // ── distribution: compose, save, confirm, per-target results ──
  await p.locator('#ops-select-none').click(); for (const id of ['A1', 'A2', 'A3', 'A4', 'D2']) await seat(p, id).getByLabel('선택').check();
  await p.locator('#ops-dist-summary').click(); await p.fill('#ops-dist-title', '[합성] 다음 활동 안내'); await p.fill('#ops-dist-body', '[합성] 미리보기를 다시 열고 버튼이 보이는지 확인해 보세요.'); await p.locator('#ops-dist-save').click(); await p.locator('#ops-dist-saved').filter({ hasText: '1번째 판' }).waitFor();
  await p.locator('#ops-dist-preview').click(); await p.locator('#ops-dist-confirm').waitFor(); await top(p, '#ops-dist-confirm'); await shot(p, 'G1-09-distribution-confirm-1280x720', '공지 보내기 전 확인 — 대상별 예정(지금 전달 가능·앱 미지원·미연결)과 본문 평문. 아직 보내지 않음.');
  await p.locator('#ops-dist-go').click(); await p.locator('#ops-dist-items').filter({ hasText: /^A1 · / }).waitFor(); await p.waitForTimeout(6000); await p.locator('#ops-dist-refresh').click().catch(() => {}); await p.waitForTimeout(1500);
  await top(p, '#ops-results'); await shot(p, 'G1-10-distribution-results-1280x720', '배포 결과 — 회수 카드와 따로 남는 새 카드. 보관함 반영/실패(디스크 거부)/앱 미지원/미연결 접수를 구분, ‘접수’는 전달이 아님.');
  facts.dist_card = { h4: await p.locator('#ops-ledger-list .ledger-card').first().locator('h4').innerText(), lines: await p.locator('#ops-ledger-list .ledger-card').first().locator('.ledger-items > p').allInnerTexts() };

  // ── help queue ──
  await p.evaluate(() => scrollTo(0, 0)); await p.locator('#ops-help-toggle').click(); await shot(p, 'G1-11-help-queue-1280x720', '도움 요청 응대 펼침 — 학생이 보낸 학습 도움 요청(기술 장애와 별개), 좌석 상세로 이동.'); await p.locator('#ops-help-toggle').click();

  // ── wrap-up: a dry run of the finish, then the four steps ──
  await p.locator('nav.flow a[href="#ops-wrap-title"]').click(); await p.locator('#ops-finish-go').click(); await p.locator('#ops-finish-state').filter({ hasText: '미리 확인 결과' }).waitFor(); await top(p, '#ops-wrap');
  facts.wrap = await p.locator('#ops-wrap-steps > li').evaluateAll((l) => l.map((x) => ({ state: x.className, text: x.innerText })));
  await shot(p, 'G1-12-wrapup-1280x720', '수업 마무리 단계 — 미리 확인만 한 상태. 보고서 초안·검수는 회수 뒤, 발송은 이 수업에서 꺼짐(사용할 수 없음). 연결 안 된 경로를 명시.', ['‘수업 마무리 시작’ 미리 확인(dry run) 1회 — 저장·요청 없음']);
  const errors = p.errors; assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'captures.json'), JSON.stringify({ at: new Date().toISOString(), synthetic: true, preview: { ...info, token_file: undefined }, source, label: LABEL, facts, shots }, null, 2) + '\n');
  console.log('G1 captures → ' + out + '\n' + JSON.stringify({ default_1280x720: facts.default_1280x720, default_1024x640: facts.default_1024x640, detail_1280: facts.detail_1280 }));
} finally { await browser.close(); }
