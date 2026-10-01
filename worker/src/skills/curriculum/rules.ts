// Curriculum skill validation rules (cr-skills #1396; CR-44, CR-46, CR-47).
//
// A contract names its rules by id; a rule is a pure check of one skill output against the
// Project's stored state (`SkillContext`, read from Venture Memory and the measurement-core
// record, SX-48) and the skill's input. A rule returns problems; any problem refuses the
// whole output and nothing is written (CR-44). Rules never call a model.
//
// Several rules compute a ground truth from stored state and require the output to match it,
// so a skill cannot pass by omission: the Critic must list every claim nothing checks as a
// missing test and every unsupported claim as weak, and must review its own AI's failure cases
// when the product calls an AI; the Deck Builder may patch only the slides the team's decision
// names; the Demo Coach may claim only what reviewed, real evidence supports.

import { EVIDENCE_DRAFT_FORMAT, validateEvidenceDraftShape, type DraftItem, type EvidenceDraft } from "../../lib/measurement-core/interpretation.ts";
import { supportsTeamEvidence } from "../../lib/curriculum/memory.ts";

/** One evidence item as a rule sees it (a projection of memory.ts `EvidenceItemView`). */
export interface SkillEvidenceItem {
  id: string;
  statement: string;
  confidence: "observed" | "interpreted" | "assumed";
  pending_review: boolean;
  sources_real: boolean;
  assumption_status?: "open" | "observed_later";
  experiment_id: string;
}

export interface SkillContext {
  project_id: string;
  week: number;
  items: SkillEvidenceItem[];
  decisions: Array<{ id: string; actor: "student" | "ai"; statement: string; affected_deck_slides: number[]; evidence_refs: string[] }>;
  slides: Array<{ number: number; title: string; body: string; evidence_refs: string[] }>;
  hypotheses: Array<{ id: string; statement: string; status: string }>;
  experiments: Array<{ id: string; hypothesis_id: string; question: string; success_criteria: string[]; week: number }>;
  /**
   * The product version the skill works on, with the text of its source files when read.
   * `unread` names source files whose text could not be read, so a rule that scans the sources
   * can refuse instead of reading "no AI call" into a file it never saw.
   */
  version: { id: string; entry_html: string; files: Array<{ path: string; text?: string }>; unread?: string[] } | null;
}

type Out = Record<string, any>;
type In = Record<string, any>;
export type Rule = (ctx: SkillContext, input: In, output: Out) => string[];

/** Evidence a team's work may rest on: reviewed, not assumed, on real records (memory.ts, one rule). */
export const usableEvidence = (it: SkillEvidenceItem | undefined): boolean => supportsTeamEvidence(it);
const itemMap = (ctx: SkillContext) => new Map(ctx.items.map((i) => [i.id, i]));

/** Problems with a list of evidence refs that must each resolve to evidence the team may rest on. */
function supportProblems(at: string, refs: unknown, items: Map<string, SkillEvidenceItem>): string[] {
  if (!Array.isArray(refs) || refs.length === 0) return [`${at}: no_evidence`];
  const out: string[] = [];
  for (const r of refs) {
    const it = items.get(String(r));
    if (!it) out.push(`${at}: unresolved_evidence_ref:${r}`);
    else if (!usableEvidence(it)) out.push(`${at}: evidence_not_usable:${r}`);
  }
  return out;
}

// ── Claims and what checks them (Critic, CR-47) ──────────────────────────────

export interface Claim {
  id: string;
  text: string;
  evidence_refs: string[];
}

/** The claims a Critic reviews: every current deck slide and every claim the student listed. */
export function claimsOf(ctx: SkillContext, input: In): Claim[] {
  const out: Claim[] = ctx.slides.map((s) => ({ id: `slide:${s.number}`, text: `${s.title}\n${s.body}`.trim(), evidence_refs: s.evidence_refs }));
  for (const c of Array.isArray(input.claims) ? input.claims : []) out.push({ id: String(c.id), text: String(c.text), evidence_refs: Array.isArray(c.evidence_refs) ? c.evidence_refs.map(String) : [] });
  return out;
}

