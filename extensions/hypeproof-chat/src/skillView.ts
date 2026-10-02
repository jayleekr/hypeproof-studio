// The "커리큘럼 스킬" panel's view model (cr-skills #1396; CR-43–CR-47). Pure, vscode-free and
// shared by the host (skillSession.ts) and the webview (SkillsPanel.tsx).
//
// The panel lists the skills the Service serves (never a workspace file), takes the few inputs
// each one needs, and shows the result the Service accepted, or why it refused it. What a
// skill wrote is named; most skills write nothing and only propose.

/** One skill as the Service lists it (`GET /v1/curriculum/skills`). */
export interface SkillListing {
  skill: string;
  version: string;
  tag: string;
  title: string;
  intent: string;
  preferred_capability: string;
  write_back_targets: string[];
}

export interface SkillWeek {
  week: number;
  question: string;
}

/** Choices the forms offer, read from Venture Memory. */
export interface SkillPickers {
  experiments: Array<{ id: string; label: string }>;
  /** The team's decisions that name deck slides (Deck Builder). */
  decisions: Array<{ id: string; label: string; slides: number[] }>;
  /** Evidence items the team may act on (reviewed, real, not assumed). */
  evidence: Array<{ id: string; label: string }>;
}

export interface SkillResult {
  skill: string;
  tag: string;
  ok: boolean;
  /** Accepted output, by section. */
  sections?: Array<{ heading: string; lines: string[] }>;
  /** What was stored, in the student's words. */
  written?: string[];
  /** Why the Service refused the answer (nothing was stored). */
  problems?: string[];
  message?: string;
}

export interface SkillsView {
  available: boolean;
  notice: string | null;
  week: SkillWeek | null;
  skills: SkillListing[];
  pickers: SkillPickers;
  result: SkillResult | null;
}

/** What the student filled in. Every field is optional here; `skillFormProblems` says what a skill needs. */
export interface SkillForm {
  experiment_id?: string;
  decision_id?: string;
  evidence_refs?: string[];
  text?: string;
  notes?: string;
}

export const SKILL_MESSAGES: Record<string, string> = {
  unknown_skill: "이 스킬은 지금 쓸 수 없어요.",
  invalid_input: "입력한 내용을 다시 확인해 주세요.",
  invalid_output: "AI의 답이 규칙을 지키지 않아 아무것도 저장하지 않았어요.",
  experiment_unresolved: "고른 실험을 찾을 수 없어요.",
  version_unresolved: "고른 제품 버전을 찾을 수 없어요.",
  experiment_data_deleted: "이 실험의 기록은 지워졌어요.",
  draft_limit: "이 실험에는 초안을 더 저장할 수 없어요.",
  unresolved_source_refs: "찾을 수 없는 기록을 가리킨 항목이 있어서 저장하지 않았어요.",
  not_json: "AI의 답을 읽지 못했어요. 다시 해 볼까요?",
  model_failed: "AI가 답하지 못했어요. 잠시 뒤에 다시 해 주세요.",
};

/** The input a skill run sends, from the form. */
export function skillInput(skill: string, form: SkillForm): Record<string, unknown> {
  const text = form.text?.trim();
  switch (skill) {
    case "experiment":
      return text ? { focus: text } : {};
    case "evidence":
      return { experiment_id: form.experiment_id ?? "", ...(text ? { focus: text } : {}) };
    case "product-builder":
      return { evidence_refs: form.evidence_refs ?? [], ...(text ? { request: text } : {}) };
    case "deck-builder":
      return { decision_id: form.decision_id ?? "" };
    case "interview":
      return { goal: text ?? "", ...(form.notes?.trim() ? { notes: form.notes.trim() } : {}) };
    case "critic": {
      const claims = (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 20);
      return claims.length ? { claims: claims.map((t, i) => ({ id: `c${i + 1}`, text: t })) } : {};
    }
    default:
      return {};
  }
}

