// #1036 — 저작 화면이 저장할 때 **자기가 모르는 단계 키를 버리지 않는다**.
//
// 단위 시험으로는 안 잡히는 결함이다. 화면이 단계를 다시 만드는 시점과 저장 요청을 만드는
// 시점 사이에서 일어나므로, **실제 브라우저 → Chalk → Service → SQLite** 를 지나야 보인다.
// 그래서 저장된 행을 직접 읽어 판정한다.
//
// 두 경계를 나눠 확인한다 — 같은 "모르는 키"라도 갈 수 있는 데까지가 다르다:
//
//   help          스키마가 허용하는 선택 키. **저장소까지** 살아남아야 한다
//   임의의 키     스키마 화이트리스트 밖(worker/src/lib/session-design.ts:112).
//                 화면은 보존하지만 **Service 가 거부한다**. 화면까지만 확인하고
//                 거부되는 것도 함께 고정한다 — 그 경계가 바뀌면 여기서 드러난다
//
// 격리: Chalk 를 프로세스 안에서 부팅해 ephemeral 127.0.0.1 포트 뒤에 두고 Service 는
// 메모리 SQLite 하네스다. origin 이 실행 중에 계산되므로 환경변수로 운영을 가리킬 수 없다.
//
//   npm --prefix e2e run test:chalk-step-keys
//
// ⚠️ **PR CI 는 이 러너를 부르지 않는다**(브라우저 잡이 없다). 저작 화면을 바꾸면 사람이
// 직접 돌려야 한다 — 이 결함이 처음 새어 나간 경로가 정확히 그것이었다.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
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

const COURSE = 'ch1-preserve-' + process.pid;
const HELP = { default: 'hint', allowed: ['hint', 'independent'] };
const base = (steps) => ({
  schema: 'hps-session-design/1', title: '단계 키 보존 검사', audience: '합성 강사',
  duration_minutes: 60, objective: '모르는 칸이 저장에서 사라지지 않는지 본다',
  prerequisites: '없음', starter: '합성 자료', steps,
});
const batch = (courseId, steps) => {
  const path = join(tmpdir(), `hps-${courseId}.json`);
  writeFileSync(path, JSON.stringify({ schema: 'hps-authoring-batch/1', courses: [{ course_id: courseId, content: base(steps) }] }));
  return path;
};

/** 저장소에 실제로 들어간 것. 화면이 뭐라 하든 여기가 사실이다. */
const stored = () => JSON.parse(local.db.prepare(
  'SELECT content_json FROM authoring_drafts WHERE course_id=?').get(COURSE).content_json);
const stepById = (c, id) => c.steps.find(s => s.id === id);

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };

