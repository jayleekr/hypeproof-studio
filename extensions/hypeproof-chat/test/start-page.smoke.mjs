import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const bundle=await build({entryPoints:[new URL('../src/startPage.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'cjs',external:['vscode'],write:false});
const profile={activity_kind:'trial',profile_id:'adult',display_name:'Adult practice',ux:{coach:{naming_mode:'fixed',fallback_name:'Coach'}},welcome:{},series_index:1,series_total:5};
let releaseFetch, proxyUrl='http://local/v1', fetches=0;
let stored='valid-old', active=false, response='valid', writes=0, starts=0, failPrepare=false, failStore=false, failResolved=false;
const states=[],commands=[];
const ctx={secrets:{get:async()=>stored,store:async(_k,v)=>{if(failStore)throw Error('storage unavailable');stored=v;writes++;},delete:async()=>{stored=undefined;writes++;}},extension:{packageJSON:{version:'test'}},subscriptions:[]};
const chat={openInEditor:async()=>{starts++;},ensureProfile:async()=>failResolved?null:stored?.startsWith('valid')?profile:null,profileFailure:()=>null,invalidateProfile(){},refreshConfig(){},hasActiveStream:()=>active,setConnectionChanging(v){this.changing=v;},coachDisplayName:()=> 'Coach',coachNameIsChosen:()=>true};
const vscode={workspace:{workspaceFolders:[],getConfiguration:()=>({get:()=> proxyUrl})},window:{},commands:{executeCommand:async id=>commands.push(id)}};
const module={exports:{}};
vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require:id=>id==='vscode'?vscode:require(id),console,Buffer,AbortSignal,fetch:async()=>{
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
