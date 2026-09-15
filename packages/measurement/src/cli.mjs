#!/usr/bin/env node
import { SessionSync, projectId, hash } from './sync.mjs';
import { homedir } from 'node:os';
import { resolve,dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir,writeFile,unlink,readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const args=process.argv.slice(2),command=args.shift()||'help';
const options={};
for(let i=0;i<args.length;i++){if(!args[i].startsWith('--'))throw Error('unexpected_argument');const k=args[i].slice(2);const v=args[i+1]?.startsWith('--')||args[i+1]===undefined?true:args[++i];(options[k]??=[]).push(v);}
const one=(key,fallback)=>options[key]?.at(-1)??fallback;
const root=resolve(one('state',join(homedir(),'.hypeproof','measurement')));
const sync=new SessionSync({root});
const print=x=>process.stdout.write(JSON.stringify(x,null,2)+'\n');
const xml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const label='xyz.hypeproof.measurement.'+hash(root).slice(0,12);
const plist=join(homedir(),'Library','LaunchAgents',label+'.plist');
const domain='gui/'+process.getuid?.();
async function service(remove=false){
 if(process.platform!=='darwin')throw Error('service_install_requires_macos_use_watch');
 if(remove){try{execFileSync('launchctl',['bootout',domain+'/'+label],{stdio:'pipe'});}catch{}await unlink(plist).catch(e=>{if(e.code!=='ENOENT')throw e;});return;}
 const status=await sync.status();if(!status.configured||!status.enabled)throw Error('connect_first');
 await mkdir(dirname(plist),{recursive:true});await mkdir(root,{recursive:true,mode:0o700});
 const argv=[process.execPath,fileURLToPath(import.meta.url),'watch','--state',root];
 const body=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${argv.map(x=>'<string>'+xml(x)+'</string>').join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key><string>${xml(join(root,'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(root,'service-error.log'))}</string></dict></plist>`;
 await writeFile(plist,body,{mode:0o600});
 try{execFileSync('launchctl',['bootout',domain+'/'+label],{stdio:'pipe'});}catch{}
 execFileSync('launchctl',['bootstrap',domain,plist],{stdio:'pipe'});
 execFileSync('launchctl',['kickstart',domain+'/'+label],{stdio:'pipe'});
}
try{
 if(command==='projects'){
  print(await Promise.all((options.project||[process.cwd()]).map(async path=>({path:resolve(path),id:await projectId(path)}))));
 }else if(command==='connect'){
  if(!one('token-stdin'))throw Error('use_token_stdin');let token='';for await(const chunk of process.stdin){token+=chunk;if(token.length>1024)throw Error('invalid_connection_token');}
  print(await sync.connect({server:one('server','https://hypeproof-ai.xyz'),token:token.trim(),projects:options.project||[process.cwd()]}));
 }else if(command==='sync'){const result=await sync.tick();print(result);if(result.state!=='connected')process.exitCode=1;
 }else if(command==='status'){print(await sync.status());
 }else if(command==='records'){
  const records=await sync.records();const id=one('id');print(id?records.find(r=>r.receipt.id===id)||null:records.map(r=>({id:r.receipt.id,host:r.snapshot.host,project:r.snapshot.project,session:r.snapshot.session,digest:r.snapshot.digest,messages:r.snapshot.payload.batch.events.length,state:r.receipt.state})));
 }else if(command==='watch'){
  const abort=new AbortController();for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>abort.abort());
  while(!abort.signal.aborted){try{print(await sync.tick());}catch(e){print({state:'attention',code:e.message==='storage_busy'?'storage_busy':'sync_failed'});}try{await delay(30000,undefined,{signal:abort.signal});}catch{break;}}
 }else if(command==='install-service'){await service();print({installed:true,label,interval_seconds:30,model_calls:0});
 }else if(command==='stop'){await service(true);print(await sync.pause());
 }else if(command==='help'){
  console.log(`hypeproof-measure projects [--project PATH ...]\nhypeproof-measure connect --token-stdin [--server ORIGIN] --project PATH ...\nhypeproof-measure install-service   # macOS, persists across terminal exit/login\nhypeproof-measure sync              # one capture/upload/download cycle\nhypeproof-measure status\nhypeproof-measure records [--id RECEIPT_ID]\nhypeproof-measure watch             # foreground supervisor on any Node platform\nhypeproof-measure stop              # remove this macOS service and pause capture\nAll commands accept --state DIRECTORY. Existing Codex/Claude sessions keep their own login and workflow. Configure your project scopes at https://hypeproof-ai.xyz/members/studio/measurement first.`);
 }else throw Error('unknown_command');
}catch(e){print({error:/^[a-z_0-9]{1,100}$/.test(e.message)?e.message:'command_failed'});process.exitCode=1;}
