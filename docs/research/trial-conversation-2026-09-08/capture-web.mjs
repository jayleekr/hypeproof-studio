// Public documentation screenshots only; no account, cookie import or mutations.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const here=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(path.resolve(here,'../../../e2e/package.json'));
const {chromium}=require('@playwright/test');
const browser=await chromium.launch();const records=[];
try {
 for(const [id,url] of [
 ['cursor-github-setup','https://prod.cursor.com/docs/integrations/github#setup'],
 ['cursor-github-permissions','https://prod.cursor.com/docs/integrations/github#permissions'],
 ['cursor-github-recovery','https://prod.cursor.com/docs/integrations/github#troubleshooting'],
 ['cursor-github-app','https://github.com/apps/cursor'],
 ['cursor-usage-limits','https://prod.cursor.com/help/models-and-usage/usage-limits'],
 ['claude-artifacts','https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them']]) {
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  try {const res=await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1200);
   const file='screenshots/'+id+'.png';await page.screenshot({path:path.join(here,file)});
   records.push({id,kind:'DOC',url,finalUrl:page.url(),httpStatus:res.status(),title:await page.title(),capturedAt:new Date().toISOString(),viewport:page.viewportSize(),file,sha256:crypto.createHash('sha256').update(await fs.readFile(path.join(here,file))).digest('hex')});
  }catch(e){records.push({id,kind:'DOC',url,status:'BLOCKED',error:e.message});}finally{await page.close();}
 }
}finally{await browser.close();}
await fs.writeFile(path.join(here,'web-capture.json'),JSON.stringify(records,null,2)+'\n');
console.log(records.map(({id,httpStatus,status})=>({id,httpStatus,status})));
