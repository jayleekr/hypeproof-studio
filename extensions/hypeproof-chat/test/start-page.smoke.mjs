import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
// #960 — startPage 와 activityConnections 를 **한 번들로** 묶는다. 따로 묶으면 등록용
// WeakMap 이 두 벌이 되어 `activityConnections(ctx)` 가 영원히 undefined 를 돌려주고,
// selectActivity 의 성공 경로가 '저장된 활동을 찾지 못했습니다' 로만 재게 된다.
const bundle=await build({stdin:{contents:"export * from './src/startPage.ts';export * from './src/activityConnections.ts';",resolveDir:new URL('..',import.meta.url).pathname,loader:'ts'},bundle:true,platform:'node',format:'cjs',external:['vscode'],write:false});
const profile={activity_kind:'trial',profile_id:'adult',display_name:'Adult practice',ux:{coach:{naming_mode:'fixed',fallback_name:'Coach'}},welcome:{},series_index:1,series_total:5};
let releaseFetch, proxyUrl='http://local/v1', fetches=0;
let stored='valid-old', active=false, response='valid', writes=0, starts=0, failPrepare=false, failStore=false, failResolved=false;
const states=[],commands=[];
const history=new Map();
const ctx={workspaceState:{keys:()=>[...history.keys()],get:(k,d)=>history.has(k)?history.get(k):d,update:async(k,v)=>{history.set(k,v);}},secrets:{get:async()=>stored,store:async(_k,v)=>{if(failStore)throw Error('storage unavailable');stored=v;writes++;},delete:async()=>{stored=undefined;writes++;}},extension:{packageJSON:{version:'test'}},subscriptions:[]};
const chat={openInEditor:async()=>{starts++;},ensureProfile:async()=>failResolved?null:stored?.startsWith('valid')?profile:null,profileFailure:()=>null,invalidateProfile(){},refreshConfig(){},hasActiveStream:()=>active,setConnectionChanging(v){this.changing=v;},coachDisplayName:()=> 'Coach',coachNameIsChosen:()=>true};
const vscode={workspace:{workspaceFolders:[],getConfiguration:()=>({get:()=> proxyUrl})},window:{},commands:{executeCommand:async id=>commands.push(id)}};
const module={exports:{}};
vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require:id=>id==='vscode'?vscode:require(id),console,Buffer,AbortSignal,URL,process,TextEncoder,fetch:async()=>{
 fetches++;
 if(response==='waiting')await new Promise(resolve=>releaseFetch=resolve);
 if(response==='network')throw Error('connection refused');
 if(response==='invalid')return new Response(JSON.stringify({error:{code:'signature'}}),{status:401});
 if(response==='forbidden')return new Response(JSON.stringify({error:{code:'not_in_roster'}}),{status:403});
 return new Response(JSON.stringify(response==='malformed'?{}:profile),{status:200});
}});
const page=new module.exports.StartPage(ctx,chat,async(_profile,commit)=>{if(failPrepare)throw Error('folder unavailable');await commit();return false;});
const attach=()=>page.panel={webview:{postMessage:async msg=>states.push(msg)}};
attach();
for(const failure of ['invalid','forbidden','network','malformed']){
 response=failure;await page.handle({type:'connectCourse',token:'candidate-test-code'});assert.equal(stored,'valid-old');assert.equal(writes,0);assert.ok(states.at(-1).state.error,failure);assert.equal(chat.changing,false);
}
active=true;response='valid';await page.handle({type:'connectCourse',token:'valid-new'});assert.equal(writes,0);assert.equal(page.candidate,undefined);active=false;
await page.handle({type:'connectCourse',token:'valid-new'});
assert.equal(stored,'valid-old');assert.equal(writes,0,'code preview never replaces active credential');
assert.equal(states.at(-1).state.candidate,true);assert.equal(states.at(-1).state.profile.kind,'trial');
assert.ok(!JSON.stringify(states).includes('valid-new'),'credential never returned to UI');
await page.handle({type:'cancelCandidate'});assert.equal(stored,'valid-old');assert.equal(states.at(-1).state.candidate,false);
await page.handle({type:'connectCourse',token:'valid-new'});failPrepare=true;
await page.handle({type:'beginCourse'});assert.equal(stored,'valid-old');assert.equal(writes,0);assert.equal(starts,0);assert.match(states.at(-1).state.error,/열지 못/);assert.equal(chat.changing,false);
failPrepare=false;failStore=true;
await page.handle({type:'beginCourse'});assert.equal(stored,'valid-old');assert.equal(starts,0);assert.equal(chat.changing,false);
failStore=false;failResolved=true;
await page.handle({type:'beginCourse'});assert.equal(stored,'valid-old','post-store revalidation failure restores original credential');assert.equal(starts,0);assert.equal(chat.changing,false);
failResolved=false;response='invalid';
await page.handle({type:'beginCourse'});assert.equal(stored,'valid-old');assert.equal(starts,0,'expired preview cannot start');
response='valid';await page.handle({type:'beginCourse'});assert.equal(stored,'valid-new');assert.equal(starts,1);assert.equal(page.panel,undefined);assert.equal(page.candidate,undefined);assert.equal(page.started,true);
attach();await page.handle({type:'disconnectCourse'});assert.equal(stored,undefined);assert.equal(states.at(-1).state.profile,undefined);
await page.handle({type:'openStudioFiles'});await page.handle({type:'openStudioSettings'});assert.deepEqual(commands,['workbench.view.explorer','workbench.action.openSettings']);
console.log('PASS host candidate transaction: 401/403/network/malformed, active-stream exclusion, preview/cancel, workspace/storage/revalidation rollback, committed entry, disconnect and navigation');