/**
 * Is a claim checked by a verification criterion or an experiment? A verification criterion
 * the student named for it checks it; an experiment checks it only when the claim cites
 * evidence an experiment confirmed: a reviewed item on real records that is not an assumption,
 * or an assumption a later revision observed. A claim resting only on an open assumption, an
 * unreviewed AI item or a record that is not real was never checked: it is a missing test.
 */
export function claimChecked(claim: Claim, ctx: SkillContext, input: In): boolean {
  const criteria = Array.isArray(input.criteria) ? input.criteria : [];
  if (criteria.some((c: { claim_id?: unknown }) => c?.claim_id === claim.id)) return true;
  const items = itemMap(ctx);
  return claim.evidence_refs.some((r) => {
    const it = items.get(r);
    return usableEvidence(it) || (!!it && it.confidence === "assumed" && it.assumption_status === "observed_later" && !it.pending_review && it.sources_real);
  });
}

/** A weak claim: nothing reviewed and real supports it (no refs, or only assumptions, unreviewed AI items or unreal records). */
export const claimWeak = (claim: Claim, ctx: SkillContext): boolean => !claim.evidence_refs.some((r) => usableEvidence(itemMap(ctx).get(r)));

// ── The product's own AI (Critic, CR-47 Week 2: failure and safety review) ──────

