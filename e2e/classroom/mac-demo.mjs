// Remote classroom operations (#751) — a Mac session a PERSON can sit in front of, from the prepared dev host.
//
//   node e2e/classroom/mac-devhost.mjs prepare                                        # once per source change (copy + current build + SDK JS)
//   node --experimental-strip-types --experimental-sqlite e2e/classroom/mac-demo.mjs  # this file; stays up until Control-C
//
// It starts a local Service (real router + SQLite, synthetic class of six seats), the real Chalk board on
// http://127.0.0.1:18762/manage, a guide page on /demo, and opens the prepared Studio COPY as seat A1.
// Real: the Studio shell copy, the extension, the Agent SDK + native binary, the ops sync loop, the SessionSpool on disk,
//       the snapshot upload, Chalk. Synthetic: accounts, lesson, MODEL answers, report evaluator, mail transport;
//       A2 (error) and A3 (connected) are scripted signals, A4–A6 never connect.
// The app runs WITHOUT the e2e gate so that the spool is the real one, and with its own HOME so that nothing is written
// into the user's Studio data (…/Library/Application Support/HypeProof-Studio). /Applications is never touched.
// mac-gui.mjs is the machine-checked run of the same path; this file proves nothing by itself — write down what you did.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { localOps } from '../../worker/test/harness/classroom-ops.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), serviceRepo = repo, home = path.resolve(process.env.HPS_DEVHOST_DIR || path.join(repo, 'e2e/test-results/classroom-devhost'));
const servicePort = Number(process.env.HPS_DEMO_SERVICE_PORT || 18761), boardPort = Number(process.env.HPS_DEMO_BOARD_PORT || 18762), prefix = 'demo-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex'), json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const manifest = json(path.join(home, 'manifest.json')), copy = path.join(home, 'HypeProof Studio (ops devhost).app'), ext = path.join(copy, 'Contents/Resources/app/extensions/hypeproof-chat');
assert.ok(!copy.startsWith('/Applications'), 'never the installed app');
for (const [f, h] of Object.entries(manifest.extension.bundles)) { assert.equal(sha(path.join(ext, f)), h, `${f} changed since prepare`); assert.equal(sha(path.join(repo, 'extensions/hypeproof-chat', f)), h, `${f}: the prepared copy is not the current build — prepare again`); }
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['diff', manifest.extension.source_sha, head, '--', 'extensions/hypeproof-chat/src', 'extensions/hypeproof-chat/webview-ui/src'], { cwd: repo, encoding: 'utf8' }), '', 'extension sources changed since prepare');
const sdk = manifest.agent_sdk?.vendored === true && manifest.agent_sdk.binary && process.env.HPS_GUI_NO_SDK !== '1';

// ── Service: real router + SQLite, synthetic class run ──
const local = await localOps(), { setRoster } = await import(serviceRepo + '/worker/src/lib/kv.ts');
const seats = Array.from({length:6},(_,i)=>({seat_id:'A'+(i+1),student_id:prefix+(i+1)}));
await setRoster(local.env.HPS_KV, local.cohort, seats.map((s) => s.student_id)); await local.freeze();
assert.equal((await local.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect:true, ops_reports:true, ops_delivery:true } })).status, 201);
// The harness instructor token lives one hour; a participant token may not outlive its issuer, so this one is issued for longer.
const { issueIssuer } = await import(serviceRepo + '/worker/src/lib/tokens.ts'), { TEST_SECRET } = await import(serviceRepo + '/worker/test/harness/index.mjs'), { OPS_ALL } = await import(serviceRepo + '/worker/test/harness/classroom-ops.mjs');
const inviter = (await issueIssuer({ issuer: 'teacher-a', scopes: [{ cohort: local.cohort, profiles: [local.profile], ops: OPS_ALL }] }, 4, TEST_SECRET)).token;
const invite = await local.request(`/admin/cohorts/${local.cohort}/authoring/${local.lesson.course_id}/versions/${local.lesson.version}/participants`, 'POST', { user: seats[0].student_id, hours: 1 }, inviter);
assert.equal(invite.status, 200, invite.raw); const token = invite.json.token;
Object.assign(local.env, { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'synthetic-no-live-key', OPENAI_API_KEY: undefined, ANTHROPIC_PROXY_URL: undefined });