response='waiting';stored='valid-old';const pending=page.handle({type:'connectCourse',token:'valid-first'});
while(!releaseFetch)await new Promise(r=>setTimeout(r,0));
await page.handle({type:'connectCourse',token:'valid-second'});response='valid';releaseFetch();await pending;
assert.equal(page.candidate.token,'valid-first','duplicate choice cannot overtake pending validation');
assert.equal(stored,'valid-old');assert.equal(chat.changing,false);
console.log('PASS candidate duplicate control: pending validation cannot be overtaken');

const previousFetches=fetches;proxyUrl='https://other.invalid/v1';await page.handle({type:'beginCourse'});
assert.equal(fetches,previousFetches,'candidate credential never forwarded to a different Service');
assert.equal(stored,'valid-old');assert.equal(chat.changing,false);
console.log('PASS candidate origin change rejected before credential forwarding');

proxyUrl='http://local/v1';response='waiting';releaseFetch=undefined;
const closing=page.handle({type:'beginCourse'});
while(!releaseFetch)await new Promise(r=>setTimeout(r,0));
page.panel=undefined;page.candidate=undefined;response='valid';releaseFetch();await closing;
assert.equal(stored,'valid-old','closing the entry before preparation completes must not commit');
assert.equal(page.candidate,undefined);
assert.equal(chat.changing,false);
console.log('PASS closed entry cancels pending activation');

// ─────────────────────────────────────────────────────────────────────────────
// #960 — #969 가 더한 세 진입 메시지의 성공·실패·경계.
//
// 왜 여기냐: change-impact 리뷰(#960)에서 `chooseActivityFolder` ·
// `selectActivity` · `exportLegacyHistory` 에 단언이 **한 줄도** 없다는 것이
// 드러났다. 위의 후보 트랜잭션 검사는 촘촘하지만 그 셋 중 어디도 지나가지 않는다.
// 세 메시지 모두 자격증명·작업 폴더를 건드리므로 "화면에 버튼이 생겼다" 가 아니라
// **무엇이 저장되고 무엇이 안 되는지**로 잠근다.
// ─────────────────────────────────────────────────────────────────────────────

let saveTarget, saveCalls=0, writeFails=false, written;
let folderChoice, folderDialogs=0;
vscode.window.showSaveDialog=async()=>{saveCalls++;return saveTarget;};
vscode.window.showOpenDialog=async()=>{folderDialogs++;return folderChoice;};
vscode.workspace.fs={writeFile:async(_uri,bytes)=>{if(writeFails)throw Error('disk full');written=Buffer.from(bytes).toString('utf8');}};

attach();
// 위 절들이 남긴 오류 문구를 지우고 시작한다 — 안 지우면 아래의 "정상 경로에는
// 오류가 없다" 단언이 남의 실패를 읽는다(처음 이 절을 붙였을 때 실제로 그랬다).
page.error=undefined;

