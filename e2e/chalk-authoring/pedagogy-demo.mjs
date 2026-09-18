// 교육 원칙 관문 시연 — 실제 저작 화면에서 **세 겹이 각각 어디서 막는지** 찍는다 (#1116).
//
// 같은 수업 하나가 세 단계로 나온다. 화면이 세 번 다르게 반응하고, 그 차이가 시연의 전부다.
//
//   ① 화면 선검사   목표가 비어 서버에 가지도 않는다            → 기존 클라이언트 검사
//   ② 관문(422)     목표는 있고 선행 조건만 비어 확정이 막힌다   → 이번에 추가한 검사
//   ③ 확정 성공     선행 조건까지 채우면 통과한다               → 남은 경고는 함께 보인다
//
// **①과 ②는 다른 층에서 막힌 것이다.** 둘 다 "막혔다"로 보이면 시연이 부정확해진다 —
// 화면 문구가 실제로 다르고(전자는 한국어 안내, 후자는 `HTTP 422:` 로 시작), 스크린샷
// 파일명도 층으로 나눠 둔다. 위클리에서 "두 겹이 다 잡았고 첫 겹은 기존 검증기"라고
// 말할 근거가 이 세 장이다.
//
// ─── 격리 ────────────────────────────────────────────────────────────────────
// Chalk Worker 를 **이 프로세스 안에서** 부팅해 ephemeral 127.0.0.1 포트 뒤에 두고,
// Service 는 메모리 SQLite 하네스다. origin 이 실행 중에 `server.address().port` 로
// 계산되므로 **환경변수로 운영을 가리킬 수 없다.** wrangler 를 쓰지 않고 네트워크로
// 나가지 않는다. 격리가 설정이 아니라 구조다.
//
//   npm --prefix e2e run demo:pedagogy
//
// 운영 도메인을 부르는 다른 러너를 이 시연에 섞지 말 것 — 절차는
// docs/testing/pedagogy-gate-demo.md 에 있다.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { localAuthoring } from '../../worker/test/harness/dental-authoring.mjs';

const local = await localAuthoring({});
const { default: chalk } = await import('../../chalk/src/index.ts');
const { TEST_SECRET } = await import('../../worker/test/harness/index.mjs');
const env = { HPS_SIGNING_SECRET: TEST_SECRET, ENVIRONMENT: 'dev', HPS_SERVICE_ORIGIN: local.origin };
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) =>
  String(url).startsWith(local.origin) ? local.fetcher(url, options) : realFetch(url, options);

const OUT = process.env.HPS_PEDAGOGY_DEMO_OUT || 'test-results/pedagogy-gate';
const WIDTHS = [390, 1280];
const fixtureDir = new URL('../../worker/test/fixtures/lesson-pedagogy/', import.meta.url);

/** 데모 픽스처를 저작 화면이 받는 형식으로 감싼다.
 *  화면의 import 는 `hps-authoring-batch/1` 만 읽는다. 제품이 데모 봉투를 알 필요는
 *  없으므로 **러너가 자기 입력을 만든다** — 픽스처도 제품 코드도 건드리지 않는다. */
function batchFile(name, tag) {
  const fx = JSON.parse(readFileSync(new URL(name, fixtureDir), 'utf8'));
  // 세 겹이 같은 수업의 세 단계라 픽스처의 course_id 가 겹친다(해소본은 차단본과 같은
  // 강의여야 한다 — 그것을 테스트가 고정한다). 저작 API 는 같은 id 재생성을 409 로
  // 막으므로 — 기존 강의를 보호하는 정상 동작이다 — **러너가 층 꼬리표를 붙여** 세 번을
  // 각각 다른 강의로 만든다. `demo-` 접두사는 앞에 그대로 남는다.
  const courses = fx.courses.map(c => ({ ...c, course_id: `${c.course_id}-${tag}` }));
  const path = join(tmpdir(), `hps-demo-${fx.id}-${tag}-${process.pid}.json`);
  writeFileSync(path, JSON.stringify({ schema: 'hps-authoring-batch/1', courses }));
  return { path, fx, courseIds: courses.map(c => c.course_id) };
}

