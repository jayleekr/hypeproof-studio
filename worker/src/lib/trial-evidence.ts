// Portable Service policy. Curriculum prose is data in docs/curriculum/studio-trial.
// Public browser observations are learning evidence, never authenticated credentials.
export const TRIAL_FORMAT = 'hps-trial/1';
export const ASSETS = ['TASTE', 'INTENT', 'CONTEXT', 'VERIFY', 'DELEGATE', 'ITERATE', 'OWNERSHIP'] as const;
export type Asset = typeof ASSETS[number];
export type Signal = 'partial' | 'full' | 'missed';
export type Mode = 'initial' | 'coached' | 'transfer';
export interface Choice { id: string; label: string; signal: Signal; explanation: string }
export interface Item { id: string; asset: Asset; prompt: string; options: Choice[] }
export interface Form { id: string; title: string; brief: string; sources: string[]; draft: string; items: Item[] }
export interface Approach { id: string; name: string; choice: string; strength: string; watch: string }
export interface Curriculum {
  format: string; version: string;
  contexts: { id: string; name: string; connection: string }[];
  approaches: Approach[];
  assets: { id: Asset; name: string; next: string }[];
  levels: { level: number; name: string; evidence: string }[];
  forms: Form[];
}
export interface TrialEvent { form: string; item: string; choice: string; mode: Mode }
export interface TrialSession { format: string; version: string; approach: string; events: TrialEvent[] }
export interface Observation { choice: string; label: string; signal: Signal | 'unobserved'; explanation: string }
export interface AssetResult {
  asset: Asset; level: number | null; beforeLevel: number | null;
  status: 'unobserved' | 'needs-evidence' | 'observed';
  initial: Observation | null; coached: Observation | null; transfer: Observation | null;
}
export interface TrialResult { assets: AssetResult[]; level: number | null; observed: number; approach: Approach; nextAsset: Asset | null }
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function requireCondition(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

export function validateCurriculum(value: unknown): asserts value is Curriculum {
  requireCondition(record(value) && value.format === TRIAL_FORMAT && typeof value.version === 'string', 'invalid curriculum version');
  requireCondition(Array.isArray(value.forms) && value.forms.length === 2, 'two distinct forms required');
  const ids = new Set<string>();
  for (const raw of value.forms) {
    requireCondition(record(raw) && typeof raw.id === 'string' && !ids.has(raw.id), 'duplicate form'); ids.add(raw.id);
    requireCondition(typeof raw.title === 'string' && typeof raw.brief === 'string' && typeof raw.draft === 'string' && Array.isArray(raw.sources) && raw.sources.every(s => typeof s === 'string'), 'invalid scenario');
    requireCondition(Array.isArray(raw.items) && raw.items.length === ASSETS.length, 'seven items required');
    const assets = new Set<string>(); const items = new Set<string>();
    for (const item of raw.items) {
      requireCondition(record(item) && typeof item.id === 'string' && !items.has(item.id) && typeof item.asset === 'string' && ASSETS.includes(item.asset as Asset) && !assets.has(item.asset), 'invalid item');
      items.add(item.id); assets.add(item.asset);
      requireCondition(typeof item.prompt === 'string' && Array.isArray(item.options) && item.options.length === 3, 'three options required');
      const options = new Set<string>(); const signals = new Set<string>();
      for (const option of item.options) {
        requireCondition(record(option) && typeof option.id === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(option.id) && option.id !== 'skip' && !options.has(option.id), 'invalid choice');
        requireCondition(typeof option.label === 'string' && typeof option.explanation === 'string' && ['partial', 'full', 'missed'].includes(String(option.signal)), 'invalid choice content');
        options.add(option.id); signals.add(String(option.signal));
      }
      requireCondition(signals.size === 3, 'each signal must be represented');
    }
  }
  const assetDefinitions = value.assets;
  requireCondition(Array.isArray(assetDefinitions) && assetDefinitions.length === 7 && ASSETS.every(a => assetDefinitions.filter((v: unknown) => record(v) && v.id === a && typeof v.name === 'string' && typeof v.next === 'string').length === 1), 'invalid assets');
  requireCondition(Array.isArray(value.approaches) && value.approaches.length === 4, 'four approaches required');
  const approaches = new Set<string>();
  for (const a of value.approaches) {
    requireCondition(record(a) && typeof a.id === 'string' && /^[a-z-]{1,30}$/.test(a.id) && !approaches.has(a.id) && ['name','choice','strength','watch'].every(k => typeof a[k] === 'string'), 'invalid approach'); approaches.add(a.id);
  }
  requireCondition(Array.isArray(value.contexts) && value.contexts.length > 0 && value.contexts.every(c => record(c) && ['id','name','connection'].every(k => typeof c[k] === 'string')), 'invalid contexts');
  requireCondition(Array.isArray(value.levels) && value.levels.length === 5 && value.levels.every((l, i) => record(l) && l.level === i + 1 && typeof l.name === 'string' && typeof l.evidence === 'string'), 'five levels required');
}

export function validateSession(value: unknown, curriculum: Curriculum): asserts value is TrialSession {
  validateCurriculum(curriculum);
  requireCondition(record(value) && value.format === TRIAL_FORMAT && value.version === curriculum.version, 'unsupported trial version');
  requireCondition(curriculum.approaches.some(a => a.id === value.approach), 'invalid approach');
  requireCondition(Array.isArray(value.events) && value.events.length <= 21, 'invalid event count');
  const seen = new Set<string>(); const initial = new Set<string>(); let phase = 'initial';
  for (const event of value.events) {
    requireCondition(record(event) && ['initial','coached','transfer'].includes(String(event.mode)), 'invalid mode');
    const form = curriculum.forms[event.mode === 'transfer' ? 1 : 0]!;
    requireCondition(event.form === form.id, 'mode/form mismatch');
    const item = form.items.find(i => i.id === event.item);
    requireCondition(item && (event.choice === 'skip' || item.options.some(o => o.id === event.choice)), 'unknown item or choice');
    const key = `${event.mode}:${event.item}`;
    requireCondition(!seen.has(key), 'duplicate observation'); seen.add(key);
    if (event.mode === 'initial') {
      requireCondition(phase === 'initial', 'initial observations are frozen'); initial.add(String(event.item));
    } else {
      requireCondition(initial.size === 7, 'complete initial form first');
      requireCondition(event.mode !== 'coached' || phase !== 'transfer', 'coaching must precede transfer'); phase = String(event.mode);
    }
  }
}

export function evaluateTrial(value: unknown, curriculum: Curriculum): TrialResult {
  validateSession(value, curriculum);
  const observe = (asset: Asset, mode: Mode): Observation | null => {
    const form = curriculum.forms[mode === 'transfer' ? 1 : 0]!;
    const item = form.items.find(i => i.asset === asset)!;
    const event = value.events.find(e => e.mode === mode && e.item === item.id);
    if (!event) return null;
    if (event.choice === 'skip') return { choice: 'skip', label: '아직 모르겠어요', signal: 'unobserved', explanation: '선택을 유보했어요. 이 자산은 다른 과제에서 더 살펴볼 수 있어요.' };
    const option = item.options.find(o => o.id === event.choice)!;
    return { choice: option.id, label: option.label, signal: option.signal, explanation: option.explanation };
  };
  const toLevel = (o: Observation | null) => o?.signal === 'full' ? 2 : o?.signal === 'partial' ? 1 : null;
  const assets: AssetResult[] = ASSETS.map(asset => {
    const initial = observe(asset, 'initial'); const coached = observe(asset, 'coached'); const transfer = observe(asset, 'transfer');
    const beforeLevel = toLevel(initial); const other = toLevel(transfer);
    const level = initial?.signal === 'full' && transfer?.signal === 'full' ? 3 : beforeLevel === null ? other : other === null ? beforeLevel : Math.max(beforeLevel, other);
    return { asset, level, beforeLevel, initial, coached, transfer, status: level !== null ? 'observed' : [initial, transfer].some(o => o?.signal === 'missed') ? 'needs-evidence' : 'unobserved' };
  });
  const observed = assets.filter(a => a.level !== null).length;
  return { assets, observed, level: observed === 7 ? Math.min(...assets.map(a => a.level!)) : null,
    approach: curriculum.approaches.find(a => a.id === value.approach)!,
    nextAsset: assets.find(a => a.level === null)?.asset ?? assets.find(a => a.level! < 3)?.asset ?? null };
}

// Fragment contains only a public approach label, never scores, answers, job text or identity.
export function parseTrialShare(hash: string, curriculum: Curriculum): string | null {
  if (hash.length > 60 || !hash.startsWith('#approach=')) return null;
  const id = hash.slice(10);
  return curriculum.approaches.some(a => a.id === id) ? id : null;
}
