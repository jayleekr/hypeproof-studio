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
 * A reference to the product's AI: the `hypeproof.ai` SDK object (dotted, optional-chained or
 * bracket access, called directly or through an alias or a destructured `{ ai } = …hypeproof`),
 * a provider host, a provider API path, or a provider SDK import. The detector is a floor, not
 * a ceiling (review round 3): a miss only means the review is not required; it never refuses a
 * review the Critic gives.
 */
const QUOTE = "['\"`]";
const HYPEPROOF_AI = new RegExp(
  [
    "\\bhypeproof\\s*(?:\\?\\.|\\.)\\s*ai\\b",
    `\\bhypeproof\\s*(?:\\?\\.)?\\s*\\[\\s*${QUOTE}ai${QUOTE}\\s*\\]`,
    `${QUOTE}hypeproof${QUOTE}\\s*\\]\\s*(?:\\?\\.\\s*ai\\b|\\.\\s*ai\\b|(?:\\?\\.)?\\s*\\[\\s*${QUOTE}ai${QUOTE}\\s*\\])`,
    "\\{[^{}]*\\bai\\b[^{}]*\\}\\s*=\\s*[^;\\n]*\\bhypeproof\\b",
  ].join("|"),
  "g",
);
const PROVIDER_HOSTS = ["api.openai.com", "openai.azure.com", "api.anthropic.com", "generativelanguage.googleapis.com", "aiplatform.googleapis.com", "openrouter.ai", "api.groq.com", "api.mistral.ai", "api.together.xyz", "api.deepseek.com", "api.x.ai", "api.cohere.ai", "api.cohere.com", "api-inference.huggingface.co", "router.huggingface.co", "api.perplexity.ai", "api.fireworks.ai", "api.replicate.com", "models.inference.ai.azure.com", "bedrock-runtime", "api.moonshot.cn", "open.bigmodel.cn", "dashscope.aliyuncs.com"];
const PROVIDER_CALL = new RegExp(`${PROVIDER_HOSTS.map((h) => h.replace(/[.]/g, "\\.")).join("|")}|\\/v1\\/chat\\/completions|\\/v1\\/messages\\b`, "g");
const PROVIDER_SDKS = ["openai", "@anthropic-ai/sdk", "@google/generative-ai", "@google/genai", "groq-sdk", "@mistralai/mistralai", "cohere-ai", "@huggingface/inference", "together-ai", "replicate", "ollama", "@ai-sdk/[a-z-]+"];
const PROVIDER_IMPORT = new RegExp(`\\b(?:from|import|require)\\s*\\(?\\s*${QUOTE}(?:[^'"\`]*\\/)?(?:${PROVIDER_SDKS.map((s) => s.replace(/[/]/g, "\\/")).join("|")})(?:@[^'"\`/]*)?(?:\\/[^'"\`]*)?${QUOTE}`);
/** A handler for every rejection in the page (a global handler is handling for the whole file). */
const GLOBAL_HANDLER = /\bunhandledrejection\b|\b(?:window|self|globalThis)\s*\.\s*onerror\s*=/;
const SCRIPT_FILE = /\.(?:m?js|cjs|jsx|ts|tsx|svelte|vue)$/i;

/** The script text of a product file: a script file whole, an HTML file's `<script>` bodies and inline `on…` handlers only, so page prose such as "Powered by hypeproof.ai" is not a call. */
export function scriptTextOf(path: string, text: string): string {
  if (SCRIPT_FILE.test(path)) return text;
  if (!/\.html?$/i.test(path)) return "";
  const parts: string[] = [];
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) parts.push(`${m[1] ?? ""}\n${m[2] ?? ""}`);
  for (const m of text.matchAll(/\son[a-z]+\s*=\s*("([^"]*)"|'([^']*)')/gi)) parts.push(m[2] ?? m[3] ?? "");
  return parts.join("\n;\n");
}