// ── provider: scripted, and the only thing that is. Nothing in this process may reach a real provider. ──
let provider = 'ok'; const providerCalls = [], realFetch = globalThis.fetch;
const sse = (model, text) => new Response([['message_start', { type: 'message_start', message: { id: 'synthetic-' + providerCalls.length, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }], ['message_stop', { type: 'message_stop' }]].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.origin === 'https://service.test') return local.app.fetch(new Request(input,init),local.env,{waitUntil(){}});
  assert.equal(url.origin, 'https://api.anthropic.com', 'unexpected outbound request from the Service: ' + url.origin);
  const body = JSON.parse(init.body), mode = provider; providerCalls.push({ mode, model: body.model, stream: body.stream === true, tools: (body.tools ?? []).length });
  if (mode === '500') return Response.json({ type: 'error', error: { type: 'api_error', message: 'synthetic provider failure' } }, { status: 500 });
  if (mode === '400') return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'synthetic provider refusal' } }, { status: 400 });
  if (mode === 'stall') return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  const text = '[로컬 시험 응답] 모바일 화면에서 예약 버튼이 보이고 눌리는지 먼저 확인해 보세요. 실제 AI 모델은 호출하지 않았습니다.';
  return body.stream ? sse(body.model, text) : Response.json({ id: 'synthetic', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 9 } });
};
const server = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts);
  const r = await local.app.fetch(new Request('https://service.test' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), local.env, { waitUntil() {}, passThroughOnException() {} });
  res.writeHead(r.status, Object.fromEntries(r.headers)); if (r.body) for await (const chunk of r.body) res.write(chunk); res.end(); } catch { if (!res.headersSent) res.writeHead(500); res.end(); } });
server.listen(servicePort, '127.0.0.1'); await once(server, 'listening'); const origin = 'http://127.0.0.1:' + server.address().port;

