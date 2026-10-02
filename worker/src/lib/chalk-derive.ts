// #1469 (E3-3) — pure derive functions for runbook and handout.
// Both functions are deterministic: same opsHtml + opsSha256 → same output bytes.
import { parsePlan } from './chalk-plan/parser.ts';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sectionHtml(html: string, key: string): string | null {
  const re = new RegExp(
    `<[^>]*data-chalk-section=["']${key}["'][^>]*>([\\s\\S]*?)</section>`,
    'i',
  );
  const m = re.exec(html);
  return m ? (m[1] ?? null) : null;
}

const STYLE = `
  body { font-family: sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
  h1, h2, h3 { margin-top: 1.5rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; }
  th { background: #f5f5f5; }
  .label { font-weight: bold; color: #555; font-size: 0.85em; }
  .block { margin-bottom: 1rem; border: 1px solid #ddd; border-radius: 4px; padding: 0.75rem; }
  .block-break { background: #fafafa; }
  .stale-warning { background: #fff3cd; border: 1px solid #ffc107; padding: 0.5rem; border-radius: 4px; margin-bottom: 1rem; }
`.trim();

function metaRow(label: string, value: string | null): string {
  if (!value) return '';
  return `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`;
}

export function deriveRunbook(opsHtml: string, opsSha256: string): string {
  const plan = parsePlan(opsHtml, 'ops');
  const { meta, blocks = [], risks = [] } = plan;

  const course = meta.course ?? '';
  const format = meta.format ?? '';
  const durationMin = meta.durationMin != null ? String(meta.durationMin) : '';

  const blockRows = blocks.map((b) => {
    const kind = b.kind;
    const isBreak = kind === 'break';
    const isBuffer = kind === 'buffer';

    const cells: string[] = [];
    cells.push(`<td>${esc(b.start ?? '')}</td>`);
    cells.push(`<td>${esc(b.durationMin != null ? String(b.durationMin) : '')}</td>`);
    cells.push(`<td>${esc(b.key)}</td>`);
    cells.push(`<td>${isBreak ? '쉬는 시간' : esc(kind)}</td>`);
    cells.push(`<td>${esc(b.fields.activity ?? '')}</td>`);
    cells.push(`<td>${esc(b.fields.asset ?? '')}</td>`);
    cells.push(`<td>${esc(b.fields.artifact ?? '')}</td>`);
    cells.push(`<td>${esc(b.roles.facilitator ?? '')}</td>`);
    cells.push(`<td>${esc(b.roles.assistant ?? '')}</td>`);
    cells.push(`<td>${esc(b.roles.learner ?? '')}</td>`);
    if (meta.familySession) {
      cells.push(`<td>${esc(b.roles.parent?.text ?? '')}</td>`);
    }
    cells.push(`<td>${esc(b.fields.exitCriteria ?? '')}</td>`);
    cells.push(`<td>${esc(b.fields.ifStuck ?? '')}</td>`);
    cells.push(`<td>${isBuffer ? esc(b.fields.ifAhead ?? '') : ''}</td>`);
    cells.push(`<td>${isBuffer ? esc(b.fields.ifBehind ?? '') : ''}</td>`);
    cells.push(`<td>${esc(b.stepRefs.join(', '))}</td>`);

    const cls = isBreak ? ' class="block-break"' : '';
    return `<tr${cls}>${cells.join('')}</tr>`;
  }).join('\n');

  const parentTh = meta.familySession ? '<th>parent</th>' : '';

  const riskRows = risks.map((r) =>
    `<tr><td>${esc(r.key)}</td><td>${esc(r.firstLine ?? '')}</td></tr>`
  ).join('\n');

  const materialsHtml = sectionHtml(opsHtml, 'materials') ?? '';
  const consentHtml = sectionHtml(opsHtml, 'consent') ?? '';
  const postHtml = sectionHtml(opsHtml, 'post-deliverables') ?? '';

  return `<!DOCTYPE html>
<html lang="ko" data-chalk-kind="runbook" data-chalk-derived-from="${esc(opsSha256)}">
<head><meta charset="utf-8"><title>런북 — ${esc(course)}</title><style>${STYLE}</style></head>
<body>
<h1>진행자 런북 — ${esc(course)}</h1>
<table>
${metaRow('코스', course)}
${metaRow('형식', format)}
${metaRow('총 시간(분)', durationMin)}
</table>

<h2>블록 일정</h2>
<table>
<thead><tr><th>시작</th><th>분</th><th>블록</th><th>종류</th><th>활동</th><th>자산</th><th>산출물</th><th>진행자</th><th>보조</th><th>학습자</th>${parentTh}<th>종료 기준</th><th>막혔을 때</th><th>빠를 때</th><th>느릴 때</th><th>단계 참조</th></tr></thead>
<tbody>
${blockRows}
</tbody>
</table>

<h2>리스크 목록</h2>
<table>
<thead><tr><th>키</th><th>첫 줄</th></tr></thead>
<tbody>
${riskRows}
</tbody>
</table>

<h2>준비물</h2>
${materialsHtml}

<h2>동의</h2>
${consentHtml}

<h2>사후 제출물</h2>
${postHtml}
</body>
</html>`;
}

