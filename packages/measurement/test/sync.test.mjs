import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,stat,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { SessionSync,projectId,digestOf,makeSnapshots,validateServer } from '../dist/sync.mjs';
import { parseLocalTranscript,parseLocalTranscriptFile } from '../dist/adapters.mjs';
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
 const rows=[];let fail=false,corrupt=false,postCount=0,unauthorized=false,token='x'.repeat(40),owner='b'.repeat(64),scopes=[await projectId(project)];
 const server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  const send=(status,b)=>{res.writeHead(status);res.end(JSON.stringify(b));};
  if(unauthorized||req.headers.authorization!=='Bearer '+token)return send(401,{error:'unauthorized'});
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
  return send(200,{owner,projects:scopes,snapshots:rows.slice(index).map(r=>({...r.receipt,host:r.snapshot.host,project:r.snapshot.project,session:r.snapshot.session})),next_cursor:null});
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 const root=join(dir,'state'),sync=new SessionSync({root,home,now:()=>at});await sync.connect({server:origin,token:'x'.repeat(40),projects:[project]});
 return {dir,home,project,root,source,sync,rows,origin,codexDir,fail:v=>fail=v,corrupt:v=>corrupt=v,deny:v=>unauthorized=v,posts:()=>postCount,rotate:v=>token=v,owner:v=>owner=v,grant:v=>scopes=v};
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

test('token rotation keeps same-owner pending data and namespace',async t=>{
 const f=await fixture(t);f.fail(true);await f.sync.tick();const old=await f.sync.read('config');
 f.rotate('y'.repeat(40));f.fail(false);
 await f.sync.connect({server:f.origin,token:'y'.repeat(40),projects:[f.project]});
 assert.equal((await f.sync.read('config')).namespace,old.namespace);
 const result=await f.sync.tick();assert.equal(result.uploaded,2);assert.equal(result.pending,0);
});
test('scope expansion replays B history skipped while only A was selected',async t=>{
 const f=await fixture(t);const b=join(f.dir,'project-b');await mkdir(b);const bid=await projectId(b);
 f.grant([await projectId(f.project),bid]);
 const snapshot=makeSnapshots(parseLocalTranscript(codex(b,'earlier-b'),'codex'),bid)[0];
 const receipt={state:'accepted-server',id:randomUUID(),digest:snapshot.digest,accepted_at:new Date().toISOString()};f.rows.push({snapshot,receipt});
 await f.sync.tick();assert.equal((await f.sync.records()).length,2);
 await f.sync.connect({server:f.origin,token:'x'.repeat(40),projects:[f.project,b]});
 assert.equal((await f.sync.tick()).downloaded,1);assert.equal((await f.sync.records()).length,3);
});
test('owner change quarantines previous pending evidence instead of transferring it',async t=>{
 const f=await fixture(t);f.fail(true);await f.sync.tick();const old=await f.sync.read('config');
 f.owner('c'.repeat(64));await f.sync.connect({server:f.origin,token:'x'.repeat(40),projects:[f.project]});
 assert.notEqual((await f.sync.read('config')).namespace,old.namespace);
 assert.equal((await f.sync.status()).isolated_pending,2);
 assert.equal((await f.sync.store.list('outbox/'+old.namespace+'/')).length,2);
});

test('disabled project backlog cannot starve an active project upload',async t=>{
 const f=await fixture(t);const c=await f.sync.read('config');
 const snapshot=makeSnapshots(parseLocalTranscript(codex(f.project,'disabled'),'codex'),'c'.repeat(64))[0];
 for(let i=0;i<50;i++)await f.sync.write('outbox/'+c.namespace+'/000'+String(i).padStart(3,'0'),snapshot);
 const result=await f.sync.tick();assert.equal(result.uploaded,2);assert.equal(result.pending,50);
 assert.equal(result.issues.find(i=>i.code==='queued_project_not_enabled').count,50);
});


test('Codex subagent ordinal boundary excludes inherited history and preserves child identity',async t=>{
 const f=await fixture(t);
 const rows=[
  {ordinal:0,type:'session_meta',payload:{id:'child',cwd:f.project,forked_from_id:'parent',subagent_history_start_ordinal:5}},
  {ordinal:1,type:'session_meta',payload:{id:'parent',cwd:'/unselected-parent'}},
  {ordinal:2,...msg('Inherited parent message must not transfer.')},
  {ordinal:3,type:'turn_context',timestamp:new Date(at).toISOString(),payload:{model:'parent-model'}},
  {ordinal:4,type:'event_msg',payload:{type:'task_started'}},
  {ordinal:5,type:'turn_context',timestamp:new Date(at).toISOString(),payload:{model:'child-model'}},
  {ordinal:6,...msg('Delegated child task.')},
  {ordinal:7,...msg('Child result.','assistant')},
 ];
 const raw=rows.map(JSON.stringify).join('\n')+'\n';await writeFile(f.source,raw);
 const text=parseLocalTranscript(raw,'codex'),stream=await parseLocalTranscriptFile(f.source,'codex');
 assert.deepEqual(stream,text);assert.equal(text.batch.session,'child');assert.equal(text.project,f.project);
 assert.deepEqual(text.models,['child-model']);assert.deepEqual(text.batch.events.map(e=>e.text),['Delegated child task.','Child result.']);
 assert.ok(text.exclusions.some(x=>x.includes('not direct evidence of human behavior')));
 const cycle=await f.sync.tick();assert.equal(cycle.state,'connected');
 const child=f.rows.find(x=>x.snapshot.session==='child');assert.ok(child);assert.ok(!JSON.stringify(child).includes('Inherited parent message'));
 const noParent=structuredClone(rows);delete noParent[0].payload.forked_from_id;
 assert.deepEqual(parseLocalTranscript(noParent.map(JSON.stringify).join('\n'),'codex').batch,text.batch);
 const emptyPrefix=[{ordinal:0,type:'session_meta',payload:{id:'empty-prefix',cwd:f.project,subagent_history_start_ordinal:0}},{ordinal:1,...msg('First child message.')}];
 assert.equal(parseLocalTranscript(emptyPrefix.map(JSON.stringify).join('\n'),'codex').batch.events.length,1);
 const missing=structuredClone(rows);delete missing[6].ordinal;
 assert.throws(()=>parseLocalTranscript(missing.map(JSON.stringify).join('\n'),'codex'),/invalid_fork_ordinal/);
 const bad=structuredClone(rows);bad[0].payload.subagent_history_start_ordinal=-1;
 assert.throws(()=>parseLocalTranscript(bad.map(JSON.stringify).join('\n'),'codex'),/invalid_fork_boundary/);
 const foreign=[...rows,{ordinal:8,type:'session_meta',payload:{id:'foreign',cwd:f.project}}];
 assert.throws(()=>parseLocalTranscript(foreign.map(JSON.stringify).join('\n'),'codex'),/mixed_sessions/);
});
