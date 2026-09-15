import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalReviewService } from '../src/localReviewService.ts';
import { FileRecordStorage } from '../src/localRecordFile.ts';
import { confirmPurpose } from '../../../worker/src/lib/measurement-core/index.ts';
const root = await mkdtemp(join(tmpdir(), 'hps-recovery-'));
const raw = [
 { type:'session_meta', payload:{id:'recovery-session',cwd:'/project'} },
 { timestamp:'2026-09-15T00:00:00Z', type:'response_item', payload:{type:'message',role:'user',content:[{type:'input_text',text:'Review the actual receipt.'}]} },
].map(JSON.stringify).join('\n');
try {
 const service = new LocalReviewService(join(root,'store'));
 const card=await service.import(raw,'codex','/project');
 const id=card.task.id;
 const preview=await service.preview(id,false);
 const remove=service.store.remove.bind(service.store);
 service.store.remove=async key=>{if(key==='previews/'+id)throw Error('EIO');return remove(key);};
 await assert.rejects(service.purpose(id,'A changed purpose'),/EIO/);
 const reopened = new LocalReviewService(service.store.root);
 const current = await reopened.card(id);
 if(current.task.purpose.text !== card.task.purpose.text) {
   await assert.rejects(reopened.submit(id,preview.digest),/preview_changed|preview_required/,'An acknowledged storage failure must not leave a submittable stale purpose');
 }
 service.store.remove=remove;
 // An older process can modify records without invalidating the current preview.
 const bound = await reopened.preview(id,false);
 await reopened.record.saveTask(confirmPurpose(await reopened.record.getTask(id),{by:'user',at:Date.now(),text:'Changed in another process'}));
 await assert.rejects(reopened.submit(id,bound.digest),/preview_changed/);
 const fresh=await reopened.preview(id,false);
 const receipt=await reopened.submit(id,fresh.digest);
 assert.deepEqual(await reopened.submit(id,fresh.digest),receipt,'Successful receipt retry remains idempotent');
 const legacy = await reopened.preview(id,false);
 await reopened.store.write('previews/'+id,JSON.stringify(legacy));
 await assert.rejects(reopened.submit(id,legacy.digest),/preview_required/,'Unbound old-version preview needs a new user preview');
 const orphanRoot=join(root,'orphan');await mkdir(join(orphanRoot,'.writer'),{recursive:true});
 const store=new FileRecordStorage(orphanRoot);
 await store.exclusive(()=>store.write('test/recovered','yes'));
 assert.equal(await store.read('test/recovered'),'yes');
 await assert.rejects(store.exclusive(()=>new FileRecordStorage(orphanRoot).exclusive(async()=>{})),/storage_busy/,'Recovery must not steal a live writer');
 console.log('PASS failure-safe previews, revision binding, receipt retry and incomplete-lock recovery');
} finally { await rm(root,{recursive:true,force:true}); }