/** Is the AI reference at `at` inside a `try` block, or chained to a `.catch(` in the same statement? */
function siteHandled(src: string, at: number): boolean {
  // Forward: the rest of the statement (chained calls may continue on the next line).
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const ch = src[i]!;
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      depth--;
      if (depth < -2) break;
    } else if (ch === ";" && depth <= 0) break;
    else if (ch === "\n" && depth <= 0 && !/^\s*[.?]/.test(src.slice(i + 1, i + 40))) break;
    if (ch === "." && /^\.\s*catch\s*\(/.test(src.slice(i, i + 12))) return true;
  }
  // Backward: every enclosing block; one opened by `try` handles the reference.
  depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const ch = src[i]!;
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth > 0) depth--;
      else if (/\btry\s*$/.test(src.slice(Math.max(0, i - 12), i))) return true;
    }
  }
  return false;
}

/** The places a script reaches its AI: each reference, and each use of a name bound to `hypeproof.ai`. */
function aiSites(src: string): { sites: number[]; sdkImport: boolean } {
  const sites: number[] = [];
  const aliases = new Set<string>();
  const bareName = (s: string) => s.replace(/=.*$/s, "").trim();
  for (const m of src.matchAll(HYPEPROOF_AI)) {
    const destructured = /^\{([^{}]*)\}/.exec(m[0]);
    if (destructured) {
      // `const { ai } = window.hypeproof` or `{ ai: model }`: the name bound to the `ai` property.
      for (const part of destructured[1]!.split(",")) {
        const [key, val] = part.split(":");
        if (bareName(key ?? "") === "ai") aliases.add(bareName(val ?? key ?? ""));
      }
      continue;
    }
    // A chained use (`hypeproof.ai.generate(…)`) is a call site.
    if (/^\s*(?:\?\.|\.|\(|\[)/.test(src.slice(m.index! + m[0].length))) {
      sites.push(m.index!);
      continue;
    }
    // A binding (`const ai = window.hypeproof.ai`, `const { generate } = hypeproof.ai`): its uses are the sites.
    const decl = /(?:const|let|var)\s+(?:([A-Za-z_$][\w$]*)|\{([^{}]*)\})\s*=\s*[^;\n=]*$/.exec(src.slice(Math.max(0, m.index! - 200), m.index!));
    if (decl?.[1]) aliases.add(decl[1]);
    else if (decl?.[2]) for (const part of decl[2].split(",")) aliases.add(bareName(part.split(":")[1] ?? part.split(":")[0] ?? ""));
    else sites.push(m.index!);
  }
  for (const m of src.matchAll(PROVIDER_CALL)) sites.push(m.index!);
  for (const a of [...aliases].filter((x) => /^[A-Za-z_$][\w$]*$/.test(x))) {
    const use = new RegExp(`(?<![\\w$.])${a.replace(/\$/g, "\\$")}\\s*(?:\\?\\.|\\.|\\()`, "g");
    for (const m of src.matchAll(use)) sites.push(m.index!);
  }
  return { sites, sdkImport: PROVIDER_IMPORT.test(src) };
}

/**
 * Which product files call an AI, and which of those leave a call unhandled. A call is handled when
 * it sits in a `try` block or its statement chains `.catch(`; a global `unhandledrejection` or
 * `window.onerror` handler handles the whole file. A provider SDK call is reached through objects
 * the check does not follow, so a file importing one counts as handled when it has any `catch`.
 */
export function aiFailureHandling(files: ReadonlyArray<{ path: string; text?: string }>): { uses_ai: boolean; unhandled: string[] } {
  const calling: string[] = [];
  const unhandled: string[] = [];
  for (const f of files) {
    if (typeof f.text !== "string") continue;
    const src = scriptTextOf(f.path, f.text);
    const { sites, sdkImport } = aiSites(src);
    // A name bound to the SDK but never used still marks the file as reaching its AI.
    const bound = !sites.length && !sdkImport && src.search(HYPEPROOF_AI) >= 0;
    if (!sites.length && !sdkImport && !bound) continue;
    calling.push(f.path);
    if (GLOBAL_HANDLER.test(src)) continue;
    const handled = sites.length ? sites.every((at) => siteHandled(src, at)) : /\bcatch\b/.test(src);
    if (!handled) unhandled.push(f.path);
  }
  return { uses_ai: calling.length > 0, unhandled };
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
  /(훌륭|멋진|멋지|최고|대단|완벽|놀라운|놀랍)/,
  // A presupposed benefit or comparison (review round 3): "기존 키오스크보다 나은가요?", "더 편한가요?",
  // "이 앱 덕분에…", "시간을 절약해 주었나요?", "추천하시겠어요?" / "추천하고 싶은 이유".
  /보다\s*(더\s*)?(나은|낫|좋|편|쉽|쉬운|빠르|빠른)/,
  /(더|훨씬)\s*(편한|편리한|나은|좋은|쉬운|빠른)(가요|가|지요|죠|\s*[?？])/,
  /덕분에/,
  /(절약|해결|도움)(을|이)?\s*(해\s*)?(주|줬|주었|드렸|되었|됐)/,
  /추천하(시겠|실|고\s*싶|겠)/,
  /\b(don't|wouldn't|isn't|aren't|doesn't) (you|it|that)\b/i,
  /\bagree\b/i,
  /\bhow much do you (love|like|enjoy|appreciate)\b/i,
  /^(do|did) you (love|like|enjoy)\b/i,
  /\bwhat (do|does|did) (you|they) (love|like|enjoy)\b/i,
  /\bwhy (is|was|are|were) (it|this|that|they|the [a-z]+) (so |much )?(better|easier|great|good|helpful)\b/i,
  /\bhow (great|good|easy|helpful|useful|nice|amazing) (is|was|were|are)\b/i,
  /\b(amazing|awesome|wonderful|fantastic|incredible|excellent|brilliant|outstanding|perfect|great app|lovely)\b/i,
  /\b(so|much|so much) (better|easy|easier|great|good|helpful|convenient|simple|faster|quicker|nicer)\b/i,
  /\bprefer\b.*\b(over|to)\b/i,
  /\bthanks to (this|the|our|it)\b|\b(save|saved|saves) (you|them)\b/i,
  /\bwhy would you recommend\b|\brecommend (it|this|us|the app)\b/i,
];
/** An open question asks what, how, why, when, where, who or for a story. */
const OPEN = /(무엇|무슨|뭐|어떻게|어떤|어떠|왜|언제|어디|누가|누구|어느|얼마나 자주|몇|이야기해|말씀해|설명해|보여 ?주|알려 ?주|\b(what|how|why|when|where|who|tell me|describe)\b)/i;

export const isLeadingQuestion = (q: string) => LEADING.some((re) => re.test(q.trim()));
export const isOpenQuestion = (q: string) => OPEN.test(q) && !isLeadingQuestion(q);

/** A note field is a short label to fill in while listening, never a sentence or a quoted answer. */
export const NOTE_LABEL_MAX = 30;
/** A demo `show` is a label of what is on screen, a little longer than a note field. */
export const SHOW_MAX = 60;
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
/**
 * A label that is an answer in the nominal style (음슴체, review round 3): the last word is a verb or
 * adjective stem plus final ㅁ ("씀", "듦", "비쌈") or a verdict word ("불가", "가능", "됨"). Nouns that end
 * in ㅁ ("느낌", "이름", "처음") stay labels.
 */
const NOUNS_ENDING_IN_M = new Set(["느낌", "이름", "처음", "다음", "마음", "사람", "요금", "고민", "점심", "가름", "기름", "그림", "모임", "무게감", "질문", "흐름", "움직임", "걸음", "웃음", "울음", "믿음", "물음", "기쁨", "슬픔", "아픔", "배움", "도움", "놀람", "다짐", "바람", "점", "꿈", "몸", "힘", "잠", "밤", "봄", "삶", "짐", "섬", "숨", "땀", "앎"]);
/** Sino-Korean noun syllables ending in ㅁ: never the nominal of a verb. */
const SINO_NOUN_M = new Set([..."험념심금감람점품침담범삼염참탐검엄"]);
const VERDICT_WORDS = /(불가|불가능|가능|안됨|안 됨|됨|못함|없음|있음|싫음|좋음)$/;
const nominalAnswer = (v: string): boolean => {
  const word = v.trim().split(/\s+/).pop() ?? "";
  if (VERDICT_WORDS.test(word)) return true;
  const last = word.charCodeAt(word.length - 1) - 0xac00;
  if (!(last >= 0 && last < 11172 && (last % 28 === 16 || last % 28 === 10))) return false; // final ㅁ or ㄻ
  if (word.length > 1 && SINO_NOUN_M.has(word.slice(-1))) return false; // 경험, 개념, 관심, 요금, 만족감, 장점, 제품
  for (const n of NOUNS_ENDING_IN_M) if (word.endsWith(n)) return false;
  return true;
};
export const isNoteLabel = (v: string) => v.trim().length > 0 && v.trim().length <= NOTE_LABEL_MAX && !QUOTE_MARKS.test(v) && !SENTENCE_END.test(v.trim()) && !EMBEDDED_CLAUSE.test(v) && !hasPastSyllable(v) && !nominalAnswer(v);
/** A question's purpose is a short label too (at most 60 characters), so no answer is written there; a past-tense word may name what is asked about ("겪었던 일"). */
export const PURPOSE_MAX = 60;
export const isPurposeLabel = (v: string) => v.trim().length > 0 && v.trim().length <= PURPOSE_MAX && !QUOTE_MARKS.test(v) && !SENTENCE_END.test(v.trim()) && !EMBEDDED_CLAUSE.test(v) && !nominalAnswer(v);

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
 * become their value ("3", "20", "100"); "about N" ("백여 명", "100여 명") becomes "100+"; a
 * share of a count becomes a ratio ("세 명 중 두 명", "2 of 3", "삼분의 이", "열에 아홉" → "2/3",
 * "9/10"), so "3명 중 3명" is not "3명 중 2명"; magnitudes and approximate amounts ("수십",
 * "수백", "많은", "hundreds", "dozens", "many") and words that claim a share or a frequency
 * ("모두", "전원", "매일", "대다수", "아무도", "everyone") keep the word. A week reference
 * ("2주차") or an ordinal ("3번째") is not a quantity. Korean number words count only before a
 * counter, since "한" or "이" alone are ordinary words. "one" is left out for the same reason.
 */
const COUNTER = "(?:명|분|사람|번(?!째)|회|개|가지|곳|군데|초|시간|배|일|주(?!차)|달|개월|년|살|퍼센트|프로)";
const NATIVE_TENS: Record<string, number> = { 열: 10, 스물: 20, 스무: 20, 서른: 30, 마흔: 40, 쉰: 50, 예순: 60, 일흔: 70, 여든: 80, 아흔: 90 };
const NATIVE_UNITS: Record<string, number> = { 한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 석: 3, 네: 4, 넷: 4, 넉: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9 };
const SINO_DIGITS: Record<string, number> = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
const SINO_PLACES: Record<string, number> = { 십: 10, 백: 100, 천: 1000, 만: 10000 };
const EN_NUMBERS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, dozen: 12, twice: 2, thrice: 3 };
const SHARE_WORDS = "절반|대부분|대다수|다수|과반|모두|모든|전부|전원|다들|누구나|아무도|아무것도|누구도|매일|항상|언제나";
const EN_SHARE_WORDS = "everyone|everybody|nobody|always|never|all|most|half|majority|none|percent";
const KO_APPROX = "수십|수백|수천|수만|수억|몇십|몇백|몇천|여러|많은|많이|많다|많아|많았|많습";
const EN_APPROX = "hundreds|dozens|thousands|millions|tens of|scores of|lots of|a lot of|many|several|numerous|countless|plenty";
const NATIVE = `(?:(?:${Object.keys(NATIVE_TENS).join("|")})\\s?(?:${Object.keys(NATIVE_UNITS).join("|")})?|(?:${Object.keys(NATIVE_UNITS).join("|")}))`;
const SINO = "(?:[일이삼사오육칠팔구]?[십백천만])+[일이삼사오육칠팔구]?";
const SINO_OR_DIGIT = "(?:\\d+|(?=[일이삼사오육칠팔구십백천만])(?:[일이삼사오육칠팔구]?[십백천만])*[일이삼사오육칠팔구]?)";
const QUANTITY = new RegExp(
  [
    `(?<![가-힣])(?<fden>${SINO_OR_DIGIT})\\s*분의\\s*(?<fnum>${SINO_OR_DIGIT})`,
    `(?<![가-힣])(?<tden>${NATIVE})\\s*에\\s*(?<tnum>${NATIVE})(?=[^가-힣]|[은는이가도]|$)`,
    `(?<digits>\\d+(?:[.,]\\d+)*)(?!\\s*(?:주차|번째|\\d))(?<dyeo>\\s*여(?=\\s*${COUNTER}))?`,
    `(?<![가-힣])(?<approx>${KO_APPROX})`,
    `(?<![가-힣])(?<native>${NATIVE})\\s*${COUNTER}`,
    `(?<![가-힣])(?<sino>${SINO})(?<syeo>\\s*여)?\\s*${COUNTER}`,
    `\\b(?<enapprox>${EN_APPROX})\\b`,
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
  if (/^\d+$/.test(words)) return Number(words);
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
/** "3명 중 2명" / "세 명 가운데 두 명" (Korean: whole first) and "2 of 3" / "two out of three" (English: part first). */
const KO_SHARE_OF = /^\s*(?:명|분|사람|개|번|회|곳|가지)?\s*(?:중에서|중에|중|가운데)\s*$/;
const EN_SHARE_OF = /^\s*(?:[a-z]+\s+)?(?:out\s+)?of\s*$/i;
const APPROX_FORM = (w: string) => (w.startsWith("많") ? "많" : w.toLowerCase().replace(/^(a lot of|lots of)$/, "lots"));
export function quantitiesIn(text: string): string[] {
  const t = text.normalize("NFKC");
  const found: Array<{ value: string; at: number; end: number }> = [];
  for (const m of t.matchAll(QUANTITY)) {
    const g = m.groups!;
    let value: string;
    if (g.fden !== undefined && g.fnum) value = `${sinoValue(g.fnum)}/${sinoValue(g.fden)}`;
    else if (g.tden !== undefined) value = `${nativeValue(g.tnum!)}/${nativeValue(g.tden)}`;
    else if (g.digits !== undefined) value = g.digits.replace(/,/g, "") + (g.dyeo ? "+" : "");
    else if (g.approx !== undefined || g.enapprox !== undefined) value = APPROX_FORM(g.approx ?? g.enapprox!);
    else if (g.native !== undefined) value = String(nativeValue(g.native));
    else if (g.sino !== undefined) value = String(sinoValue(g.sino)) + (g.syeo ? "+" : "");
    else if (g.en !== undefined) value = String(EN_NUMBERS[g.en.toLowerCase()]);
    else value = (g.share ?? g.enshare ?? m[0]).toLowerCase();
    found.push({ value, at: m.index!, end: m.index! + m[0].length });
  }
  const out = found.map((f) => f.value);
  for (let i = 0; i + 1 < found.length; i++) {
    const [a, b] = [found[i]!, found[i + 1]!];
    if (!/^\d+(?:\.\d+)?$/.test(a.value) || !/^\d+(?:\.\d+)?$/.test(b.value)) continue;
    const between = t.slice(a.end, b.at);
    if (KO_SHARE_OF.test(between)) out.push(`${b.value}/${a.value}`);
    else if (EN_SHARE_OF.test(between)) out.push(`${a.value}/${b.value}`);
  }
  return out;
}

/** The fixed answer to a question the team has no evidence for (Demo Coach): the only answer without a claim. */
export const DEMO_NOT_CONFIRMED = "아직 확인하지 못했어요";
const isNotConfirmedAnswer = (v: unknown) => typeof v === "string" && v.trim().replace(/[.!。]+$/, "") === DEMO_NOT_CONFIRMED;

/**
 * Is `said` the statement `stored`, allowing only a different sentence ending (review round 3)?
 * Both are compared after dropping end punctuation, extra white space and one ending of the
 * same verb ("멈췄다" / "멈췄어요" / "멈췄습니다", "많다" / "많아요", "학생이다" / "학생이에요"); a
 * word changed, added or removed anywhere else is a different statement.
 */
const ENDINGS = ["이에요", "입니다", "습니다", "이다", "에요", "예요", "어요", "아요", "여요", "다", "요"];
function stem(v: string): string {
  let t = v.normalize("NFKC").replace(/\s+/g, " ").trim().replace(/[\s.!?。？！~…]+$/, "").toLowerCase();
  for (const e of ENDINGS) if (t.endsWith(e) && t.length > e.length) {
    t = t.slice(0, -e.length);
    break;
  }
  return t.trim();
}
export const sameStatement = (said: string, stored: string): boolean => stem(said).length > 0 && stem(said) === stem(stored);
/** The sentences of a free-text answer (split after end punctuation and at line breaks). */
const sentencesOf = (v: string) => v.split(/(?<=[.!?。？！])\s+|\n+/).map((x) => x.trim()).filter(Boolean);

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

/** A path inside the version's folder: relative, no `..`, no backslash, no scheme or drive. */
const isPlainRelativePath = (p: string) => p.length > 0 && !p.startsWith("/") && !p.includes("\\") && !/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.split("/").some((seg) => seg === ".." || seg === "." || seg === "");

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
  // Product Builder (CR-46): a change touches a file of the product version; a new file is declared as
  // one, stays inside the version's folder, and is wired in by an edit of an existing file in the same
  // plan that names it (review round 3), so a new file nobody's change needs is out of scope.
  product_paths_in_version: (ctx, _input, out) => {
    const paths = new Set((ctx.version?.files ?? []).map((f) => f.path));
    if (!ctx.version) return ["$: no_product_version"];
    const changes: Out[] = Array.isArray(out.changes) ? out.changes : [];
    const edits = changes.filter((c) => c.kind !== "add" && paths.has(String(c.path)));
    return changes.flatMap((ch: Out, i: number) => {
      const path = String(ch.path);
      const exists = paths.has(path);
      if (ch.kind !== "add") return exists ? [] : [`$.changes[${i}]: path_not_in_version:${path}`];
      if (exists) return [`$.changes[${i}]: add_of_existing_file:${path}`];
      if (!isPlainRelativePath(path)) return [`$.changes[${i}]: path_outside_version:${path}`];
      const base = path.split("/").pop()!;
      return edits.some((e) => String(e.change ?? "").includes(base)) ? [] : [`$.changes[${i}]: add_not_used:${path}`];
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
      const p = isPurposeLabel(String(q.purpose ?? "")) ? [] : [`$.questions[${i}].purpose: purpose_not_a_label`];
      if (isLeadingQuestion(text)) return [`$.questions[${i}]: leading_question`, ...p];
      return isOpenQuestion(text) ? p : [`$.questions[${i}]: not_open`, ...p];
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
  // The detector is a floor (review round 3): when it finds no call, a review the Critic gives is
  // still accepted (and must be complete); only leaving the review out depends on the detector.
  critic_reviews_ai_failure: (ctx, _input, out) => {
    const { uses_ai, unhandled } = aiFailureHandling(ctx.version?.files ?? []);
    const review = Array.isArray(out.ai_failure_review) ? out.ai_failure_review : [];
    // A source file the Service could not read may call an AI: "no AI" is not known, so leaving the review out is not accepted.
    if (!uses_ai && !review.length && ctx.version?.unread?.length) return [`$.ai_failure_review: sources_not_read:${ctx.version.unread.join(",")}`];
    if (!uses_ai && !review.length) return [];
    const problems: string[] = [];
    for (const kase of ["wrong", "unsafe", "unavailable"]) if (!review.some((r: Out) => r.case === kase)) problems.push(`$.ai_failure_review: case_missing:${kase}`);
    const unavailable = review.find((r: Out) => r.case === "unavailable");
    if (unhandled.length && unavailable && unavailable.handling !== "missing") problems.push(`$.ai_failure_review: unhandled_failure_not_named:${unhandled.join(",")}`);
    return problems;
  },
  // Demo Coach (CR-47, SX-48): every claim in the demo flow and the Q&A rests on reviewed, real evidence
  // and is that evidence's own statement (review round 3): a claim's text is the stored statement of
  // an item it cites, up to the sentence ending, so it cannot paraphrase, contradict or overstate
  // it. A Q&A answer is its claims' statements, one sentence each, or exactly the fixed "not
  // confirmed" answer with no claim. `step` and `show` state nothing (a short label of what is done
  // or shown); every quantity in them is in a cited statement of the same entry.
  demo_claims_supported: (ctx, _input, out) => {
    const items = itemMap(ctx);
    const problems: string[] = [];
    for (const [key, list] of [["flow", out.flow], ["qa", out.qa]] as const) {
      for (const [i, entry] of (Array.isArray(list) ? list : []).entries()) {
        const claims: Out[] = Array.isArray(entry.claims) ? entry.claims : [];
        const statements: string[] = [];
        for (const [j, claim] of claims.entries()) {
          const at = `$.${key}[${i}].claims[${j}]`;
          const p = supportProblems(at, claim.evidence_refs, items);
          if (!p.length) {
            const cited = (claim.evidence_refs as unknown[]).map((r) => items.get(String(r))!.statement);
            const own = cited.find((st) => sameStatement(String(claim.text ?? ""), st));
            if (own === undefined) p.push(`${at}: claim_not_cited_statement`);
            else statements.push(own);
          }
          problems.push(...p);
        }
        const supported = new Set(statements.flatMap((st) => quantitiesIn(st)));
        if (key === "qa") {
          const answer = String(entry.answer ?? "");
          if (!claims.length) {
            if (!isNotConfirmedAnswer(answer)) problems.push(`$.qa[${i}]: answer_without_claim`);
          } else if (statements.length) {
            for (const sentence of sentencesOf(answer)) if (!statements.some((st) => sameStatement(sentence, st))) problems.push(`$.qa[${i}].answer: answer_not_claims`);
          }
          for (const q of new Set(quantitiesIn(answer))) if (!supported.has(q)) problems.push(`$.qa[${i}].answer: unsupported_quantity:${q}`);
          continue;
        }
        const show = String(entry.show ?? "");
        const step = String(entry.step ?? "");
        if (asserts(show) || nominalAnswer(show) || show.trim().length > SHOW_MAX) problems.push(`$.flow[${i}].show: show_asserts`);
        if (asserts(step) || nominalAnswer(step)) problems.push(`$.flow[${i}].step: step_asserts`);
        for (const [textKey, text] of [["step", step], ["show", show]] as const) for (const q of new Set(quantitiesIn(text))) if (!supported.has(q)) problems.push(`$.flow[${i}].${textKey}: unsupported_quantity:${q}`);
      }
    }
    return problems;
  },
};

export const RULE_IDS: ReadonlySet<string> = new Set(Object.keys(RULES));
