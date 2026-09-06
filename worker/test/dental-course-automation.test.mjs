import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sourceURL, generatedURL, compileProgram, renderFiles, importDrafts } from '../scripts/dental-authoring.mjs';
import { localAuthoring } from './harness/dental-authoring.mjs';
const p=JSON.parse(readFileSync(sourceURL,'utf8'));
const batch=compileProgram(p);
let passed=0;
async function check(name,fn){await fn();passed++;console.log(`PASS ${name}`);}
await check('five complete level-specific designs; repeat generation is deterministic',()=>{
 assert.deepEqual(compileProgram(p),batch);assert.equal(batch.courses.length,5);
 assert.equal(new Set(batch.courses.map(c=>c.content.objective)).size,5);
 assert.deepEqual(batch.courses.map(c=>c.content.duration_minutes),[120,120,120,120,120]);
});
await check('generated teaching documents and drafts match source exactly',()=>{
 for(const [name,text] of Object.entries(renderFiles(p))) assert.equal(readFileSync(new URL(name,generatedURL),'utf8'),text,name);
});
await check('negative controls: missing level, duplicate level, time and evidence defects rejected',()=>{
 for(const mutate of [x=>x.courses.pop(),x=>x.courses[1].level=1,x=>x.courses[0].steps[0].minutes=0,x=>x.courses[2].steps[2].evidence='',x=>x.courses[1].steps[4].id='other']) {
  const bad=structuredClone(p);mutate(bad);assert.throws(()=>compileProgram(bad));
 }
});
await check('all five are saved through real Service routing and reopened byte-for-byte',async()=>{
 const local=await localAuthoring();try {
  const report=await importDrafts({...local,batch});assert.equal(report.results.length,5);
  assert.ok(report.results.every(r=>r.status==='created'&&r.reopened&&r.revision===1));
  for(const c of batch.courses){const row=local.db.prepare('SELECT * FROM authoring_drafts WHERE course_id=?').get(c.course_id);assert.deepEqual(JSON.parse(row.content_json),c.content);assert.equal(row.owner_id,'instructor-seoyeon');}
  assert.equal(local.db.prepare('SELECT count(*) n FROM authoring_versions').get().n,0);
  assert.equal([...local.env._kv.keys()].filter(k=>k.includes(':pin')||k.includes('active_session')).length,0);
  const puts=local.calls.filter(c=>c.method==='PUT').length;
  const retry=await importDrafts({...local,batch});assert.ok(retry.results.every(r=>r.status==='existing'&&r.revision===1));
  assert.equal(local.calls.filter(c=>c.method==='PUT').length,puts);
 } finally {local.close();}
});
await check('interrupted batch reports partial progress and resumes without duplicate writes',async()=>{
 const local=await localAuthoring();try {
  const fetcher=(url,opts)=>url.endsWith('l3')?Promise.resolve(new Response('{}',{status:503})):local.fetcher(url,opts);
  await assert.rejects(importDrafts({...local,batch,fetcher}),e=>e.results.length===2);
  assert.equal(local.db.prepare('SELECT count(*) n FROM authoring_drafts').get().n,2);
  const resumed=await importDrafts({...local,batch});assert.deepEqual(resumed.results.map(r=>r.status),['existing','existing','created','created','created']);
  assert.equal(local.db.prepare('SELECT max(revision) r FROM authoring_drafts').get().r,1);
 } finally {local.close();}
});
await check('response lost after successful PUT resumes without a new revision',async()=>{
 const local=await localAuthoring();try {
  let lose=true;
  const fetcher=async(url,opts)=>{const r=await local.fetcher(url,opts);if(lose&&opts.method==='PUT'){lose=false;throw new Error('response lost');}return r;};
  await assert.rejects(importDrafts({...local,batch,fetcher}),/response lost/);
  const resumed=await importDrafts({...local,batch});assert.equal(resumed.results[0].status,'existing');assert.equal(resumed.results[0].revision,1);
 } finally {local.close();}
});
await check('changed course content never overwrites a saved instructor draft',async()=>{
 const local=await localAuthoring();try {
  await importDrafts({...local,batch});const changed=structuredClone(batch);changed.courses[0].content.title='A new title';
  await assert.rejects(importDrafts({...local,batch:changed}),/content conflict/);
  assert.equal(local.db.prepare('SELECT revision FROM authoring_drafts WHERE course_id=?').get(batch.courses[0].course_id).revision,1);
 } finally {local.close();}
});
await check('another instructor cannot take over these course identifiers',async()=>{
 const local=await localAuthoring();try {
  await importDrafts({...local,batch});
  await assert.rejects(importDrafts({...local,batch,token:await local.credential('another-instructor')}));
  assert.equal(local.db.prepare("SELECT count(*) n FROM authoring_drafts WHERE owner_id!='instructor-seoyeon'").get().n,0);
 } finally {local.close();}
});
await check('validate entire batch before any network write; reject policy injection',async()=>{
 let calls=0;const bad=structuredClone(batch);bad.courses[4].content.sdk_tools={shell:true};
 await assert.rejects(importDrafts({batch:bad,origin:'https://test.invalid',cohort:'test',profileId:'test',token:'synthetic',fetcher:()=>{calls++;}}));assert.equal(calls,0);
});
await check('a 200 with wrong reopened content is not counted as a successful import',async()=>{
 const local=await localAuthoring();try {
  let gets=0;const fetcher=async(url,opts)=>{if(opts.method==='GET'&&++gets===2)return new Response(JSON.stringify({revision:1,profile_id:local.profileId,content:{}}));return local.fetcher(url,opts);};
  await assert.rejects(importDrafts({...local,batch,fetcher}),/reopen mismatch/);
 } finally {local.close();}
});
console.log(`${passed} dental automation checks passed; learner rehearsal NOT RUN.`);
