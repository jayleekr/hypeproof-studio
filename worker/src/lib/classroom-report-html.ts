// Remote classroom operations R5/R6 (#751) — the page a guardian or learner actually reads.
//
// It renders exactly what composeReport() produced: observed behaviour → the evidence → how a
// judgement changed → one next experiment. There is no second data path, so the page and the
// reviewed draft cannot disagree.
//   - Every learner/AI string is escaped. The page has no script and a `default-src 'none'` CSP.
//   - Provenance travels with each quote (whose words, real or simulated, helped or alone).
//   - Missing evidence is "아직 충분히 보지 못함" in words — never a zero, a bar or a colour of failure.
//   - Versions and counts are folded under "이 보고서는 어떻게 만들어졌나요"; nothing numeric leads.
//   - The same HTML prints to PDF (A4, light paper palette) — scripts/classroom-report-pdf.mjs.
import type { DraftEvidence, ReportSection } from './classroom-report';

export const REPORT_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const ACTOR: Record<string, string> = { student: '학생이 직접 쓴 말', ai: 'AI의 응답', teacher: '강사의 말', external_user: '다른 사람의 말', tool: '도구의 출력', system: '시스템 기록', unknown: '누구의 말인지 확인되지 않음' };
const SOURCE: Record<string, string> = { real: '실제 수업 중', simulated: '가상 사례(연습)', self_reported: '학생의 자기 보고', unverified: '' };
const ASSIST: Record<string, string> = { assisted: 'AI나 강사의 도움을 받아 한 일입니다.', independent: '스스로 한 일로 기록돼 있습니다.' };

function evidenceHtml(e: DraftEvidence): string {
  const who = ACTOR[e.actor ?? 'unknown'] ?? ACTOR.unknown, src = SOURCE[e.source_state ?? 'unverified'] ?? '';
  // Only the learner's own, non-simulated words carry the accent. AI output, other people and practice cases read as context.
  return `<figure class="quote${e.actor === 'student' && e.source_state !== 'simulated' ? '' : ' context'}"><blockquote>${esc(e.quote)}</blockquote><figcaption>${esc([who, src].filter(Boolean).join(' · '))}</figcaption></figure>`;
}
function sectionHtml(s: ReportSection, index: number): string {
  // "Not seen yet" for five capabilities is one sentence with five names, not the same phrase five times.
  if (s.items.length > 1 && s.items.every((i) => i.text === s.title && i.label && !i.evidence?.length)) return `<section aria-labelledby="s${index}"><h2 id="s${index}">${esc(s.title)}</h2><p class="names">${s.items.map((i) => `<span>${esc(i.label)}</span>`).join('')}</p>${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}</section>`;
  const items = s.items.map((i) => `<li>${i.label ? `<h3>${esc(i.label)}</h3>` : ''}<p>${esc(i.text)}</p>${i.assistance && ASSIST[i.assistance] ? `<p class="assist">${esc(ASSIST[i.assistance])}</p>` : ''}${(i.evidence ?? []).map(evidenceHtml).join('')}</li>`).join('');
  return `<section aria-labelledby="s${index}"><h2 id="s${index}">${esc(s.title)}</h2>${items ? `<ul>${items}</ul>` : ''}${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}</section>`;
}

