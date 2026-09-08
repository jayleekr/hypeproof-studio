// Official multi-model UI references; no authenticated product/model execution.
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../../..');
const require=createRequire(path.join(process.env.HPS_CAPTURE_DEPS_ROOT||root,'e2e/package.json'));
const {chromium}=require('@playwright/test');
const out=path.join(here,'screenshots'),records=[];
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch();
async function shot(target,id,metadata){
 const file=id+'.png';await target.screenshot({path:path.join(out,file)});
 records.push({id,file,capturedAt:new Date().toISOString(),...metadata,
  sha256:crypto.createHash('sha256').update(await fs.readFile(path.join(out,file))).digest('hex')});
}
try{
 for(const [id,url,heading,section,vendor] of [
  ['cursor-models-docs','https://cursor.com/help/models-and-usage/available-models','Available models',null,null],
  ['cursor-router-docs','https://cursor.com/help/models-and-usage/cursor-router','Cursor Router',null,null],
  ['vscode-models-docs','https://code.visualstudio.com/docs/agent-customization/language-models','AI language models in VS Code','Change the model for chat',{id:'vscode-model-picker-vendor',alt:'Screenshot that shows the model picker in the Chat view.'}],
  ['cascade-arena-docs','https://docs.devin.ai/desktop/cascade/arena','Arena Mode',null,{id:'cascade-arena-vendor',sourcePath:'/cascade/proceed.png'}],
 ]){
  const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
  try{
   const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:25000});
   if(!response?.ok())throw Error('HTTP '+response?.status());
   await page.getByRole('heading',{name:heading,exact:false}).first().waitFor({timeout:15000});
   if(section)await page.getByRole('heading',{name:section,exact:true}).scrollIntoViewIfNeeded();
   await page.waitForTimeout(1000);
   await shot(page,id,{kind:'official-page',requestedUrl:url,resolvedUrl:page.url(),httpStatus:response.status(),viewport:page.viewportSize(),scope:'Official documentation, not our authenticated product execution'});
   if(vendor){
    const imgs=await page.locator('img').evaluateAll(xs=>xs.map(i=>({alt:i.alt,src:i.currentSrc,width:i.naturalWidth,height:i.naturalHeight})));
    const item=vendor.alt?imgs.find(i=>i.alt===vendor.alt):imgs.find(i=>i.src.includes(vendor.sourcePath));
    if(!item?.src)throw Error('Missing vendor illustration: '+vendor.id);
    const imagePage=await browser.newPage({viewport:{width:1440,height:1000}});
    try{
     await imagePage.goto(item.src,{timeout:25000});
     const img=imagePage.locator('img').first();await img.waitFor();await img.evaluate(i=>i.decode());
     await shot(img,vendor.id,{kind:'vendor-illustration',sourcePage:page.url(),imageUrl:item.src,alt:item.alt,originalPixels:{width:item.width,height:item.height},scope:'Screenshot of an official vendor illustration; not our authenticated agent session'});
    }finally{await imagePage.close();}
   }
  }catch(e){records.push({id,requestedUrl:url,status:'BLOCKED',reason:e.message});}
  finally{await page.close();}
 }
}finally{await browser.close();}
await fs.writeFile(path.join(here,'model-capture.json'),JSON.stringify(records,null,2)+'\n');
console.log(JSON.stringify(records,null,2));
if(records.some(r=>r.status==='BLOCKED'))process.exitCode=1;