// ─── exportLegacyHistory ────────────────────────────────────────────────────
// 활동별 기록(키 끝이 64자리 hex)은 **내보내지 않는다** — 그건 이미 활동에 묶여
// 있고, 여기 섞이면 "이전 기록" 이라는 이름으로 현재 활동의 대화가 파일로 나간다.
history.set('hypeproofChat.history',[{role:'user',content:'legacy plain'}]);
history.set('hypeproofChat.history:trial',[{role:'user',content:'legacy scoped'}]);
history.set('hypeproofChat.history:'+'a'.repeat(64),[{role:'user',content:'current activity'}]);
history.set('hypeproofChat.coachName','not history');
{
  // 버튼 노출 판정과 내보내기 판정은 **같은 술어**여야 한다. 두 벌이던 동안
  // 한쪽만 바꿔도 양쪽이 다 통과했다(#960 에서 변이 대조군이 드러냈다).
  await page.handle({type:'startReady'});
  assert.equal(states.at(-1).state.legacyHistory,true,'이전 기록이 있는데 내보내기 버튼이 숨는다');
  const onlyScoped=new Map(history);history.clear();
  history.set('hypeproofChat.history:'+'c'.repeat(64),[{role:'user',content:'activity only'}]);
  await page.handle({type:'startReady'});
  assert.equal(states.at(-1).state.legacyHistory,false,'활동별 기록만 있는데 "이전 기록" 버튼이 뜬다');
  history.clear();for(const [k,v] of onlyScoped) history.set(k,v);
}
{
  saveTarget={fsPath:'/tmp/hps-export.json'};written=undefined;
  await page.handle({type:'exportLegacyHistory'});
  assert.equal(saveCalls,1);
  const backup=JSON.parse(written);
  assert.equal(backup.format,'hps-local-history-export/1');
  const sources=backup.records.map(r=>r.source).sort();
  assert.deepEqual(sources,['hypeproofChat.history','hypeproofChat.history:trial'],
    '활동별 기록이나 기록이 아닌 키가 내보내기에 섞였다');
  assert.ok(!written.includes('current activity'),'현재 활동 대화가 이전 기록으로 나갔다');
  assert.equal(backup.records.find(r=>r.source==='hypeproofChat.history').messages[0].content,'legacy plain');
  assert.ok(!states.at(-1).state.error,'정상 내보내기에 오류가 남았다');
}
{
  // 취소는 아무 일도 일어나지 않는 것이어야 한다 — 빈 파일도, 오류도 아니다.
  saveTarget=undefined;written=undefined;const before=saveCalls;
  await page.handle({type:'exportLegacyHistory'});
  assert.equal(saveCalls,before+1);assert.equal(written,undefined,'취소했는데 파일을 썼다');
  assert.ok(!states.at(-1).state.error,'취소가 오류로 보고됐다');
}
{
  // 저장 실패는 **말해야** 한다. 조용히 끝나면 아이는 파일이 생긴 줄 안다.
  saveTarget={fsPath:'/tmp/hps-export.json'};writeFails=true;
  await page.handle({type:'exportLegacyHistory'});
  assert.match(states.at(-1).state.error,/저장하지 못했습니다/);
  writeFails=false;page.error=undefined;
}
{
  // 경계: 내보내기는 진행 중인 턴에도 막히지 않는다(읽기만 한다). 이 줄이 없으면
  // 나중에 누가 활동 변경 가드 아래로 옮겨도 아무도 모른다.
  active=true;saveTarget={fsPath:'/tmp/hps-export.json'};written=undefined;
  await page.handle({type:'exportLegacyHistory'});
  assert.ok(written,'진행 중인 턴이 기록 내보내기를 막았다');
  active=false;
}
console.log('PASS legacy history export: activity-scoped records excluded, cancel writes nothing, failure surfaces, not blocked by an active turn');

// ─── chooseActivityFolder ───────────────────────────────────────────────────
{
  // 후보가 없으면 대화상자를 **열지도 않는다**.
  page.candidate=undefined;const before=folderDialogs;
  await page.handle({type:'chooseActivityFolder'});
  assert.equal(folderDialogs,before,'후보가 없는데 폴더 선택 대화상자를 열었다');
}
response='valid';proxyUrl='http://local/v1';stored='valid-old';
await page.handle({type:'connectCourse',token:'valid-new'});
assert.equal(page.candidate.workspace,undefined,'전제 확인: 후보는 폴더 없이 시작한다');
{
  // 취소하면 후보의 폴더는 그대로다.
  folderChoice=undefined;const writesBefore=writes;
  await page.handle({type:'chooseActivityFolder'});
  assert.equal(page.candidate.workspace,undefined,'취소했는데 폴더가 바뀌었다');
  assert.equal(writes,writesBefore,'폴더 선택이 자격증명을 건드렸다');
}
{
  // 선택하면 후보와 화면에 **같은 값**이 반영된다 — 한쪽만 바뀌면 아이가 보는
  // 폴더와 실제로 열릴 폴더가 갈린다.
  folderChoice=[{fsPath:'/tmp/hps-chosen'}];const writesBefore=writes;
  await page.handle({type:'chooseActivityFolder'});
  assert.equal(page.candidate.workspace,'/tmp/hps-chosen');
  assert.equal(page.candidate.profile.workspace_root,'/tmp/hps-chosen');
  assert.equal(states.at(-1).state.profile.workspace,'/tmp/hps-chosen','화면이 선택한 폴더를 보여주지 않는다');
  assert.equal(writes,writesBefore,'폴더 선택이 자격증명을 저장했다');
  assert.equal(states.at(-1).state.candidate,true,'폴더 선택이 후보 상태를 끝냈다');
}
{
  // 진행 중인 턴에서는 거절한다 — 폴더가 바뀌면 그 턴이 쓰던 경로가 사라진다.
  active=true;const before=folderDialogs;
  await page.handle({type:'chooseActivityFolder'});
  assert.equal(folderDialogs,before,'진행 중인 턴에서 폴더 선택 대화상자가 열렸다');
  assert.match(states.at(-1).state.error,/진행 중인 작업/);
  active=false;page.error=undefined;
}
console.log('PASS activity folder choice: no candidate opens no dialog, cancel keeps the folder, choice reaches both candidate state and UI, active turn refuses');

