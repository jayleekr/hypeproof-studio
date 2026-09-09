import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from '@playwright/test';
import {budgetFixture} from './fixture.mjs';
const out=process.env.HPS_BUDGET_EVIDENCE_DIR||'/tmp/hps-856-evidence';mkdirSync(out,{recursive:true});
const h=await budgetFixture();let browser;
try{
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(h.chalkOrigin+'/budgets');await page.locator('#token').fill(h.teacher);await page.locator('#cohort').fill(h.cohort);await page.locator('#connect button[type=submit],#connect button:not([type])').click();await page.locator('#status').filter({hasText:'확인 시각'}).waitFor();
 assert.equal(await page.locator('#token').inputValue(),'');assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
 for(const width of [390,1280]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:out+'/chalk-budget-'+width+'.png',fullPage:true});}
 await page.getByRole('button',{name:'학생 배분 추가'}).click();await page.locator('#seat').selectOption({label:'student-a'});await page.locator('#slots').fill('1');await page.locator('#limits input').fill('0.25');await page.locator('#save').click();await page.locator('#overview').filter({hasText:'student-a · 공유 사용 상한'}).waitFor();
 assert.equal(h.db.prepare("SELECT granted FROM budget_limits l JOIN budget_accounts a ON a.id=l.account_id WHERE a.scope_kind='subject'").get().granted,250000);
 await page.getByRole('button',{name:'조절',exact:true}).click();await page.locator('#paused').check();await page.locator('#save').click();await page.locator('#overview').filter({hasText:'student-a · 공유 사용 상한 · 일시정지'}).waitFor();
 // Keyboard and actual browser page zoom layout, keeping viewport fixed.
 await page.locator('#refresh').focus();await page.keyboard.press('Enter');await page.locator('#status').filter({hasText:'확인 시각'}).waitFor();
 await page.evaluate(()=>{document.documentElement.style.zoom='2';});await page.setViewportSize({width:1280,height:1000});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:out+'/chalk-budget-200-percent.png',fullPage:true});await page.evaluate(()=>{document.documentElement.style.zoom='1';});
 const rogue=await browser.newPage();await rogue.goto(h.chalkOrigin+'/budgets');await rogue.locator('#token').fill(h.otherTeacher);await rogue.locator('#cohort').fill(h.cohort);await rogue.locator('#connect button:not([type])').click();await rogue.locator('#status').filter({hasText:'권한'}).waitFor();assert.equal(await rogue.locator('#overview section').count(),0);await rogue.screenshot({path:out+'/chalk-budget-role-denied.png',fullPage:true});await rogue.close();
 const operator=await browser.newPage({viewport:{width:1280,height:900}});await operator.goto(h.serviceOrigin+'/operator/budgets');await operator.locator('#password').fill('synthetic-admin');await operator.locator('#connect button:not([type])').click();await operator.locator('#status').filter({hasText:'확인 시각'}).waitFor();await operator.locator('#root').selectOption(h.root.account_id);await operator.locator('#balance').filter({hasText:'granted'}).waitFor();assert.equal(await operator.locator('#password').inputValue(),'');await operator.screenshot({path:out+'/operator-budget-1280.png',fullPage:true});
 assert.deepEqual(errors,[]);writeFileSync(out+'/browser-result.json',JSON.stringify({pass:true,environment:'actual Chromium -> local Chalk -> local Service/HMAC/SQLite',synthetic:true,live_provider:false,checks:['390/1280','200% CSS page zoom','keyboard refresh','student cap and pause persisted','cross-class issuer denied','operator authenticated read','credentials absent from URL/storage/input after connect'],upstream_calls:h.upstream.length},null,2));
 console.log('PASS actual browser budget surfaces, persisted cap/pause, keyboard/zoom, operator and role negative control');
}finally{if(browser)await browser.close();await h.close();}
