// Authoring tooling: deterministic teaching data; all persistence uses Service HTTP.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validateSessionDesign } from '../src/lib/session-design.ts';
export const sourceURL = new URL('../../docs/curriculum/dental-ownership/program.json', import.meta.url);
export const generatedURL = new URL('../../docs/curriculum/dental-ownership/generated/', import.meta.url);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const required = (v, label) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`Missing ${label}`); };
export function compileProgram(p) {
  if (p?.schema !== 'hps-dental-program/1' || p.id !== 'dental-ownership') throw new Error('Unsupported program');
  if (!Array.isArray(p.courses) || p.courses.length !== 5) throw new Error('Exactly five courses required');
  required(p.instructor?.name, 'instructor');
  const roles = ['Reviewer','Editor','Operator','Builder','Owner'];
  const courses = p.courses.map((course, i) => {
    if (course.level !== i + 1 || course.role !== roles[i]) throw new Error('Unique ordered L1..L5 roles required');
    for (const k of ['name','situation','job','barrier','entry','exit']) required(course.persona?.[k], `persona.${k}`);
    if (!Array.isArray(course.steps) || !course.steps.length) throw new Error('Steps required');
    if (course.steps.reduce((n,s) => n + s.minutes, 0) !== 120) throw new Error('Each course must total 120 minutes');
    const steps = course.steps.map(s => {
      if (!Number.isInteger(s.minutes) || s.minutes < 1) throw new Error('Positive integer minutes required');
      for (const k of ['instructor_says','task','evidence','acceptance']) required(s[k], `step.${k}`);
      return { id:s.id, title:`${s.title} (${s.minutes}분)`,
        instructions:`강사: ${s.instructor_says}\n실습: ${s.task}\n${s.prompt ? `Studio 요청 예시: ${s.prompt}` : '독립 과제: 먼저 도움 없이 수행하고 도움 사용 여부를 기록한다.'}\n제출 증거: ${s.evidence}`,
        hint:s.hint, acceptance:s.acceptance };
    });
    if (!course.steps.some(s => s.id === 'independent')) throw new Error('Independent task required');
    const content = {schema:'hps-session-design/1', title:course.title,
      audience:`${course.persona.name}: ${course.persona.situation} 목표: ${course.persona.job}`,
      duration_minutes:120, objective:course.objective, prerequisites:course.prerequisites,
      starter:`${course.starter_files.join("; ")}; ${p.shared.context}`, steps};
    const error = validateSessionDesign(content, true);
    if (error) throw new Error(`L${course.level}: ${error}`);
    return {course_id:`dental-ownership-l${course.level}`, content};
  });
  return {schema:'hps-authoring-batch/1', program_id:p.id, source_sha256:hash(p), courses};
}
export function renderFiles(p) {
  const batch = compileProgram(p);
  const files = {'drafts.json':JSON.stringify(batch,null,2)+'\n'};
  files['feature-requests.json'] = JSON.stringify(p.feature_requests.map(r=>({...r,
    origin:'curriculum_design; not a measured learner incident',
    course_ids:r.levels.map(n=>`dental-ownership-l${n}`),
    review:'not_reviewed', assigned_to:null })),null,2)+'\n';
  const lines = [`# ${p.title}`, '', '> 자동 생성: program.json을 수정하고 npm run courses:dental로 재생성한다.', '', p.source_note, '',
    '## 강사 페르소나', '', `**${p.instructor.name}** — ${p.instructor.background}`, '', p.instructor.goal, '',
    ...p.instructor.constraints.map(s=>`- ${s}`), '', `진행 방식: ${p.instructor.method}`, '',
    '## 수강 경로', '', p.routing.rule, '', ...p.routing.diagnostic.map(s=>`- ${s}`), '', p.routing.grading, '', p.routing.limits, '',
    '## 실행 전 준비', '', ...p.shared.preflight.map(s=>`- ${s}`), '', p.shared.capability_note, '',
    '## 강의', '', '| 레벨 | 페르소나 | 강의 |', '|---|---|---|',
    ...p.courses.map(c=>`| L${c.level} ${c.role} | ${c.persona.name} | [${c.title}](l${c.level}.md) |`), '',
    '## 강사 검토 질문', '', ...p.instructor.review_questions.map(s=>`- [ ] ${s}`), '',
    '## 기능 요청', '', ...p.feature_requests.map(r=>`- **${r.id} ${r.need}** (${r.status}) — ${r.evidence}. 대안: ${r.fallback}. 완료 조건: ${r.acceptance}`), '',
    '## 상태', '', '자료 생성·스키마 검증과 실제 학습 효과는 별개다. 강사 검토, 학생 기기 리허설, 학습 평가는 아직 미실행이다. 자동 생성은 초안만 준비하며 수업을 활성화하지 않는다.', ''];
  files['README.md'] = lines.join('\n');
  for (const c of p.courses) {
    let elapsed=0;
    const out=[`# ${c.title}`, '', '> 자동 생성 문서. 수정은 ../program.json에서 한다. 강사 검토 전 초안.', '',
      `**수강생:** ${c.persona.name} (${c.role})`, '', `상황: ${c.persona.situation}`, '', `막히는 지점: ${c.persona.barrier}`, '',
      `시작 역량: ${c.persona.entry}`, '', `수강 후 행동: ${c.persona.exit}`, '', `**목표:** ${c.objective}`, '', `준비: ${c.prerequisites}`, '',
      '## 결과물', '', ...c.deliverables.map(s=>`- ${s}`), '', '## 강사 진행안·학생 실습', ''];
    for (const s of c.steps) {
      out.push(`### ${elapsed}–${elapsed+s.minutes}분 · ${s.title}`, '', `강사 발화: “${s.instructor_says}”`, '', s.task, '');
      if (s.prompt) out.push('Studio 요청 예시:', '', '```text', s.prompt, '```', '');
      out.push(`막혔을 때: ${s.hint}`, '', `제출: ${s.evidence}`, '', `완료 기준: ${s.acceptance}`, '');
      elapsed += s.minutes;
    }
    out.push('## 평가 기록 (수행 전 빈칸)', '', p.routing.grading, '', '| 단계 | 증거 위치 | 점수 0/1/2 | 도움·미완료 사유 |', '|---|---|---|---|',
      ...c.steps.map(s=>`| ${s.title} |  |  |  |`), '', '## 수업 후 자기 환경에서 할 일', '', c.homework, '', '## 도구가 막히면', '', p.shared.capability_note, '');
    files[`l${c.level}.md`] = out.join('\n');
  }
  return files;
}
// Create-only: interrupted batches can resume, but instructor edits never get overwritten.
// Caller chooses the authenticated Service transport; no credentials in generated artifacts.
export async function importDrafts({batch, origin, cohort, profileId, token, fetcher=fetch}) {
  if (batch?.schema !== 'hps-authoring-batch/1' || !Array.isArray(batch.courses) || batch.courses.length !== 5) throw new Error('Invalid batch');
  if (new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error('HTTPS origin required');
  for (const v of [cohort,profileId]) if (!/^[a-zA-Z0-9_-]{1,128}$/.test(v)) throw new Error('Invalid scope');
  required(token,'token');
  const ids=new Set();
  for (const item of batch.courses) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(item.course_id) || ids.has(item.course_id)) throw new Error('Invalid/duplicate course id');
    ids.add(item.course_id);
    const error=validateSessionDesign(item.content,true); if(error) throw new Error(error);
  }
  const results=[];
  const fail=(item,status) => { const e=new Error(`Draft import stopped: ${item.course_id} (${status})`); e.results=results; throw e; };
  const call=(path,method='GET',body) => fetcher(origin+path,{method,redirect:'error',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  for (const item of batch.courses) {
    const path=`/admin/cohorts/${cohort}/authoring/${item.course_id}`;
    let response=await call(path);
    let status='existing';
    if(response.status===404) {
      response=await call(path,'PUT',{expected_revision:0,request_id:`seed-${hash([profileId,item]).slice(0,48)}`,profile_id:profileId,content:item.content});
      status='created';
    }
    if(response.status!==200) fail(item,response.status);
    const saved=await response.json();
    if(saved.profile_id!==profileId || hash(saved.content)!==hash(item.content) || !Number.isSafeInteger(saved.revision) || saved.revision<1) fail(item,'content conflict');
    const reopened=await call(path);
    if(reopened.status!==200) fail(item,`reopen ${reopened.status}`);
    const read=await reopened.json();
    if(read.profile_id!==profileId || read.revision!==saved.revision || hash(read.content)!==hash(item.content)) fail(item,'reopen mismatch');
    results.push({course_id:item.course_id,status,revision:read.revision,reopened:true});
  }
  return {target:origin,results,activated:false,rehearsal:'not_run'};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const p=JSON.parse(readFileSync(sourceURL,'utf8'));
  const files=renderFiles(p);
  mkdirSync(generatedURL,{recursive:true});
  for (const [name,content] of Object.entries(files)) writeFileSync(new URL(name,generatedURL),content);
  console.log(`Generated ${Object.keys(files).length} files; 5 schema-valid course drafts, 600 teaching minutes. No network writes.`);
}