// ─── selectActivity ─────────────────────────────────────────────────────────
{
  // 저장소가 없는 창에서는 조용히 실패하지 않고 이유를 남긴다.
  page.candidate=undefined;const writesBefore=writes;
  await page.handle({type:'selectActivity',ref:'hps.activity.credential.missing'});
  assert.match(states.at(-1).state.error,/저장된 활동을 찾지 못했습니다/);
  assert.equal(page.candidate,undefined);assert.equal(writes,writesBefore);
  page.error=undefined;
}
{
  const {ActivityConnections}=module.exports;
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hps-start-page-'));
  const root=path.join(tmp,'work');fs.mkdirSync(root);
  const saved={...profile,activity_id:'b'.repeat(64),display_name:'Saved activity'};
  const vault=new Map();
  const raw={globalStorageUri:{fsPath:path.join(tmp,'storage')},extension:{packageJSON:{version:'test'}},
    workspaceState:{keys:()=>[],get:(_k,d)=>d,update:async()=>{}},
    secrets:{keys:async()=>[...vault.keys()],get:async k=>vault.get(k),store:async(k,v)=>{vault.set(k,v);},
      delete:async k=>{vault.delete(k);},onDidChange:()=>({dispose(){}})}};
  const store=new ActivityConnections(raw,()=>proxyUrl,()=>root,async()=>saved);
  await store.commit('saved-token',saved,root);
  const ref=store.current.ref;
  const saw=[];
  const scoped=store.wrap();
  const page2=new module.exports.StartPage(scoped,chat,async(_p,commit)=>{await commit();return false;});
  page2.panel={webview:{postMessage:async msg=>saw.push(msg)}};

  await page2.handle({type:'selectActivity',ref});
  assert.equal(page2.candidate.token,'saved-token','저장된 활동의 자격증명을 쓰지 않았다');
  assert.equal(page2.candidate.workspace,fs.realpathSync(root),'저장된 활동의 작업 폴더를 따르지 않았다');
  assert.equal(page2.candidate.profile.workspace_root,fs.realpathSync(root));
  assert.equal(saw.at(-1).state.candidate,true);
  // 자격증명은 화면으로 **절대** 돌아가지 않는다 (위 후보 검사와 같은 규칙).
  assert.ok(!JSON.stringify(saw).includes('saved-token'),'저장된 활동의 토큰이 UI 로 나갔다');

  // 없는 ref 는 이유를 남긴다. 문구가 위(저장소 자체가 없는 창)와 **다르다**:
  // 저장소가 있는 창에서 못 찾은 것은 읽기 계층이 "현재 서버의 저장된 활동이
  // 아니다" 로 판정한다. 둘을 같은 문구로 접으면 "이 창에 저장소가 없다" 와
  // "그 항목이 사라졌다" 가 구별되지 않는다.
  await page2.handle({type:'selectActivity',ref:'hps.activity.credential.'+'0'.repeat(8)});
  assert.match(saw.at(-1).state.error,/현재 서버의 저장된 활동이 아닙니다/);

  // 다른 Service 로 옮겨 간 창에서는 저장된 활동을 열지 않는다 — 자격증명이
  // 다른 서버로 나가는 경로가 여기서도 막혀야 한다.
  const previousUrl=proxyUrl;proxyUrl='https://other.invalid/v1';page2.error=undefined;
  const fetchesBefore=fetches;
  await page2.handle({type:'selectActivity',ref});
  assert.equal(fetches,fetchesBefore,'다른 Service 로 저장된 자격증명을 보냈다');
  assert.ok(saw.at(-1).state.error,'다른 Service 의 저장된 활동이 조용히 열렸다');
  proxyUrl=previousUrl;

  fs.rmSync(tmp,{recursive:true,force:true});
}
console.log('PASS saved activity selection: record drives token/workspace, credential never reaches the UI, unknown ref and foreign Service refuse before forwarding');
