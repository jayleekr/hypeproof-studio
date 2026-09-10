import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {planLauncher,applyLauncher,restoreLauncher} from './unified-launcher.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hps-launcher-'));
try{
 const app=path.join(root,'HypeProof Studio.app'),resources=path.join(app,'Contents/Resources/app'),ext=path.join(resources,'extensions/hypeproof-chat');
 fs.mkdirSync(path.join(ext,'dist'),{recursive:true});fs.writeFileSync(path.join(resources,'product.json'),JSON.stringify({version:'synthetic',commit:'a'.repeat(40)}));fs.writeFileSync(path.join(ext,'package.json'),JSON.stringify({version:'synthetic'}));
 const launcher=path.join(root,"HP user's trial.command"),old='synthetic launcher with synthetic-local-credential';fs.writeFileSync(launcher,old);
 fs.writeFileSync(path.join(ext,'dist/extension.js'),'old');assert.throws(()=>planLauncher(launcher,app),/install the verified/);assert.equal(fs.readFileSync(launcher,'utf8'),old);
 fs.writeFileSync(path.join(ext,'dist/extension.js'),'hps.activity.credential.');
 const plan=planLauncher(launcher,app);assert.equal(fs.readFileSync(launcher,'utf8'),old);assert.equal(JSON.stringify(plan).includes('synthetic-local-credential'),false);
 const backup=applyLauncher(plan);assert.equal(fs.readFileSync(path.join(backup,'original.command'),'utf8'),old);assert.equal(fs.readFileSync(launcher,'utf8').includes('synthetic-local-credential'),false);
 restoreLauncher(backup);assert.equal(fs.readFileSync(launcher,'utf8'),old);
 const second=applyLauncher(planLauncher(launcher,app));fs.appendFileSync(launcher,'user edit');assert.throws(()=>restoreLauncher(second),/changed/);
 assert.equal(fs.readFileSync(launcher,'utf8').endsWith('user edit'),true);
 console.log('PASS launcher migration: old App rejected, dry run, private exact backup, no credential transfer, restore, concurrent edit preserved');
}finally{fs.rmSync(root,{recursive:true,force:true});}
