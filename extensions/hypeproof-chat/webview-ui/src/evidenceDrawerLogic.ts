/**
 * D 영역(Evidence drawer) 의 순수 판정 (SX-17·18·20·22·23).
 *
 * `.tsx` 가 아니라 `.ts` 인 이유는 `MissionHeader`/`missionHeaderLogic` 과 같다 —
 * `node --experimental-strip-types` 는 JSX 를 스트립하지 못한다. 컴포넌트는
 * 렌더 계측기로 보고, 규칙은 여기서 직접 부른다.
 *
 * 여기에 **해석이 없다.** 서랍은 무엇이 있었는지만 보여 준다(SX-17 부정 조건:
 * "drawer 가 해석·점수를 포함하면 실패"). 해석은 E 회고와 F 변화 기록의 몫이다.
 */
import type {
  EvidenceType,
  SourceKind,
} from "../../../../worker/src/lib/measurement-core/learning-events.ts";

/** 서랍이 다루는 근거 한 줄. 호스트가 `learningState.evidence` 로 내려보낸 모양 그대로다. */
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
  /** SX-16 — 변경 전후 보기가 쓰는 칸. */
  sha256?: string | null;
  artifact_before?: string | null;
  artifact_after?: string | null;
  criterion_ref?: string | null;
}

/**
 * SX-18 의 여섯 종류. 순서는 설계 §관측 이벤트와 필드의 표 순서다.
 *
 * 라벨에 숫자를 쓰지 않는다. "근거 3종" 같은 문구는 개수 세기를 부르고, 개수는
 * 곧 점수로 읽힌다.
 */
export const EVIDENCE_TYPE_LABELS: Record<EvidenceType, string> = {
  intent: "무엇을 하려 했나",
  criterion: "기대 조건",
  action: "직접 해 본 것",
  decision: "고른 이유",
  change: "고쳐 달라고 한 것",
  ownership: "내가 맡은 몫",
};

/** 종류를 모르는 근거가 가는 자리. 여섯 중 하나로 **추정하지 않는다**. */
export const UNTYPED_LABEL = "종류 미기록";

/**
 * 학생이 비워 둔 출처 칸에 저장하는 값.
 *
 * `/2` 검증기는 `provenance` 에 `{who,when,where}` 세 칸이 **모두 비어 있지 않을 것**을
 * 요구한다(`legacy-observation.ts` `shapeOf`). 그런데 SX-20 은 미입력을 "출처 미기록"
 * 으로 남기라고 한다. 빈 문자열을 보내면 배치 전체가 거절되고, 아무 말이나 지어
 * 넣으면 SX-20 이 금지한 "추정으로 채우기" 가 된다.
 *
 * 그래서 **기록되지 않았다는 사실 자체를 기록한다.** 지어낸 출처가 아니므로 추정이
 * 아니고, 화면에서는 `provenanceLine` 이 빈 칸과 똑같이 다룬다. 스키마를 넓히는
 * 쪽이 옳은지는 사람이 정할 일이고 STATE.md 개정 제안에 올려 둔다.
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
 * SX-22 — 종류마다 필요한 출처 칸이 다르다.
 *
 * 인터뷰는 **누가·언제**, 규정은 **문서명(어디)·조항**이 필요하다. 전부 같은 칸을
 * 요구하면 "URL 만으로 규정으로 분류" 하는 길이 열린다(SX-22 부정 조건).
 * 칸 이름은 `provenance{who,when,where}` 셋으로 고정돼 있고(스키마는 P1-A 에서
 * 닫혔다), 라벨만 종류에 맞게 바꾼다.
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
 * SX-20 — 출처 한 줄. 비어 있으면 "출처 미기록" 이고, 추정으로 채우지 않는다.
 *
 * 일부만 적힌 경우 적어 준 것은 그대로 보여 주고 빠진 것이 있다는 사실을 함께
 * 말한다. 셋 중 둘만 있는 것을 완성된 출처처럼 보여 주면 나중에 그 근거의 무게를
 * 잘못 읽게 된다.
 */