const AI_CALL = /hypeproof\.ai\.\w+\s*\(|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com/;
const HANDLES_FAILURE = /\.catch\s*\(|\bcatch\s*[({]|\bonerror\b/;

/** Which product files call an AI, and which of those have no failure handling at all. */
export function aiFailureHandling(files: ReadonlyArray<{ path: string; text?: string }>): { uses_ai: boolean; unhandled: string[] } {
  const calling = files.filter((f) => typeof f.text === "string" && AI_CALL.test(f.text));
  return { uses_ai: calling.length > 0, unhandled: calling.filter((f) => !HANDLES_FAILURE.test(f.text!)).map((f) => f.path) };
}

// ── Interview (CR-47) ───────────────────────────────────────────────────────

/** Phrasings that suggest the answer (Korean and English). */
const LEADING = [
  /않(나요|으세요|을까요|았나요|겠어요|아요)\s*\??$/,
  /(죠|지요|잖아요)\s*\??$/,
  /(좋|편하|편리하|쉽|필요하|유용하)(지|잖)/,
  /(동의하시|그렇게 생각하시)/,
  /얼마나\s*(좋|편|만족|유용|쉽)/,
  // A closed question whose last word is a favourable verdict ("어떤 점이 좋았나요?", "무엇이든 괜찮으세요?").
  /(^|\s)(좋|괜찮|만족|편하|편했|편리|유용)[가-힣]*\s*[?？]?$/,
  /(마음|맘)에\s*(드|들)[가-힣]*\s*[?？]?$/,
  /\b(don't|wouldn't|isn't|aren't|doesn't) (you|it|that)\b/i,
  /\bagree\b/i,
  /\bhow much do you (love|like|enjoy|appreciate)\b/i,
  /^(do|did) you (love|like|enjoy)\b/i,
];
/** An open question asks what, how, why, when, where, who or for a story. */
const OPEN = /(무엇|무슨|뭐|어떻게|어떤|어떠|왜|언제|어디|누가|누구|어느|얼마나 자주|몇|이야기해|말씀해|설명해|보여 ?주|알려 ?주|\b(what|how|why|when|where|who|tell me|describe)\b)/i;

export const isLeadingQuestion = (q: string) => LEADING.some((re) => re.test(q.trim()));
export const isOpenQuestion = (q: string) => OPEN.test(q) && !isLeadingQuestion(q);

/** A note field is a short label to fill in while listening, never a sentence or a quoted answer. */
export const NOTE_LABEL_MAX = 30;
const QUOTE_MARKS = /['"‘’“”「」『』]/;
const SENTENCE_END = /(다|요|함|음|임|죠)\s*[.!?。？！]*$|[.!?。？！]$/;
export const isNoteLabel = (v: string) => v.trim().length > 0 && v.trim().length <= NOTE_LABEL_MAX && !QUOTE_MARKS.test(v) && !SENTENCE_END.test(v.trim());

// ── Quantities in free text (Demo Coach, CR-47) ───────────────────────────────

/**
 * Numbers and quantity words a sentence asserts: a number (a week reference such as "2주차"
 * or an ordinal "3번째" is not a quantity), a Korean counted number ("세 명"), and words that
 * claim a share or a frequency ("모두", "매일", "대부분"). Normalised so the same quantity in a
 * claim matches: digits keep only the number, words lose spaces and case.
 */
const QUANTITY = /(\d+(?:[.,]\d+)*)(?!\s*(?:주차|번째|\d))|(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*(?:명|번|회|개|초|분|배|시간)|절반|대부분|모두|모든|전부|다들|누구나|매일|항상|언제나|\b(?:everyone|everybody|always|all|most|half|percent)\b/gi;
export function quantitiesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(QUANTITY)) out.push(m[1] !== undefined ? m[1].replace(/,/g, "") : m[0].replace(/\s+/g, "").toLowerCase());
  return out;
}

/** The fixed answer to a question the team has no evidence for (Demo Coach): the only answer without a claim. */
export const DEMO_NOT_CONFIRMED = "아직 확인하지 못했어요";
const isNotConfirmedAnswer = (v: unknown) => typeof v === "string" && v.trim().replace(/[.!。]+$/, "") === DEMO_NOT_CONFIRMED;

// ── Evidence (CR-46): the output as an hps-evidence-draft/1 revision 1 by the AI ──

/** The draft the Evidence skill's output becomes: revision 1, author `ai`, every item a draft (MC-22). */
export function evidenceDraftOf(output: Out, input: In, at: { id: string; now: number; skill: string }): EvidenceDraft {
  return {
    format: EVIDENCE_DRAFT_FORMAT,
    id: at.id,
    revision: 1,
    supersedes: null,
    experiment: String(input.experiment_id ?? ""),
    author: "ai",
    created_at: at.now,
    skill: at.skill,
    items: (Array.isArray(output.items) ? output.items : []).map((i: Out) => ({ id: i.id, section: i.section, text: i.text, source_refs: i.source_refs ?? [], review: "draft" }) as DraftItem),
  } as EvidenceDraft;
}

// ── The rules ───────────────────────────────────────────────────────────────

export const RULES: Record<string, Rule> = {
  // Experiment (CR-46): the assumption tested is one the Project still holds open.
  experiment_tests_open_assumption: (ctx, _input, out) => {
    const open = ctx.items.filter((i) => i.confidence === "assumed" && i.assumption_status !== "observed_later");
    const ref = out.assumption_ref;
    if (ref === undefined) return open.length ? ["$.assumption_ref: open_assumption_not_chosen"] : [];
    const it = itemMap(ctx).get(String(ref));
    if (!it) return [`$.assumption_ref: unresolved_evidence_ref:${ref}`];
    if (it.confidence !== "assumed" || it.assumption_status === "observed_later") return [`$.assumption_ref: not_an_open_assumption:${ref}`];
    return [];
  },
  // Experiment (CR-46): every success criterion can be counted (a number, or a counted word).
  experiment_criteria_countable: (_ctx, _input, out) =>
    (Array.isArray(out.success_criteria) ? out.success_criteria : []).flatMap((c: unknown, i: number) =>
      /\d|(한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*(명|번|회|개|초|분)/.test(String(c)) ? [] : [`$.success_criteria[${i}]: not_countable`],
    ),
  // Evidence (CR-46, SX-48): the output is a valid evidence draft by the AI; every observation cites records.
  evidence_draft_valid: (_ctx, input, out) => {
    try {
      validateEvidenceDraftShape(evidenceDraftOf(out, input, { id: "skill-check", now: 1, skill: "evidence@0.0.0" }));
    } catch (e) {
      return [`$: ${e instanceof Error ? e.message : "invalid_evidence_draft"}`];
    }
    return (Array.isArray(out.items) ? out.items : []).flatMap((i: Out, n: number) => (i.section === "observation" && !(Array.isArray(i.source_refs) && i.source_refs.length) ? [`$.items[${n}]: observation_without_source_refs`] : []));
  },
  // Product Builder (CR-46): every change is justified by evidence the student chose to act on.
  product_changes_cite_selected_evidence: (ctx, input, out) => {
    const items = itemMap(ctx);
    const selected = new Set(Array.isArray(input.evidence_refs) ? input.evidence_refs.map(String) : []);
    return (Array.isArray(out.changes) ? out.changes : []).flatMap((ch: Out, i: number) => {
      const at = `$.changes[${i}]`;
      const p = supportProblems(at, ch.evidence_refs, items);
      for (const r of Array.isArray(ch.evidence_refs) ? ch.evidence_refs : []) if (!selected.has(String(r))) p.push(`${at}: evidence_not_selected:${r}`);
      return p;
    });
  },
  // Product Builder (CR-46): a change touches a file of the product version; a new file is declared as one.
  product_paths_in_version: (ctx, _input, out) => {
    const paths = new Set((ctx.version?.files ?? []).map((f) => f.path));
    if (!ctx.version) return ["$: no_product_version"];
    return (Array.isArray(out.changes) ? out.changes : []).flatMap((ch: Out, i: number) => {
      const exists = paths.has(String(ch.path));
      if (ch.kind === "add") return exists ? [`$.changes[${i}]: add_of_existing_file:${ch.path}`] : [];
      return exists ? [] : [`$.changes[${i}]: path_not_in_version:${ch.path}`];
    });
  },
  // Deck Builder (CR-46): only the slides the team's decision names, one patch each.
  deck_patches_affected_only: (ctx, input, out) => {
    const d = ctx.decisions.find((x) => x.id === input.decision_id);
    if (!d) return ["$: decision_unresolved"];
    if (d.actor !== "student") return ["$: decision_is_ai_suggestion"];
    const seen = new Set<number>();
    return (Array.isArray(out.patches) ? out.patches : []).flatMap((p: Out, i: number) => {
      const out2: string[] = [];
      if (!d.affected_deck_slides.includes(p.slide)) out2.push(`$.patches[${i}]: slide_not_affected:${p.slide}`);
      if (seen.has(p.slide)) out2.push(`$.patches[${i}]: duplicate_slide:${p.slide}`);
      seen.add(p.slide);
      return out2;
    });
  },
  // Deck Builder (CR-46): every patch carries evidence the team may rest on.
  deck_patches_cite_evidence: (ctx, _input, out) => {
    const items = itemMap(ctx);
    return (Array.isArray(out.patches) ? out.patches : []).flatMap((p: Out, i: number) => supportProblems(`$.patches[${i}]`, p.evidence_refs, items));
  },
  // Interview (CR-47): open questions only, none leading.
  interview_questions_open: (_ctx, _input, out) =>
    (Array.isArray(out.questions) ? out.questions : []).flatMap((q: Out, i: number) => {
      const text = String(q.text ?? "");
      if (isLeadingQuestion(text)) return [`$.questions[${i}]: leading_question`];
      return isOpenQuestion(text) ? [] : [`$.questions[${i}]: not_open`];
    }),
  // Interview (CR-47): structured notes quote only what the student's notes say, under one of the
  // note fields; no answer is written for the interviewee, in a quote or in a topic.
  interview_notes_verbatim: (_ctx, input, out) => {
    const notes = typeof input.notes === "string" ? input.notes : "";
    const fields = new Set((Array.isArray(out.note_fields) ? out.note_fields : []).map(String));
    return (Array.isArray(out.structured_notes) ? out.structured_notes : []).flatMap((n: Out, i: number) => {
      const quote = String(n.quote ?? "").trim();
      const p: string[] = [];
      if (!fields.has(String(n.topic))) p.push(`$.structured_notes[${i}].topic: not_a_note_field`);
      if (!notes) p.push(`$.structured_notes[${i}]: answer_without_notes`);
      else if (!(quote && notes.includes(quote))) p.push(`$.structured_notes[${i}]: answer_not_in_notes`);
      return p;
    });
  },
  // Interview (CR-47): a note field is a short label, never a sentence or a quoted answer.
  interview_note_fields_are_labels: (_ctx, _input, out) =>
    (Array.isArray(out.note_fields) ? out.note_fields : []).flatMap((f: unknown, i: number) => (isNoteLabel(String(f)) ? [] : [`$.note_fields[${i}]: not_a_label`])),
  // Critic (CR-47): every claim the output names exists.
  critic_claims_known: (ctx, input, out) => {
    const ids = new Set(claimsOf(ctx, input).map((c) => c.id));
    const out2: string[] = [];
    for (const key of ["weak_claims", "missing_tests"]) for (const [i, x] of (Array.isArray(out[key]) ? out[key] : []).entries()) if (!ids.has(String(x.claim_id))) out2.push(`$.${key}[${i}]: unknown_claim:${x.claim_id}`);
    return out2;
  },
  // Critic (CR-47): every claim that no verification criterion or experiment checks is a missing test.
  critic_lists_missing_tests: (ctx, input, out) => {
    const listed = new Set((Array.isArray(out.missing_tests) ? out.missing_tests : []).map((x: Out) => String(x.claim_id)));
    return claimsOf(ctx, input).filter((c) => !claimChecked(c, ctx, input) && !listed.has(c.id)).map((c) => `$.missing_tests: not_listed:${c.id}`);
  },
  // Critic (CR-47): every claim nothing reviewed and real supports is a weak claim.
  critic_lists_weak_claims: (ctx, input, out) => {
    const listed = new Set((Array.isArray(out.weak_claims) ? out.weak_claims : []).map((x: Out) => String(x.claim_id)));
    return claimsOf(ctx, input).filter((c) => claimWeak(c, ctx) && !listed.has(c.id)).map((c) => `$.weak_claims: not_listed:${c.id}`);
  },
  // Critic (CR-47, Week 2): a product that calls an AI gets a failure review of wrong, unsafe and unavailable answers; a missing handler is named.
  critic_reviews_ai_failure: (ctx, _input, out) => {
    const { uses_ai, unhandled } = aiFailureHandling(ctx.version?.files ?? []);
    const review = Array.isArray(out.ai_failure_review) ? out.ai_failure_review : [];
    // A source file the Service could not read may call an AI: "no AI" is not known, so nothing is accepted.
    if (!uses_ai && ctx.version?.unread?.length) return [`$.ai_failure_review: sources_not_read:${ctx.version.unread.join(",")}`];
    if (!uses_ai) return review.length ? ["$.ai_failure_review: product_has_no_ai"] : [];
    const problems: string[] = [];
    for (const kase of ["wrong", "unsafe", "unavailable"]) if (!review.some((r: Out) => r.case === kase)) problems.push(`$.ai_failure_review: case_missing:${kase}`);
    const unavailable = review.find((r: Out) => r.case === "unavailable");
    if (unhandled.length && unavailable && unavailable.handling !== "missing") problems.push(`$.ai_failure_review: unhandled_failure_not_named:${unhandled.join(",")}`);
    return problems;
  },
  // Demo Coach (CR-47, SX-48): every claim in the demo flow and the Q&A rests on reviewed, real evidence.
  // The free text a student reads is checked too: an answer either carries a claim or is the fixed
  // "not confirmed" answer, and every number or quantity word in `show` or `answer` appears in a
  // supported claim of the same entry.
  demo_claims_supported: (ctx, _input, out) => {
    const items = itemMap(ctx);
    const problems: string[] = [];
    for (const [key, list, textKey] of [["flow", out.flow, "show"], ["qa", out.qa, "answer"]] as const) {
      for (const [i, entry] of (Array.isArray(list) ? list : []).entries()) {
        const claims: Out[] = Array.isArray(entry.claims) ? entry.claims : [];
        const supported = new Set<string>();
        for (const [j, claim] of claims.entries()) {
          const p = supportProblems(`$.${key}[${i}].claims[${j}]`, claim.evidence_refs, items);
          problems.push(...p);
          if (!p.length) for (const q of quantitiesIn(String(claim.text ?? ""))) supported.add(q);
        }
        if (key === "qa" && !claims.length && !isNotConfirmedAnswer(entry.answer)) problems.push(`$.qa[${i}]: answer_without_claim`);
        for (const q of new Set(quantitiesIn(String(entry[textKey] ?? "")))) if (!supported.has(q)) problems.push(`$.${key}[${i}].${textKey}: unsupported_quantity:${q}`);
      }
    }
    return problems;
  },
};

export const RULE_IDS: ReadonlySet<string> = new Set(Object.keys(RULES));