export function deriveHandout(opsHtml: string, opsSha256: string): string {
  const plan = parsePlan(opsHtml, 'ops');
  const { meta, blocks = [] } = plan;

  const course = meta.course ?? '';
  const format = meta.format ?? '';
  const durationMin = meta.durationMin != null ? String(meta.durationMin) : '';

  // Time summary: use data-start values only; omit when absent.
  const firstBlock = blocks.length > 0 ? blocks[0] : null;
  const lastBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null;
  const breakBlock = blocks.find((b) => b.kind === 'break');

  const timeRows: string[] = [];
  if (firstBlock?.start) {
    timeRows.push(metaRow('시작 시각', firstBlock.start));
  }
  if (lastBlock?.start) {
    timeRows.push(metaRow('종료 시각', lastBlock.start));
  }
  if (breakBlock?.start) {
    const breakInfo = breakBlock.durationMin != null
      ? `${breakBlock.start} (${breakBlock.durationMin}분)`
      : breakBlock.start;
    timeRows.push(metaRow('쉬는 시간', breakInfo));
  }

  // Handout blocks: exclude buffer blocks entirely; include normal/break/wrap-up.
  const handoutBlocks = blocks.filter((b) => b.kind !== 'buffer');

  const blockRows = handoutBlocks.map((b) => {
    const isBreak = b.kind === 'break';
    const cells: string[] = [];
    cells.push(`<td>${esc(b.key)}</td>`);
    cells.push(`<td>${isBreak ? '쉬는 시간' : esc(b.fields.artifact ?? '')}</td>`);
    cells.push(`<td>${esc(b.roles.learner ?? '')}</td>`);
    if (meta.familySession) {
      const parentText = b.roles.parent?.text ?? '';
      const parentRole = b.roles.parent?.role ?? '';
      const combined = parentRole ? `[${parentRole}] ${parentText}` : parentText;
      cells.push(`<td>${esc(combined)}</td>`);
    }
    return `<tr>${cells.join('')}</tr>`;
  }).join('\n');

  const parentTh = meta.familySession ? '<th>보호자</th>' : '';

  // Materials: learner and parent only (exclude instructor materials).
  const materialsSection = sectionHtml(opsHtml, 'materials') ?? '';
  const learnerMaterialsHtml = extractMaterialsByOwner(materialsSection, ['learner', 'parent']);

  const consentHtml = sectionHtml(opsHtml, 'consent') ?? '';
  const postHtml = sectionHtml(opsHtml, 'post-deliverables') ?? '';

  return `<!DOCTYPE html>
<html lang="ko" data-chalk-kind="handout" data-chalk-derived-from="${esc(opsSha256)}">
<head><meta charset="utf-8"><title>참가자 안내문 — ${esc(course)}</title><style>${STYLE}</style></head>
<body>
<h1>참가자 안내문 — ${esc(course)}</h1>
<table>
${metaRow('코스', course)}
${metaRow('형식', format)}
${metaRow('총 시간(분)', durationMin)}
${timeRows.join('\n')}
</table>

<h2>일정</h2>
<table>
<thead><tr><th>블록</th><th>오늘 만드는 것 / 활동</th><th>학습자</th>${parentTh}</tr></thead>
<tbody>
${blockRows}
</tbody>
</table>

<h2>준비물</h2>
${learnerMaterialsHtml}

<h2>동의</h2>
${consentHtml}

<h2>사후 제출물</h2>
${postHtml}
</body>
</html>`;
}

function extractMaterialsByOwner(materialsHtml: string, owners: string[]): string {
  if (!materialsHtml) return '';
  // Extract list items or table rows with matching data-owner attribute.
  const ownerPattern = owners.map((o) => esc(o)).join('|');
  const re = new RegExp(
    `<(?:li|tr)([^>]*data-owner=["'](?:${ownerPattern})["'][^>]*)>([\\s\\S]*?)<\\/(?:li|tr)>`,
    'gi',
  );
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(materialsHtml)) !== null) {
    matches.push(`<li${m[1]}>${m[2]}</li>`);
  }
  if (matches.length === 0) return '';
  return `<ul>${matches.join('')}</ul>`;
}
