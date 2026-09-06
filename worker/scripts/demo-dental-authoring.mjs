// Executable authoring simulation. Does not run a learner or call an LLM.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sourceURL, compileProgram, importDrafts } from './dental-authoring.mjs';
import { localAuthoring } from '../test/harness/dental-authoring.mjs';
const batch=compileProgram(JSON.parse(readFileSync(sourceURL,'utf8')));
const local=await localAuthoring();
try {
  const created=await importDrafts({...local,batch});
  const resumed=await importDrafts({...local,batch});
  assert.equal(created.results.length,5);
  assert.ok(created.results.every(r=>r.status==='created'&&r.revision===1&&r.reopened));
  assert.ok(resumed.results.every(r=>r.status==='existing'&&r.revision===1&&r.reopened));
  assert.equal(local.db.prepare('SELECT count(*) n FROM authoring_versions').get().n,0);
  console.log(JSON.stringify({mode:'local Service routes + SQLite; in-memory simulation',instructor:'김서연 (가상)',
    source_sha256:batch.source_sha256,created:created.results,resumed:resumed.results,
    frozen_versions:0,production_writes:0,learner_rehearsal:'not_run',learning_scores:null},null,2));
} finally {local.close();}
