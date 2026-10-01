// #751 U1b (AT-48) — collection KINDS and the sessions of the same learner in the class window, end to end in-process:
// the REAL Service routes (SQLite + in-memory R2), the App's REAL freezer and uploader, and a REAL SessionSpool writing to a
// temp directory (restart = a second SessionSpool on the same root; a shared PC = another learner's session in that root).
// Not a real Studio window, a real offline laptop, real R2/D1 or a network. Every learner and value here is synthetic.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { localOps } from './harness/classroom-ops.mjs';
import { SessionSpool } from '../../extensions/hypeproof-chat/src/sessionSpool.ts';
import * as App from '../../extensions/hypeproof-chat/src/evidenceSnapshot.ts';
const Svc = await import('../src/lib/classroom-collect.ts');
let n = 0; const check = async (name, fn) => { await fn(); n++; console.log('PASS ' + name); };
const NOTICE = { purpose: 'class_report', notice_version: 'notice-v1' }, KEY = () => crypto.randomUUID();
const f = await localOps();
try {
  await f.freeze();
  const seats = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }, { seat_id: 'A3', student_id: 'student-c' }];
  assert.equal((await f.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true, ops_delivery: true } })).status, 201);
  const conn = {}; let pn = 0; for (const s of seats) conn[s.seat_id] = (await f.pair(s.seat_id, 1, ++pn)).conn.json;
  for (const s of ['A1', 'A2']) assert.equal((await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, ...NOTICE }, conn[s].credential)).status, 201);
  const a1 = conn.A1, run = a1.run, scope = { grant_id: a1.grant_id, class_run_id: a1.class_run_id, seat_id: a1.seat_id, student: a1.student, activity: a1.lesson ? { course_id: a1.lesson.course_id, version: a1.lesson.version } : null, run };
  const decode = (v) => new TextDecoder().decode(v.body ?? v), stored = () => [...f.r2.entries()].map(([k, v]) => [k, decode(v)]);
  const holds = (needle) => stored().some(([, v]) => v.includes(needle)), keysOf = (student) => [...f.r2.keys()].filter((k) => k.includes('/' + student + '/'));
  const post = (body) => f.request(f.base + '/report-batches', 'POST', { idempotency_key: KEY(), roster_revision: 1, ...NOTICE, dry_run: false, ...body });
  const view = async (id) => (await f.request(f.base + '/report-batches/' + id)).json;

  // ── the learner's spool: one session before a graceful app restart, one after, plus what must never travel ──
  const root = mkdtempSync(path.join(tmpdir(), 'u1b-spool-'));
  const clock = { t: 0 }, tick = (ms) => { clock.t = ms; }, spoolAt = () => new SessionSpool({ root, appVersion: 'synthetic', os: { platform: 'darwin', release: 't', arch: 'arm64' }, now: () => new Date(run.starts_at + clock.t) });
  const ident = { u: a1.student.u, c: a1.student.c, p: a1.student.p };
  const APPROVED = '<html><body>APPROVED-HTML-v2</body></html>', UNAPPROVED = '<html><body>UNAPPROVED-HTML-v1</body></html>';
  const { createHash } = await import('node:crypto'); const h = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
  // Another activity of the same learner earlier that day, and another learner on the same PC during class: neither is this collection's.
  { tick(-2 * 3_600_000); const early = spoolAt(); early.noteIdentity(ident); early.recordPrompt({ turnId: 'e-1', runtime: 'proxy', text: 'EARLIER-CLASS-PROMPT' }); await early.close('shutdown'); }
  { tick(-10 * 60_000); const lead = spoolAt(); lead.noteIdentity(ident); lead.recordPrompt({ turnId: 'l-1', runtime: 'proxy', text: 'LEAD-IN-EARLIER-SESSION' }); await lead.close('shutdown'); }
  { tick(3_000); const other = spoolAt(); other.noteIdentity({ u: 'student-b', c: ident.c, p: ident.p }); other.recordPrompt({ turnId: 'o-1', runtime: 'proxy', text: 'OTHER-LEARNER-SECRET' }); await other.close('shutdown'); }
  const s1 = spoolAt(); s1.noteIdentity(ident);
  tick(5_000); s1.recordPrompt({ turnId: 't-1', runtime: 'proxy', text: 'PROMPT-ONE', instructorPromptRefs: [{ object_id: 'obj-1', revision: 2 }] });
  tick(6_000); s1.recordResponse({ turnId: 't-1', runtime: 'proxy', status: 'ok', text: 'RESPONSE-ONE-SECRET' });
  tick(7_000); s1.recordArtifactSnapshot({ turnId: 't-1', source: 'assistant_response', path: '/Users/someone/work/index.html', content: UNAPPROVED });
  tick(8_000); s1.recordTurnEnd({ turnId: 't-1', status: 'ok', runtime: 'proxy' });
  tick(9_000); s1.recordArtifactSnapshot({ source: 'existing', path: 'index.html', content: APPROVED }); s1.recordArtifactApproval({ sha256: h(APPROVED), path: 'index.html', approved: true });
  tick(10_000); await s1.close('shutdown'); // graceful quit → session_close
  const s2 = spoolAt(); s2.noteIdentity(ident);
  tick(12_000); s2.recordPrompt({ turnId: 't-2', runtime: 'agent-sdk', text: 'PROMPT-TWO' });
  tick(13_000); s2.recordResponse({ turnId: 't-2', runtime: 'agent-sdk', status: 'ok', text: 'RESPONSE-TWO-SECRET' }); s2.recordTurnEnd({ turnId: 't-2', status: 'ok', runtime: 'agent-sdk' });
  await s2.flush();
  const since = run.starts_at - App.WINDOW_LEAD_MS;

  // The device half, as the host wires it: copy frozen once per (batch, revision) from the live spool, then PUT + seal.
  let puts = [];
  const device = (kinds, source = () => s2.readForCollection(since, ident)) => { const frozen = new Map(); let saved = null; return {
    scope: () => scope,
    copy: async (b, rev) => { const k = b + ':' + rev; if (!frozen.has(k)) { const src = await source(); if (!src) return null; const fr = App.freezeCollection(src, scope, b, NOTICE, kinds, Date.now()); if (!fr.ok) return { code: fr.code }; frozen.set(k, { files: fr.files, collection: fr.binding }); } return frozen.get(k); },
    loadState: async () => (saved ? JSON.parse(saved) : null), saveState: async (s) => { saved = JSON.stringify(s); }, peek: () => JSON.parse(saved), frozen,
    put: async (b, rev, name, data) => { puts.push(name); const r = await f.app.fetch(new Request(`https://service.test/v1/classroom/ops/collect/snapshots/${b}/${rev}/${name}`, { method: 'PUT', headers: { authorization: 'Bearer ' + a1.credential }, body: data }), f.env, { waitUntil() {} }); const j = await r.json().catch(() => ({})); return { status: r.status, reason: j.reason }; },
    seal: async (b, rev, manifest) => { const r = await f.request(`/v1/classroom/ops/collect/snapshots/${b}/${rev}/seal`, 'POST', manifest, a1.credential); return { status: r.status, reason: r.json?.reason, receipt_id: r.json?.receipt_id, coverage: r.json?.coverage, coverage_reason: r.json?.coverage_reason }; },
  }; };
  const collect = async (kinds, extra = {}) => { const made = await post({ targets: ['A1'], mode: 'collect_only', kinds, ...extra }); assert.equal(made.status, 201, made.raw); return made.json.batch.id; };


  await check('G3 explicit wrap-up spans restarts; collecting alone does not evaluate', async () => {
    assert.equal((await post({mode:'finish', kinds:['prompts']})).status,400);
    assert.equal((await post({targets:['A1'], mode:'finish', kinds:['record']})).status,400);
    const selected = await collect(['record']);
    await App.uploadSnapshot(selected, device(['record']));
    assert.equal((await f.request(f.base+'/report-batches/'+selected+'/advance','POST',{})).json.reason,'collect_only_batch');
    const made = await post({mode:'finish', kinds:['record']}); assert.equal(made.status,201,made.raw);
    const batch = made.json.batch.id, B=f.base+'/report-batches/'+batch;
    const uploaded = await App.uploadSnapshot(batch, device(['record']));
    assert.equal((await view(batch)).items.find(x=>x.seat_id==='A1').state,'verified',JSON.stringify(uploaded));
    assert.equal(f.db.prepare('SELECT count(*) n FROM classroom_report_jobs').get().n,0);
    const {setEvaluatorTransport}=await import('../src/routes/classroom-reports.ts');
    const calls=[];f.env.HPS_CLASSROOM_EVALUATOR='service-anthropic';f.env.ANTHROPIC_API_KEY='synthetic-not-a-key';
    setEvaluatorTransport(async req=>{const catalog=JSON.parse(req.messages[0].content).evidence_catalog; calls.push(catalog);return Response.json({content:[{type:'text',text:JSON.stringify({findings:[{capability:'FRAMING',status:'observed',claim:'두 작업에서 조건을 확인했다',assistance:'unknown',evidence:catalog.filter(q=>q.quote==='PROMPT-ONE'||q.quote==='PROMPT-TWO').map(q=>({quote_id:q.quote_id}))}],next_experiment:'다음에는 조건을 먼저 적어 보기'})}]});});
    try {
      const advance=await f.request(B+'/advance','POST',{});assert.equal(advance.status,200,advance.raw);
      const jobs=(await f.request(B+'/reports')).json.jobs,job=jobs.find(j=>j.student_id==='student-a'&&j.draft_digest);
      assert.ok(job,JSON.stringify(jobs));assert.equal(calls.length,1);
      assert.ok(!JSON.stringify(calls).includes('OTHER-LEARNER-SECRET'));assert.ok(!JSON.stringify(calls).includes('EARLIER-CLASS-PROMPT'));
      const report=(await f.request(B+'/reports/'+job.id)).json;
      const evidence=report.report.sections.flatMap(s=>s.items).flatMap(i=>i.evidence||[]);
      assert.equal(new Set(evidence.map(e=>e.session_id)).size,2,JSON.stringify(evidence));
      assert.ok(report.report.sections.some(s=>s.title==='이 보고서에 포함된 기록'&&s.items.length===2));
      await f.request(B+'/advance','POST',{});assert.equal(calls.length,1,'no duplicate evaluation');
      assert.equal((await f.request(B+'/reports/'+job.id+'/review','PUT',{decision:'approve',expected_revision:report.revision,draft_digest:report.draft_digest})).status,200);
      const admin={authorization:'Basic '+Buffer.from('x:pw').toString('base64')};
      assert.equal((await f.request('/admin/classroom/recipients','POST',{class_run_id:f.run,source_ref:'synthetic-g3',recipients:[{student_id:'student-a',recipient_ref:'guardian-g3',channel:'email',address:'guardian@example.test',viewer_check:{kind:'phone_last4',value:'4821'}}]},null,admin)).status,201);
      const shown=(await f.request(B+'/recipients?template_revision=tmpl-1')).json;assert.equal(shown.expected_messages,1);
      const approval=(await f.request(B+'/approve','POST',{template_revision:'tmpl-1',channel:'email',scope_hash:shown.scope_hash})).json;
      const {registerDeliveryAdapter}=await import('../src/routes/classroom-delivery.ts');let sends=0;
      registerDeliveryAdapter({id:'sandbox',external:true,send:async()=>{sends++;return{status:'accepted',provider_message_id:'g3-message'};}});f.env.HPS_DELIVERY_PROVIDER='sandbox';
      assert.equal((await f.request(B+'/deliver','POST',{approval_id:approval.approval_id,dry_run:false})).status,202);
      assert.equal(sends,1);assert.equal(f.db.prepare('SELECT state FROM classroom_report_deliveries').get().state,'provider_accepted');
      assert.equal((await f.request('/admin/classroom/delivery-events','POST',{provider_event_id:'g3-event',provider_message_id:'g3-message',kind:'delivered'},null,admin)).json.state,'delivered');
      const {readReportInput}=await import('../src/lib/classroom-report-input.ts'), {validateDraft}=await import('../src/lib/classroom-report.ts');
      const row=f.db.prepare('SELECT * FROM classroom_report_jobs WHERE id=?').get(job.id), input=await readReportInput(f.env,row);
      const rawDraft=JSON.parse(new TextDecoder().decode([...f.r2.entries()].find(([k])=>k.includes(job.id)&&k.endsWith('.json'))[1]));
      const wrong=structuredClone(rawDraft);delete wrong.findings[0].evidence[0].session_id;
      assert.equal(validateDraft(wrong,row,input).reason,'evidence_event_not_found');
      const swap=structuredClone(rawDraft);swap.findings[0].evidence[0].session_id=swap.findings[0].evidence[1].session_id;
      assert.equal(validateDraft(swap,row,input).ok,false,'cross-session quote cannot be rebound');
      const key=[...f.r2.keys()].find(k=>k.includes(batch)&&k.endsWith('p1.events.jsonl')), old=f.r2.get(key);
      f.r2.set(key,new TextEncoder().encode('corrupt').buffer);await assert.rejects(()=>readReportInput(f.env,row),/input_hash_mismatch/);f.r2.set(key,old);
    } finally {setEvaluatorTransport(undefined);}
  });
  await s2.close('shutdown');rmSync(root,{recursive:true,force:true});
} finally {f.close();}
console.log(n+' G3 journey checks passed');
