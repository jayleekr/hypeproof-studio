#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {appIdentity,treeHash} from './artifact.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [app,output,sha,version]=process.argv.slice(2);
const base='https://api.hypeproof-ai.xyz/v1';
let temp;
try{
 const identity=appIdentity(app),before=treeHash(app);
 if(identity.sha!==sha||identity.version!==version)throw Error('Wrong candidate identity');
 const health=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)});
 if(!health.ok)throw Error('Public Service health failed');
 const initial=await health.json();
 if(!initial.version||initial.version==='unknown')throw Error('Unidentified public Service');
 temp=fs.mkdtempSync(path.join(os.tmpdir(),'hps-public-acceptance-'));
 const activities=[];
 for(const kind of ['trial','classroom']){
  const credential=process.env[kind==='trial'?'HPS_ACCEPTANCE_TRIAL_CODE':'HPS_ACCEPTANCE_CLASSROOM_CODE'];
  if(!credential)throw Error('BLOCKED: approved synthetic '+kind+' public code missing');
  const response=await fetch(base+'/profile',{headers:{authorization:'Bearer '+credential},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error(kind+' public profile rejected: '+response.status);
  const profile=await response.json();
  if(profile.activity_kind!==kind||!profile.activity_id)throw Error('Wrong activity kind or public Service predates activity binding');
  const evidence=path.resolve(output,kind);fs.mkdirSync(evidence,{recursive:true});
  const token=path.join(temp,kind);fs.writeFileSync(token,credential,{mode:0o600});
  const env={...process.env,HPS_APP_PATH:path.resolve(app),HPS_E2E_TOKEN_FILE:token,HPS_E2E_PROXY_URL:base,HPS_PUBLIC_ACTIVITY:'1',HPS_NATIVE_MANAGED:kind==='trial'?'1':'0',HPS_NATIVE_EVIDENCE_DIR:evidence,HPS_QUIET_NO_HIDE:'1'};
  for(const name of Object.keys(env))if(/API_KEY|ADMIN_PASSWORD|TOKEN$|_CODE$/.test(name))delete env[name];
  await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,['node_modules/@playwright/test/cli.js','test','--config=native-trial.config.ts','--workers=1','--retries=0'],{cwd:path.join(root,'e2e'),env,stdio:'inherit'});
   child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(kind+' public App check failed')));
  });
  const result=JSON.parse(fs.readFileSync(path.join(evidence,'public-activity.json'),'utf8'));
  if(result.status!=='PASS'||!result.created||!result.revised||!result.originalPreserved)throw Error('Incomplete public acceptance');
  activities.push({kind,status:'PASS',fileOperations:true,profileId:profile.profile_id});
 }
 const after=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)});
 if(!after.ok||(await after.json()).version!==initial.version||treeHash(app)!==before)throw Error('Service or App changed during acceptance');
 const receiptPath=path.join(output,'../receipt.json'),receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
 receipt.publicService={base,version:initial.version,status:'PASS',activities};
 fs.writeFileSync(receiptPath,JSON.stringify(receipt,null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
finally{if(temp)fs.rmSync(temp,{recursive:true,force:true});}
