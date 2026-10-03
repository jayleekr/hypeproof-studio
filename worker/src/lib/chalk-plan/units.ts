// #1466 (E2-7) — planUnits: stable-key unit extraction for revision diff.
// Pure function: same input → same output. No side effects, no I/O.
// Does NOT modify parsePlan return shape.

export interface PlanUnit {
  /** Stable key for this unit (e.g. "meta:chalk:format", "flow/s-2:teacher"). */
  key: string;
  /** Normalized text: tags stripped, whitespace collapsed to single space. */
  text: string;
}

// Strip HTML tags and collapse whitespace.
function normalize(raw: string): string {
  return raw.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// Extract the inner HTML of a section identified by data-chalk-section.
function sectionInner(html: string, sectionKey: string): string | null {
  const re = new RegExp(
    `<[^>]*data-chalk-section=["']${sectionKey}["'][^>]*>([\\s\\S]*?)</section>`,
    'i',
  );
  const m = re.exec(html);
  return m ? (m[1] ?? null) : null;
}

// Extract all <tr data-chalk-step> elements from the flow section.
function flowSteps(flowHtml: string): Array<{ stepKey: string; fields: Record<string, string> }> {
  const results: Array<{ stepKey: string; fields: Record<string, string> }> = [];
  const rowRe = /<tr[^>]*data-chalk-step="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowM: RegExpExecArray | null;
  while ((rowM = rowRe.exec(flowHtml)) !== null) {
    const stepKey = rowM[1] ?? '';
    const rowHtml = rowM[2] ?? '';
    const fields: Record<string, string> = {};
    const fieldRe = /<td[^>]*data-chalk-field="([^"]*)"[^>]*>([\s\S]*?)<\/td>/gi;
    let fieldM: RegExpExecArray | null;
    while ((fieldM = fieldRe.exec(rowHtml)) !== null) {
      const fKey = fieldM[1] ?? '';
      fields[fKey] = normalize(fieldM[2] ?? '');
    }
    results.push({ stepKey, fields });
  }
  return results;
}

// Extract <li data-chalk-stuck> elements from the support section.
function supportItems(supportHtml: string): Array<{ stuckKey: string; fields: Record<string, string> }> {
  const results: Array<{ stuckKey: string; fields: Record<string, string> }> = [];
  const liRe = /<li[^>]*data-chalk-stuck="([^"]*)"[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(supportHtml)) !== null) {
    const stuckKey = m[1] ?? '';
    const liHtml = m[2] ?? '';
    const fields: Record<string, string> = {};
    const fieldRe = /<[^>]*data-chalk-field="([^"]*)"[^>]*>([\s\S]*?)<\/(?:td|div|span|p)>/gi;
    let fieldM: RegExpExecArray | null;
    while ((fieldM = fieldRe.exec(liHtml)) !== null) {
      const fKey = fieldM[1] ?? '';
      fields[fKey] = normalize(fieldM[2] ?? '');
    }
    results.push({ stuckKey, fields });
  }
  return results;
}

const LESSON_NAMED_SECTIONS = new Set([
  'meta', 'objectives', 'essential-question', 'evidence',
  'flow', 'key-questions', 'prohibited-moves', 'materials', 'safety', 'bridging', 'support',
]);

const FLOW_FIELDS = ['title', 'teacher', 'assistant', 'learner', 'parent', 'duration-min', 'requires', 'forbids'];
const STUCK_FIELDS = ['expected-stuck', 'signal', 'min-support', 'expected-response'];

/**
 * Extract stable-key units from a plan HTML for diffing.
 * file='lesson' is currently the only supported kind.
 * Returns a flat list of (key, text) pairs — one per unit field.
 */
