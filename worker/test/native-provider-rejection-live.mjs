// One real unauthenticated provider request; never reads or changes a real key.
import './harness/loader.mjs';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createMockEnv} from './harness/index.mjs';
const {assessNativeObservation}=await import('../src/lib/native-assessment.ts');
if(process.env.HPS_NATIVE_LIVE!=='1')throw Error('explicit live negative control required');
const env=createMockEnv({env:{ANTHROPIC_API_KEY:'synthetic-invalid-key',ANTHROPIC_PROXY_URL:undefined}});
const batch={format:'hps-observation/1',scope:'negative-control',session:'negative-control',program:'synthetic',events:[]};
let actualStatus=null,requestId=null;
const realFetch=globalThis.fetch;
globalThis.fetch=async(...args)=>{const response=await realFetch(...args);actualStatus=response.status;requestId=response.headers.get('request-id');return response;};
await assert.rejects(assessNativeObservation(env,'studio-native-trial','claude-sonnet-4-6',batch),/assessment_provider_401/);
assert.equal(actualStatus,401);
writeFileSync(process.argv[2],JSON.stringify({status:'PASS',real_provider_status:actualStatus,provider_request_id:requestId,mode:'deliberately invalid synthetic key; no real credential loaded'}));
console.log('PASS real provider 401 is rejected; no findings fabricated');