export function provenanceLine(row: Pick<EvidenceRowView, "provenance">): string {
  const p = row.provenance;
  if (!p) return "출처 미기록";
  const parts = [p.who, p.when, p.where].map((v) => (typeof v === "string" ? v.trim() : ""));
  // `UNRECORDED` 는 저장된 값이지 적힌 값이 아니다. 화면에서는 빈 칸과 같이 다룬다.
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

/** SX-18 — 종류별로 나눈다. 종류가 없는 것은 `type: null` 묶음으로 **남겨 둔다**. */
export function groupByEvidenceType(rows: readonly EvidenceRowView[]): EvidenceGroup[] {
  const order: (EvidenceType | null)[] = [...(Object.keys(EVIDENCE_TYPE_LABELS) as EvidenceType[]), null];
  return order.map((type) => ({
    type,
    label: type === null ? UNTYPED_LABEL : EVIDENCE_TYPE_LABELS[type],
    rows: rows.filter((r) => (r.evidence_type ?? null) === type),
  }));
}

/** SX-22 — 목록을 종류로 거른다. `null` 은 필터 없음이지 "종류 없음" 이 아니다. */
export function filterBySourceKind(
  rows: readonly EvidenceRowView[],
  kind: SourceKind | null,
): EvidenceRowView[] {
  if (kind === null) return [...rows];
  return rows.filter((r) => r.source_kind === kind);
}

/**
 * SX-23 — 선택 이유 한 줄.
 *
 * 비어 있으면 "이유 미기록" 으로 남는다. 코치가 쓴 문장(actor≠user)은 학생의
 * 이유로 보여 주지 않는다 — 그러면 AI 가 대신 채운 것이 학생 판단으로 집계된다.
 */
export function decisionReason(row: Pick<EvidenceRowView, "text" | "actor">): string {
  if (row.actor !== "user") return "이유 미기록 (학생이 쓴 문장이 아님)";
  const text = typeof row.text === "string" ? row.text.trim() : "";
  return text.length > 0 ? text : "이유 미기록";
}

// ── SX-16 변경 전후 보기 ─────────────────────────────────────────────────────

/** AI 초안이 없을 때 붙는 주석. **빈 비교를 만들지 않는다**(SX-16 부정 조건). */
export const NO_AI_DRAFT = "AI 초안 없음";

export interface ArtifactSide {
  id: string;
  sha256: string;
  /** 보존된 본문. 없으면 빈 문자열이고 화면은 "본문 없음" 으로 그린다. */
  text: string;
  actor: string;
}

export interface BeforeAfterPair {
  id: string;
  /** AI 초안. 없으면 null 이고 `note` 가 그 사실을 말한다. */
  before: ArtifactSide | null;
  after: ArtifactSide;
  /** 그때 적용된 기대 조건 원문. 없으면 빈 문자열. */
  criterionText: string;
  criterionId: string | null;
  note: string | null;
}

/**
 * 변경 하나마다 전후 한 쌍 (SX-16).
 *
 * **쌍의 기준은 `change_requested` 다.** SX-16 이 이름으로 부르는 두 칸이
 * `artifact_before` 와 `artifact_after` 이고, 앞의 것은 변경 요청이, 뒤의 것은 그
 * 뒤의 확인(`retest_confirmed`/`test_observed`)이 들고 있다. 산출물 목록에서
 * 앞뒤로 **인접한 것**을 골라 쌍을 만들지 않는다 — 처음에 그렇게 썼고, 그러면
 * 학생이 아직 아무것도 고치지 않은 상태(코치 초안을 그냥 한 번 확인한 것)까지
 * "변경 전후" 로 그려 버린다. 데이터가 이미 무엇이 before 인지 말하고 있는데
 * 위치로 짐작할 이유가 없다(verification.md 규칙 1).
 *
 * 변경이 세 번이면 쌍도 셋이다. 마지막 하나로 뭉뚱그리면 앞의 두 판단은 없었던
 * 일이 된다.
 *
 * 변경 요청이 **한 번도 없었던** 과제에서 확인만 있으면, AI 초안이 아예 없었던
 * 것이다. 그때만 `before: null` + "AI 초안 없음" 이고, 빈 비교를 만들지 않는다
 * (SX-16 부정 조건).
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
    // 이 변경 **뒤**의 첫 확인이 그 변경의 결과를 가리킨다. 그 뒤의 변경에 딸린
    // 확인을 끌어오지 않도록 다음 변경 앞에서 멈춘다.
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

  // 변경 요청이 한 번도 없었다. 확인만 있다면 AI 초안이 없었던 과제다.
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

/** 화면에 쓰는 개정본 표시. 64자 16진수는 학생에게 아무 의미가 없다. */
export const shortRevision = (sha256: string) => String(sha256).slice(0, 7);

// ── SX-21 · SX-46 real / simulated 라벨 ──────────────────────────────────────

/**
 * 네 상태의 **하나뿐인** 어휘 (SX-21).
 *
 * 데이터의 `source_state` 와 화면 문구가 같은 곳에서 나온다. 화면 쪽에 사본을 두면
 * 값이 하나 늘었을 때 라벨 없는 상태가 생기고, 그것이 SX-21 이 금지하는
 * "라벨 없는 외부 반응" 이다. 검사가 이 표의 키와 코어 enum 이 정확히 같은지를 센다.
 *
 * **색이 아니라 문구로 구분한다.** 색맹인 학생과 흑백 인쇄에서도 실제와 가상이
 * 갈라져야 한다.
 */
export const SOURCE_STATE_LABELS: Record<string, string> = {
  real: "실제로 있었던 일",
  simulated: "가상으로 해 본 것",
  self_reported: "내가 그렇다고 적은 것",
  unverified: "아직 확인 전",
};

/**
 * Amber 를 붙이는 상태 (SX-21 "Amber는 혼동 가능 상태에만 쓴다").
 *
 * 가상만이다. 실제에까지 경고를 붙이면 경고가 배경이 되고, 정작 헷갈릴 자리에서
 * 아무도 보지 않게 된다.
 */
export const AMBER_STATES: readonly string[] = ["simulated"];

/**
 * 라벨 한 줄. 모르는 값과 빈 값은 **`unverified`** 로 읽는다.
 *
 * 절대 `real` 로 떨어지지 않는다 — 모르는 것을 "실제로 있었던 일" 로 보여 주는 것이
 * 이 화면이 할 수 있는 가장 나쁜 실수다(SX-46).
 */
export function sourceStateLabel(state: unknown): string {
  return SOURCE_STATE_LABELS[normalizeSourceState(state)]!;
}

/**
 * 모르는 값·빈 값을 `unverified` 로 떨어뜨린다.
 *
 * 라벨·Amber 판정·`data-source-state` 가 **전부 이 함수를 지나야** 한 줄이 두 가지로
 * 읽히지 않는다. 라벨만 정규화하고 나머지가 원값을 쓰면, 모르는 문자열이 들어왔을 때
 * 마크업은 그 문자열을 말하고 화면은 "아직 확인 전" 을 말한다.
 */
export function normalizeSourceState(state: unknown): string {
  const key = typeof state === "string" ? state : "";
  return Object.prototype.hasOwnProperty.call(SOURCE_STATE_LABELS, key) ? key : "unverified";
}

/**
 * 실제 / 그 밖 (SX-46).
 *
 * `simulated`·`self_reported`·`unverified` 는 실제 칸에 섞이지 않는다. 4주차 가짜
 * 결제가 매출로 읽히는 것이 이 함수가 막으려는 것이고, 섞이면 학생은 자기가 만든
 * 숫자를 세상이 준 답으로 착각한다.
 *
 * 개수를 세서 돌려주지 않는다. 세는 순간 "반응 N건" 이 생기고 그것은 곧 점수다.
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
