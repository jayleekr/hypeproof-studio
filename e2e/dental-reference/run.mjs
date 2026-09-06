// Reference-output browser exercise, not an Electron/LLM learner run.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=resolve(process.env.HPS_DENTAL_REFERENCE_OUT || join(root,'e2e/test-results/dental-reference'));
mkdirSync(out,{recursive:true});
const base=join(root,'docs/curriculum/dental-ownership');
const read=p=>readFileSync(join(base,p),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
const original=read('starter/index.html'), final=read('reference/site/index.html');
const firstEdit=final.replace('10월 16일','10월 9일');
const snapshots={original:{'index.html':original},edited:{'index.html':firstEdit},final:{'index.html':final,'careers.html':read('reference/site/careers.html')},broken:{'index.html':final.replace('href="#hours"','href="#missing"')}};
let active='original';
const events=[];
const server=createServer((req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 let body;
 if(path==='/reference-b.html')body=read('starter/reference-b.html');
 else if(path==='/'||path==='/index.html')body=snapshots[active]['index.html'];
 else if(path==='/careers.html')body=snapshots[active]['careers.html'];
 if(body===undefined){res.writeHead(404);res.end('Not found');return;}
 res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-practice-version':active});res.end(body);
});
const report={scope:'reference HTML + loopback HTTP release simulation; NOT Studio/Electron/LLM or public hosting',started_at:new Date().toISOString(),checks:[],events,studio:'blocked: desktop binary unavailable',student_scores:null,production_writes:0};
let browser;let work;
async function check(level,name,fn){const detail=await fn();report.checks.push({level,name,status:'passed',detail:detail??null});console.log(`PASS L${level} ${name}`);}
function activate(version){assert.ok(snapshots[version]);active=version;events.push({action:'practice-activate',version,sha256:hash(snapshots[version]['index.html'])});}
async function measure(page){return page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth,font:parseFloat(getComputedStyle(document.body).fontSize),hoursTop:document.querySelector('#hours')?.getBoundingClientRect().top,brokenAnchors:[...document.querySelectorAll('a[href^="#"]')].filter(a=>!document.getElementById(a.hash.slice(1))).map(a=>a.hash)}));}
try {
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${server.address().port}`;
 report.origin=origin;
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
 await check(1,'positive/negative layout controls',async()=>{
  await page.goto(origin);const good=await measure(page);assert.ok(good.documentWidth<=good.width);assert.equal(good.font,18);assert.deepEqual(good.brokenAnchors,[]);
  const nav=await page.locator('nav a[href="#hours"]').boundingBox();assert.ok(nav.y<844);
  await page.screenshot({path:join(out,'l1-a-mobile.png'),fullPage:true});
  await page.goto(origin+'/reference-b.html');const bad=await measure(page);assert.ok(bad.documentWidth>bad.width);assert.equal(bad.font,11);assert.ok(bad.hoursTop>844);
  await page.screenshot({path:join(out,'l1-b-mobile.png'),fullPage:true});return {good,bad};
 });
 await check(2,'three edits and independent date change',async()=>{
  activate('edited');await page.goto(origin);
  assert.match(await page.locator('#notice').innerText(),/10월 9일/);
  assert.match(await page.locator('tr').filter({hasText:'화요일'}).innerText(),/19:00/);
  for(const day of ['월요일','수요일'])assert.match(await page.locator('tr').filter({hasText:day}).innerText(),/18:00/);
  assert.match(await page.locator('#faq').innerText(),/주차 안내는 방문 전 확인해주세요/);
  activate('final');await page.reload();assert.match(await page.locator('#notice').innerText(),/10월 16일/);assert.doesNotMatch(await page.locator('#notice').innerText(),/10월 9일/);
  await page.screenshot({path:join(out,'l2-edited-mobile.png'),fullPage:true});
  activate('original');await page.reload();assert.match(await page.locator('tr').filter({hasText:'화요일'}).innerText(),/18:00/);return {restored_original:true};
 });
 await check(3,'HTTP version evidence, planted link defect and rollback',async()=>{
  activate('final');const r=await fetch(origin);assert.equal(r.status,200);assert.equal(r.headers.get('x-practice-version'),'final');assert.equal(hash(await r.text()),hash(final));
  activate('broken');await page.goto(origin);assert.deepEqual((await measure(page)).brokenAnchors,['#missing']);
  activate('final');await page.reload();assert.deepEqual((await measure(page)).brokenAnchors,[]);await page.locator('nav a[href="#hours"]').click();assert.ok(page.url().endsWith('#hours'));
  const back=await fetch(origin);assert.equal(hash(await back.text()),hash(final));return {http_status:200,restored_sha256:hash(final),deployment_kind:'loopback-only'};
 });
 await check(4,'careers requirements, navigation and two viewport widths',async()=>{
  for(const width of [390,1280]){
   await page.setViewportSize({width,height:844});await page.goto(origin);await page.getByRole('link',{name:'채용 안내'}).click();assert.ok(page.url().endsWith('/careers.html'));
   for(const id of ['role','work','conditions','process','contact'])assert.equal(await page.locator('#'+id).count(),1);
   assert.equal(await page.locator('form,input,textarea').count(),0);
   assert.ok((await measure(page)).documentWidth<=width);
   await page.screenshot({path:join(out,`l4-careers-${width}.png`),fullPage:true});
   await page.getByRole('link',{name:'진료시간',exact:true}).click();assert.ok(page.url().endsWith('/index.html#hours'));assert.deepEqual((await measure(page)).brokenAnchors,[]);
  }
  return {viewports:[390,1280],required_sections:5,forms:0};
 });
 await check(5,'backup integrity negative control and restore to separate directory',async()=>{
  work=mkdtempSync(join(tmpdir(),'hps-dental-restore-'));
  const backup=join(work,'backup'),restored=join(work,'restored');mkdirSync(backup);mkdirSync(restored);
  const manifest={};
  for(const [name,body] of Object.entries(snapshots.final)){writeFileSync(join(backup,name),body);manifest[name]=hash(body);}
  const restore=()=>{
   const files=Object.keys(manifest).map(name=>[name,readFileSync(join(backup,name),'utf8')]);
   for(const [name,body] of files)assert.equal(hash(body),manifest[name],'backup integrity');
   for(const [name,body] of files)writeFileSync(join(restored,name),body);
  };
  writeFileSync(join(backup,'index.html'),'corrupted backup');assert.throws(restore,/backup integrity/);
  writeFileSync(join(backup,'index.html'),final);restore();
  snapshots.restored=Object.fromEntries(Object.keys(manifest).map(name=>[name,readFileSync(join(restored,name),'utf8')]));
  activate('restored');await page.goto(origin);assert.equal(hash(await (await fetch(origin)).text()),manifest['index.html']);
  await page.getByRole('link',{name:'채용 안내'}).click();assert.equal(hash(await (await fetch(page.url())).text()),manifest['careers.html']);
  return {manifest,corrupted_backup_rejected:true,restored_over_http:true,domain_recovery:'tabletop only; not executed'};
 });
 assert.deepEqual(pageErrors,[]);report.status='passed_reference_checks';
} catch(e){report.status='failed_or_blocked';report.error=String(e);process.exitCode=1;}
finally {
 if(browser)await browser.close();if(server.listening)await new Promise(r=>server.close(r));if(work)rmSync(work,{recursive:true,force:true});
 report.finished_at=new Date().toISOString();writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
 console.log(`Evidence: ${out}/report.json`);
}
