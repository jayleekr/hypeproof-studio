/**
 * Pure rules for area D (Evidence drawer) (SX-17·18·20·22·23).
 *
 * The reason this is `.ts` and not `.tsx` is the same as for
 * `MissionHeader`/`missionHeaderLogic` — `node --experimental-strip-types` cannot
 * strip JSX. Treat the component as a render instrument and call the rules directly
 * from here.
 *
 * **There is no interpretation here.** The drawer only shows what happened (SX-17
 * negative condition: "fails if the drawer contains interpretation or scores").
 * Interpretation is the job of the E retrospective and the F change record.
 */
import type {
  EvidenceType,
  SourceKind,
} from "../../../../worker/src/lib/measurement-core/learning-events.ts";

/** One evidence row the drawer handles. Exactly the shape the host sends down as `learningState.evidence`. */
export interface EvidenceRowView {
  id: string;
  kind: string;
  evidence_type: EvidenceType | null;
  at: number;
  text: string;
  actor: string;
  source_kind: SourceKind;
  source_state: string;
  provenance: { who: string; when: string; where: string } | null;
  adopted_from: string | null;
  /** SX-16 — the fields the before/after view uses. */
  sha256?: string | null;
  artifact_before?: string | null;
  artifact_after?: string | null;
  criterion_ref?: string | null;
}

/**
 * The six types of SX-18. The order is the table order of the design doc's
 * §관측 이벤트와 필드.
 *
 * No numbers in the labels. Wording like "3 kinds of evidence" invites counting, and a
 * count is immediately read as a score.
 */
export const EVIDENCE_TYPE_LABELS: Record<EvidenceType, string> = {
  intent: "무엇을 하려 했나",
  criterion: "기대 조건",
  action: "직접 해 본 것",
  decision: "고른 이유",
  change: "고쳐 달라고 한 것",
  ownership: "내가 맡은 몫",
};

/** Where evidence of unknown type goes. We do **not guess** one of the six. */
export const UNTYPED_LABEL = "종류 미기록";

/**
 * The value stored for a provenance field the student left empty.
 *
 * The `/2` validator requires that all three `{who,when,where}` fields of `provenance`
 * be **non-empty** (`legacy-observation.ts` `shapeOf`). But SX-20 says an unfilled field
 * must be left as "source not recorded". Sending an empty string gets the whole batch
 * rejected, and stuffing in whatever comes to mind is the "fill in by guessing" SX-20
 * forbids.
 *
 * So we **record the fact that it was not recorded.** It is not an invented source, so
 * it is not a guess, and on screen `provenanceLine` treats it exactly like an empty
 * field. Whether widening the schema is the right answer is for a human to decide, and
 * it is filed as a revision proposal in STATE.md.
 */
export const UNRECORDED = "미기록";

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  link: "링크",
  article: "기사",
  policy: "학교 규정",
  interview: "인터뷰",
  test: "직접 시험",
  none: "종류 없음",
};

export interface ProvenanceField {
  key: "who" | "when" | "where";
  label: string;
}

/**
 * SX-22 — each kind needs different provenance fields.
 *
 * An interview needs **who · when**; a policy needs **document name (where) · clause**.
 * Requiring the same fields for all of them opens the path to "classifying something as
 * a policy from a URL alone" (SX-22 negative condition). The field names are fixed to
 * the three `provenance{who,when,where}` (the schema was closed in P1-A); only the
 * labels change per kind.
 */
export const PROVENANCE_FIELDS: Record<SourceKind, readonly ProvenanceField[]> = {
  link: [{ key: "where", label: "주소" }],
  article: [
    { key: "where", label: "매체·제목" },
    { key: "when", label: "언제 나온 글인가" },
  ],
  policy: [
    { key: "where", label: "문서명" },
    { key: "who", label: "조항" },
  ],
  interview: [
    { key: "who", label: "누가 말했나 (화자)" },
    { key: "when", label: "언제" },
  ],
  test: [{ key: "when", label: "언제 해 봤나" }],
  none: [
    { key: "who", label: "누가" },
    { key: "when", label: "언제" },
    { key: "where", label: "어떤 상황에서" },
  ],
};

/**
 * SX-20 — the provenance line. Empty means "source not recorded", and we never fill it
 * in by guessing.
 *
 * When only part of it was written, show what was written as-is and say alongside it
 * that something is missing. Showing two of the three as if it were a complete source
 * makes the weight of that evidence read wrong later.
 */