/**
 * The bounds of the skills' input schemas the form can break (the Service checks them again and
 * refuses with `invalid_input`; here the student sees them before a run).
 */
export const SKILL_INPUT_LIMITS = { text: 500, notes: 8000, evidenceRefs: 10, claims: 20, claimText: 600 } as const;

/** What the form still needs before a run, in the student's words; empty means ready. */
export function skillFormProblems(skill: string, form: SkillForm): string[] {
  const out: string[] = [];
  const text = form.text?.trim() ?? "";
  switch (skill) {
    case "evidence":
      if (!form.experiment_id) out.push("정리할 실험을 골라 주세요.");
      break;
    case "product-builder":
      if (!form.evidence_refs?.length) out.push("고칠 근거를 하나 이상 골라 주세요.");
      else if (form.evidence_refs.length > SKILL_INPUT_LIMITS.evidenceRefs) out.push(`근거는 ${SKILL_INPUT_LIMITS.evidenceRefs}개까지 고를 수 있어요.`);
      break;
    case "deck-builder":
      if (!form.decision_id) out.push("슬라이드를 바꾸게 한 팀의 결정을 골라 주세요.");
      break;
    case "interview":
      if (!text) out.push("인터뷰로 알고 싶은 것을 적어 주세요.");
      if ((form.notes?.trim().length ?? 0) > SKILL_INPUT_LIMITS.notes) out.push(`인터뷰 메모는 ${SKILL_INPUT_LIMITS.notes}자까지 쓸 수 있어요.`);
      break;
  }
  if (skill === "critic") {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > SKILL_INPUT_LIMITS.claims) out.push(`주장은 ${SKILL_INPUT_LIMITS.claims}줄까지 적을 수 있어요.`);
    if (lines.some((l) => l.length > SKILL_INPUT_LIMITS.claimText)) out.push(`주장 한 줄은 ${SKILL_INPUT_LIMITS.claimText}자까지 쓸 수 있어요.`);
  } else if (text.length > SKILL_INPUT_LIMITS.text) out.push(`내용은 ${SKILL_INPUT_LIMITS.text}자까지 쓸 수 있어요.`);
  return out;
}

