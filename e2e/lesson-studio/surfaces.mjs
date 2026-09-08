// Feature B runs inside the existing native lesson acceptance. No host events
// or approval results are injected. File-write approval is explicitly enabled
// in this isolated test user's settings; it is not the product default.
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {APPROVAL_TITLE_PATTERN} from '../../extensions/hypeproof-chat/src/coachIdentity.ts';

export function surfaceAcceptance({out,workspace,live,degraded,gatewayCalls}){
 const checks=[];let failure;
 const save=()=>writeFileSync(join(out,'surfaces-result.json'),JSON.stringify({scope:'actual Mac app + local Service; synthetic lesson and workspace',checks,status:failure?'FAIL':'IN_PROGRESS',error:failure,visual_review:'PENDING separate image inspection',not_run:['all eight approval kinds','Windows','screen reader','historical identity','human learning']},null,2));
 const record=(id,detail)=>{checks.push({id,status:'PASS',...detail});save();};
 return {
  async connected({entry,name,key,shot,wait}){
   await wait(()=>entry.evaluate(`document.querySelector('.studio-connect')?.textContent.includes(${JSON.stringify(name)})`),'start page resolved name');
   const state=await entry.evaluate(`({course:document.querySelector('.studio-course')?.textContent,process:document.querySelector('.studio-process')?.textContent,description:document.querySelector('.studio-connect')?.textContent,width:innerWidth,document_width:document.documentElement.scrollWidth,credential_field:!!document.querySelector('#course-code')})`);
   assert.equal(state.credential_field,false);
   assert.ok(state.course.includes('AI 이름'));assert.ok(state.course.includes(name));assert.ok(state.process.includes(name));
   assert.ok(!state.process.includes('코치와 작은 시도부터')||name==='코치');
   if(['first','b','html','long','legacy'].includes(key))await shot('b-start-'+key);
   record('B1-'+key,{name,...state});
  },
  async verify({app,window,chat,frame,shot,wait,fill,key,text,click,cases}){
   const name=cases.a.name, composer='.hps-input textarea';
   const send=async message=>{await fill(chat,composer,message);await key(chat,'Enter','Enter',{windowsVirtualKeyCode:13});await wait(()=>chat.evaluate("!!document.querySelector('.hps-btn-stop')"),'B turn started');};
   const finished=()=>wait(()=>chat.evaluate("!document.querySelector('.hps-btn-stop')"),'B turn finished',120000);
   const approve=async(label,kind,decision)=>{
    const modal=window.locator('.monaco-dialog-box').first();await modal.waitFor({state:'visible',timeout:90000});
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
     await wait(()=>chat.evaluate(`document.body.textContent.includes(${JSON.stringify('지금 '+name+'는 파일 저장·명령 실행 도구 없이')})`),'named SDK-unavailable notice',90000);
     await finished();await shot('b-sdk-unavailable');
     assert.ok(gatewayCalls.some(c=>c.path==='/v1/chat/completions'),'fallback did not use actual proxy route');
     assert.ok(!gatewayCalls.some(c=>c.path==='/v1/messages'),'SDK request observed in unavailable fixture');
     record('B4',{name,sdk_unavailable_fixture:true,proxy_route_observed:true,notice:await text(chat,'.hps-messages')});return;
    }
    const file=join(workspace,'b-identity-proof.txt'),content='SYNTHETIC-B-IDENTITY';assert.equal(existsSync(file),false);
    const request=`합성 파일 승인 검수입니다. Write 도구로 ${file} 한 파일에 ${content} 한 줄만 쓰세요. 다른 파일·셸·브라우저는 사용하지 마세요. 승인이 거절되면 재시도나 다른 방법 없이 멈추고 거절됐다고 알려주세요.`;
    await send(request);const denied=await approve('저장','write','deny');assert.equal(existsSync(file),false);record('B2-deny',{...denied,file_exists:false});
    await send(request+' 이번 요청에서는 저장을 허용할 예정입니다.');const allowed=await approve('저장','write','allow');
    assert.equal(readFileSync(file,'utf8').trim(),content);await shot('b-write-complete');record('B2-allow',{...allowed,file,content:readFileSync(file,'utf8'),write_approval:'explicit test setting; product default is automatic workspace write'});
    await send('합성 셸 승인 검수입니다. Bash 도구로 pwd 명령을 한 번만 실행하세요. 파일 변경·다른 명령·브라우저는 사용하지 마세요.');
    record('B3-shell',await approve('실행','shell','allow'));
    chat=await frame('.hps-native-observation');await click(chat,'.hps-native-observation > summary');
    await click(chat,'.hps-native-observation > button');
    await wait(()=>chat.evaluate("document.querySelector('.hps-native-observation ol li')!==null"),'actual recorded events');
    const observation=await chat.evaluate("({intro:document.querySelector('.hps-native-observation > p').textContent,events:[...document.querySelectorAll('.hps-native-observation ol li')].map(e=>({kind:e.querySelector('strong').textContent,text:e.querySelector('pre').textContent})),consent:document.querySelector('.hps-native-observation input[type=checkbox]').checked})");
    assert.ok(observation.events.some(e=>e.kind.includes('user')));assert.ok(observation.events.some(e=>e.kind.includes('tool_result')));assert.ok(observation.events.some(e=>e.kind.includes('approval')));assert.equal(observation.consent,false);
    await chat.evaluate("document.querySelectorAll('.hps-native-observation details').forEach(d=>d.open=true)");await shot('b-observation');record('B5',observation);
   }catch(e){failure=e.message;await shot('b-failure').catch(()=>{});throw e;}
   finally{save();}
  },
 };
}
