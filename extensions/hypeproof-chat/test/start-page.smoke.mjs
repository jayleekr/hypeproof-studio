import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const bundle=await build({entryPoints:[new URL('../src/startPage.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'cjs',external:['vscode'],write:false});
const profile={profile_id:'adult',display_name:'Adult practice',ux:{coach:{naming_mode:'fixed',fallback_name:'Coach'}},welcome:{},series_index:1,series_total:5};
let stored='valid-old', busy=false, response='valid',writes=0;
const states=[];const commands=[];
const ctx={secrets:{get:async()=>stored,store:async(_k,v)=>{stored=v;writes++;},delete:async()=>{stored=undefined;writes++;}},extension:{packageJSON:{version:'test'}},subscriptions:[]};
const chat={ensureProfile:async()=>stored?.startsWith('valid')?profile:null,profileFailure:()=>null,invalidateProfile(){},refreshConfig(){},hasActiveStream:()=>busy,setConnectionChanging(v){this.changing=v;}};
const vscode={workspace:{workspaceFolders:[],getConfiguration:()=>({get:()=> 'http://local/v1'})},window:{},commands:{executeCommand:async id=>commands.push(id)}};
const module={exports:{}};
vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require:id=>id==='vscode'?vscode:require(id),console,Buffer,AbortSignal,fetch:async()=>{
 if(response==='network')throw Error('connection refused');
 if(response==='invalid')return new Response(JSON.stringify({error:{code:'signature'}}),{status:401});
 if(response==='forbidden')return new Response(JSON.stringify({error:{code:'not_in_roster'}}),{status:403});
 return new Response(JSON.stringify(response==='malformed'?{}:profile),{status:200});
}});
const page=new module.exports.StartPage(ctx,chat,async()=>false);page.panel={webview:{postMessage:async msg=>states.push(msg)}};
for(const failure of ['invalid','forbidden','network','malformed']){
 response=failure;await page.handle({type:'connectCourse',token:'candidate-test-code'});assert.equal(stored,'valid-old');assert.equal(writes,0);assert.ok(states.at(-1).state.error,failure);assert.equal(chat.changing,false);
}
busy=true;response='valid';await page.handle({type:'connectCourse',token:'valid-new'});assert.equal(writes,0);busy=false;
await page.handle({type:'connectCourse',token:'valid-new'});assert.equal(stored,'valid-new');assert.equal(writes,1);assert.ok(states.at(-1).state.profile);assert.equal(states.at(-1).state.error,undefined);
assert.ok(!JSON.stringify(states).includes('valid-new'),'credential must never be returned to webview');
console.log('PASS start-page host: 401/403/network/malformed preserve prior token; active chat blocks switch; valid token stored without echo');

await page.handle({type:"disconnectCourse"});assert.equal(stored,undefined);assert.equal(states.at(-1).state.profile,undefined);assert.equal(chat.changing,false);

await page.handle({type:"openStudioFiles"});await page.handle({type:"openStudioSettings"});assert.deepEqual(commands,["workbench.view.explorer","workbench.action.openSettings"]);