/** Why the Service refused an answer, by problem code, in the student's words. The raw code stays for tests and teachers. */
const PROBLEM_LINES: Record<string, string> = {
  not_countable: "성공 기준을 셀 수 있게 (숫자로) 적지 않았어요.",
  open_assumption_not_chosen: "아직 확인하지 않은 가정을 고르지 않았어요.",
  not_an_open_assumption: "이미 확인했거나 가정이 아닌 것을 확인할 가정으로 골랐어요.",
  observation_without_source_refs: "본 것(관찰)에 어느 기록에서 봤는지가 빠졌어요.",
  no_evidence: "근거가 없는 내용이 있어요.",
  evidence_not_usable: "가정이거나 아직 검토하지 않은 근거를 썼어요.",
  unresolved_evidence_ref: "프로젝트에 없는 근거를 가리켰어요.",
  evidence_not_selected: "고르지 않은 근거로 바꾸려 했어요.",
  path_not_in_version: "제품에 없는 파일을 바꾸려 했어요.",
  add_of_existing_file: "이미 있는 파일을 새 파일로 만들려 했어요.",
  add_not_used: "바꾸는 파일 어디에서도 쓰지 않는 새 파일을 만들려 했어요.",
  path_outside_version: "제품 폴더 밖의 파일을 만들려 했어요.",
  no_product_version: "아직 공개한 제품 버전이 없어요.",
  decision_unresolved: "고른 결정을 찾을 수 없어요.",
  decision_is_ai_suggestion: "AI 제안은 팀의 결정이 아니라서 슬라이드를 바꿀 수 없어요.",
  slide_not_affected: "결정과 관계없는 슬라이드를 바꾸려 했어요.",
  duplicate_slide: "같은 슬라이드를 두 번 바꾸려 했어요.",
  leading_question: "답을 정해 두고 묻는 질문이 있어요.",
  not_open: "열린 질문이 아닌 질문이 있어요.",
  answer_not_in_notes: "메모에 없는 말을 인터뷰 대답처럼 적었어요.",
  answer_without_notes: "메모가 없는데 인터뷰 대답을 적었어요.",
  not_a_note_field: "메모 정리가 적을 칸 이름을 쓰지 않았어요.",
  not_a_label: "적을 칸 이름이 짧은 이름이 아니에요.",
  purpose_not_a_label: "질문의 목적에 대답이나 문장이 들어 있어요.",
  unknown_claim: "없는 주장을 가리켰어요.",
  not_listed: "빠뜨린 주장이 있어요.",
  case_missing: "AI가 틀리거나 위험하거나 답하지 못할 때의 검토가 빠졌어요.",
  unhandled_failure_not_named: "제품 파일에 AI 실패 대비가 없는데 있다고 했어요.",
  sources_not_read: "제품 파일을 다 읽지 못해서 검토를 받을 수 없어요.",
  answer_without_claim: "근거 없는 대답이 있어요.",
  unsupported_quantity: "근거 없는 숫자나 '모두' 같은 말이 있어요.",
  claim_not_cited_statement: "주장이 근거에 적힌 말과 달라요.",
  answer_not_claims: "대답에 근거에 적힌 말이 아닌 내용이 있어요.",
  show_asserts: "데모 장면 설명에 결과를 말하는 문장이 있어요.",
  step_asserts: "데모 순서 이름에 확인하지 않은 결과가 들어 있어요.",
  missing: "꼭 있어야 할 칸이 빠졌어요.",
  not_allowed: "정해지지 않은 칸이 들어 있어요.",
  too_few_items: "항목 수가 너무 적어요.",
  too_many_items: "항목 수가 너무 많아요.",
  too_short: "비어 있는 내용이 있어요.",
  too_long: "너무 긴 내용이 있어요.",
  not_in_enum: "정해진 값이 아닌 값이 있어요.",
  below_minimum: "너무 작은 숫자가 있어요.",
  above_maximum: "너무 큰 숫자가 있어요.",
};
/** One refused problem (`[rule ]$.path: code[:detail]`) as a sentence a student reads. */
export function problemLine(problem: string): string {
  const code = problem.slice(problem.lastIndexOf(": ") + 2).split(":")[0] ?? "";
  if (code.startsWith("expected_")) return "형식이 맞지 않는 칸이 있어요.";
  return PROBLEM_LINES[code] ?? "AI의 답에 규칙에 맞지 않는 곳이 있어요.";
}

/**
 * The model's answer as one JSON object: the whole text, or the first fenced ```json block,
 * or the outermost braces. null when none parses.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const tries = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence?.[1]) tries.push(fence[1].trim());
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* next */
    }
  }
  return null;
}

const SECTION_NAMES: Record<string, string> = {
  observation: "본 것",
  interpretation: "해석",
  assumption: "가정",
  next_experiment: "다음 실험",
};
const CASE_NAMES: Record<string, string> = { wrong: "AI가 틀렸을 때", unsafe: "AI가 위험한 답을 할 때", unavailable: "AI가 답하지 못할 때" };
const list = (v: unknown): Array<Record<string, any>> => (Array.isArray(v) ? v : []);
const refs = (v: unknown) => (Array.isArray(v) && v.length ? ` (근거 ${v.length}개)` : "");
/** A claim id in the student's words: `slide:3` is "슬라이드 3", `c2` (the second line the student typed) is "주장 2". */
export function claimName(id: unknown): string {
  const v = String(id ?? "");
  const slide = /^slide:(\d+)$/.exec(v);
  if (slide) return `슬라이드 ${slide[1]}`;
  const typed = /^c(\d+)$/.exec(v);
  return typed ? `주장 ${typed[1]}` : "주장";
}

