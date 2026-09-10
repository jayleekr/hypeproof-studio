#!/usr/bin/env node
// Mac launcher migration only. App installation remains in install-mac.sh.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
export function planLauncher(launcher,app='/Applications/HypeProof Studio.app') {
 if(!path.isAbsolute(launcher)||!launcher.endsWith('.command')||!fs.lstatSync(launcher).isFile())throw Error('Select an existing regular .command launcher.');
 const root=path.join(app,'Contents/Resources/app');
 const product=JSON.parse(fs.readFileSync(path.join(root,'product.json'),'utf8'));
 const extension=JSON.parse(fs.readFileSync(path.join(root,'extensions/hypeproof-chat/package.json'),'utf8'));
 if(!fs.readFileSync(path.join(root,'extensions/hypeproof-chat/dist/extension.js'),'utf8').includes('hps.activity.credential.'))throw Error('BLOCKED: install the verified unified App first; the current installation cannot isolate activity credentials.');
 if(/[/\\]releases[/\\]v\d/.test(app))throw Error('A version-pinned app copy is not a common installation.');
 const bytes=Buffer.from('#!/bin/bash\nset -euo pipefail\n/usr/bin/open -a '+quote(app)+' --args --new-window\n');
 return {format:'hps-unified-launcher/1',launcher,app,appVersion:product.version,appSha:product.commit,extensionVersion:extension.version,originalSha256:hash(fs.readFileSync(launcher)),launcherSha256:hash(bytes),bytes};
}
export function applyLauncher(plan) {
 if(hash(fs.readFileSync(plan.launcher))!==plan.originalSha256)throw Error('Launcher changed after planning; inspect again.');
 const backup=path.join(path.dirname(plan.launcher),'HypeProof-launcher-backups',crypto.randomUUID());
 fs.mkdirSync(backup,{recursive:true,mode:0o700});
 fs.copyFileSync(plan.launcher,path.join(backup,'original.command'),fs.constants.COPYFILE_EXCL);
 fs.chmodSync(path.join(backup,'original.command'),0o600);
 const {bytes,...metadata}=plan;
 fs.writeFileSync(path.join(backup,'manifest.json'),JSON.stringify({...metadata,originalMode:fs.statSync(plan.launcher).mode & 0o777},null,2),{flag:'wx',mode:0o600});
 const tmp=plan.launcher+'.'+crypto.randomUUID();
 try {fs.writeFileSync(tmp,bytes,{flag:'wx',mode:0o755});fs.renameSync(tmp,plan.launcher);}
 finally {if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return backup;
}
export function restoreLauncher(backup) {
 const m=JSON.parse(fs.readFileSync(path.join(backup,'manifest.json'),'utf8'));
 const original=fs.readFileSync(path.join(backup,'original.command'));
 if(m.format!=='hps-unified-launcher/1'||hash(original)!==m.originalSha256||hash(fs.readFileSync(m.launcher))!==m.launcherSha256)throw Error('Backup or current launcher changed; do not overwrite it.');
 const tmp=m.launcher+'.'+crypto.randomUUID();
 try{fs.writeFileSync(tmp,original,{flag:'wx',mode:m.originalMode});fs.renameSync(tmp,m.launcher);}
 finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {
  if(process.platform!=='darwin')throw Error('BLOCKED: .command launcher migration requires macOS.');
  const args=process.argv.slice(2);
  if(args[0]==='--restore'){restoreLauncher(path.resolve(args[1]));console.log('Restored the preserved launcher.');}
  else {
   const plan=planLauncher(path.resolve(args[0]??''));
   const {bytes,...metadata}=plan;
   console.log(JSON.stringify({...metadata,installedAppVerified:false,credentialsCopied:false,userDataChanged:false,workspaceChanged:false},null,2));
   if(args.includes('--apply'))console.log('Launcher backup: '+applyLauncher(plan));
   else console.log('Plan only. After verified installation, use --apply. Public credentials must be entered in the App; legacy data remains in its original location.');
  }
 }catch(error){console.error(error.code ? 'Could not access the selected launcher or installed App.' : error.message);process.exitCode=1;}
}
