import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {once} from 'node:events';import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {serveStatic} from '../../extensions/hypeproof-chat/src/liveServerHelpers.ts';
const root=fileURLToPath(new URL('../../docs/curriculum/dental-ownership/starter',import.meta.url));
for(const target of ['https://example.test/','//example.test/','/../outside.html','/__hp_viewport','/index.html%00','/\\example.test/'])assert.notEqual(serveStatic(root,'/__hp_viewport?path='+encodeURIComponent(target)).status,200);
const server=createServer((req,res)=>{const r=serveStatic(root,req.url);res.writeHead(r.status,{'content-type':r.contentType});res.end(r.body);});let browser;
try{server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;browser=await chromium.launch();const page=await browser.newPage({viewport:{width:600,height:900}});
await page.goto(origin+'/__hp_viewport?path=/index.html');const frame=page.frameLocator('#site');await frame.locator('h1').waitFor();await page.getByRole('status').filter({hasText:'390px'}).waitFor();assert.equal(await frame.locator('body').evaluate(()=>innerWidth),390);assert.equal(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth),390);
await page.getByRole('button',{name:'데스크톱 1280px'}).click();await page.getByRole('status').filter({hasText:'1280px'}).waitFor();assert.equal(await frame.locator('body').evaluate(()=>innerWidth),1280);
await page.getByRole('button',{name:'모바일 390px'}).click();await page.getByRole('status').filter({hasText:'390px'}).waitFor();await frame.getByRole('link',{name:'진료시간',exact:true}).click();assert.match(await frame.locator('body').evaluate(()=>location.hash),/hours/);
await page.getByRole('link',{name:'원본 크기로 열기'}).click();assert.equal(await page.evaluate(()=>innerWidth),600);
await page.goto(origin+'/__hp_viewport?path=/reference-b.html');await page.frameLocator('#site').locator('h1').waitFor();assert.ok(await page.frameLocator('#site').locator('body').evaluate(()=>document.documentElement.scrollWidth>innerWidth));console.log('PASS preview viewport: local paths only, 390/1280 actual iframe widths, good/bad overflow controls, anchor navigation, original width restored');
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
