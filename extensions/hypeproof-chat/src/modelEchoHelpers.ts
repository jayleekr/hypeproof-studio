// #897 H-13 — **요청한 모델과 실제로 답한 모델이 다를 때** 화면이 무엇을 말하나.
//
// 2026-09-11 Codex 관측(H-05 부분): 같은 요청 `gpt-5.6-luna` 에 (A) 같은 모델 에코와
// (B) `claude-sonnet-4-6` 에코를 주입했더니 **화면 전체 innerText 가 완전히 같았다.**
// 모델 선택기는 둘 다 GPT 를 유지했고 변경 안내도, 불일치 표시도 없었다. 응답의
// `usage.model` 은 갈렸고 `x-hps-model` 헤더도 왔지만 그 값을 읽는 코드가 확장 어디에도
// 없었다 — `proxyUsageRecorder` 가 spool 에 넘기고 끝이었다.
//
// 즉 **조용한 대체가 성공과 구별되지 않는다.** 이 파일은 그 구별을 한 곳에서 만든다.
//
// 설계에서 가장 중요한 결정 둘:
//
//   1. **명시적 선택과 서버 해석을 구분한다.** 학생이 직접 고른 모델이 바뀐 것과,
//      수업 기본값/legacy alias 가 서버에서 구체 모델로 풀린 것은 다른 사건이다.
//      후자까지 경고하면 정상 동작이 매 턴 경고를 내고, 그러면 진짜 대체도 같이
//      무시된다(승인 피로와 같은 병).
//   2. **날짜 변형을 대체로 세지 않는다.** 공급자는 `claude-sonnet-4-6` 을 물어도
//      `claude-sonnet-4-6-20260901` 처럼 날짜가 붙은 id 를 에코한다. 그걸 불일치로
//      세면 정상 응답마다 거짓 경고가 뜨고, 이 레포는 그런 계측기를 이미 비싸게
//      치렀다. 그래서 날짜 접미만 다른 경우는 **일치**로 판정하되 그 사실을 남긴다.
//
// 이 파일이 **주장하지 않는 것**:
//   - 서버가 실제로 모델을 바꾼다는 주장 아님. 지금까지 실제 운영에서 관측된 것은
//     Codex 의 **합성 SSE 주입**이고, 정상 UI 는 허용 목록만 노출한다.
//   - 공급자 변경을 자동으로 되돌리거나 다시 보내는 정책 아님 — 그건 승인이 필요한
//     결정이고 이 층은 **표시**만 한다.
//   - SDK 경로 검증 아님(#897 H-05 는 proxy 경로 관측이다).
//
// 순수하다 — `vscode` 도 DOM 도 import 하지 않는다.

/** 이 턴의 모델이 **어떻게 정해졌나**. 판정이 여기서 갈린다. */
export type ModelSelectionSource =
  /** 학생이 선택기에서 직접 골랐다. 바뀌면 말해야 한다. */
  | 'explicit'
  /** 수업/프로필 기본값. 서버가 구체 모델로 푸는 것이 정상이다. */
  | 'course_default'
  /** 구형 alias — 서버 해석에 맡긴 경로. 역시 정상이다. */
  | 'legacy_alias'
  /** 출처를 모른다. 모르면 경고하지 않는다(REQ-R1 ③ 과 같은 규칙). */
  | 'unknown';

export interface ModelChoice {
  readonly alias: string;
  readonly id: string;
  readonly label?: string;
  readonly provider?: string;
}

export interface ModelEchoInput {
  /** 요청에 실어 보낸 alias. 없으면 모른다. */
  readonly requestedAlias: string | null;
  readonly source: ModelSelectionSource;
  /** 공급자/워커가 에코한 실제 모델 (`usage.model` 또는 `x-hps-model`). 없으면 null. */
  readonly resolved: string | null;
  /** 이 좌석의 허용 선택지. alias → id 매핑에 쓴다. */
  readonly choices: readonly ModelChoice[];
  /** 좌석 전체의 공급자. 선택지별 provider 가 없을 때의 기본값이다. */
  readonly seatProvider?: string | null;
}

export type ModelEchoVerdict =
  /** 요청과 응답이 같다. `dated` 는 날짜 접미만 다른 경우. */
  | { readonly kind: 'match'; readonly dated: boolean }
  /**
   * 에코가 없거나 요청 모델을 모른다. **일치라고도 불일치라고도 적지 않는다.**
   * 측정하지 못한 것을 사실로 쓰지 않기 위한 갈래다.
   */
  | { readonly kind: 'unobserved'; readonly why: 'no_echo' | 'unknown_request' }
  /** 기본값/legacy 를 서버가 구체 모델로 풀었다 — 정상 경로. */
  | { readonly kind: 'server_resolved'; readonly resolved: string }
  /** 명시적으로 고른 모델이 아닌 것이 답했다. */
  | {
      readonly kind: 'substituted';
      readonly requested: string;
      readonly requestedLabel: string;
      readonly resolved: string;
      readonly providerChanged: boolean;
    };