let browser, server;
try {
  server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const r = await chalk.fetch(new Request('http://localhost' + req.url,
      { method: req.method, headers: req.headers, body: body.length ? body : undefined }), env, {});
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;

  browser = await chromium.launch(process.env.HPS_BROWSER_CHANNEL ? { channel: process.env.HPS_BROWSER_CHANNEL } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('dialog', d => d.accept());
  const errors = []; page.on('pageerror', e => errors.push(e.message));

  const connect = async () => {
    await page.goto(origin + '/authoring');
    await page.locator('details').evaluateAll(es => es.forEach(e => (e.open = true)));
    await page.locator('#token').fill(local.token);
    await page.locator('#cohort').fill(local.cohort);
    await page.locator('#profile').fill(local.profileId);
  };
  const save = async () => {
    await page.locator('#save').click();
    await page.locator('#status').filter({ hasText: '저장했습니다' }).waitFor();
  };
  const steps = () => page.locator('.step');
  const field = (i, name) => steps().nth(i).locator(`[data-field="${name}"]`);

  // ── 1. import 가 모르는 칸을 들고 들어온다 ─────────────────────────────────
  await connect();
  await page.locator('#import').setInputFiles(batch(COURSE, [
    { id: 'keep', title: '도움 있는 단계', instructions: '실습', hint: '', acceptance: '확인', help: HELP },
    { id: 'plain', title: '평범한 단계', instructions: '실습', hint: '', acceptance: '확인' },
  ]));
  await page.locator('#status').filter({ hasText: '강의를 선택한 뒤' }).waitFor();
  await page.locator('#courses').selectOption('0');
  await page.locator('#assistant_name').fill('제작 파트너');
  await save();

  await check('import 한 도움 방식이 저장소까지 간다', () => {
    const c = stored();
    assert.deepEqual(stepById(c, 'keep').help, HELP);
    assert.equal(stepById(c, 'plain').help, undefined, '없던 단계에 생기지 않는다');
    assert.equal(c.assistant?.display_name, '제작 파트너', '대조: AI 이름은 여전히 보존된다');
  });

  await check('도움 방식이 있는 단계에만 읽기 전용 표시가 붙는다', async () => {
    await assert.doesNotReject(steps().nth(0).locator('.step-note')
      .filter({ hasText: '도움 방식 설정 있음' }).waitFor({ timeout: 5000 }));
    assert.equal(await steps().nth(1).locator('.step-note').count(), 0);
  });

  // ── 2. 제목만 고쳐 저장 — 이 결함의 원래 재현 경로 ────────────────────────
  await check('제목만 고쳐 저장해도 도움 방식이 남는다', async () => {
    await field(0, 'title').fill('제목만 바꿈');
    await save();
    const c = stored();
    assert.equal(stepById(c, 'keep').title, '제목만 바꿈');
    assert.deepEqual(stepById(c, 'keep').help, HELP, '이것이 #1036 의 결함이었다');
  });

  // ── 3. 순서 변경 — 원본이 다른 단계로 옮겨붙지 않는다 ─────────────────────
  await check('순서를 바꿔도 도움 방식이 자기 단계를 따라간다', async () => {
    await steps().nth(0).getByRole('button', { name: '아래로' }).click();
    await save();
    const c = stored();
    assert.deepEqual(c.steps.map(s => s.id), ['plain', 'keep'], '순서가 실제로 바뀌었다');
    assert.deepEqual(stepById(c, 'keep').help, HELP);
    assert.equal(stepById(c, 'plain').help, undefined, '다른 단계로 옮겨붙지 않는다');
  });

  // ── 4. 새 단계는 아무 키도 물려받지 않는다 ────────────────────────────────
  await check('새로 추가한 단계는 모르는 칸을 물려받지 않는다', async () => {
    await page.locator('#add').click();
    const last = steps().nth(2);
    await last.locator('[data-field="title"]').fill('새 단계');
    await last.locator('[data-field="instructions"]').fill('실습');
    await last.locator('[data-field="acceptance"]').fill('확인');
    await save();
    const c = stored();
    assert.equal(c.steps.length, 3);
    assert.deepEqual(Object.keys(c.steps[2]).sort(), ['acceptance', 'hint', 'id', 'instructions', 'title']);
  });

  // ── 5. 단계를 지우면 그 키도 사라진다 ─────────────────────────────────────
  await check('단계를 지우면 그 단계의 도움 방식도 사라진다', async () => {
    const keepIndex = (await steps().count()) - 2;
    await steps().nth(keepIndex).getByRole('button', { name: '삭제' }).click();
    await save();
    const c = stored();
    assert.equal(stepById(c, 'keep'), undefined, '단계가 사라졌다');
    assert.ok(c.steps.every(s => s.help === undefined), '남은 어느 단계에도 옮겨가지 않았다');
    assert.equal(c.assistant?.display_name, '제작 파트너', '대조: AI 이름은 끝까지 보존된다');
  });

  // ── 6. 스키마 화이트리스트 밖의 키 — 화면은 보존하고 Service 가 막는다 ────
  // 지금 허용되는 단계 키는 id·title·instructions·hint·acceptance·help 뿐이다
  // (worker/src/lib/session-design.ts:112). 화면이 보존하는 것과 서버가 받아 주는 것은
  // 다른 문제이며, 새 칸을 넓힐 때 **화면은 이미 준비돼 있고 스키마만 열면 된다**는 것이
  // 이 검사의 뜻이다.
  const UNKNOWN = 'ch1-unknown-' + process.pid;
  await check('화면은 임의의 미지 키를 보존한다 (content() 수준)', async () => {
    await connect();
    await page.locator('#import').setInputFiles(batch(UNKNOWN, [
      { id: 'odd', title: '미지 키 단계', instructions: '실습', hint: '', acceptance: '확인', x_note: '화면이 모르는 칸' },
    ]));
    await page.locator('#status').filter({ hasText: '강의를 선택한 뒤' }).waitFor();
    await page.locator('#courses').selectOption('0');
    await field(0, 'title').fill('제목만 바꿈');
    const built = await page.evaluate(() => content());
    assert.equal(built.steps[0].x_note, '화면이 모르는 칸', '화면이 버리지 않는다');
    assert.equal(built.steps[0].title, '제목만 바꿈');
  });

  await check('Service 는 화이트리스트 밖 단계 키를 거부한다 (경계 고정)', async () => {
    await page.locator('#save').click();
    await page.locator('#status').filter({ hasText: 'invalid step fields' }).waitFor();
    const row = local.db.prepare('SELECT count(*) n FROM authoring_drafts WHERE course_id=?').get(UNKNOWN);
    assert.equal(Number(row.n), 0, '거부된 저장은 행을 남기지 않는다');
  });

  assert.deepEqual(errors, [], '페이지 스크립트 오류: ' + errors.join(' | '));
  console.log(`\nstep-key-preservation: ${passed} checks passed — 브라우저 → Chalk → Service → SQLite.`);
} finally {
  await browser?.close();
  server?.close();
  local.close();
  globalThis.fetch = realFetch;
}
