// Feature B runs inside the existing native lesson acceptance. No host events
// or approval results are injected. File-write approval is explicitly enabled
// in this isolated test user's settings; it is not the product default.
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {APPROVAL_TITLE_PATTERN} from '../../extensions/hypeproof-chat/src/coachIdentity.ts';

export function surfaceAcceptance({out,workspace,live,degraded,gatewayCalls}){
 const checks=[];let failure,completed=false;
 const save=()=>writeFileSync(join(out,'surfaces-result.json'),JSON.stringify({scope:'actual Mac app + local Service; synthetic lesson and workspace',checks,status:failure?'FAIL':completed?'PASS_EXECUTED_CASES':'IN_PROGRESS',error:failure,visual_review:'PENDING separate image inspection',not_run:['all eight approval kinds','Windows','screen reader','historical identity','human learning']},null,2));
 const record=(id,detail)=>{checks.push({id,status:'PASS',...detail});save();};
 return {
  async connected({entry,name,key,shot,wait}){
   await wait(()=>entry.evaluate(`document.querySelector('.studio-connect')?.textContent.includes(${JSON.stringify(name)})`),'start page resolved name');
   const state=await entry.evaluate(`({course:document.querySelector('.studio-course')?.textContent,process:document.querySelector('.studio-process')?.textContent,description:document.querySelector('.studio-connect')?.textContent,width:innerWidth,document_width:document.documentElement.scrollWidth,credential_field:!!document.querySelector('#course-code')})`);
   state.overflow_elements=await entry.evaluate("[...document.querySelectorAll('body *')].filter(e=>e.clientWidth>0&&e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX==='visible').map(e=>({tag:e.tagName,class:e.className,width:e.clientWidth,scroll_width:e.scrollWidth})).slice(0,20)");
   assert.equal(state.credential_field,false);
   assert.ok(state.course.includes('AI 이름'));assert.ok(state.course.includes(name));assert.ok(state.process.includes(name));
   assert.ok(!state.process.includes('코치와 작은 시도부터')||name==='코치');
   if(['first','b','html','long','legacy'].includes(key))await shot('b-start-'+key);
   const fits=state.document_width<=state.width&&state.overflow_elements.length===0;
   if(!fits){failure='B start-page overflow: '+key;process.exitCode=1;}
   if(key==='html')assert.equal(await entry.evaluate("document.querySelectorAll('.studio-course b').length"),0,'name rendered as HTML');
   record('B1-'+key,{name,...state,status:fits?'PASS':'FAIL'});
  },
  async started({entry,name,app,window,shot,wait,setZoom,key}){
   await wait(()=>entry.evaluate(`document.querySelector('.studio-primary')?.textContent.includes(${JSON.stringify(name+'와 계속')})||document.querySelector('.studio-primary')?.textContent.includes(${JSON.stringify(name+'과 계속')})`),'named continue action');
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1800,height:1000}));await window.waitForTimeout(400);
   const check=async label=>{
    await entry.evaluate("document.querySelector('.studio-primary').scrollIntoView({block:'center'})");
    const state=await entry.evaluate("({width:innerWidth,document_width:document.documentElement.scrollWidth,title:document.querySelector('#connect-title').textContent,button:document.querySelector('.studio-primary').textContent,overflow_elements:[...document.querySelectorAll('body *')].filter(e=>e.clientWidth>0&&e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX==='visible').map(e=>({tag:e.tagName,class:e.className,width:e.clientWidth,scroll_width:e.scrollWidth})).slice(0,20)})");
    assert.ok(state.title.includes(name));assert.ok(state.button.includes(name));
    const fits=state.document_width<=state.width&&state.overflow_elements.length===0;if(!fits){failure='B started-page overflow: '+label;process.exitCode=1;}
    await shot('b-continue-'+label);record('B6-continue-'+label,{...state,status:fits?'PASS':'FAIL'});
   };
   for(const width of [1280,390]){
    for(let attempt=0;attempt<5;attempt++){
     const current=await entry.evaluate('innerWidth');if(current===width)break;
     const box=await window.locator('.part.sidebar').boundingBox();assert.ok(box);
     await window.mouse.move(box.x+box.width,box.y+box.height/2);await window.mouse.down();await window.mouse.move(box.x+box.width+current-width,box.y+box.height/2,{steps:12});await window.mouse.up();await window.waitForTimeout(300);
    }
    assert.equal(await entry.evaluate('innerWidth'),width,'native start viewport differs from requested width');await check(String(width));
   }
   setZoom(2);await wait(async()=>Math.abs(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())-2)<0.01,'B 200% zoom');await window.waitForTimeout(500);await check('zoom-200');
   await entry.evaluate("document.querySelector('.studio-primary').focus()");await key(entry,'Tab','Tab',{windowsVirtualKeyCode:9});
   const focus=await entry.evaluate("({tag:document.activeElement.tagName,text:document.activeElement.textContent,visible:document.activeElement.getBoundingClientRect().right<=innerWidth&&document.activeElement.getBoundingClientRect().bottom<=innerHeight})");
   assert.equal(focus.tag,'BUTTON');assert.equal(focus.visible,true);record('B6-continue-keyboard',{zoom:2,focus});
   setZoom(1);await wait(async()=>Math.abs(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())-1)<0.01,'B normal zoom');
  },
  async verify({app,window,chat,frame,shot,wait,fill,key,text,click,cases}){
   const name=cases.a.name, composer='.hps-input textarea';
   const send=async message=>{await fill(chat,composer,message);await key(chat,'Enter','Enter',{windowsVirtualKeyCode:13});await wait(()=>chat.evaluate("!!document.querySelector('.hps-btn-stop')"),'B turn started');};
   const finished=()=>wait(()=>chat.evaluate("!document.querySelector('.hps-btn-stop')"),'B turn finished',120000);
   const approve=async(label,kind,decision)=>{
    const modal=window.locator('.monaco-dialog-box').first();
    await wait(async()=>{if(await modal.isVisible())return true;if(!await chat.evaluate("!!document.querySelector('.hps-btn-stop')")){const response=await text(chat,'.hps-messages');record(kind+'-no-approval',{status:'BLOCKED',response});throw Error(kind+' turn ended without an approval dialog');}},kind+' actual approval',90000);
    const body=await modal.innerText();assert.ok(body.includes(name),kind+' approval name');assert.ok(APPROVAL_TITLE_PATTERN.test(body),kind+' observer classification');
    const buttons=await modal.locator('button,.monaco-button').allTextContents();
    await shot('b-'+kind+'-'+decision);
    if(decision==='deny')await modal.getByRole('button',{name:/^(취소|Cancel)$/}).click();
    else await modal.getByRole('button',{name:label,exact:true}).click();
    await finished();
    assert.equal(await chat.evaluate("!!document.querySelector('.hps-error-banner')"),false,'B action completed with a chat error');
    return {name,body,buttons,decision,observer_classification:'coach'};
   };
   try{
    const intro=await text(chat,'.hps-native-observation');assert.ok(intro?.includes(name+'·도구'));
    if(!live){record('B5-intro',{name,actual_service_profile:true});return;}
    if(degraded){
     await send('합성 검수입니다. 도구는 사용하지 말고 현재 이름으로 한 문장만 답하세요.');
     await wait(async()=>{if(await chat.evaluate(`document.body.textContent.includes(${JSON.stringify('지금 '+name+'는 파일 저장·명령 실행 도구 없이')})`))return true;if(!await chat.evaluate("!!document.querySelector('.hps-btn-stop')"))throw Error('SDK-unavailable turn ended without its notice');},'named SDK-unavailable notice',90000);
     await finished();await shot('b-sdk-unavailable');
     assert.ok(gatewayCalls.some(c=>c.path==='/v1/chat/completions'),'fallback did not use actual proxy route');
     assert.ok(!gatewayCalls.some(c=>c.path==='/v1/messages'),'SDK request observed in unavailable fixture');
     record('B4',{name,sdk_unavailable_fixture:true,proxy_route_observed:true,notice:await text(chat,'.hps-messages')});return;
    }
    const file=join(workspace,'flower-shop-hours.txt'),content='가상 꽃집 영업시간: 월–금 오전 10시–오후 6시';assert.equal(existsSync(file),false);
    const request=`가상 꽃집 홈페이지에 쓸 영업시간 안내 원문을 저장해 주세요. Write 도구로 ${file} 한 파일에 ${content} 한 줄만 쓰세요. 다른 파일·셸·브라우저는 사용하지 마세요. 승인이 거절되면 재시도나 다른 방법 없이 멈추고 거절됐다고 알려주세요.`;
    await send(request);const denied=await approve('저장','write','deny');assert.equal(existsSync(file),false);record('B2-deny',{...denied,file_exists:false});
    await send(request+' 이번 요청에서는 저장을 허용할 예정입니다.');const allowed=await approve('저장','write','allow');
    assert.equal(readFileSync(file,'utf8').trim(),content);await shot('b-write-complete');record('B2-allow',{...allowed,file,content:readFileSync(file,'utf8'),write_approval:'explicit test setting; product default is automatic workspace write'});
    await send('가상 꽃집 작업 폴더의 위치를 확인하고 싶어요. Bash 도구로 pwd 명령을 한 번만 실행하세요. 파일 변경·다른 명령·브라우저는 사용하지 마세요.');
    await finished();
    assert.equal(await chat.evaluate("!!document.querySelector('.hps-error-banner')"),false);
    assert.ok((await text(chat,'.hps-messages')).includes('Bash(pwd)'));
    record('B3-pwd',{policy:'evaluateSdkToolUse auto-allows non-destructive shell commands',actual_tool:'Bash(pwd)',named_shell_dialog:'NOT_RUN; this actual SDK path does not call the ordinary shell modal'});
    chat=await frame('.hps-native-observation');await click(chat,'.hps-native-observation > summary');
    await click(chat,'.hps-native-observation > button');
    await wait(()=>chat.evaluate("document.querySelector('.hps-native-observation ol li')!==null"),'actual recorded events');
    const observation=await chat.evaluate("({intro:document.querySelector('.hps-native-observation > p').textContent,events:[...document.querySelectorAll('.hps-native-observation ol li')].map(e=>({kind:e.querySelector('strong').textContent,text:e.querySelector('pre').textContent})),consent:document.querySelector('.hps-native-observation input[type=checkbox]').checked})");
    assert.ok(observation.events.some(e=>e.kind.includes('user')));assert.ok(observation.events.some(e=>e.kind.includes('tool_result')));assert.ok(observation.events.some(e=>e.kind.includes('approval')));assert.equal(observation.consent,false);
    await shot('b-observation');
    await chat.evaluate("[...document.querySelectorAll('.hps-native-observation details')].find(d=>d.querySelector('ol'))?.setAttribute('open','')");await window.waitForTimeout(300);
    await chat.evaluate("document.querySelector('.hps-native-observation ol')?.scrollIntoView({block:'start'})");await window.waitForTimeout(300);await shot('b-observation-records');record('B5',observation);
   }catch(e){failure=e.message;await shot('b-failure').catch(()=>{});throw e;}
   finally{completed=!failure;save();}
  },
 };
}
