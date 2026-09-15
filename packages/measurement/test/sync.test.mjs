import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,stat,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { SessionSync,projectId,digestOf,makeSnapshots,validateServer } from '../dist/sync.mjs';
import { parseLocalTranscript } from '../dist/adapters.mjs';
const at=Date.now();
const msg=(text,role='user')=>({type:'response_item',timestamp:new Date(at).toISOString(),payload:{type:'message',role,content:[{type:'input_text',text}]}});
const codex=(project,session='sample',extra=[])=>[{type:'session_meta',payload:{id:session,cwd:project}},{type:'turn_context',timestamp:new Date(at).toISOString(),payload:{model:'test-model',effort:'medium'}},msg('Please verify both normal and empty input.'),msg('Checks passed (unverified claim).','assistant'),...extra].map(JSON.stringify).join('\n')+'\n';
async function fixture(t){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'hps-sync-test-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const home=join(dir,'home'),project=join(dir,'project');await mkdir(project,{recursive:true});
 const date=new Date(at),codexDir=join(home,'.codex/sessions',String(date.getFullYear()),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0'));
 const claudeDir=join(home,'.claude/projects',project.replace(/[^a-zA-Z0-9]/g,'-'));await mkdir(codexDir,{recursive:true});await mkdir(claudeDir,{recursive:true});
 const source=join(codexDir,'one.jsonl');await writeFile(source,codex(project));
 await writeFile(join(claudeDir,'one.jsonl'),JSON.stringify({type:'user',sessionId:'claude-one',cwd:project,timestamp:new Date(at).toISOString(),message:{role:'user',content:'Compare alternatives before choosing.'}})+'\n');
 const rows=[];let fail=false,corrupt=false,postCount=0,unauthorized=false;
 const server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  const send=(status,b)=>{res.writeHead(status);res.end(JSON.stringify(b));};
  if(unauthorized||req.headers.authorization!=='Bearer '+'x'.repeat(40))return send(401,{error:'unauthorized'});
  const u=new URL(req.url,'http://localhost');
  if(req.method==='POST'){
   postCount++;if(fail)return send(503,{});
   let body='';for await(const c of req)body+=c;const snapshot=JSON.parse(body);
   assert.equal(digestOf(snapshot.payload),snapshot.digest);
   let row=rows.find(r=>r.snapshot.digest===snapshot.digest&&r.snapshot.host===snapshot.host&&r.snapshot.project===snapshot.project&&r.snapshot.session===snapshot.session);
   if(!row){row={snapshot,receipt:{state:'accepted-server',id:randomUUID(),digest:snapshot.digest,accepted_at:new Date().toISOString()}};rows.push(row);}
   return send(200,{receipt:corrupt?{...row.receipt,digest:'bad'}:row.receipt});
  }
  if(u.searchParams.has('id')){const row=rows.find(r=>r.receipt.id===u.searchParams.get('id'));return send(200,corrupt?{...row,snapshot:{...row.snapshot,digest:'bad'}}:row);}
  const cursor=u.searchParams.get('cursor');const index=cursor?rows.findIndex(r=>r.receipt.id===cursor)+1:0;
  return send(200,{projects:[await projectId(project)],snapshots:rows.slice(index).map(r=>({...r.receipt,host:r.snapshot.host,project:r.snapshot.project,session:r.snapshot.session})),next_cursor:null});
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 const root=join(dir,'state'),sync=new SessionSync({root,home,now:()=>at});await sync.connect({server:origin,token:'x'.repeat(40),projects:[project]});
 return {dir,home,project,root,source,sync,rows,origin,codexDir,fail:v=>fail=v,corrupt:v=>corrupt=v,deny:v=>unauthorized=v,posts:()=>postCount};
}
test('both hosts export automatically, retry offline across restart, import receipts and avoid duplicates',async t=>{
 const f=await fixture(t);f.fail(true);let r=await f.sync.tick();assert.equal(r.pending,2);assert.equal(r.uploaded,0);assert.equal(f.rows.length,0);
 f.fail(false);const resumed=new SessionSync({root:f.root,home:f.home,now:()=>at});r=await resumed.tick();assert.equal(r.uploaded,2);assert.equal(r.downloaded,2);assert.equal(r.pending,0);assert.deepEqual(new Set(f.rows.map(r=>r.snapshot.host)),new Set(['codex','claude-code']));
 const posts=f.posts();r=await resumed.tick();assert.equal(r.unchanged,2);assert.equal(f.posts(),posts);assert.equal((await resumed.records()).length,2);
 await writeFile(f.source,codex(f.project,'sample',[msg('Check the real test output.')]));r=await resumed.tick();assert.equal(r.uploaded,1);assert.equal(f.rows.length,3);assert.equal(f.rows[2].snapshot.payload.batch.events.length,3);
 const text=JSON.stringify(await resumed.status());assert.ok(!text.includes('x'.repeat(40)));assert.equal((await stat(resumed.store.root)).mode&0o777,0o700);
});
test('connection token rejection, wrong receipt, malformed file and foreign project fail closed',async t=>{
 const f=await fixture(t);await writeFile(join(f.codexDir,'foreign.jsonl'),codex('/not/authorized','foreign'));
 await writeFile(join(f.codexDir,'bad.jsonl'),codex(f.project,'bad')+'{broken}\n');
 f.corrupt(true);let r=await f.sync.tick();assert.equal(r.pending,2);assert.equal(r.uploaded,0);assert.ok(r.issues.some(e=>e.code==='invalid_server_receipt'));assert.ok(r.issues.some(e=>e.code==='invalid_transcript_json'));assert.equal(f.rows.some(r=>r.snapshot.session==='foreign'),false);
 f.corrupt(false);r=await f.sync.tick();assert.equal(r.pending,0);assert.equal(f.rows.length,2);
 f.deny(true);await assert.rejects(f.sync.connect({server:f.origin,token:'x'.repeat(40),projects:[f.project]}),/server_401/);
 r=await f.sync.tick();assert.equal(r.state,'attention');assert.ok(r.issues.some(e=>e.code==='server_401'));
});
test('remote import is validated before cursor advances and resumes after repair',async t=>{
 const f=await fixture(t);await f.sync.tick();const cfg=await f.sync.read('config');
 for(const key of await f.sync.store.list('inbox/'))await f.sync.store.remove(key);await f.sync.store.remove('cursor/'+cfg.namespace);
 f.corrupt(true);let r=await f.sync.tick();assert.equal(r.downloaded,0);assert.equal(await f.sync.read('cursor/'+cfg.namespace),null);
 f.corrupt(false);r=await f.sync.tick();assert.equal(r.downloaded,2);assert.ok(await f.sync.read('cursor/'+cfg.namespace));
 await f.sync.pause();await writeFile(f.source,codex(f.project,'sample',[msg('Do not upload while paused.')]));assert.equal((await f.sync.tick()).state,'disconnected');assert.equal(f.rows.length,2);
});
test('bounded chunks reuse source parser, redact secrets, and never invent interpretation',()=>{
 const rows=Array.from({length:180},(_,i)=>msg('Evidence '+i+' '+ 'a'.repeat(19000)));
 const parsed=parseLocalTranscript(codex('/project','large',rows),'codex');const snapshots=makeSnapshots(parsed,'a'.repeat(64));assert.ok(snapshots.length>1);
 assert.equal(snapshots.reduce((n,s)=>n+s.payload.batch.events.length,0),182);
 for(const s of snapshots){assert.ok(Buffer.byteLength(JSON.stringify(s))<=1536*1024);assert.equal(s.digest,digestOf(s.payload));assert.equal(s.payload.interpretation_status,'unreviewed');assert.ok(s.payload.batch.incomplete);}
 const secret='sk-'+'a'.repeat(48);const redacted=makeSnapshots(parseLocalTranscript(codex('/project','secret',[msg(secret)]),'codex'),'a'.repeat(64));assert.ok(!JSON.stringify(redacted).includes(secret));
 assert.throws(()=>validateServer('http://example.com'),/invalid_server/);assert.throws(()=>validateServer('https://u:password@example.com'),/invalid_server/);
});
