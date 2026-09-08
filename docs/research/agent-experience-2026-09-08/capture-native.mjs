// Research capture only. No credentials, model requests, or production sessions.
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../../..');
const require=createRequire(path.join(process.env.HPS_CAPTURE_DEPS_ROOT || root,'e2e/package.json'));
const {_electron}=require('@playwright/test');
const out=path.join(here,'screenshots'); await fs.mkdir(out,{recursive:true});
const report=[];
for (const [name,slug] of [['HypeProof Studio','studio'],['Cursor','cursor']]) {
  const data=await fs.mkdtemp(path.join(os.tmpdir(),'hps-comparison-'));
  let app;
  try {
    await fs.mkdir(path.join(data,'User'));await fs.mkdir(path.join(data,'comparison-project'));
    await fs.writeFile(path.join(data,'comparison-project','index.html'),'<h1>Sample studio project</h1>');
    await fs.writeFile(path.join(data,'User','settings.json'),JSON.stringify({
      'hypeproofChat.proxyUrl':'http://127.0.0.1:1/v1','update.mode':'none',
      'telemetry.telemetryLevel':'off','workbench.startupEditor':'none','window.dialogStyle':'custom'
    }));
    const env={...process.env,HPS_TEST_E2E:'1'};
    for(const key of Object.keys(env)) if(/TOKEN|SECRET|API_KEY|AUTH|HPS_TEST_(TOKEN|COACH)/i.test(key)) delete env[key];
    app=await _electron.launch({executablePath:`/Applications/${name}.app/Contents/MacOS/${name}`,
      args:[`--user-data-dir=${data}`,`--extensions-dir=${data}/extensions`,'--use-inmemory-secretstorage',
        '--disable-updates','--skip-welcome','--skip-release-notes','--disable-workspace-trust',
        '--disable-background-timer-throttling','--disable-renderer-backgrounding',
        '--folder-uri',pathToFileURL(path.join(data,'comparison-project')).href],env,timeout:30000});
    await app.evaluate(({app,BrowserWindow})=>{
      app.dock?.hide();const place=w=>{w.setBounds({x:-4000,y:-4000,width:1440,height:1000});w.showInactive();};
      for(const w of BrowserWindow.getAllWindows())place(w);
      app.on('browser-window-created',(_,w)=>place(w));
    });
    const page=await app.firstWindow();await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(4500);
    const product=JSON.parse(await fs.readFile(`/Applications/${name}.app/Contents/Resources/app/product.json`,'utf8'));
    const image=`${slug}-installed-entry.png`;await page.screenshot({path:path.join(out,image)});
    const png=await fs.readFile(path.join(out,image));
    report.push({product:name,version:product.version,commit:product.commit,capturedAt:new Date().toISOString(),
      sha256:crypto.createHash('sha256').update(png).digest('hex'),
      imagePixels:{width:png.readUInt32BE(16),height:png.readUInt32BE(20)},
      image,scope:'Installed macOS app; isolated empty account; no authenticated agent turn',
      viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight})),
      visibleText:(await page.locator('body').innerText()).slice(0,6500)});
  }catch(e){report.push({product:name,status:'BLOCKED',reason:e.message});}
  finally {if(app)await app.close().catch(()=>{});await fs.rm(data,{recursive:true,force:true});}
}
await fs.writeFile(path.join(here,'native-capture.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report.map(({visibleText,...x})=>x),null,2));