const norm = (v: string): string => v.trim().toLowerCase();

/** 날짜 접미(`-20260901`)만 다른 같은 모델인가. 공급자가 흔히 이렇게 에코한다. */
function datedVariantOf(base: string, actual: string): boolean {
  if (!actual.startsWith(base + '-')) return false;
  return /^\d{6,8}$/.test(actual.slice(base.length + 1));
}

function sameModel(choice: ModelChoice, resolved: string): { same: boolean; dated: boolean } {
  const r = norm(resolved), id = norm(choice.id), alias = norm(choice.alias);
  if (r === id || r === alias) return { same: true, dated: false };
  if (datedVariantOf(id, r) || datedVariantOf(alias, r)) return { same: true, dated: true };
  return { same: false, dated: false };
}

/** 에코된 모델이 어느 선택지인지 — 공급자 변경 여부 판정에 쓴다. */
function choiceFor(resolved: string, choices: readonly ModelChoice[]): ModelChoice | undefined {
  return choices.find(c => sameModel(c, resolved).same);
}

/**
 * 요청 ↔ 응답 모델 판정.
 *
 * 순서가 의미를 가진다: **관측 부재를 먼저 걸러낸다.** 에코가 없는데 비교를 계속하면
 * "다르다" 가 나오고, 그건 측정하지 못한 것을 불일치로 적는 것이다.
 */
export function modelEchoVerdict(i: ModelEchoInput): ModelEchoVerdict {
  const resolved = i.resolved?.trim();
  if (!resolved) return { kind: 'unobserved', why: 'no_echo' };

  const requested = i.requestedAlias?.trim();
  if (!requested) return { kind: 'unobserved', why: 'unknown_request' };

  const chosen = i.choices.find(c => norm(c.alias) === norm(requested) || norm(c.id) === norm(requested));
  if (!chosen) {
    // 허용 목록에 없는 alias — 구형 기본값 경로다. 서버 해석이 정상이므로 경고하지 않는다.
    // 단 명시적 선택이었다고 주장할 근거도 없으므로 `server_resolved` 로 남긴다.
    return { kind: 'server_resolved', resolved };
  }

  const { same, dated } = sameModel(chosen, resolved);
  if (same) return { kind: 'match', dated };

  // 다르다. 여기서 **출처가 판정을 가른다.**
  if (i.source !== 'explicit') return { kind: 'server_resolved', resolved };

  const answered = choiceFor(resolved, i.choices);
  const requestedProvider = chosen.provider ?? i.seatProvider ?? null;
  const answeredProvider = answered?.provider ?? (answered ? i.seatProvider ?? null : null);
  return {
    kind: 'substituted',
    requested: chosen.alias,
    requestedLabel: chosen.label ?? chosen.alias,
    resolved,
    // 응답 모델이 허용 목록 밖이면 공급자를 **모른다** — 모르는 것을 "바뀌었다" 로
    // 적지 않는다. 목록 안이고 공급자가 다를 때만 공급자 변경으로 본다.
    providerChanged: !!(requestedProvider && answeredProvider && norm(requestedProvider) !== norm(answeredProvider)),
  };
}

/**
 * 학생 화면에 붙일 한 줄. 붙일 것이 없으면 `null`.
 *
 * 문구 규칙은 REQ-M15/M39 와 같다 — **원인을 단정하지 않고**, 무슨 일이 있었는지
 * 말하고, 다음 행동을 하나 준다. 자동으로 다시 보내거나 모델을 되돌리지 않는다.
 */
export function modelEchoNotice(v: ModelEchoVerdict): string | null {
  if (v.kind !== 'substituted') return null;
  const head = `\n\n---\n\n골라 둔 **${v.requestedLabel}** 대신 \`${v.resolved}\` 가 이 답을 만들었어요.`;
  return v.providerChanged
    ? `${head} 만드는 곳이 바뀐 것이라 말투나 결과가 달라질 수 있어요. 그대로 이어가도 되고, 모델을 다시 골라도 돼요 — 선생님께 알려주면 더 좋아요. 🔧`
    : `${head} 그대로 이어가도 되고, 모델을 다시 골라도 돼요. 이상하면 선생님께 알려주세요. 🔧`;
}

/**
 * 기록용 한 줄 — 사람이 읽는 진단/스풀용이고 화면 문구가 아니다.
 *
 * `match` 와 `unobserved` 를 **둘 다** 남기는 것이 요점이다. 조용한 성공만 기록하면
 * 나중에 "그날 실제로 어떤 모델이 답했나" 를 아무도 답할 수 없다.
 */
export function describeModelEcho(v: ModelEchoVerdict): string {
  switch (v.kind) {
    case 'match': return v.dated ? 'model=match(dated)' : 'model=match';
    case 'unobserved': return `model=unobserved(${v.why})`;
    case 'server_resolved': return `model=server_resolved(${v.resolved})`;
    case 'substituted':
      return `model=substituted(${v.requested}->${v.resolved}${v.providerChanged ? ',provider_changed' : ''})`;
  }
}