export interface ReportPageMeta { student_label: string; class_label: string; approved_at?: number; expires_at?: number }
export function renderReportHtml(report: { sections: ReportSection[]; method: Record<string, unknown> }, meta: ReportPageMeta): string {
  const m = report.method as { capability_model?: { id?: string; revision?: number }; rubric?: string; evaluator?: string; renderer_revision?: string; scope?: string };
  const date = (t?: number) => (t ? new Date(t).toISOString().slice(0, 10) : '');
  // Folded on screen (numbers never lead); a PDF has nothing to unfold, so the same block is printed open at the end.
  const methodBody = `<p>수업 중 학생이 동의한 기록에서 근거를 찾아 초안을 만들고, 강사가 근거를 하나씩 확인해 승인했습니다. 기록에 없는 행동은 추측해 적지 않습니다.</p>
<dl><dt>관찰 기준</dt><dd>${esc(m.capability_model?.id)} r${esc(m.capability_model?.revision)}</dd><dt>기준 문서</dt><dd>${esc(m.rubric)}</dd><dt>초안 작성</dt><dd>${esc(m.evaluator)}</dd><dt>보고서 형식</dt><dd>${esc(m.renderer_revision)}</dd>${meta.approved_at ? `<dt>강사 승인일</dt><dd>${esc(date(meta.approved_at))}</dd>` : ''}</dl>`;
  const method = `<details class="screen-only"><summary>이 보고서는 어떻게 만들어졌나요</summary>${methodBody}</details><section class="print-only"><h2>이 보고서는 어떻게 만들어졌나요</h2>${methodBody}</section>`;
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>수업 관찰 보고서 · ${esc(meta.student_label)}</title>
<style>
:root{--bg:#151D19;--panel:#202C24;--accent:#D5F279;--caution:#E6A373;--text:#F2F4E8;--muted:#B9C2B0;color-scheme:dark}
*{box-sizing:border-box}html{font-size:100%}body{margin:0;background:var(--bg);color:var(--text);font:1rem/1.7 system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif;word-break:keep-all;overflow-wrap:anywhere}
main{max-width:44rem;margin:0 auto;padding:1.5rem 1.25rem 4rem}
header p{color:var(--muted);margin:.25rem 0}h1{font-size:1.6rem;line-height:1.3;margin:0 0 .5rem}h2{font-size:1.2rem;margin:0 0 .75rem;color:var(--accent)}h3{font-size:1rem;margin:0 0 .25rem}
section{background:var(--panel);border-radius:.75rem;padding:1.25rem;margin:1rem 0}ul{list-style:none;margin:0;padding:0}li+li{margin-top:1.25rem;padding-top:1.25rem;border-top:1px solid #33443a}p{margin:.25rem 0}
.note,.assist{color:var(--muted)}.names{display:flex;flex-wrap:wrap;gap:.5rem;margin:0 0 .75rem}.names span{border:1px solid #4a5d50;border-radius:1rem;padding:.1rem .7rem}figure{margin:.75rem 0 0;border-left:.25rem solid var(--accent);padding:.25rem 0 .25rem .9rem}figure.context{border-left-color:var(--muted)}blockquote{margin:0;white-space:pre-wrap}figcaption{color:var(--muted);font-size:.9rem;margin-top:.25rem}
details{margin:1rem 0;color:var(--muted)}summary{cursor:pointer;color:var(--text);padding:.5rem 0}summary:focus-visible{outline:.2rem solid var(--accent);outline-offset:.2rem}dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:.5rem 0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
footer{color:var(--muted);font-size:.9rem;margin-top:2rem}.print-only{display:none}
@media print{:root{--bg:#fff;--panel:#fff;--accent:#2f4a12;--text:#111;--muted:#444;color-scheme:light}body{font-size:11pt}main{max-width:none;padding:0}section{border:1px solid #bbb;break-inside:avoid;padding:.8rem;margin:.6rem 0}li+li{border-top-color:#ccc}details.screen-only{display:none}.print-only{display:block}@page{size:A4;margin:16mm}}
</style></head>
<body><main>
<header><h1>수업 관찰 보고서</h1><p>${esc(meta.student_label)} · ${esc(meta.class_label)}</p><p>이 보고서는 ${m.scope === 'cumulative' ? '여러 수업의 기록에서' : '이번 수업 한 번의 기록에서'} 실제로 관찰된 행동과 그 근거를 적은 것입니다. 점수나 순위가 아니며, 강사가 근거를 확인한 뒤 보냈습니다.</p></header>
${report.sections.map(sectionHtml).join('\n')}
${method}
<footer><p>이 주소와 확인 값을 아는 사람은 이 보고서를 볼 수 있습니다. 다른 사람에게 전달하지 마세요.${meta.expires_at ? ` ${esc(date(meta.expires_at))}까지 열립니다.` : ''} 내용에 고칠 점이 있으면 수업 운영자에게 알려 주세요.</p></footer>
</main></body></html>`;
}
