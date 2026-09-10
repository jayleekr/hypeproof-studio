#!/usr/bin/env node
// Drive the packaged App; never build, inject, re-sign or seed credentials in it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {appIdentity,treeHash,sha256,assertReceipt} from './artifact.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [appDirectory,assetDirectory,outputDirectory,sourceSha,version,publicAppSha]=process.argv.slice(2);
const serviceOnly=!!publicAppSha;
const platform=process.platform==='darwin'?'darwin-arm64':process.platform==='win32'?'win32-x64':null;
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const command=(exe,args,options={})=>new Promise((resolve,reject)=>{
 const child=spawn(exe,args,{cwd:root,stdio:'inherit',...options});
 child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Acceptance process failed: '+code)));
});
let temporary,gateway,log;
try{
 if(!platform||!appDirectory||!assetDirectory||!outputDirectory||!sourceSha||!version)throw Error('Usage: run.mjs APP ASSETS OUTPUT SOURCE_SHA VERSION (Mac/Windows only)');
 if(!process.env.ANTHROPIC_API_KEY)throw Error('BLOCKED: acceptance model credential missing; no skipped PASS');
 if(git('rev-parse','HEAD')!==sourceSha||git('status','--porcelain','--untracked-files=no'))throw Error('Acceptance requires clean pinned source');
 for(const flag of ['HPS_NATIVE_ISOLATED_KEYCHAIN','HPS_CODEX_REHEARSAL','HPS_MODEL_REHEARSAL'])if(process.env[flag])throw Error('Incompatible acceptance override: '+flag);
 const app=appIdentity(appDirectory),before=treeHash(appDirectory);
 if(app.sha!==(publicAppSha??sourceSha)||app.version!==version||app.extensionVersion!==version||app.name!=='HypeProof Studio')throw Error('Candidate identity mismatch');
 const assets=Object.fromEntries(fs.readdirSync(assetDirectory).filter(n=>/\.(zip|exe)$/.test(n)).map(n=>[n,sha256(path.join(assetDirectory,n))]));
 fs.mkdirSync(outputDirectory,{recursive:true});
 temporary=fs.mkdtempSync(path.join(os.tmpdir(),'hps-unified-acceptance-'));
 const activities=[];
 for(const kind of ['trial','classroom']){
  const evidence=path.resolve(outputDirectory,kind);fs.mkdirSync(evidence,{recursive:true});
  const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const token=path.join(temporary,kind+'-token');
  const env={...process.env,HPS_APP_PATH:path.resolve(appDirectory),HPS_E2E_TOKEN_FILE:token,HPS_E2E_PROXY_URL:`http://127.0.0.1:${port}/v1`,HPS_NATIVE_PORT:String(port),HPS_NATIVE_EVIDENCE_DIR:evidence,HPS_UNIFIED_SWITCH:serviceOnly?'0':'1',HPS_SERVICE_ACCEPTANCE:serviceOnly?'1':'0',HPS_UNIFIED_LIVE:'1',HPS_NATIVE_LIVE:'1',HPS_NATIVE_MANAGED:kind==='trial'?'1':'0',HPS_TEST_REAL_WORKSPACE:'1',HPS_QUIET:'1',HPS_QUIET_NO_HIDE:'1'};
  log=fs.openSync(path.join(temporary,kind+'-gateway.log'),'w',0o600);
  gateway=spawn(process.execPath,['--experimental-strip-types','worker/test/native-trial-live-server.mjs'],{cwd:root,env,stdio:['ignore',log,log]});
  let launchError;gateway.on('error',error=>{launchError=error;});
  let ready=false;
  for(let attempt=0;attempt<60;attempt++){
   if(launchError||gateway.exitCode!==null)break;
   try{ready=(await fetch(env.HPS_E2E_PROXY_URL+'/health',{signal:AbortSignal.timeout(500)})).ok;}catch{}
   if(ready)break;await new Promise(resolve=>setTimeout(resolve,500));
  }
  if(!ready)throw Error('BLOCKED: synthetic gateway failed to start');
  // Do not pass provider keys to Electron. Only the synthetic gateway has them.
  const appEnv={...env};for(const name of Object.keys(appEnv))if(/API_KEY|ADMIN_PASSWORD|TOKEN$/.test(name))delete appEnv[name];
  await command(process.execPath,['node_modules/@playwright/test/cli.js','test','--config=native-trial.config.ts','--workers=1','--retries=0'],{cwd:path.join(root,'e2e'),env:appEnv});
  const result=JSON.parse(fs.readFileSync(path.join(evidence,serviceOnly?'result.json':'unified-switch.json'),'utf8'));
  if(serviceOnly){
   const calls=JSON.parse(fs.readFileSync(path.join(evidence,'api-evidence.json'),'utf8')).calls;
   if(result.status!=='PASS'||!result.initial_file_created||!result.revised_file_created||!result.original_preserved||!calls.length||calls.length>8||calls.some(c=>c.status!==200))throw Error('Service compatibility acceptance failed');
   activities.push({kind,serviceSha:sourceSha,result,modelCalls:calls.length});
  }else{
   const turns=JSON.parse(fs.readFileSync(path.join(evidence,'unified-live-turns.json'),'utf8'));
   activities.push({kind,serviceSha:sourceSha,payloadIsolation:turns.payload_isolation===true,result});
  }
  const stopped=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await stopped;gateway=null;fs.closeSync(log);log=undefined;
 }
 const receipt={schema:'hps-unified-acceptance/1',status:'PASS',sourceSha,sourceDirty:false,platform,mode:'candidate-unmodified',app,assets,treeBefore:before,treeAfter:treeHash(appDirectory),activities};
 if(platform==='win32-x64'&&!serviceOnly){
  const installers=JSON.parse(fs.readFileSync(path.join(assetDirectory,'installer-verification.json'),'utf8'));
  receipt.installerPayloadsVerified=installers.portableTree===before&&Object.entries(assets).filter(([n])=>/Setup.*\.exe$/.test(n)).every(([n,digest])=>installers.installers?.some(row=>row.name===n&&row.sha256===digest&&row.payloadMatches===true));
 }
 if(serviceOnly){
  if(before!==receipt.treeAfter)throw Error('Public App modified');
  receipt.schema='hps-service-compatibility/1';receipt.mode='public-app-unmodified';
 }else assertReceipt(receipt,{sha:sourceSha,version,platform,assets,requirePublic:false});
 fs.writeFileSync(path.join(outputDirectory,'receipt.json'),JSON.stringify(receipt,null,2));
 console.log('PASS untouched candidate: both activities; '+platform);
}catch(error){console.error(error.message);process.exitCode=1;}
finally{
 if(gateway){const stopped=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await Promise.race([stopped,new Promise(resolve=>setTimeout(resolve,3000))]);}
 if(log!==undefined)fs.closeSync(log);
 if(temporary){fs.rmSync(temporary,{recursive:true,force:true});}
}
