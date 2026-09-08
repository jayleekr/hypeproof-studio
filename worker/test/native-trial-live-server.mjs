// Real gateway + real upstream, synthetic in-memory KV/D1/Analytics bindings.
// Never deploys or reads/writes a production cohort. Not a D1 integration test.
import './harness/loader.mjs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AsyncLocalStorage} from 'node:async_hooks';
const effortRun=process.env.HPS_NATIVE_EFFORT==='1';
const requestContext=new AsyncLocalStorage();
import { bootApp, createMockEnv, makeCtx } from './harness/index.mjs';
const { issue, issueIssuer } = await import('../src/lib/tokens.ts');

const port = Number(process.env.HPS_NATIVE_PORT || 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('invalid isolated gateway port');
const codexMode = process.env.HPS_CODEX_REHEARSAL === '1';
if (codexMode && effortRun) throw Error('effort and GPT rehearsal fixtures cannot be combined');
if (!codexMode && !process.env.ANTHROPIC_API_KEY) throw new Error('BLOCKED: ANTHROPIC_API_KEY is not configured in this test runner');
const output = resolve(process.env.HPS_NATIVE_EVIDENCE_DIR || '../e2e/test-results/native-trial');
mkdirSync(output, { recursive: true });
const signing = randomBytes(32).toString('hex');
let codex;
if (codexMode) {
 const { CodexLocalClient } = await import('../../scripts/lib/codex-local-client.mjs');
 codex = new CodexLocalClient();
 try { const info=await codex.connect(); writeFileSync(resolve(output,'connection.json'),JSON.stringify({...info,scope:'local rehearsal only; subscription limits apply',request_limit:24,concurrency:1,timeout_ms:60000},null,2)); }
 catch(error) {codex.close();throw error;}
}
const { codexRehearsalResponse } = await import('./harness/codex-rehearsal.mjs');
const env = createMockEnv({ withSession: false, withRoster: false, secret: signing, env: {
  LLM_PROVIDER: codexMode ? 'openai' : 'anthropic', ANTHROPIC_API_KEY: codexMode ? undefined : process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: codexMode ? 'local-adapter-only' : undefined, ANTHROPIC_PROXY_URL: undefined,
  GALLERY_LOGS_BASE: undefined, HPS_ADMIN_PASSWORD: undefined,
} });
const now = Date.now(), id = codexMode ? 'studio-gpt-practice' : 'studio-native-trial';
await env.HPS_KV.put(`cohort:${id}:active_session`, JSON.stringify({ session_id: 'native-ci', profile_id: id,
  starts_at: new Date(now - 60000).toISOString(), ends_at: new Date(now + 3600000).toISOString() }));
await env.HPS_KV.put(`cohort:${id}:roster`, JSON.stringify({ users: ['synthetic-adult',...(process.env.HPS_NATIVE_IDENTITY==='1'?['synthetic-other']:[])], updated_at: new Date(now).toISOString() }));
const app = await bootApp();
let token;
let grantDb;
let effortDb;
if(effortRun){
 if(process.env.HPS_NATIVE_MANAGED==='1')throw Error('effort fixture uses frozen lessons, not native grants');
 effortDb=new DatabaseSync(':memory:');
 effortDb.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 effortDb.exec(readFileSync(new URL('../migrations/0002-chalk-authoring.sql',import.meta.url),'utf8'));
 effortDb.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(id,'Synthetic effort');
 effortDb.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)').run('native-ci',id,id,new Date(now-60000).toISOString(),new Date(now+3600000).toISOString());
 env.HPS_DB={prepare(sql){let args=[];return {bind(...v){args=v;return this;},async first(){return effortDb.prepare(sql).get(...args)??null;},async run(){const r=effortDb.prepare(sql).run(...args);return {success:true,meta:{changes:Number(r.changes)}};},async all(){return {success:true,results:effortDb.prepare(sql).all(...args)};}};}};
 const {getProfile}=await import('../src/profiles/index.ts');
 const profile=getProfile(id);
 if(process.env.HPS_EFFORT_RUNTIME==='proxy')profile.coach_runtime='proxy';
 const issuer=(await issueIssuer({issuer:'synthetic-instructor',scopes:[{cohort:id,profiles:[id]}]},4,signing)).token;
 const call=async(path,method,body)=>{
  const ctx=makeCtx();const r=await app.fetch(new Request('http://local'+path,{method,headers:{authorization:'Bearer '+issuer,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env,ctx);
  const j=await r.json();await ctx.settle();if(r.status!==200)throw Error('effort fixture: '+path+' '+r.status);return j;
 };
 const catalogue=await call('/admin/cohorts/'+id+'/authoring/catalog/models/'+id,'GET');
 for(const mode of ['choice','fixed']){
  const base='/admin/cohorts/'+id+'/authoring/effort-'+mode;
  const content={schema:'hps-session-design/1',title:'처리 수준 연습 '+mode,audience:'합성 성인',duration_minutes:60,objective:'요청 설정을 확인한다',prerequisites:'',starter:'빈 폴더',steps:[{id:'one',title:'확인',instructions:'가상 꽃집을 소개하세요.',hint:'',acceptance:'설정 비교'}],assistant:{display_name:'제작 파트너'},model:{default:'hypeproof-default',allowed:mode==='fixed'?['hypeproof-default']:catalogue.choices.map(c=>c.alias),effort:mode==='fixed'?{default:'low',allowed:['low']}:{default:'medium',allowed:['low','medium','high']}}};
  await call(base,'PUT',{profile_id:id,expected_revision:0,request_id:'create-'+mode,content});
  await call(base+'/versions/m2026.09.08-1','PUT',{expected_revision:1});
  const delivered=await call(base+'/versions/m2026.09.08-1/participants','POST',{user:'synthetic-adult',hours:1});
  if(mode==='choice')token=delivered.token;
  else writeFileSync(process.env.HPS_E2E_TOKEN_FILE+'.fixed',delivered.token,{mode:0o600});
 }
}
if(codexMode && process.env.HPS_NATIVE_MANAGED==='1') throw Error('GPT practice uses its normal separate cohort, not a native trial grant');
if(process.env.HPS_NATIVE_MANAGED==='1') {
 grantDb=new DatabaseSync(':memory:');grantDb.exec(readFileSync(new URL('../migrations/0004-native-trials.sql',import.meta.url),'utf8'));
 const original=env.HPS_DB;
 env.HPS_DB={prepare(sql){if(!/native_trials|native_trial_requests/.test(sql))return original.prepare(sql);let args=[];return {bind(...v){args=v;return this;},async first(){return grantDb.prepare(sql).get(...args)??null;},async run(){const r=grantDb.prepare(sql).run(...args);return {success:true,meta:{changes:Number(r.changes)}};},async all(){return {success:true,results:grantDb.prepare(sql).all(...args)};}};}};
 const issuer=(await issueIssuer({issuer:'synthetic-instructor',scopes:[{cohort:id,profiles:[id],max_hours:2,can_start_session:true,max_session_hours:1}]},4,signing)).token;
 const response=await app.fetch(new Request('http://local/admin/tokens/issue',{method:'POST',headers:{authorization:'Bearer '+issuer,'content-type':'application/json'},body:JSON.stringify({u:'synthetic-adult',c:id,p:id,hours:1,native_trial:true})}),env,makeCtx());
 if(response.status!==200)throw Error('synthetic issuer mint failed: '+response.status);
 token=(await response.json()).token;
 if(process.env.HPS_NATIVE_IDENTITY==='1'){
  const alternate=await app.fetch(new Request('http://local/admin/tokens/issue',{method:'POST',headers:{authorization:'Bearer '+issuer,'content-type':'application/json'},body:JSON.stringify({u:'synthetic-other',c:id,p:id,hours:1,native_trial:true})}),env,makeCtx());
  if(alternate.status!==200)throw Error('alternate synthetic issuer mint failed');
  writeFileSync(process.env.HPS_E2E_TOKEN_FILE+'.alternate',(await alternate.json()).token,{mode:0o600});
 }
 await env.HPS_KV.delete(`cohort:${id}:active_session`);
} else if(!effortRun) token=(await issue({u:'synthetic-adult',c:id,p:id},1,signing)).token;
// File deliberately lives outside evidence; never print or upload it.
writeFileSync(process.env.HPS_E2E_TOKEN_FILE || '/tmp/hps-native-trial-token', token, { mode: 0o600 });

let fault='none';
const calls = [];
let attempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (codexMode) {
    if(url.href!=='https://api.openai.com/v1/chat/completions') throw Error('unexpected GPT rehearsal upstream');
    if(++attempts>24) throw Error('live rehearsal request budget exhausted (24)');
    return codexRehearsalResponse(codex,JSON.parse(init.body),{signal:init.signal,record(row){calls.push(row);writeFileSync(resolve(output,'api-evidence.json'),JSON.stringify({real_upstream:true,provider:'codex-app-server',auth:'chatgpt',api_key_calls:0,storage:'synthetic-memory',calls},null,2));}});
  }
  if (url.origin !== 'https://api.anthropic.com') throw new Error('unexpected upstream origin in isolated trial test');
  if (++attempts > 24) throw new Error('live rehearsal request budget exhausted (24); inspect the recorded failure before rerunning');
  const start = Date.now();
  const settings=init?.body?JSON.parse(init.body):undefined;
  const call={model:settings?.model??null,...(effortRun&&settings?{effort:settings.output_config?.effort??null,thinking:settings.thinking?.type??null,...requestContext.getStore()}:{}),origin:url.origin,path:url.pathname,status:null,request_id:null,elapsed_ms:null};
  const saveCalls=()=>writeFileSync(resolve(output,'api-evidence.json'),JSON.stringify({real_upstream:true,storage:effortRun?'synthetic-sqlite':'synthetic-memory',calls},null,2));
  calls.push(call);saveCalls();
  let response;
  try {
    response = await realFetch(input, { ...init, signal: AbortSignal.any([
      ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(90000),
    ]) });
    call.status=response.status;call.request_id=response.headers.get('request-id');
  } catch(e) {call.error='transport';throw e;}
  finally {call.elapsed_ms=Date.now()-start;saveCalls();}
  return response;
};
const server = createServer(async (req, res) => {
  const cancellation = new AbortController();
  res.on('close', () => { if (!res.writableEnded) cancellation.abort(); });
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    if(process.env.HPS_NATIVE_FAULTS==='1'&&req.url==='/__test/fault'&&req.method==='POST'){
      if(req.headers.authorization!=='Bearer '+token){res.writeHead(401).end();return;}
      const next=Buffer.concat(chunks).toString();if(!['none','401','429','503','timeout','old-service','old-client'].includes(next)){res.writeHead(400).end();return;}
      fault=next;res.writeHead(204).end();return;
    }
    if(process.env.HPS_NATIVE_FAULTS==='1'&&['/v1/messages','/v1/chat/completions'].some(path=>req.url?.startsWith(path))&&fault!=='none'&&fault!=='old-service'&&fault!=='old-client'){
      if(fault==='timeout'){const timer=setTimeout(()=>res.end(),20000);res.on('close',()=>clearTimeout(timer));return;}
      res.writeHead(Number(fault),{'content-type':'application/json'}).end(JSON.stringify({type:'error',error:{type:fault==='401'?'authentication_error':fault==='429'?'rate_limit_error':'api_error',message:'synthetic gateway failure '+fault}}));return;
    }
    const method = req.method || 'GET', ctx = makeCtx();
    // Isolated synthetic harness only: selected record evidence, never credentials.
    if(req.url==='/v1/observations/assess') writeFileSync(resolve(output,'observation-input.json'),Buffer.concat(chunks),{mode:0o600});
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method, headers: req.headers, signal: cancellation.signal,
      ...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(chunks) }) });
    let response = await requestContext.run(effortRun?{turn_id:req.headers['x-hps-turn-id']??null,requested_effort:req.headers['x-hps-effort']??null}:undefined,()=>app.fetch(request, env, ctx));
    if(process.env.HPS_NATIVE_FAULTS==='1'&&fault==='old-service'&&req.url==='/v1/profile'&&response.ok){const old=await response.json();delete old.observation;response=Response.json(old);}

    if(req.url==='/v1/observations/assess') writeFileSync(resolve(output,'observation-response.json'),await response.clone().text(),{mode:0o600});
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
    await ctx.settle();
  } catch { if (!res.headersSent) res.writeHead(500); res.end('isolated test gateway error'); }
});
server.listen(port, '127.0.0.1', () => console.log('Isolated rehearsal gateway ready; '+(codexMode?'official Codex ChatGPT connection':'real Anthropic API')+'; synthetic storage'));
process.on('SIGTERM', () => server.close(() => {
 if(grantDb){writeFileSync(resolve(output,'grant-evidence.json'),JSON.stringify(grantDb.prepare('SELECT started_at,expires_at,request_limit,requests_used,lease_id IS NOT NULL AS busy FROM native_trials').all(),null,2));grantDb.close();}
 if(effortDb)effortDb.close();
 codex?.close();
 process.exit(0);
}));