const userDir = realpathSync(mkdtempSync(path.join(tmpdir(),'hps-751-demo-'))), ws = path.join(userDir, 'ws'); mkdirSync(path.join(userDir, 'User'), { recursive: true }); mkdirSync(ws, { recursive:true });
writeFileSync(path.join(ws, 'index.html'), '<!doctype html><title>학생 작업</title><h1>SYNTHETIC LEARNER WORK</h1>\n'); writeFileSync(path.join(ws, 'notes.md'), '# 내 메모\n- 예약 버튼 위치 확인\n');
writeFileSync(path.join(userDir, 'User/settings.json'), JSON.stringify({ 'hypeproofChat.proxyUrl': origin + '/v1', 'window.dialogStyle': 'custom', 'workbench.startupEditor': 'none', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off' }));
const fakeHome=path.join(userDir,'home'); mkdirSync(fakeHome,{recursive:true});
const tokenPath=path.join(home,'synthetic-learner-token.txt'); writeFileSync(tokenPath,token,{mode:0o600});
const workHashes = () => Object.fromEntries(readdirSync(ws).filter((f) => statSync(path.join(ws, f)).isFile()).sort().map((f) => [f, sha(path.join(ws, f))]));


const {default:chalk}=await import('../../chalk/src/index.ts');
const {setEvaluatorTransport}=await import(serviceRepo+'/worker/src/routes/classroom-reports.ts');
const {setResendFetch}=await import(serviceRepo+'/worker/src/routes/classroom-delivery.ts');
local.env.HPS_CLASSROOM_EVALUATOR='service-anthropic';
let evaluatorCalls=0; const mails=[];
setEvaluatorTransport(async request=>{evaluatorCalls++;const own=JSON.parse(request.messages[0].content).evidence_catalog.find(q=>q.basis);return Response.json({content:[{type:'text',text:JSON.stringify({findings:own?[{capability:'FRAMING',status:'observed',claim:'확인할 조건을 말로 제시했습니다.',evidence:[{quote_id:own.quote_id}],assistance:'unknown'}]:[],next_experiment:'다음에는 확인 조건을 두 개 적고 결과를 비교해 보세요.'})}],usage:{input_tokens:10,output_tokens:5}});});
setResendFetch(async(_u,init)=>{mails.push(JSON.parse(init.body));return Response.json({id:'local-demo-mail-'+mails.length});});
Object.assign(local.env,{HPS_DELIVERY_PROVIDER:'resend',RESEND_API_KEY:'synthetic-not-a-key',HPS_DELIVERY_FROM:'Local demo <report@example.invalid>',HPS_PUBLIC_BASE_URL:'http://127.0.0.1:'+servicePort});
const recipient=await local.request('/admin/classroom/recipients','POST',{class_run_id:local.run,source_ref:'synthetic-local-demo',recipients:[{student_id:seats[0].student_id,recipient_ref:'local-demo-reader',channel:'email',address:'demo@example.invalid',viewer_check:{kind:'passphrase',value:'demo-only-4821'}}]},null,{authorization:'Basic '+Buffer.from('x:pw').toString('base64')});
assert.equal(recipient.status,201,recipient.raw);
const credentials=[];
for(let i=1;i<3;i++){const c=(await local.pair(seats[i].seat_id,1,i+1)).conn.json;credentials.push(c);}
let seq=0;
const tick=async()=>{seq++;for(let i=0;i<credentials.length;i++){const c=credentials[i];await local.sync(c.credential,[local.event(seq,'activation',{stage:'token_verified'}),...(i===0?[local.event(seq+1,'error',{class:'provider_5xx',code:'http_503',blocking:true})]:[])],i+2);}seq++;};
await tick();const timer=setInterval(()=>tick().catch(()=>{}),15000);
const pairing=(await local.request(local.base+'/pairings','POST',{seat_id:'A1',roster_revision:1})).json.ticket;
const server2=createServer(async(req,res)=>{try{
const u=new URL(req.url,'http://127.0.0.1:'+boardPort);const parts=[];for await(const b of req)parts.push(b);const body=Buffer.concat(parts);
if(u.pathname==='/demo/status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({provider,providerCalls,evaluatorCalls,mails,workspace_sha256:workHashes(),status:(await local.request(local.base+'/status')).json,jobs:local.db.prepare('SELECT student_id,state,reason FROM classroom_report_jobs').all(),objects:[...local.r2.keys()]}));return;}
if(u.pathname==='/demo/provider'&&req.method==='POST'){const mode=new URLSearchParams(body.toString()).get('mode');assert.ok(['ok','400','stall'].includes(mode));provider=mode;res.writeHead(303,{location:'/demo'});res.end();return;}
if(u.pathname==='/demo'){res.setHeader('Content-Type','text/html;charset=utf-8');res.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>HypeProof 로컬 실행 안내</title><style>body{font:18px system-ui;background:#151D19;color:#F2F4E8;max-width:880px;margin:40px auto;line-height:1.8}a{color:#D5F279}input,button{font:inherit;padding:12px}code{word-break:break-all}</style><h1>원격 수업 운영 · 이 맥에서 실행 중</h1><p>shell ${manifest.shell.version} 복사본 + 확장·Service 소스 ${head.slice(0,7)} + Agent SDK ${manifest.agent_sdk?.version ?? '없음'}. 로컬 Service와 실제 학생 앱 1대(A1), 모의 좌석 2대(A2·A3), 미연결 3석입니다.</p><p>합성 계정·AI 응답·평가·메일만 사용합니다. 실제 모델 호출·실제 발송·운영 변경은 없습니다.</p><p><a href="/manage">강사 관제 화면 열기</a></p><p>코호트: <code>${local.cohort}</code><br>학생 접두어: <code>${prefix}</code></p><details><summary>로컬 전용 강사 시험 토큰</summary><textarea rows="5" style="width:100%">${local.teacherToken}</textarea></details><p>학생 앱 연결 코드: <code>${pairing}</code> (발급 후 10분·1회용, 만료되면 관제 A1에서 새로 발급)</p><p>A1만 실제 앱입니다. A2는 오류 표시 예시, A3는 연결 표시 예시이며 복구 성공을 입증하지 않습니다.</p><p>시험 응답 상태: ${provider}</p><form action="/demo/provider" method="post"><button name="mode" value="ok">정상 응답</button> <button name="mode" value="400">다음 대화 오류 재현</button> <button name="mode" value="stall">다음 대화 대기 상태</button></form><p>보고서 열람 확인 값: <code>demo-only-4821</code></p><p>서버 종료 후 합성 수업은 사라집니다. 다시 시작하면 새 수업으로 생성됩니다.</p></html>`);return;}
const rr=await chalk.fetch(new Request('http://localhost'+req.url,{method:req.method,headers:req.headers,...(body.length?{body}:{})}),{...local.env,HPS_SERVICE_ORIGIN:'https://service.test'},{});res.writeHead(rr.status,Object.fromEntries(rr.headers));res.end(Buffer.from(await rr.arrayBuffer()));
}catch(e){res.writeHead(500);res.end(String(e));}});
server2.listen(boardPort,'127.0.0.1');await once(server2,'listening');
writeFileSync(path.join(home,'session.json'),JSON.stringify({origin,board:'http://127.0.0.1:'+boardPort+'/manage',guide:'http://127.0.0.1:'+boardPort+'/demo',cohort:local.cohort,teacherToken:local.teacherToken,pairing,student:seats[0].student_id,user_data_dir:userDir,workspace:ws,spool_root:path.join(fakeHome,'Library/Application Support/HypeProof-Studio/logs/sessions'),source_sha:head,shell:manifest.shell.version,agent_sdk:manifest.agent_sdk?.version??null,real:['Studio shell copy','extension + webview','Agent SDK + native binary','ops sync + commands','SessionSpool on disk','snapshot upload','Chalk board'],synthetic:['accounts','lesson','model answers','report evaluator','mail transport','seats A2/A3 signals']},null,2),{mode:0o600});
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(API_KEY|AUTH_TOKEN|SIGNING_SECRET|ADMIN_PASSWORD|_SECRET$|HPS_TEST|ELECTRON_RUN_AS_NODE)/.test(k)));
const app=spawn(path.join(copy,'Contents/MacOS/HypeProof Studio'),['--user-data-dir='+userDir,'--extensions-dir='+path.join(userDir,'extensions'),'--use-inmemory-secretstorage','--disable-updates','--skip-welcome','--skip-release-notes','--new-window',ws],{env:{...env,HOME:fakeHome,HPS_DEV_TOKEN_FILE:tokenPath,HPS_TEST_COACH_NAME:'연습 코치',HPS_SDK_BINARY:manifest.agent_sdk.binary.path},stdio:['ignore','ignore','inherit']});
console.log(JSON.stringify({pid:process.pid,app_pid:app.pid,guide:'http://127.0.0.1:'+boardPort+'/demo',board:'http://127.0.0.1:'+boardPort+'/manage',pairing,workspace:ws,shell:manifest.shell.version,extension:head,sdk:manifest.agent_sdk.version}));
writeFileSync(path.join(home,'server.pid'),String(process.pid)); app.on('exit',(code,signal)=>console.log('APP_EXIT',code,signal));
const cleanup=()=>{clearInterval(timer);app.kill();server.close();server2.close();local.close();process.exit(0);}; process.on('SIGTERM',cleanup); process.on('SIGINT',cleanup);