export function planUnits(html: string, _file: string): PlanUnit[] {
  const units: PlanUnit[] = [];

  // 1. head meta tags: meta:<name>
  const metaRe = /<meta\s[^>]*name="(chalk:[^"]*)"[^>]*content="([^"]*)"[^>]*/gi;
  let metaM: RegExpExecArray | null;
  while ((metaM = metaRe.exec(html)) !== null) {
    units.push({ key: `meta:${metaM[1] ?? ''}`, text: (metaM[2] ?? '').trim() });
  }

  // 2. flow steps
  const flowHtml = sectionInner(html, 'flow');
  if (flowHtml) {
    for (const { stepKey, fields } of flowSteps(flowHtml)) {
      for (const field of FLOW_FIELDS) {
        const val = fields[field];
        if (val !== undefined) {
          units.push({ key: `flow/${stepKey}:${field}`, text: val });
        }
      }
    }
  }

  // 3. support (stuck items)
  const supportHtml = sectionInner(html, 'support');
  if (supportHtml) {
    for (const { stuckKey, fields } of supportItems(supportHtml)) {
      for (const field of STUCK_FIELDS) {
        const val = fields[field];
        if (val !== undefined) {
          units.push({ key: `support/${stuckKey}:${field}`, text: val });
        }
      }
    }
  }

  // 4. objectives list items
  const objHtml = sectionInner(html, 'objectives');
  if (objHtml) {
    const liRe = /<li[^>]*data-chalk-objective[^>]*>([\s\S]*?)<\/li>/gi;
    let i = 1;
    let liM: RegExpExecArray | null;
    while ((liM = liRe.exec(objHtml)) !== null) {
      units.push({ key: `objectives/obj-${i}`, text: normalize(liM[1] ?? '') });
      i++;
    }
  }

  // 5. evidence list items
  const evHtml = sectionInner(html, 'evidence');
  if (evHtml) {
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let i = 1;
    let liM: RegExpExecArray | null;
    while ((liM = liRe.exec(evHtml)) !== null) {
      units.push({ key: `evidence/ev-${i}`, text: normalize(liM[1] ?? '') });
      i++;
    }
  }

  // 6. prohibited-moves: group by <p-key>/<step>
  const pmHtml = sectionInner(html, 'prohibited-moves');
  if (pmHtml) {
    const groupRe = /<[^>]*data-chalk-prohibited="([^"]*)"[^>]*>([\s\S]*?)<\/(?:ul|ol|div)>/gi;
    let gM: RegExpExecArray | null;
    while ((gM = groupRe.exec(pmHtml)) !== null) {
      const pKey = gM[1] ?? '';
      const groupHtml = gM[2] ?? '';
      const liRe = /<li[^>]*data-chalk-step="([^"]*)"[^>]*>([\s\S]*?)<\/li>/gi;
      let liM: RegExpExecArray | null;
      while ((liM = liRe.exec(groupHtml)) !== null) {
        units.push({
          key: `prohibited-moves/${pKey}/${liM[1] ?? ''}`,
          text: normalize(liM[2] ?? ''),
        });
      }
    }
  }

  // 7. all other named sections: whole section text
  const sectionRe = /<section[^>]*data-chalk-section="([^"]*)"[^>]*>([\s\S]*?)<\/section>/gi;
  let sM: RegExpExecArray | null;
  while ((sM = sectionRe.exec(html)) !== null) {
    const sKey = sM[1] ?? '';
    if (!LESSON_NAMED_SECTIONS.has(sKey)) {
      units.push({ key: sKey, text: normalize(sM[2] ?? '') });
    }
  }

  return units;
}

export interface DiffChange {
  key: string;
  field?: string;
  kind: 'added' | 'removed' | 'changed';
  before: string | null;
  after: string | null;
  truncated?: true;
}

const TRUNC = 1000;

function truncate(s: string | null): { text: string | null; truncated?: true } {
  if (s === null) return { text: null };
  if (s.length <= TRUNC) return { text: s };
  return { text: s.slice(0, TRUNC), truncated: true };
}

/** Diff two snapshots from planUnits(). Returns changed units only. */
export function diffUnits(before: PlanUnit[], after: PlanUnit[]): DiffChange[] {
  const beforeMap = new Map(before.map(u => [u.key, u.text]));
  const afterMap = new Map(after.map(u => [u.key, u.text]));
  const changes: DiffChange[] = [];

  for (const [key, afterText] of afterMap) {
    const bText = beforeMap.get(key);
    if (bText === undefined) {
      const { text: a, truncated } = truncate(afterText);
      const c: DiffChange = { key, kind: 'added', before: null, after: a };
      if (truncated) c.truncated = true;
      changes.push(c);
    } else if (bText !== afterText) {
      const { text: b, truncated: tb } = truncate(bText);
      const { text: a, truncated: ta } = truncate(afterText);
      const c: DiffChange = { key, kind: 'changed', before: b, after: a };
      if (tb || ta) c.truncated = true;
      changes.push(c);
    }
  }
  for (const [key, bText] of beforeMap) {
    if (!afterMap.has(key)) {
      const { text: b, truncated } = truncate(bText);
      const c: DiffChange = { key, kind: 'removed', before: b, after: null };
      if (truncated) c.truncated = true;
      changes.push(c);
    }
  }

  return changes;
}
