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
 * Is a claim checked by an experiment? Only when the claim cites evidence an experiment
 * confirmed: a reviewed item on real records that is not an assumption, or an assumption a
 * later revision observed. A claim resting only on an open assumption, an unreviewed AI item or
 * a record that is not real was never checked: it is a missing test. A verification criterion
 * does not count here: the stored `cr-verify` criteria name no claim, and a criterion typed into
 * the input would be the model's or the student's word, not a stored check (review round 2).
 */
export function claimChecked(claim: Claim, ctx: SkillContext, _input: In): boolean {
  const items = itemMap(ctx);
  return claim.evidence_refs.some((r) => {
    const it = items.get(r);
    return usableEvidence(it) || (!!it && it.confidence === "assumed" && it.assumption_status === "observed_later" && !it.pending_review && it.sources_real);
  });
}

/** A weak claim: nothing reviewed and real supports it (no refs, or only assumptions, unreviewed AI items or unreal records). */
export const claimWeak = (claim: Claim, ctx: SkillContext): boolean => !claim.evidence_refs.some((r) => usableEvidence(itemMap(ctx).get(r)));

// ── The product's own AI (Critic, CR-47 Week 2: failure and safety review) ──────

/**
 * A reference to the product's AI: the `hypeproof.ai` SDK object (called directly or through an
 * alias such as `const ai = window.hypeproof.ai`), a provider host, or a provider API path.
 */
const AI_CALL = /\bhypeproof\.ai\b|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|openrouter\.ai|api\.groq\.com|api\.mistral\.ai|api\.together\.xyz|api\.deepseek\.com|api\.x\.ai|\/v1\/chat\/completions|\/v1\/messages\b/;
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
  // The same verdict in an embedded or request form ("좋았는지 이야기해 주세요", "편리하다고 느끼셨어요?",
  // "좋다고 생각하세요?"). "불편했는지" and "안 좋았는지" ask about a problem and stay open.
  /(?<!불|안\s?)(좋|괜찮|만족|편하|편했|편리|유용|쉬웠|쉽)[가-힣]*?(는지|은지|다고|다는)/,
  /(마음|맘)에\s*(드|들)[가-힣]*?(는지|은지|다고|다는)/,
  // A question that praises the product for the interviewee ("이 훌륭한 앱").
  /(훌륭|멋진|멋지|최고|대단|완벽)/,
  /\b(don't|wouldn't|isn't|aren't|doesn't) (you|it|that)\b/i,
  /\bagree\b/i,
  /\bhow much do you (love|like|enjoy|appreciate)\b/i,
  /^(do|did) you (love|like|enjoy)\b/i,
  /\bwhat did you (love|like|enjoy)\b/i,
  /\bwhy (is|was|are|were) (it|this|that|they|the [a-z]+) (so |much )?(better|easier|great|good|helpful)\b/i,
  /\bhow (great|good|easy|helpful|useful|nice|amazing) (is|was|were|are)\b/i,
];
/** An open question asks what, how, why, when, where, who or for a story. */
const OPEN = /(무엇|무슨|뭐|어떻게|어떤|어떠|왜|언제|어디|누가|누구|어느|얼마나 자주|몇|이야기해|말씀해|설명해|보여 ?주|알려 ?주|\b(what|how|why|when|where|who|tell me|describe)\b)/i;

export const isLeadingQuestion = (q: string) => LEADING.some((re) => re.test(q.trim()));
export const isOpenQuestion = (q: string) => OPEN.test(q) && !isLeadingQuestion(q);

