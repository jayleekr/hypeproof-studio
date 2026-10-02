// #1409: App copies preserve approved page bytes and exclude undated fragments outside the class window.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionSpool } from '../src/sessionSpool.ts';
import { freezeCollection } from '../src/evidenceSnapshot.ts';
const now = Date.parse('2026-10-02T03:00:00Z'), ident = {u:'synthetic',c:'test',p:'test'};
const scope = {class_run_id:'run',seat_id:'A1',student:ident,activity:null,run:{starts_at:now-60000,ends_at:now+3600000}};
const notice = {purpose:'class_report',notice_version:'v1'}, enc = new TextEncoder();
const decode = f => new TextDecoder().decode(f.data);
for (const restart of [false, true]) {
  const root = mkdtempSync(path.join(tmpdir(),'hps-1409-'));
  try {
    let at = now - (restart ? 10 : 60) * 60000;
    const spool = new SessionSpool({root,appVersion:'test',os:{platform:'darwin',release:'test',arch:'arm64'},now:()=>new Date(at),newSessionId:()=> 'before'});
    spool.noteIdentity(ident);
    const page = '<html>APPROVED-PAGE</html>';
    spool.recordArtifactSnapshot({source:'existing',path:'index.html',content:page}); await spool.flush();
    at = now;
    assert.equal(await spool.recordArtifactApprovalFor(await spool.owner(),{content:page,path:'index.html',approved:true}), true);
    let reader = spool;
    if (restart) {
      reader = new SessionSpool({root,appVersion:'test',os:{platform:'darwin',release:'test',arch:'arm64'},now:()=>new Date(now),newSessionId:()=> 'after'});
      reader.noteIdentity(ident); reader.recordPrompt({turnId:'t',runtime:'proxy',text:'NEXT'}); await reader.flush();
    }
    const src = await reader.readForCollection(0, ident);
    for (const kind of ['artifacts','record']) {
      const copy = freezeCollection(src, scope, 'batch', notice, [kind], now+1000);
      assert.equal(copy.ok,true);
      const events = copy.files.filter(f=>f.name.endsWith('.events.jsonl')).flatMap(f=>decode(f).trim().split('\n').map(JSON.parse));
      const approval = events.find(e=>e.type==='artifact_approval' && e.approved);
      assert.ok(approval); assert.ok(events.some(e=>e.type==='artifact_snapshot' && e.sha256===approval.artifact_sha256 && e.content===page));
    }
    console.log('PASS approved page present with restart=' + restart);
  } finally { rmSync(root,{recursive:true,force:true}); }
}
function freeze(lines) {
  const meta = enc.encode(JSON.stringify({session_id:'s',user:ident}));
  return freezeCollection({current:{files:[{name:'session.meta.json',data:meta},{name:'events.jsonl',data:enc.encode(lines.join('\n')+'\n')}],sequence:{session_id:'s',last_seq:5}},others:[],omitted:{unreadable:0,over_limit:0}},scope,'batch',notice,['record'],now);
}
const line = (ts,seq,text)=>JSON.stringify({ts:new Date(ts).toISOString(),seq,type:'prompt',text});
const result=freeze(['{"text":"OUTSIDE-FRAGMENT',line(now-2*3600000,1,'OLD'),'{"text":"BOUNDARY-FRAGMENT',line(now-30000,2,'CURRENT'),'{"text":"INSIDE-DAMAGED',line(now-10000,4,'CURRENT2')]);
assert.equal(result.ok,true);
const sent=result.files.filter(f=>f.name.endsWith('.events.jsonl')).map(decode).join('');
assert.ok(!sent.includes('OUTSIDE-FRAGMENT')); assert.ok(!sent.includes('BOUNDARY-FRAGMENT')); assert.ok(!sent.includes('OLD'));
assert.ok(sent.includes('INSIDE-DAMAGED')); assert.ok(sent.includes('CURRENT2'));
const legacy=freeze(['{"type":"prompt","text":"LEGACY"}','{"text":"LEGACY-DAMAGED']);
assert.equal(legacy.ok,true); assert.ok(legacy.files.filter(f=>f.name.endsWith('.events.jsonl')).map(decode).join('').includes('LEGACY-DAMAGED'));
console.log('PASS timestamped window excludes outside fragments and retains inside damage; undated legacy preserved');
