// #751 U3 — "초안에 가져오기": an instructor prompt enters the learner's input ONLY by the learner's own press, as one
// functional state update inside the webview. Pure rules; ChatPanel applies them with `setDraft(d => …)` so the draft that
// is merged into is the one that exists at the moment of the press — text typed after the card was drawn is never lost.
//
//   - It APPENDS. There is no replace option: appending is the one behaviour that needs no confirmation and loses nothing.
//   - It never sends, never calls a model, never touches attachments or a parked (queued) message.
//   - Undo restores the previous draft only while the text is byte-identical to the just-imported state; one keystroke
//     later it is the learner's text and is left alone.
export const DRAFT_MAX_CHARS = 200_000; // the same bound activityDraft.ts validates
export interface ImportRef { object_id: string; revision: number; hash16: string }
export type ImportResult = { ok: true; draft: string } | { ok: false; reason: "too_long" | "empty" };

export function importIntoDraft(draft: string, body: string): ImportResult {
  if (!body) return { ok: false, reason: "empty" };
  // The learner's own text is kept exactly as typed; only the separator between it and the imported text is chosen.
  const next = draft === "" ? body : draft + (draft.endsWith("\n\n") ? "" : draft.endsWith("\n") ? "\n" : "\n\n") + body;
  return next.length > DRAFT_MAX_CHARS ? { ok: false, reason: "too_long" } : { ok: true, draft: next };
}
export interface LastImport { before: string; after: string; object_id: string; revision: number }
export const canUndoImport = (current: string, last: LastImport | null): boolean => !!last && current === last.after;
/** Bodiless provenance kept with the draft: which instructor prompt (and which revision of it) was imported into it. */
export function addImportRef(refs: readonly ImportRef[], ref: ImportRef): ImportRef[] {
  return [...refs.filter((r) => !(r.object_id === ref.object_id && r.revision === ref.revision)), ref].slice(-8);
}
export const dropImportRef = (refs: readonly ImportRef[], ref: { object_id: string; revision: number }): ImportRef[] => refs.filter((r) => !(r.object_id === ref.object_id && r.revision === ref.revision));
