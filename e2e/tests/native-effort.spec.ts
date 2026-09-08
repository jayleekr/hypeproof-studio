import {test, expect} from '@playwright/test';
import {launchApp, closeApp, chatFrame, startFrame} from '../fixtures/app';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const freshCalls = (calls:any[], previous:Set<unknown>) => calls.filter(c=>!previous.has(c.turn_id)&&c.path==='/v1/messages');

test('delayed auxiliary requests remain with their original turn',()=>{
  const old={turn_id:'old',path:'/v1/messages',effort:'low'}, current={turn_id:'current',path:'/v1/messages',effort:'high'};
  expect(freshCalls([old,current,old],new Set(['old']))).toEqual([current]);
  expect(freshCalls([old],new Set(['old']))).toEqual([]);
  expect(freshCalls([old,current],new Set()).length).toBe(2);
});

test('course effort reaches the real model and survives UI transitions', async () => {
  test.setTimeout(900000);
  const ctx = await launchApp({preseedToken:true, preseedCoach:{name:'제작 파트너'}});
  const out = process.env.HPS_NATIVE_EVIDENCE_DIR!;
  let activeToken=ctx.token;
  const shot=async(name:string)=>{
    const png=await ctx.app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    writeFileSync(join(out,name+'.png'),Buffer.from(png,'base64'));
  };
  const checks: unknown[] = [];
  const save = (status:string, error?:string) => writeFileSync(join(out,'effort-result.json'), JSON.stringify({status,error,checks,runtime:process.env.HPS_EFFORT_RUNTIME??'agent-sdk',scope:'actual Mac App + real Anthropic + synthetic frozen lessons/SQLite',visual_review:'PENDING'},null,2));
  const api = () => JSON.parse(readFileSync(join(out,'api-evidence.json'),'utf8')).calls;
  try {
    let chat = await chatFrame(ctx.win);
    const model = () => chat.getByRole('combobox',{name:'대화 모델',exact:true});
    const effort = () => chat.getByRole('combobox',{name:'처리 수준',exact:true});
    const input = () => chat.locator('.hps-input textarea').first();
    await expect(effort()).toHaveValue('medium');
    await input().fill('아직 보내지 않은 꽃집 소개 초안');
    await effort().focus(); await effort().press('ArrowDown');
    await expect(effort()).toHaveValue('high');
    await expect(input()).toHaveValue('아직 보내지 않은 꽃집 소개 초안');
    await model().selectOption('hypeproof-fast');
    await expect(effort()).toHaveCount(0);
    await expect(chat.locator('.hps-effort')).toContainText('지원하지');
    await model().selectOption('hypeproof-default');
    await expect(effort()).toHaveValue('medium');
    checks.push({keyboard:'ArrowDown selects high',unsupported:'Haiku has no control',draft_preserved:true,model_change:'course default restored'});

    // Actual shell zoom and bounds, without changing app layout/CSS or OS focus.
    for (const width of [390,1280]) {
      const zoom = width===390?2:1;
      const settingsPath=join(ctx.userDataDir,'User','settings.json');
      const settings=JSON.parse(readFileSync(settingsPath,'utf8'));
      settings['window.zoomLevel']=Math.log(zoom)/Math.log(1.2);
      writeFileSync(settingsPath,JSON.stringify(settings));
      await expect.poll(()=>ctx.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBeCloseTo(zoom,1);
      for(let n=0;n<8;n++) {
        const current=await chat.locator('body').evaluate(()=>innerWidth);
        if(current===width)break;
        await ctx.app.evaluate(({BrowserWindow},delta)=>{const w=BrowserWindow.getAllWindows()[0];w.setBounds({width:w.getBounds().width+delta,height:1000});},Math.round((width-current)*zoom));
        await ctx.win.waitForTimeout(300);
      }
      const metrics=await effort().evaluate(e=>({width:innerWidth,scroll:document.documentElement.scrollWidth,right:e.getBoundingClientRect().right,bottom:e.getBoundingClientRect().bottom,height:innerHeight}));
      expect(metrics.width).toBe(width);expect(metrics.scroll).toBe(width);expect(metrics.right).toBeLessThanOrEqual(width);expect(metrics.bottom).toBeLessThanOrEqual(metrics.height);
      const composer=await chat.locator('.hps-btn-send').evaluate(e=>({bottom:e.getBoundingClientRect().bottom,height:innerHeight}));
      expect(composer.bottom).toBeLessThanOrEqual(composer.height);
      await shot('effort-'+width);
      checks.push({viewport:metrics,composer,zoom});save('IN_PROGRESS');
    }
    const send = async (alias:string, selected:string|null, expected:string, switchDuring=false) => {
      if(await model().isEnabled())await model().selectOption(alias);else await expect(model()).toHaveValue(alias);
      if(selected) {if(await effort().isEnabled())await effort().selectOption(selected);await expect(effort()).toHaveValue(selected);}
      else await expect(effort()).toHaveCount(0);
      const previousTurns = new Set((()=>{try{return api().map((c:any)=>c.turn_id);}catch{return [];}})());
      await input().fill('합성 테스트야. 가상 꽃집 이름은 민트플라워. 도구 없이 이름만 답해 줘.');
      await input().press('Enter');await expect(chat.locator('.hps-btn-stop')).toBeVisible();
      if(switchDuring){await input().fill('진행 중 작성한 초안');await effort().selectOption('high');}
      await expect(chat.locator('.hps-btn-stop')).toHaveCount(0,{timeout:150000});
      await expect(chat.locator('.hps-error-banner')).toHaveCount(0);
      await expect(chat.locator('.hps-messages')).toContainText('민트플라워');
      if(switchDuring)await expect(input()).toHaveValue('진행 중 작성한 초안');
      const details=chat.locator('.hps-effort details');
      if(await details.getAttribute('open')===null)await details.locator('summary').click();
      await expect.poll(async()=>{
        await details.getByRole('button',{name:'적용 기록 다시 확인'}).click();
        return await details.innerText();
      },{timeout:15000}).toContain('서버에서 확인된');
      await expect.poll(()=>freshCalls(api(),previousTurns).every((c:any)=>c.status!==null),{timeout:95000}).toBe(true);
      const calls=freshCalls(api(),previousTurns);
      expect(new Set(calls.map((c:any)=>c.turn_id)).size).toBe(1);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c:any)=>c.status===200&&c.model===expected&&c.effort===selected)).toBe(true);
      expect(calls.every((c:any)=>c.requested_effort===selected)).toBe(true);
      const turn=calls[0].turn_id;expect(typeof turn).toBe('string');
      let records:any[]=[];
      await expect.poll(async()=>{
        const r=await fetch(process.env.HPS_E2E_PROXY_URL+'/request-settings/'+turn,{headers:{authorization:'Bearer '+activeToken}});
        expect(r.status).toBe(200);records=(await r.json()).requests;return records.length;
      },{timeout:15000}).toBe(calls.length);
      expect(records.length).toBe(calls.length);
      expect(records.every((r:any)=>r.model===expected&&r.applied===selected&&r.requested===selected)).toBe(true);
      checks.push({alias,selected,calls,records,next_request_only:switchDuring});save('IN_PROGRESS');
    };
    await send('hypeproof-default','low','claude-sonnet-4-6',true);
    await send('hypeproof-default','high','claude-sonnet-4-6');
    await send('claude-sonnet-5','medium','claude-sonnet-5');
    await send('claude-opus-4-5-20251101','low','claude-opus-4-5-20251101');
    await send('claude-opus-5','high','claude-opus-5');
    await send('claude-opus-4-6','medium','claude-opus-4-6');
    await send('hypeproof-strong','low','claude-opus-4-7');
    await send('claude-opus-4-8','high','claude-opus-4-8');
    await send('hypeproof-fast',null,'claude-haiku-4-5');
    await send('claude-sonnet-4-5-20250929',null,'claude-sonnet-4-5-20250929');
    await shot('unsupported-model-record');
    await chat.getByRole('button',{name:'수업 연결',exact:true}).click();
    const entry=await startFrame(ctx.win);await entry.getByRole('button',{name:'다른 수업에 연결'}).click();
    activeToken=readFileSync(process.env.HPS_E2E_TOKEN_FILE+'.fixed','utf8').trim();
    await entry.getByLabel('수업 참여 코드',{exact:true}).fill(activeToken);
    await entry.getByRole('button',{name:'수업 확인하기'}).click();await expect(entry.locator('.studio-course')).toBeVisible();
    await entry.getByRole('button',{name:'수업 시작하기'}).click();chat=await chatFrame(ctx.win);
    await expect(effort()).toHaveValue('low');await expect(effort()).toBeDisabled();
    await expect(chat.locator('.hps-effort')).not.toContainText('서버에서 확인된');
    await send('hypeproof-default','low','claude-sonnet-4-6');
    await shot('fixed-course');
    checks.push({fixed_course:'low, disabled, old receipt cleared'});save('PASS_EXECUTED_CASES');
  } catch(e) {save('FAIL',String(e));await ctx.win.screenshot({path:join(out,'failure.png'),timeout:5000}).catch(()=>{});throw e;}
  finally {await closeApp(ctx);}
});
