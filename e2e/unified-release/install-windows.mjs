// CI-only: install BOTH shipped installers in isolated directories and compare
// every portable payload file. Extra uninstaller/installation bookkeeping is OK.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {sha256,treeHash} from './artifact.mjs';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true')throw Error('Windows disposable CI runner required');
const [assets,portable]=process.argv.slice(2);
const names=fs.readdirSync(assets).filter(n=>/Setup.*\.exe$/.test(n));
if(names.length!==2||!names.some(n=>/UserSetup/.test(n)))throw Error('Both installers required');
const files=[];function visit(rel=''){for(const entry of fs.readdirSync(path.join(portable,rel),{withFileTypes:true})){const next=path.join(rel,entry.name);if(entry.isDirectory())visit(next);else if(entry.isFile())files.push(next);else throw Error('Unexpected payload type');}}visit();
const installers=[];
for(const name of names){
 const destination=fs.mkdtempSync(path.join(os.tmpdir(),'hps-installer-'));
 execFileSync(path.resolve(assets,name),['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/MERGETASKS=!runcode,!desktopicon,!quicklaunchicon',`/DIR=${destination}`],{stdio:'pipe',timeout:180000});
 for(const file of files)if(sha256(path.join(portable,file))!==sha256(path.join(destination,file)))throw Error('Installer payload differs: '+name+' / '+file);
 installers.push({name,sha256:sha256(path.join(assets,name)),payloadMatches:true});
 // CI runner disposal cleans installed applications/registry; don't invoke user uninstallers.
}
fs.writeFileSync(path.join(assets,'installer-verification.json'),JSON.stringify({portableTree:treeHash(portable),installers},null,2));
