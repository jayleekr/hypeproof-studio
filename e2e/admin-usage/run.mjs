// Real operator HTML and Service routing, synthetic stored rows, no production.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { localUsageObservation } from '../../worker/test/harness/usage-observation.mjs';

const local = await localUsageObservation();
const requests = [];
let oldService = false;
const server = createServer(async (req, res) => {
  try {
    requests.push(req.method);
    let response = await local.fetch(new Request('http://local' + req.url, { headers: req.headers }));
    if (oldService && req.url.includes('/usage') && response.ok) {
      const body = await response.json(); delete body.observation; response = Response.json(body);
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500).end('synthetic test failure'); }
});
let browser;
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 },
    extraHTTPHeaders: { authorization: local.auth } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  const button = page.locator(`button[data-act="load-usage"][data-cohort="${local.cohort}"]`);
  await button.locator('..').locator('summary').click();
  await button.click();
  const panel = page.locator('#usage-' + local.cohort);
  await panel.getByText('원가 미확인', { exact: false }).waitFor();
  assert.match(await panel.innerText(), /캐시 쓰기 54/);
  assert.match(await panel.innerText(), /오류 중 토큰이 기록된 요청 1개/);
  assert.equal(await panel.locator('tbody tr').count(), 4);
  assert.equal(await panel.locator('img').count(), 0);
  assert.equal(await page.evaluate(() => window.usageInjected), undefined);
  const out = process.env.HPS_USAGE_EVIDENCE_DIR || 'test-results/admin-usage';
  mkdirSync(out, { recursive: true });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await panel.screenshot({ path: out + '/usage-' + width + '.png' });
  }
  const table = panel.getByRole('region', { name: '최근 사용 기록 표' });
  await page.setViewportSize({ width: 390, height: 900 });
  await table.focus(); assert(await table.evaluate(el => document.activeElement === el));
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('.usage-scroll').scrollLeft > 0);
  await panel.screenshot({ path: out + '/usage-390-scrolled.png' });
  local.state.failReads = true; await button.click();
  await panel.getByText('사용 기록을 확인할 수 없습니다.', { exact: false }).waitFor();
  assert.equal(await panel.locator('table').count(), 0, 'stale successful report clears on failure');
  assert(await button.isEnabled());
  await panel.screenshot({ path: out + '/usage-unavailable.png' });
  local.state.failReads = false; oldService = true; await button.click();
  await panel.getByText('사용 기록을 확인할 수 없습니다.', { exact: false }).waitFor();
  assert.equal(await panel.locator('table').count(), 0, 'old response cannot imply confirmed coverage');
  oldService = false;
  local.db.prepare('DELETE FROM usage_log WHERE cohort_id=?').run(local.cohort);
  await button.click(); await panel.getByText('조회된 기록이 없습니다.', { exact: false }).waitFor();
  assert.match(await panel.innerText(), /실제 사용량이 0이라는 뜻은 아닙니다/);
  await panel.screenshot({ path: out + '/usage-empty.png' });
  assert.deepEqual(errors, []);
  assert(requests.every(method => method === 'GET'), 'operator observation issues no writes');
  console.log('PASS operator browser: cache write/failed spend/unknown, 390/1280px, keyboard table region, escaped stored text, empty/error/old Service, no mutations');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve)); local.close();
}
