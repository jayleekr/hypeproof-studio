/** Local draft contract. No credential or execution permission belongs here. */
/** `imports` (#751 U3): bodiless references to instructor prompts the learner imported into this draft. Local provenance, never an instruction. */
export interface ActivityDraft { text: string; images: string[]; queued: string | null; imports?: Array<{ object_id: string; revision: number; hash16: string }> }
export const emptyActivityDraft = (): ActivityDraft => ({text:'',images:[],queued:null});
export function validActivityDraft(value: unknown): value is ActivityDraft {
  if (!value || typeof value !== 'object') return false;
  const d=value as ActivityDraft;
  return typeof d.text==='string' && d.text.length<=200000 &&
    (d.queued===null || typeof d.queued==='string' && d.queued.length<=200000) &&
    Array.isArray(d.images) && d.images.length<=10 && d.images.every(i=>typeof i==='string' && /^data:image\//.test(i) && i.length<=12000000) &&
    (d.imports===undefined || Array.isArray(d.imports) && d.imports.length<=8 && d.imports.every(r=>!!r && typeof r.object_id==='string' && /^[A-Za-z0-9-]{8,64}$/.test(r.object_id) && Number.isSafeInteger(r.revision) && r.revision>0 && typeof r.hash16==='string' && /^[a-f0-9]{16}$/.test(r.hash16) && Object.keys(r).length===3));
}