export function provenanceLine(row: Pick<EvidenceRowView, "provenance">): string {
  const p = row.provenance;
  if (!p) return "출처 미기록";
  const parts = [p.who, p.when, p.where].map((v) => (typeof v === "string" ? v.trim() : ""));
  // `UNRECORDED` is a stored value, not a written one. On screen it is treated like an empty field.
  const filled = parts.filter((v) => v.length > 0 && v !== UNRECORDED);
  if (filled.length === 0) return "출처 미기록";
  if (filled.length < 3) return `${filled.join(" · ")} (나머지 미기록)`;
  return filled.join(" · ");
}

export interface EvidenceGroup {
  type: EvidenceType | null;
  label: string;
  rows: EvidenceRowView[];
}

/** SX-18 — split by type. Rows with no type are **left** in the `type: null` group. */
export function groupByEvidenceType(rows: readonly EvidenceRowView[]): EvidenceGroup[] {
  const order: (EvidenceType | null)[] = [...(Object.keys(EVIDENCE_TYPE_LABELS) as EvidenceType[]), null];
  return order.map((type) => ({
    type,
    label: type === null ? UNTYPED_LABEL : EVIDENCE_TYPE_LABELS[type],
    rows: rows.filter((r) => (r.evidence_type ?? null) === type),
  }));
}

/** SX-22 — filter the list by kind. `null` means no filter, not the "none" kind. */
export function filterBySourceKind(
  rows: readonly EvidenceRowView[],
  kind: SourceKind | null,
): EvidenceRowView[] {
  if (kind === null) return [...rows];
  return rows.filter((r) => r.source_kind === kind);
}

/**
 * SX-23 — the one-line reason for a choice.
 *
 * If it is empty it stays as "reason not recorded". A sentence the coach wrote
 * (actor≠user) is never shown as the student's reason — otherwise what the AI filled in
 * on their behalf gets counted as the student's own judgment.
 */
export function decisionReason(row: Pick<EvidenceRowView, "text" | "actor">): string {
  if (row.actor !== "user") return "이유 미기록 (학생이 쓴 문장이 아님)";
  const text = typeof row.text === "string" ? row.text.trim() : "";
  return text.length > 0 ? text : "이유 미기록";
}

// ── SX-16 before/after view ─────────────────────────────────────────────────

/** The note attached when there is no AI draft. **Do not build an empty comparison** (SX-16 negative condition). */
export const NO_AI_DRAFT = "AI 초안 없음";

export interface ArtifactSide {
  id: string;
  sha256: string;
  /** The preserved body. Empty string when there is none, and the screen draws it as "no body". */
  text: string;
  actor: string;
}

export interface BeforeAfterPair {
  id: string;
  /** The AI draft. null when there is none, and `note` says so. */
  before: ArtifactSide | null;
  after: ArtifactSide;
  /** The verbatim expected condition that applied at that moment. Empty string when there is none. */
  criterionText: string;
  criterionId: string | null;
  note: string | null;
}

/**
 * One before/after pair per change (SX-16).
 *
 * **The pairing key is `change_requested`.** The two fields SX-16 calls by name are
 * `artifact_before` and `artifact_after`; the change request holds the first, and the
 * confirmation that follows it (`retest_confirmed`/`test_observed`) holds the second.
 * Do not build pairs by picking **adjacent** entries in the artifact list — it was
 * written that way at first, and then even a state where the student has fixed nothing
 * yet (they just confirmed the coach's draft once) gets drawn as a "before/after". The
 * data already says what the before is; there is no reason to guess from position
 * (verification.md rule 1).
 *
 * Three changes means three pairs. Lumping them into the last one makes the two earlier
 * judgments never have happened.
 *
 * If a task has **no** change request at all and only a confirmation, there was no AI
 * draft in the first place. Only then is it `before: null` + "no AI draft", and we do
 * not build an empty comparison (SX-16 negative condition).
 */
