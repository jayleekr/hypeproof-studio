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

/** What the form still needs before a run, in the student's words; empty means ready. */
export function skillFormProblems(skill: string, form: SkillForm): string[] {
  switch (skill) {
    case "evidence":
      return form.experiment_id ? [] : ["정리할 실험을 골라 주세요."];
    case "product-builder":
      return form.evidence_refs?.length ? [] : ["고칠 근거를 하나 이상 골라 주세요."];
    case "deck-builder":
      return form.decision_id ? [] : ["슬라이드를 바꾸게 한 팀의 결정을 골라 주세요."];
    case "interview":
      return form.text?.trim() ? [] : ["인터뷰로 알고 싶은 것을 적어 주세요."];
    default:
      return [];
  }
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
        { heading: "근거가 약한 주장", lines: list(out.weak_claims).map((w) => `${w.claim_id}: ${w.reason}`) },
        { heading: "아직 시험하지 않은 주장", lines: list(out.missing_tests).map((m) => `${m.claim_id}: ${m.test}`) },
        { heading: "더 필요한 근거", lines: list(out.missing_evidence).map((m) => `${m.claim_id ? `${m.claim_id}: ` : ""}${m.what}`) },
        { heading: "안전", lines: list(out.safety).map((s) => String(s.issue)) },
        { heading: "AI 실패 대비", lines: list(out.ai_failure_review).map((r) => `${CASE_NAMES[r.case] ?? r.case}: ${r.handling === "missing" ? "대비 없음" : "대비 있음"} — ${r.note}`) },
      ].filter((s) => s.lines.length);
    case "demo-coach":
      return [
        { heading: "데모 순서", lines: list(out.flow).map((f, i) => `${i + 1}. ${f.step} — ${f.show}`) },
        { heading: "예상 질문", lines: list(out.qa).map((q) => `Q. ${q.question} / A. ${q.answer}`) },
      ];
    default:
      return [];
  }
}

/** What a write-back stored, in the student's words. */
export function writtenLines(written: ReadonlyArray<{ target: string; id: string }>): string[] {
  return written.map((w) => (w.target === "evidence_draft" ? "실험 증거에 AI 초안으로 저장했어요. 하나씩 읽고 받아들이거나 고쳐 주세요." : `${w.target} 저장`));
}
