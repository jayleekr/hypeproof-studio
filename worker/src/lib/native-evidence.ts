import type { ObservationBatch } from "./native-observation";
export interface EvidenceSelection {
  quote_id: string;
  event_id: string;
  quote: string;
}
/** The model selects immutable source excerpts; it never authors citations. */
export function makeEvidenceCatalog(
  batch: ObservationBatch,
): EvidenceSelection[] {
  const entries: EvidenceSelection[] = [];
  for (const event of batch.events) {
    for (const line of event.text.split("\n")) {
      for (let offset = 0; offset < line.length; offset += 300) {
        const quote = line.slice(offset, offset + 300);
        if (quote.trim())
          entries.push({
            quote_id: "q" + entries.length,
            event_id: event.id,
            quote,
          });
      }
    }
  }
  return entries;
}
export function resolveEvidenceSelections(
  value: unknown,
  catalog: EvidenceSelection[],
): unknown {
  if (!Array.isArray(value)) throw Error("invalid_findings");
  const byId = new Map(catalog.map((e) => [e.quote_id, e]));
  return value.map((f) => {
    if (!f || typeof f !== "object") throw Error("invalid_evidence");
    if (f.status === "unobserved") {
      if ("evidence" in f || "assistance" in f)
        throw Error("unobserved_with_evidence");
      return { ...f, evidence: [], assistance: "unknown" };
    }
    if (!Array.isArray(f.evidence)) throw Error("invalid_evidence");
    return {
      ...f,
      evidence: f.evidence.map((selection: unknown) => {
        if (
          !selection ||
          typeof selection !== "object" ||
          Object.keys(selection).join() !== "quote_id"
        )
          throw Error("invalid_quote_selection");
        const entry = byId.get((selection as { quote_id: string }).quote_id);
        if (!entry) throw Error("invalid_quote_selection");
        return { event_id: entry.event_id, quote: entry.quote };
      }),
    };
  });
}
