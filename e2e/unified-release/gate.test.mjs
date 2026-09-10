import assert from 'node:assert/strict';
import {assertReceipt} from './artifact.mjs';
const sha='a'.repeat(40),digest='b'.repeat(64),version='1.2.3',platform='darwin-arm64';
const assets={'HypeProof-Studio-darwin-arm64.zip':digest};
const result={status:'PASS',real_folder_reload:true,draft_round_trip:true,attachment_round_trip:true,process_restart:true,encrypted_storage:true,shared_root_blocked:true,original_files_preserved:true,live_model:true,model_calls:4};
const good={schema:'hps-unified-acceptance/1',status:'PASS',sourceSha:sha,sourceDirty:false,platform,mode:'candidate-unmodified',app:{sha,version,extensionVersion:version,name:'HypeProof Studio'},publicService:{base:'https://api.hypeproof-ai.xyz/v1',version:'w-test',status:'PASS',activities:['trial','classroom'].map(kind=>({kind,status:'PASS',fileOperations:true}))},treeBefore:digest,treeAfter:digest,assets,activities:['trial','classroom'].map(kind=>({kind,serviceSha:sha,payloadIsolation:true,result:{...result}}))};
assert.equal(assertReceipt(good,{sha,version,platform,assets}),true);
for(const mutate of [r=>delete r.publicService,r=>r.publicService.activities.pop(),r=>r.publicService.base='http://localhost:8787/v1',r=>r.publicService.version='unknown',r=>r.activities[0].result.model_calls=0,r=>r.activities[0].result.model_calls=1.5,r=>r.activities.pop(),r=>r.activities[0].result.status='FAIL',r=>r.activities[1].result.status='BLOCKED',r=>r.sourceSha='c'.repeat(40),r=>r.sourceDirty=true,r=>r.mode='local-injected-rehearsal',r=>r.platform='win32-x64',r=>r.treeAfter='c'.repeat(64),r=>r.assets['HypeProof-Studio-darwin-arm64.zip']='c'.repeat(64),r=>r.activities[0].result.live_model=false,r=>r.activities[1].payloadIsolation=false,r=>r.app.extensionVersion='old',r=>r.activities[0].serviceSha='old']){
 const bad=structuredClone(good);mutate(bad);assert.throws(()=>assertReceipt(bad,{sha,version,platform,assets}));
}
assert.throws(()=>assertReceipt(undefined,{sha,version,platform,assets}));
console.log('PASS release verdict controls: both activities, failed/blocked/missing/stale/injected/OS/byte/version/Service/payload mismatches');