/** The accepted output in the student's words, section by section. */
export function resultSections(skill: string, out: Record<string, any>): Array<{ heading: string; lines: string[] }> {
  switch (skill) {
    case "experiment":
      return [
        { heading: "확인할 가정", lines: [String(out.assumption ?? ""), `가장 위험한 이유: ${out.why_riskiest ?? ""}`] },
        { heading: "가설", lines: [String(out.hypothesis ?? "")] },
        { heading: "방법", lines: list(out.procedure).map((s, i) => `${i + 1}. ${s}`) },
        { heading: "성공 기준", lines: list(out.success_criteria).map(String) },
      ];
    case "evidence":
      return Object.entries(SECTION_NAMES).map(([k, heading]) => ({ heading, lines: list(out.items).filter((i) => i.section === k).map((i) => `${i.text}${refs(i.source_refs)}`) })).filter((s) => s.lines.length);
    case "product-builder":
      return [
        { heading: "요약", lines: [String(out.summary ?? "")] },
        { heading: "바꿀 파일", lines: list(out.changes).map((c) => `${c.path}${c.kind === "add" ? " (새 파일)" : ""}: ${c.change}${refs(c.evidence_refs)}`) },
        ...(out.not_changed ? [{ heading: "그대로 둔 것", lines: [String(out.not_changed)] }] : []),
      ];
    case "deck-builder":
      return list(out.patches).map((p) => ({ heading: `슬라이드 ${p.slide}: ${p.title}`, lines: [String(p.body ?? ""), `근거 ${list(p.evidence_refs).length}개`] }));
    case "interview":
      return [
        { heading: "질문", lines: list(out.questions).map((q, i) => `${i + 1}. ${q.text} — ${q.purpose}`) },
        { heading: "들으면서 적을 칸", lines: list(out.note_fields).map(String) },
        ...(list(out.structured_notes).length ? [{ heading: "메모 정리 (적은 그대로)", lines: list(out.structured_notes).map((n) => `${n.topic}: "${n.quote}"`) }] : []),
      ];
    case "critic":
      return [
        { heading: "근거가 약한 주장", lines: list(out.weak_claims).map((w) => `${claimName(w.claim_id)}: ${w.reason}`) },
        { heading: "아직 시험하지 않은 주장", lines: list(out.missing_tests).map((m) => `${claimName(m.claim_id)}: ${m.test}`) },
        { heading: "더 필요한 근거", lines: list(out.missing_evidence).map((m) => `${m.claim_id ? `${claimName(m.claim_id)}: ` : ""}${m.what}`) },
        { heading: "안전", lines: list(out.safety).map((s) => String(s.issue)) },
        { heading: "AI 실패 대비", lines: list(out.ai_failure_review).map((r) => `${CASE_NAMES[r.case] ?? r.case}: ${r.handling === "missing" ? "대비 없음" : "대비 있음"} — ${r.note}`) },
      ].filter((s) => s.lines.length);
    case "demo-coach":
      return [
        { heading: "데모 순서", lines: list(out.flow).flatMap((f, i) => [`${i + 1}. ${f.step} — ${f.show}`, ...list(f.claims).map((c) => `   주장: ${c.text}${refs(c.evidence_refs)}`)]) },
        { heading: "예상 질문", lines: list(out.qa).map((q) => `Q. ${q.question} / A. ${q.answer}`) },
      ];
    default:
      return [];
  }
}

/** What a write-back stored, in the student's words. */
export function writtenLines(written: ReadonlyArray<{ target: string; id: string }>): string[] {
  return written.map((w) => (w.target === "evidence_draft" ? "실험 증거에 AI 초안으로 저장했어요. 하나씩 읽고 받아들이거나 고쳐 주세요." : "프로젝트에 저장했어요."));
}
