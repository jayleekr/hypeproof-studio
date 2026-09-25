// Remote classroom operations (#751, U1) — the instructor's side of the Mac session, in a visible browser window.
//
//   HPS_DEMO_PREPARE_A1=1 node --experimental-strip-types --experimental-sqlite e2e/classroom/mac-demo.mjs   # first, in another terminal
//   node e2e/classroom/mac-demo-board.mjs                                                                     # this file; the window stays open
//
// It signs in to the REAL Chalk /manage page of the running local session (synthetic instructor token from session.json),
// selects seat A1 — the real Studio window — and collects that learner's class record through the UI: preview → confirm →
// per-target result. Then it checks, from the Service's own rows, that the two scripted seats (A2, A3: connected AND
// consenting, so only the selection keeps them out) got no command, no item beyond `not_selected`, no object and that no
// evaluation input was queued. Real: Chalk UI, Service router + SQLite, the Studio shell copy, its spool, freezer and upload.
// Synthetic: accounts, lesson, model answers, seats A2/A3. Says nothing about Windows, a school network, staging or production.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), home = path.resolve(process.env.HPS_DEVHOST_DIR || path.join(repo, 'e2e/test-results/classroom-devhost'));
const session = JSON.parse(readFileSync(path.join(home, 'session.json'), 'utf8')), out = path.join(home, 'board'); mkdirSync(out, { recursive: true });
const status = async () => (await fetch(session.guide + '/status')).json(), seatOf = (d, id) => d.status.seats.find((s) => s.seat_id === id);
const before = await status(); assert.equal(seatOf(before, 'A1')?.connection?.state, 'active', 'seat A1 (the real Studio window) is not connected — start mac-demo.mjs with HPS_DEMO_PREPARE_A1=1, or prepare the seat by hand from /demo');
for (const id of ['A2', 'A3']) assert.equal(seatOf(before, id)?.connection?.state, 'active', id + ' (scripted seat) should be connected');

const browser = await chromium.launch({ headless: process.env.HPS_BOARD_HEADLESS === '1' }), page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(session.board); await page.locator('#token').fill(session.teacherToken); await page.locator('#cohort').fill(session.cohort); await page.locator('#connect button').first().click();
await page.locator('#status').filter({ hasText: '연결됨' }).waitFor(); await page.locator('#ops-check').click();
const row = (id) => page.locator(`#ops-seats .ops-seat[data-seat="${id}"]`); await row('A6').waitFor();
assert.match(await row('A1').innerText(), /앱이 같은 발급분|준비|입장/); assert.match(await page.locator('#ops-selection').innerText(), /선택한 좌석이 없습니다/);
await row('A1').getByLabel('선택').check(); assert.match(await page.locator('#ops-selection').innerText(), /선택 1 \/ 전체 6석 .* 기기 연결됨 1 · 기기 연결 없음 0 .*: A1$/);
await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor();
const impact = await page.locator('#ops-pick-impact').innerText(); assert.match(impact, /선택 1명 중 1명에게 기록 회수를 요청합니다.*선택하지 않은 5명에게는 아무것도 요청·저장하지 않습니다/);
assert.equal((await status()).upload_commands.length, before.upload_commands.length, 'the preview asked no device'); await page.screenshot({ path: path.join(out, '01-preview.png'), fullPage: true });
await page.locator('#ops-pick-go').click();
await page.locator('#ops-pick-items').filter({ hasText: /A1 · .* — 현재: 서버 검증됨/ }).waitFor({ timeout: 120000 }).catch(async (e) => { throw Error('A1 did not verify: ' + (await page.locator('#ops-pick-state').innerText()) + ' | ' + (await page.locator('#ops-pick-items').innerText()), { cause: e }); });
await page.locator('#ops-pick-observed').filter({ hasText: /결과 확정/ }).waitFor({ timeout: 30000 }); await page.locator('#ops-pick-state').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(out, '02-collected.png'), fullPage: true });

const after = await status(), batch = after.collect_batches.filter((b) => b.scope === 'targets' && !b.dry_run).at(-1); assert.ok(batch, 'a targeted batch exists'); assert.deepEqual(JSON.parse(batch.targets), ['A1']); assert.equal(batch.mode, 'collect_only');
const items = after.collect_items.filter((i) => i.batch_id === batch.id), a1 = items.find((i) => i.seat_id === 'A1'), a1Student = a1.student_id;
assert.deepEqual(items.map((i) => [i.seat_id, i.state]), [['A1', 'verified'], ...['A2', 'A3', 'A4', 'A5', 'A6'].map((id) => [id, 'not_selected'])]);
const objects = after.objects.filter((k) => k.includes(batch.id)); assert.equal(objects.length, 2); assert.ok(objects.every((k) => k.includes('/' + a1Student + '/')), 'objects for A1 only: ' + objects.join(' '));
assert.equal(after.objects.filter((k) => !k.includes('/' + a1Student + '/')).length, 0, 'no object exists for any other learner'); assert.deepEqual(after.upload_commands.map((t) => t.seat_id), [...before.upload_commands.map((t) => t.seat_id), 'A1'], 'only A1\'s device was asked');
assert.equal(after.evaluation_inputs, before.evaluation_inputs, 'collecting queued no evaluation'); assert.equal(after.jobs.length, before.jobs.length); assert.equal(after.evaluatorCalls, before.evaluatorCalls); assert.equal(after.mails.length, before.mails.length);
const result = { schema: 'hps-classroom-mac-board/1', at: new Date().toISOString(), source_sha: session.source_sha, shell: session.shell, agent_sdk: session.agent_sdk, selected: ['A1'], real_seat: 'A1', scripted_seats: ['A2', 'A3'],
  a1: { state: a1.state, coverage: a1.coverage, objects: objects.length }, untouched: items.filter((i) => i.seat_id !== 'A1').map((i) => [i.seat_id, i.state]), upload_commands: after.upload_commands, evaluation_inputs: after.evaluation_inputs, evaluator_calls: after.evaluatorCalls, mails: after.mails.length, ui: { impact, state: await page.locator('#ops-pick-state').innerText(), observed: await page.locator('#ops-pick-observed').innerText(), items: await page.locator('#ops-pick-items').innerText() } };
writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
console.log(`PASS — selected collection of the real seat through the Chalk UI → ${path.join(out, 'result.json')}`);
if (process.env.HPS_BOARD_HEADLESS === '1') await browser.close(); else { console.log('The board window stays open. Control-C closes it.'); await new Promise(() => {}); }
