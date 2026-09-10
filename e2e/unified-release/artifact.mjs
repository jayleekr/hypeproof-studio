import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const sha256=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function appIdentity(app,platform=process.platform) {
 const resources=path.join(app,platform==='darwin'?'Contents/Resources/app':'resources/app');
 const product=JSON.parse(fs.readFileSync(path.join(resources,'product.json'),'utf8'));
 const extension=JSON.parse(fs.readFileSync(path.join(resources,'extensions/hypeproof-chat/package.json'),'utf8'));
 return {version:product.version,sha:product.commit,name:product.nameLong,extensionVersion:extension.version};
}
export function treeHash(root) {
 const digest=crypto.createHash('sha256');
 const visit=relative=>{
  for(const name of fs.readdirSync(path.join(root,relative)).sort()) {
   const rel=path.join(relative,name),file=path.join(root,rel),stat=fs.lstatSync(file);
   digest.update(rel.replaceAll('\\','/')+'\0');
   if(stat.isSymbolicLink())digest.update('link:'+fs.readlinkSync(file));
   else if(stat.isDirectory())visit(rel);
   else digest.update(sha256(file));
  }
 };
 visit('');return digest.digest('hex');
}
export function assertReceipt(receipt,{sha,version,platform,assets,requirePublic=true}) {
 const fail=why=>{throw Error('Unified release gate: '+why);};
 if(receipt?.schema!=='hps-unified-acceptance/1'||receipt.status!=='PASS')fail('missing or unsuccessful acceptance');
 if(receipt.sourceSha!==sha||receipt.sourceDirty!==false)fail('stale or modified verification source');
 if(receipt.platform!==platform||receipt.mode!=='candidate-unmodified')fail('wrong OS or injected bundle');
 if(receipt.app?.sha!==sha||receipt.app?.version!==version||receipt.app?.extensionVersion!==version||receipt.app?.name!=='HypeProof Studio')fail('wrong app identity');
 if(!/^[a-f0-9]{64}$/.test(receipt.treeBefore)||receipt.treeBefore!==receipt.treeAfter)fail('bundle changed during acceptance');
 if(JSON.stringify(Object.keys(receipt.assets??{}).sort())!==JSON.stringify(Object.keys(assets).sort()))fail('artifact set changed');
 for(const [name,digest] of Object.entries(receipt.assets??{}))if(!/^[a-f0-9]{64}$/.test(digest)||assets[name]!==digest)fail('artifact changed: '+name);
 const names=Object.keys(receipt.assets??{});
 if(platform==='darwin-arm64'&&!names.some(n=>n==='HypeProof-Studio-darwin-arm64.zip'))fail('missing Mac artifact');
 if(platform==='win32-x64'&&(!names.some(n=>/win32-x64.*\.zip$/.test(n))||!names.some(n=>/UserSetup.*\.exe$/.test(n))||!names.some(n=>/(?<!User)Setup.*\.exe$/.test(n))))fail('missing Windows artifacts');
 if(platform==='win32-x64'&&receipt.installerPayloadsVerified!==true)fail('installer payload not verified');
 if(receipt.activities?.length!==2)fail('both activities are required');
 for(const kind of ['trial','classroom']) {
  const row=receipt.activities.find(r=>r.kind===kind),result=row?.result;
  for(const field of ['real_folder_reload','draft_round_trip','attachment_round_trip','process_restart','encrypted_storage','shared_root_blocked','original_files_preserved','live_model'])if(result?.[field]!==true)fail(kind+': '+field+' not observed');
  if(result.status!=='PASS'||!(Number.isInteger(result.model_calls)&&result.model_calls>0&&result.model_calls<=8)||row.serviceSha!==sha||row.payloadIsolation!==true)fail(kind+': execution incomplete');
 }
 if(requirePublic){
  const service=receipt.publicService;
  if(service?.base!=='https://api.hypeproof-ai.xyz/v1'||service.status!=='PASS'||!service.version||service.version==='unknown'||service.activities?.length!==2)fail('public Service acceptance missing');
  for(const kind of ['trial','classroom'])if(!service.activities.some(row=>row.kind===kind&&row.status==='PASS'&&row.fileOperations===true))fail(kind+': public Service acceptance incomplete');
 }
 return true;
}