let browser, server;
const captured = [];
try {
  server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const r = await chalk.fetch(
        new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, body: body.length ? body : undefined }),
        env, {});
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch { res.writeHead(500); res.end('test server failure'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;

  browser = await chromium.launch(process.env.HPS_BROWSER_CHANNEL ? { channel: process.env.HPS_BROWSER_CHANNEL } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  page.on('dialog', d => d.accept());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  mkdirSync(OUT, { recursive: true });

  const statusText = () => page.locator('#status').innerText();
  const shoot = async (layer) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${layer}: ${width}px 에서 가로 넘침`);
      await page.screenshot({ path: `${OUT}/${layer}-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 900 });
  };

  /** 픽스처를 올려 초안을 저장한 상태까지 만든다. 확정은 호출부가 누른다. */
  async function loadDraft(name, tag) {
    const { path, fx, courseIds } = batchFile(name, tag);
    await page.goto(origin + '/authoring');
    await page.locator('details').evaluateAll(es => es.forEach(e => (e.open = true)));
    await page.locator('#token').fill(local.token);
    await page.locator('#cohort').fill(local.cohort);
    await page.locator('#profile').fill(local.profileId);
    await page.locator('#import').setInputFiles(path);
    await page.locator('#status').filter({ hasText: '강의를 선택한 뒤' }).waitFor();
    await page.locator('#courses').selectOption('0');
    await page.locator('#save').click();
    try {
      await page.locator('#status').filter({ hasText: '저장했습니다' }).waitFor({ timeout: 15000 });
    } catch (e) {
      throw new Error(`${name}: 초안 저장 실패 — 화면 문구 "${await statusText()}" · save disabled=${await page.locator('#save').isDisabled()} · course="${await page.locator('#course').inputValue()}"`);
    }
    assert.ok(courseIds.every(id => id.startsWith('demo-')), '데모 표시가 course_id 앞에 남아야 한다');
    return fx;
  }

  // ── ① 화면 선검사 — 서버에 가지도 않는다 ──────────────────────────────────
  {
    const fx = await loadDraft('dental-field-cuesheet.demo.json', 'l1');
    assert.equal(fx.expect.shape_error, true, '원문 충실본이어야 한다');
    const before = local.calls.length;
    await page.locator('#freeze').click();
    const text = await statusText();
    assert.match(text, /목표를 작성하고 초안을 저장해주세요/, `①: ${text}`);
    assert.doesNotMatch(text, /HTTP/, '①은 HTTP 응답이 아니다 — 화면에서 끝난다');
    const versionCalls = local.calls.slice(before).filter(c => /\/versions\//.test(c.path));
    assert.equal(versionCalls.length, 0, '①에서는 확정 요청이 서버로 나가지 않아야 한다');
    captured.push({ layer: '1-client-precheck', where: '저작 화면 (서버 요청 없음)', text });
    await shoot('layer1-client-precheck');
  }

  // ── ② 관문 — 선행 조건만 비어 422 로 막힌다 ───────────────────────────────
  {
    const fx = await loadDraft('dental-field-cuesheet-gate.demo.json', 'l2');
    assert.equal(fx.expect.shape_error, false, '②는 형태 검증을 통과해야 한다');
    assert.equal(fx.expect.blocked, true);
    await page.locator('#version').fill('m2026.09.18-1');
    const before = local.calls.length;
    await page.locator('#freeze').click();
    await page.locator('#status').filter({ hasText: 'HTTP 422' }).waitFor();
    const text = await statusText();
    assert.match(text, /^HTTP 422: /, `②: ${text}`);
    assert.ok(local.calls.slice(before).some(c => /\/versions\//.test(c.path) && c.method === 'PUT'),
      '②에서는 확정 요청이 실제로 서버까지 갔어야 한다');
    assert.notEqual(captured[0].text, text, '①과 ②는 화면 문구가 달라야 한다 — 다른 층에서 막혔다');
    captured.push({ layer: '2-pedagogy-gate-422', where: 'Service 관문 (HTTP 422)', text });
    await shoot('layer2-pedagogy-gate-422');
  }

  // ── ③ 해소 — 선행 조건까지 채우면 확정된다 ────────────────────────────────
  {
    const fx = await loadDraft('dental-field-cuesheet-resolved.demo.json', 'l3');
    assert.equal(fx.expect.blocked, false);
    await page.locator('#version').fill('m2026.09.18-2');
    await page.locator('#freeze').click();
    await page.locator('#status').filter({ hasText: '불변 버전을 저장' }).waitFor();
    const text = await statusText();
    const completion = await page.locator('#completion').innerText();
    assert.match(completion, /강의가 확정되었습니다/, `③: ${completion}`);
    captured.push({ layer: '3-frozen', where: '저작 화면 (확정 성공)', text: completion });
    await shoot('layer3-frozen');

    // ── ④ 남은 경고 — 통과했어도 무엇이 비었는지 보인다 ─────────────────────
    const dump = await page.locator('#version-view').innerText();
    const served = JSON.parse(dump);
    assert.ok(Array.isArray(served.pedagogy), '확정 응답에 판정 목록이 실려 있어야 한다');
    assert.equal(served.pedagogy.filter(f => f.severity === 'fail').length, 0);
    const warns = served.pedagogy.filter(f => f.severity === 'warn' && !f.skipped);
    assert.ok(warns.length, '해소본에도 증거물 경고가 남는다 — 원문이 지목하지 않은 산출물을 지어내지 않았다');
    captured.push({
      layer: '4-remaining-warnings',
      where: '확정 응답의 pedagogy (화면에는 raw JSON)',
      text: `warn ${warns.length}건 · ${[...new Set(warns.map(w => w.check))].join(', ')}`,
    });
    // ③ 과 같은 화면이라 전체 스크린샷은 구분이 안 된다. 판정이 실린 영역만 따로 찍어
    // 네 겹이 각각 다른 그림이 되게 한다.
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('#version-view').scrollIntoViewIfNeeded();
      await page.locator('#version-view').screenshot({ path: `${OUT}/layer4-remaining-warnings-${width}.png` });
    }
    await page.setViewportSize({ width: 390, height: 900 });
  }

  assert.deepEqual(errors, [], '페이지 스크립트 오류: ' + errors.join(' | '));

  const summary = {
    schema: 'hps-pedagogy-demo-run/1',
    notice: '데모용 복제 자료에 대한 실행 기록이다. 운영 데이터도 실적도 아니다.',
    isolation: 'chalk Worker in-process + 메모리 SQLite. 운영 도메인 요청 없음.',
    screenshots: OUT,
    layers: captured,
  };
  writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
  console.log('\n=== 관문 시연: 네 겹 ===');
  for (const c of captured) console.log(`[${c.layer}] ${c.where}\n    화면 문구: ${c.text}`);
  console.log(`\n스크린샷 ${readdirSync(OUT).filter(f => f.endsWith('.png')).length}장 · ${OUT}`);
  console.log('데모용 복제 자료다. 운영 기록도 실적도 아니다.');
} finally {
  await browser?.close();
  server?.close();
  local.close();
  globalThis.fetch = realFetch;
}
