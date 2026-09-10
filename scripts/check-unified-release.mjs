#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {assertReceipt,sha256} from '../e2e/unified-release/artifact.mjs';
const [directory,sha,version]=process.argv.slice(2);
try{
 if(!directory||!/^[a-f0-9]{40}$/.test(sha??'')||!version)throw Error('Usage: check-unified-release.mjs ASSET_DIRECTORY SOURCE_SHA VERSION');
 const evidence=JSON.parse(fs.readFileSync(path.join(directory,'unified-acceptance.json'),'utf8'));
 const assets=Object.fromEntries(fs.readdirSync(directory).filter(n=>/\.(exe|zip)$/.test(n)).map(n=>[n,sha256(path.join(directory,n))]));
 if(evidence.schema!=='hps-unified-release/1'||evidence.receipts?.length!==2)throw Error('Both OS receipts are required');
 for(const platform of ['darwin-arm64','win32-x64'])assertReceipt(evidence.receipts.find(r=>r.platform===platform),{sha,version,platform,assets});
 if(new Set(evidence.receipts.map(r=>r.publicService.version)).size!==1)throw Error('Public Service changed between OS runs');
 console.log('PASS both OS artifacts: trial + classroom, live model, file isolation, encrypted restart and unchanged bytes');
}catch(error){console.error(error.code?'Missing or unreadable release acceptance evidence':error.message);process.exitCode=1;}