export function beforeAfterOf(rows: readonly EvidenceRowView[]): BeforeAfterPair[] {
  const ordered = [...rows].sort((a, b) => a.at - b.at);
  const bySha = new Map<string, EvidenceRowView>();
  for (const r of ordered) if (r.kind === "artifact" && typeof r.sha256 === "string") bySha.set(r.sha256, r);
  const criterionText = (id: string | null | undefined) =>
    (id && ordered.find((r) => r.id === id)?.text) || "";

  const side = (row: EvidenceRowView | undefined): ArtifactSide | null =>
    row && typeof row.sha256 === "string"
      ? { id: row.id, sha256: row.sha256, text: row.text ?? "", actor: row.actor }
      : null;

  const isCheck = (r: EvidenceRowView) => r.kind === "retest_confirmed" || r.kind === "test_observed";
  const changes = ordered.filter((r) => r.kind === "change_requested" && typeof r.artifact_before === "string");
  const pairs: BeforeAfterPair[] = [];

  for (const change of changes) {
    // The first confirmation **after** this change points at that change's result. Stop
    // before the next change so we don't drag in a confirmation belonging to it.
    const next = changes.find((c) => c.at > change.at);
    const check = ordered.find(
      (r) => isCheck(r) && r.at > change.at && (!next || r.at < next.at) && typeof r.artifact_after === "string",
    );
    if (!check) continue;
    const after = side(bySha.get(String(check.artifact_after)));
    if (!after) continue;
    const before = side(bySha.get(String(change.artifact_before)));
    pairs.push({
      id: check.id,
      before,
      after,
      criterionText: criterionText(check.criterion_ref ?? change.criterion_ref),
      criterionId: (check.criterion_ref ?? change.criterion_ref) ?? null,
      note: before ? null : NO_AI_DRAFT,
    });
  }
  if (pairs.length > 0) return pairs;

  // There was no change request at all. If there is only a confirmation, this task had no AI draft.
  const solo = ordered.find((r) => isCheck(r) && typeof r.artifact_after === "string");
  const after = solo && side(bySha.get(String(solo.artifact_after)));
  if (!solo || !after) return [];
  return [{
    id: solo.id,
    before: null,
    after,
    criterionText: criterionText(solo.criterion_ref),
    criterionId: solo.criterion_ref ?? null,
    note: NO_AI_DRAFT,
  }];
}

/** The revision label used on screen. A 64-character hex string means nothing to a student. */
export const shortRevision = (sha256: string) => String(sha256).slice(0, 7);

// ── SX-21 · SX-46 real / simulated labels ───────────────────────────────────

/**
 * The **single** vocabulary for the four states (SX-21).
 *
 * The data's `source_state` and the on-screen wording come from the same place. Keeping
 * a copy on the screen side means that when one value is added there is a state with no
 * label, and that is the "unlabeled external reaction" SX-21 forbids. A check counts
 * that this table's keys and the core enum are exactly the same.
 *
 * **The distinction is in the wording, not the color.** Real and simulated must split
 * apart for a color-blind student and in black-and-white print too.
 */
export const SOURCE_STATE_LABELS: Record<string, string> = {
  real: "실제로 있었던 일",
  simulated: "가상으로 해 본 것",
  self_reported: "내가 그렇다고 적은 것",
  unverified: "아직 확인 전",
};

/**
 * The states that get Amber (SX-21 "Amber is used only for confusable states").
 *
 * Simulated only. Putting a warning on real as well turns the warning into background,
 * and then nobody looks at it in the very place that is confusing.
 */
export const AMBER_STATES: readonly string[] = ["simulated"];

/**
 * The label line. Unknown and empty values read as **`unverified`**.
 *
 * It never falls back to `real` — showing something unknown as "really happened" is the
 * worst mistake this screen can make (SX-46).
 */
export function sourceStateLabel(state: unknown): string {
  return SOURCE_STATE_LABELS[normalizeSourceState(state)]!;
}

/**
 * Falls unknown and empty values back to `unverified`.
 *
 * The label, the Amber decision and `data-source-state` must **all pass through this
 * function** or one row reads two ways. If only the label is normalized and the rest use
 * the raw value, then when an unknown string arrives the markup says that string while
 * the screen says "not verified yet".
 */
export function normalizeSourceState(state: unknown): string {
  const key = typeof state === "string" ? state : "";
  return Object.prototype.hasOwnProperty.call(SOURCE_STATE_LABELS, key) ? key : "unverified";
}

/**
 * Real / everything else (SX-46).
 *
 * `simulated`·`self_reported`·`unverified` do not mix into the real column. What this
 * function is there to prevent is the week-4 fake payment reading as revenue; once they
 * mix, the student mistakes a number they made themselves for an answer the world gave
 * them.
 *
 * It does not count and return a number. The moment you count, "N reactions" exists, and
 * that is a score.
 */
export function partitionBySourceState(rows: readonly EvidenceRowView[]): {
  real: EvidenceRowView[];
  aside: EvidenceRowView[];
} {
  const real: EvidenceRowView[] = [];
  const aside: EvidenceRowView[] = [];
  for (const row of rows) (row.source_state === "real" ? real : aside).push(row);
  return { real, aside };
}
