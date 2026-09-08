// Capture the vendor's embedded product illustrations with explicit provenance.
import {createRequire} from 'node:module';import fs from 'node:fs/promises';
import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../../..');
const require=createRequire(path.join(process.env.HPS_CAPTURE_DEPS_ROOT||root,'e2e/package.json'));
const {chromium}=require('@playwright/test');
const web=JSON.parse(await fs.readFile(path.join(here,'web-capture.json'),'utf8'));
const selected=[['cursor-browser-docs',1,'cursor-browser-vendor-demo'],['replit-testing-docs',0,'replit-vendor-takeover'],['replit-testing-docs',1,'replit-vendor-replay']];
const browser=await chromium.launch(),records=[];
try{for(const [source,index,id] of selected){
 const origin=web.find(r=>r.id===source),item=web.find(r=>r.id===source+'-images').images[index];
 if(!item?.src)throw Error('Missing observed image source: '+id);
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.goto(item.src,{timeout:25000});const img=page.locator('img').first();
 await img.waitFor();await img.evaluate(i=>i.decode());
 const file=id+'.png';await img.screenshot({path:path.join(here,'screenshots',file)});
 records.push({id,file,kind:'vendor-illustration',sourcePage:origin.resolvedUrl,imageUrl:item.src,
 scope:'Screenshot of a vendor-provided illustration, not our authenticated agent session',capturedAt:new Date().toISOString(),
 sha256:crypto.createHash('sha256').update(await fs.readFile(path.join(here,'screenshots',file))).digest('hex')});
 await page.close();
}}finally{await browser.close();}
await fs.writeFile(path.join(here,'reference-capture.json'),JSON.stringify(records,null,2)+'\n');
console.log('Captured '+records.length+' vendor illustrations with source attribution.');