/** A note field is a short label to fill in while listening, never a sentence or a quoted answer. */
export const NOTE_LABEL_MAX = 30;
const QUOTE_MARKS = /['"‘’“”「」『』]/;
const SENTENCE_END = /(다|요|함|음|임|죠)\s*[.!?。？！]*$|[.!?。？！]$/;
/** An embedded statement ("…쓴다는 의견", "…비싸다고") or a past-tense result ("올랐", "했"): a label carries none. */
const EMBEDDED_CLAUSE = /(다는|다고|라는|라고)/;
const hasPastSyllable = (v: string) => [...v].some((ch) => {
  const c = ch.charCodeAt(0) - 0xac00;
  return ch !== "있" && c >= 0 && c < 11172 && c % 28 === 20; // final ㅆ: 했, 됐, 올랐, 좋겠 ("있" alone is not a result)
});
/** Does free text state something (a sentence, an embedded statement or a past-tense result)? */
export const asserts = (v: string) => SENTENCE_END.test(v.trim()) || EMBEDDED_CLAUSE.test(v) || hasPastSyllable(v);
export const isNoteLabel = (v: string) => v.trim().length > 0 && v.trim().length <= NOTE_LABEL_MAX && !QUOTE_MARKS.test(v) && !SENTENCE_END.test(v.trim()) && !EMBEDDED_CLAUSE.test(v);

/**
 * Is `quote` a whole clause of `notes`: present, and neither cut out of a longer clause at its
 * start ("좋았어요" out of "안 좋았어요") nor at its end? A boundary is the start or end of the
 * notes, white space after punctuation, a quote mark or punctuation.
 */
const CLAUSE_EDGE = /['"‘’“”「」『』()\[\].,!?;:。？！…\n]/;
export function isWholeClauseOf(quote: string, notes: string): boolean {
  if (!quote) return false;
  for (let at = notes.indexOf(quote); at >= 0; at = notes.indexOf(quote, at + 1)) {
    const before = notes.slice(0, at).replace(/[ \t]+$/, "");
    const after = notes.slice(at + quote.length);
    const startOk = before === "" || CLAUSE_EDGE.test(before.slice(-1)) || CLAUSE_EDGE.test(quote[0]!);
    const endOk = after === "" || CLAUSE_EDGE.test(after[0]!) || CLAUSE_EDGE.test(quote.slice(-1));
    if (startOk && endOk) return true;
  }
  return false;
}

// ── Quantities in free text (Demo Coach, CR-47) ───────────────────────────────

/**
 * Numbers and quantity words a sentence asserts, each normalised to one form so the same
 * quantity matches wherever it is written: a number in digits (full-width too), a Korean
 * counted number in native words ("세 명", "스무 명", "열두 번") or Sino-Korean words with a
 * place value ("백 명", "이십 명"), an English number word ("three", "twice", "hundred") all
 * become their value ("3", "20", "100"); words that claim a share or a frequency ("모두",
 * "매일", "대다수", "아무도", "everyone") keep the word. A week reference ("2주차") or an
 * ordinal ("3번째") is not a quantity. Korean number words count only before a counter, since
 * "한" or "이" alone are ordinary words. "one" is left out for the same reason.
 */
const COUNTER = "(?:명|분|사람|번(?!째)|회|개|가지|곳|군데|초|시간|배|일|주(?!차)|달|개월|년|살|퍼센트|프로)";
const NATIVE_TENS: Record<string, number> = { 열: 10, 스물: 20, 스무: 20, 서른: 30, 마흔: 40, 쉰: 50, 예순: 60, 일흔: 70, 여든: 80, 아흔: 90 };
const NATIVE_UNITS: Record<string, number> = { 한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 석: 3, 네: 4, 넷: 4, 넉: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9 };
const SINO_DIGITS: Record<string, number> = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
const SINO_PLACES: Record<string, number> = { 십: 10, 백: 100, 천: 1000, 만: 10000 };
const EN_NUMBERS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, dozen: 12, twice: 2, thrice: 3 };
const SHARE_WORDS = "절반|대부분|대다수|다수|과반|모두|모든|전부|다들|누구나|아무도|아무것도|누구도|매일|항상|언제나";
const EN_SHARE_WORDS = "everyone|everybody|nobody|always|never|all|most|half|majority|none|percent";
const QUANTITY = new RegExp(
  [
    "(?<digits>\\d+(?:[.,]\\d+)*)(?!\\s*(?:주차|번째|\\d))",
    `(?<![가-힣])(?<native>(?:(?:${Object.keys(NATIVE_TENS).join("|")})\\s?(?:${Object.keys(NATIVE_UNITS).join("|")})?|(?:${Object.keys(NATIVE_UNITS).join("|")})))\\s*${COUNTER}`,
    `(?<![가-힣])(?<sino>(?:[일이삼사오육칠팔구]?[십백천만])+[일이삼사오육칠팔구]?)\\s*${COUNTER}`,
    `\\b(?<en>${Object.keys(EN_NUMBERS).join("|")})\\b`,
    `(?<share>${SHARE_WORDS})`,
    `\\b(?<enshare>${EN_SHARE_WORDS})\\b`,
  ].join("|"),
  "gi",
);
function nativeValue(words: string): number {
  const w = words.replace(/\s+/g, "");
  for (const [tens, tv] of Object.entries(NATIVE_TENS)) if (w.startsWith(tens)) return tv + (NATIVE_UNITS[w.slice(tens.length)] ?? 0);
  return NATIVE_UNITS[w] ?? NaN;
}
function sinoValue(words: string): number {
  let total = 0;
  let digit = 0;
  for (const ch of words) {
    if (ch in SINO_DIGITS) digit = SINO_DIGITS[ch]!;
    else {
      total += (digit || 1) * SINO_PLACES[ch]!;
      digit = 0;
    }
  }
  return total + digit;
}
export function quantitiesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize("NFKC").matchAll(QUANTITY)) {
    const g = m.groups!;
    if (g.digits !== undefined) out.push(g.digits.replace(/,/g, ""));
    else if (g.native !== undefined) out.push(String(nativeValue(g.native)));
    else if (g.sino !== undefined) out.push(String(sinoValue(g.sino)));
    else if (g.en !== undefined) out.push(String(EN_NUMBERS[g.en.toLowerCase()]));
    else out.push((g.share ?? g.enshare ?? m[0]).toLowerCase());
  }
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
      quantitiesIn(String(c)).some((q) => /^\d/.test(q)) ? [] : [`$.success_criteria[${i}]: not_countable`],
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
      else if (!isWholeClauseOf(quote, notes)) p.push(`$.structured_notes[${i}]: answer_not_in_notes`);
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
  // Demo Coach (CR-47, SX-48): every claim in the demo flow and the Q&A rests on reviewed, real evidence,
  // and says no more than that evidence: every quantity in a claim's text is in the statement of an
  // item it cites. The free text a student reads is checked too: an answer carries a claim unless it
  // is the fixed "not confirmed" answer; a `show` with no claim is a short label that states nothing;
  // a `step` states no result; and every quantity in `step`, `show` or `answer` is in a supported
  // claim of the same entry.
  demo_claims_supported: (ctx, _input, out) => {
    const items = itemMap(ctx);
    const problems: string[] = [];
    for (const [key, list, textKeys] of [["flow", out.flow, ["step", "show"]], ["qa", out.qa, ["answer"]]] as const) {
      for (const [i, entry] of (Array.isArray(list) ? list : []).entries()) {
        const claims: Out[] = Array.isArray(entry.claims) ? entry.claims : [];
        const supported = new Set<string>();
        for (const [j, claim] of claims.entries()) {
          const at = `$.${key}[${i}].claims[${j}]`;
          const p = supportProblems(at, claim.evidence_refs, items);
          if (!p.length) {
            const said = new Set((claim.evidence_refs as unknown[]).flatMap((r) => quantitiesIn(items.get(String(r))!.statement)));
            for (const q of new Set(quantitiesIn(String(claim.text ?? "")))) if (!said.has(q)) p.push(`${at}: claim_quantity_not_in_evidence:${q}`);
          }
          problems.push(...p);
          if (!p.length) for (const q of quantitiesIn(String(claim.text ?? ""))) supported.add(q);
        }
        if (key === "qa" && !claims.length && !isNotConfirmedAnswer(entry.answer)) problems.push(`$.qa[${i}]: answer_without_claim`);
        if (key === "flow" && !claims.length && (asserts(String(entry.show ?? "")) || String(entry.show ?? "").trim().length > NOTE_LABEL_MAX)) problems.push(`$.flow[${i}].show: show_without_claim`);
        if (key === "flow" && (EMBEDDED_CLAUSE.test(String(entry.step ?? "")) || hasPastSyllable(String(entry.step ?? "")))) problems.push(`$.flow[${i}].step: step_asserts`);
        for (const textKey of textKeys) for (const q of new Set(quantitiesIn(String(entry[textKey] ?? "")))) if (!supported.has(q)) problems.push(`$.${key}[${i}].${textKey}: unsupported_quantity:${q}`);
      }
    }
    return problems;
  },
};

export const RULE_IDS: ReadonlySet<string> = new Set(Object.keys(RULES));
