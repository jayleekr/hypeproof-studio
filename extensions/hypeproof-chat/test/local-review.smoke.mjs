import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalReviewService } from '../src/localReviewService.ts';
import { parseLocalTranscript } from '../src/localTranscript.ts';
const root = await mkdtemp(join(tmpdir(), 'hps-review-'));
const at = '2026-09-14T12:00:00Z';
const fixture = host => (host === 'codex' ? [
 {type:'session_meta',payload:{id:'codex-one',cwd:'/project'}},
 {timestamp:at,type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Check the real change and tell me what remains unknown.'}]}},
 {timestamp:at,type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'<script>attack()</script> I claim all tests passed.'}]}},
 {timestamp:at,type:'response_item',payload:{type:'function_call',name:'exec_command',arguments:'secret tool content'}},
] : [
 {timestamp:at,type:'user',sessionId:'claude-one',cwd:'/project',message:{role:'user',content:'Check the changed file.'}},
 {timestamp:at,type:'assistant',sessionId:'claude-one',cwd:'/project',message:{role:'assistant',model:'claude-test',content:[{type:'text',text:'I will check it.'},{type:'thinking',thinking:'hidden reasoning'}]}},
]).map(r=>JSON.stringify(r)).join('\n');
try {
 const service = new LocalReviewService(root);
 await assert.rejects(service.import(fixture('codex'),'codex','/other'), /project_mismatch/);
 assert.equal((await service.record.records()).tasks.length,0);
 const card = await service.import(fixture('codex'),'codex','/project');
 assert.equal(card.observations.length,2);
 assert.equal(card.interpretation.findings.length,6);
 assert.ok(card.interpretation.findings.every(f=>f.status==='insufficient_evidence' && f.assistance==='unknown'));
 assert.equal(card.task.purpose_state,'provided');
 assert.deepEqual((await service.import(fixture('codex'),'codex','/project')).task,card.task);
 const id=card.task.id;
 await service.purpose(id,'Human edited purpose');
 await service.review(id,'FRAMING','correct','The user specified a check and its limits; source line-2.');
 await service.review(id,'FRAMING','confirm','I confirm this judgment.');
 await service.review(id,'OWNERSHIP','correct','A note to exclude');
 await service.review(id,'OWNERSHIP','exclude','Do not include this capability');
 const reopened = new LocalReviewService(root);
 const saved = await reopened.card(id);
 assert.equal(saved.task.purpose_state,'confirmed'); assert.equal(saved.reviews.length,4);
 assert.equal(saved.observations[0].event.text,card.observations[0].event.text);
 const preview = await reopened.preview(id,false);
 assert.equal(preview.payload.observations.length,0);
 assert.equal(preview.payload.interpretations.length,0);
 assert.equal(preview.payload.reviews.length,2);
 assert.ok(!JSON.stringify(preview).includes('A note to exclude'));
 const receipt = await reopened.submit(id,preview.digest);
 assert.deepEqual(await reopened.submit(id,preview.digest),receipt);
 assert.equal((await new LocalReviewService(root).card(id)).receipts.length,1);
 await assert.rejects(reopened.submit(id,'wrong'),/preview_changed/);
 const second=await reopened.preview(id,true); assert.equal(second.payload.revision,2);
 assert.equal((await reopened.submit(id,second.digest)).revision,2);
 await assert.rejects(service.store.exclusive(()=>reopened.purpose(id,'race')), /storage_busy/);
 const claude=await reopened.import(fixture('claude-code'),'claude-code','/project');
 assert.equal(claude.observations.length,2);
 assert.deepEqual(claude.interpretation.versions.work_ai_models,['claude-test']);
 assert.throws(()=>parseLocalTranscript('{bad','codex'), /invalid_transcript_json/);
 assert.throws(()=>parseLocalTranscript(JSON.stringify({type:'session_meta',payload:{id:'x',cwd:'/project'}}),'codex'), /empty_transcript/);
 await reopened.delete(id);
 await assert.rejects(reopened.card(id),/unknown_task/);
 await assert.rejects(reopened.import(fixture('codex'),'codex','/project'),/task_deleted/);
 assert.equal((await reopened.record.records()).tasks.length,1);
 const bundle=await reopened.preview(claude.task.id,true);
 await reopened.submit(claude.task.id,bundle.digest);
 const key='submissions/'+claude.task.id+'@1';
 const stored=JSON.parse(await reopened.store.read(key)); stored.payload.task.purpose.text='tampered';
 await reopened.store.write(key,JSON.stringify(stored));
 await assert.rejects(reopened.card(claude.task.id),/receipt_integrity_failure/);
 console.log('PASS both host transcripts -> durable review revisions -> preview/exclusion -> receipt/reopen/tamper detection/delete; synthetic human actions');
} finally { await rm(root,{recursive:true,force:true}); }
