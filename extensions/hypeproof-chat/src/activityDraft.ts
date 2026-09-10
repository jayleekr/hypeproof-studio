/** Local draft contract. No credential or execution permission belongs here. */
export interface ActivityDraft { text: string; images: string[]; queued: string | null }
export const emptyActivityDraft = (): ActivityDraft => ({text:'',images:[],queued:null});
export function validActivityDraft(value: unknown): value is ActivityDraft {
  if (!value || typeof value !== 'object') return false;
  const d=value as ActivityDraft;
  return typeof d.text==='string' && d.text.length<=200000 &&
    (d.queued===null || typeof d.queued==='string' && d.queued.length<=200000) &&
    Array.isArray(d.images) && d.images.length<=10 && d.images.every(i=>typeof i==='string' && /^data:image\//.test(i) && i.length<=12000000);
}
