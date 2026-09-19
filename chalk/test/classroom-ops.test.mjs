// Chalk surface for remote classroom operations (#751): forwarding only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { localOps } from '../../worker/test/harness/classroom-ops.mjs';
const f = await localOps(); const { default: chalk } = await import('../src/index.ts'); const savedFetch = globalThis.fetch; const calls = [];
const env = { ...f.env, HPS_SERVICE_ORIGIN: 'https://service.test' };
globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return f.app.fetch(new Request(url, init), f.env, { waitUntil() {} }); };
async function request(path, method = 'GET', body, token = f.teacherToken) { const r = await chalk.fetch(new Request('https://chalk.test' + path, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json', 'cf-access-authenticated-user-email': 'forged@example.test' }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} }); const raw = await r.text(); let json; try { json = JSON.parse(raw); } catch {} return { status: r.status, raw, json, headers: r.headers }; }
try {
  const html = readFileSync(new URL('../src/ui/manage.html', import.meta.url), 'utf8'), script = html.match(/<script>([\s\S]*?)<\/script>/)[1]; new Script(script);
  assert.ok(!/localStorage|sessionStorage|\.innerHTML\s*=|insertAdjacentHTML|document\.cookie/.test(script), 'ticket and token stay in page memory and are rendered as text');
  for (const label of ['준비 확인', '확인 불가', '발급은 연결 완료가 아닙니다', '개별 PC 초기화를 권하지 않습니다', '만료로 단정하지 말고']) assert.ok(html.includes(label), label);
  // Red is reserved for a confirmed block; silence and staleness render with the neutral class.
  assert.match(script, /s\.attention==='blocked'\?'blocked'/); assert.ok(!/no_signal[^\]]*blocked/.test(script));
  const seats = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }];
  await f.freeze();
  const put = await request(f.base, 'PUT', { expected_roster_revision: 0, seats, flags: { ops_observe: true }, lesson: f.lesson }); assert.equal(put.status, 201, put.raw);
  const status = await request(f.base + '/status'); assert.equal(status.status, 200); assert.equal(status.headers.get('cache-control'), 'no-store'); assert.equal(status.json.seats.length, 2);
  const pairing = await request(f.base + '/pairings', 'POST', { seat_id: 'A1', roster_revision: 1 }); assert.equal(pairing.status, 201);
  for (const { init } of calls) { assert.equal(init.headers.get('cf-access-authenticated-user-email'), null); assert.match(init.headers.get('x-hps-forwarded-by'), /^chalk\//); }
  assert.equal((await request(f.base + '/status', 'GET', undefined, await f.teacher('plain', null))).status, 403);
  assert.equal((await request(f.base + '/status', 'GET', undefined, null)).status, 401);
  // Student devices talk to the Service directly. Chalk is never a path for the operations credential or a ticket.
  const before = calls.length;
  assert.equal((await request('/v1/classroom/ops/connect', 'POST', { ticket: pairing.json.ticket, ...f.instance() }, null)).status, 404);
  assert.equal((await request('/v1/classroom/ops/sync', 'POST', {}, 'hpsops1.x.y')).status, 404);
  assert.equal((await request(f.base + '/shell', 'POST', { cmd: 'id' })).status, 404);
  assert.equal(calls.length, before, 'nothing outside the shared allowlist reaches the Service');
  console.log('PASS classroom ops surface: page contract, run/status/pairing forwarding, header stripping, capability refusal, app routes and unknown actions not forwarded');
} finally { globalThis.fetch = savedFetch; f.close(); }
