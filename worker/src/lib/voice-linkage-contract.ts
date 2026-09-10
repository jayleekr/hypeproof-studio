// #897 (VO-03) — 음성 세션을 **기존** 식별자에 묶는 단 하나의 버전 계약.
//
// 왜 이 파일이 이 모양인가.
//
// 1) 아직 음성 세션은 **존재할 수 없다.** 2026-09-10 설치본의 webview iframe
//    Permissions-Policy allow 목록은 `clipboard-read`·`clipboard-write` 뿐이고
//    `microphone` 은 0건이다(#904 / `voiceCapabilityHelpers.ts`). 그래서 이 계약은
//    "돌아가는 기능의 명세"가 아니라 **앞으로 어떤 음성 코드도 식별자를 새로 만들지
//    못하게 막는 잠금**이다.
// 2) 그 결과 계약이 주장할 수 있는 범위는 **이미 코드가 강제하는 것**까지다.
//    공급자(VO-02 ADR)가 정해지지 않았으므로 "모델이 실제로 들은 오디오"와
//    "끼어들기(barge-in) 취소 의미"는 지금 쓰면 추측이다. 그 둘은 PROVISIONAL 로
//    **타입에서 막아둔다** — 주석으로만 적으면 다음 사람이 구체값을 채워 넣고
//    그게 계약처럼 배포된다. 이 레포는 그 비용을 이미 치렀다.
// 3) VO-T03 은 "임의 새 스토어를 만들지 않았는지" 증거를 요구한다. 그래서
//    식별자별 소유 스토어를 `VOICE_LINKAGE_FIELD_OWNERS` 로 **기계가 읽을 수 있게**
//    적었고, 테스트가 그 증거 리터럴이 실제로 worker 소스에 있는지 확인한다.
//    측정 범위를 정확히 적는다 — 테스트의 스토어 스캐너는 **이름에** voice/audio/
//    speech/transcript/utterance 토큰이 든 테이블·KV 네임스페이스만 잡는다. 이름에
//    그 토큰이 없는 스토어(`realtime_sessions`, `rt:sess:` 같은 것)는 못 잡는다.
//    그쪽을 덮는 것은 스캐너가 아니라 아래 **허용 키 드리프트 락**이다: 새 스토어는
//    키로 쓸 식별자가 필요하고, 새 식별자는 RECORD_KEYS / EVENT_KEYS / FIELD_OWNERS
//    중 하나를 반드시 건드린다. 스캐너 하나로 "임의 새 스토어 없음" 을 주장하지 않는다.
//
// 순수 모듈이다 — D1/KV/Env 를 건드리지 않고, 런타임 import 는 기존 문법 정의
// 세 곳(아래)뿐이다. 그 셋을 직접 import 하는 것이 요점이다: 문법을 복사해 적으면
// 조용히 갈라지고, import 하면 갈라질 때 타입체크가 터진다.

import { validTurnId } from './request-settings';
import { accessId } from './access-contracts';
import { isUuid } from './storage';
import { isSha256Hex } from './liveness';

/** 이 계약의 버전. 모양이 바뀌면 올린다 — 과거 기록을 새 계약으로 읽지 않는다. */
export const VOICE_LINKAGE_SCHEMA = 'hps-voice-linkage/1';

/**
 * 서버가 **읽을 수 있는** 버전 집합.
 *
 * VO-T03 의 "과거 앱과 새 서버 조합" fixture 가 여기에 걸린다. 지금은 버전이 하나뿐이라
 * 실제로 구버전을 태울 수 없고, 그걸 감추기 위해 `hps-voice-linkage/0` 같은 **없던
 * 버전을 발명하지 않는다.** 대신 판정 메커니즘을 집합 포함 검사로 만들고
 * `validateVoiceLinkage(v,{accept})` 로 주입 가능하게 두었다 — 그래서 구/신 혼용
 * 경로는 "측정 안 됨"이 아니라 **메커니즘 단위로는 검증된 상태**가 된다.
 * /2 가 실제로 나오면 이 배열에 /1 을 **남겨둔 채** 추가한다.
 */
export const SUPPORTED_VOICE_LINKAGE_SCHEMAS: readonly string[] = [VOICE_LINKAGE_SCHEMA];

/**
 * 식별자 → **이미 그것을 소유한 스토어**.
 *
 * `evidence` 는 worker 소스에 실제로 존재하는 리터럴이다. 테스트가 grep 해서
 * 확인하므로, 여기 적힌 소유 스토어가 사라지면 계약이 먼저 터진다.
 *
 * `voice_session_id` 만 전용 스토어가 없다. 그래서 **만들지 않는다** — 기존
 * `hps-observation/1` 이벤트의 `task` 그룹 키로 실어 보낸다. 음성 세션에
 * 테이블을 하나 주는 순간 D1 마이그레이션(사람 게이트, DB 당 1회)이 음성 기능의
 * 배포 주기에 묶이고, 그건 액세서리 하나 때문에 전체 회계 스키마를 인질로 잡는 것이다.
 */
export const VOICE_LINKAGE_FIELD_OWNERS = {
  voice_session_id: { store: 'hps-observation/1 이벤트 스트림의 task 그룹', evidence: 'hps-observation/1' },
  cohort_id: { store: '토큰 payload (tokens.ts TokenPayload.c)', evidence: 'TokenPayload' },
  user_id: { store: '토큰 payload (tokens.ts TokenPayload.u)', evidence: 'TokenPayload' },
  session_id: { store: 'KV 활성 세션 (kv.ts sessionKey)', evidence: ':active_session' },
  trial_id: { store: 'D1 trials (storage.ts createTrial)', evidence: 'INSERT INTO trials' },
  turn_id: { store: 'D1 usage_request_settings.client_turn_id', evidence: 'client_turn_id' },
  request_id: { store: 'D1 usage_attempt_costs (budget-admission 예약 단위)', evidence: 'usage_attempt_costs' },
  artifact_sha256: { store: 'KV 산출물 레코드 (liveness.ts artifactKey)', evidence: 'live:af:' },
} as const;

/**
 * 이벤트 종류. **전부 이미 코드에 있는 전이**에 대응한다 — 공급자 프로토콜에서
 * 가져온 것은 하나도 없다(가져올 공급자가 아직 없다).
 *
 * - `voice_session_open` / `*_closed|failed|cancelled` — 세션 수명
 * - `turn_open` / `turn_closed` — 기존 턴 경계(`x-hps-turn-id`)
 * - `attempt_reserved` — `reserveBudgetAttempt` 가 D1 예약을 남긴 시점
 * - `attempt_dispatched` — `dispatchBudgetAttempt` 가 단 한 번만 허용하는 전이
 * - `artifact_revision` — 기존 `artifactChanged`(sha256)와 같은 사실
 */
export const VOICE_LINKAGE_EVENT_KINDS = [
  'voice_session_open',
  'turn_open',
  'attempt_reserved',
  'attempt_dispatched',
  'artifact_revision',
  'turn_closed',
  'voice_session_closed',
  'voice_session_failed',
  'voice_session_cancelled',
] as const;
export type VoiceLinkageEventKind = (typeof VOICE_LINKAGE_EVENT_KINDS)[number];

/** 종단 이벤트. 이 뒤에 오는 것은 전부 **지연 이벤트**이고 거부 대상이다. */
export const VOICE_LINKAGE_TERMINAL_KINDS = [
  'voice_session_closed',
  'voice_session_failed',
  'voice_session_cancelled',
] as const;

/**
 * Drift lock — 허용 키 집합. `trace.ts` 의 `ARTIFACT_CHANGED_EVENT_KEYS` 와 같은
 * 용도다. 앱과 서버가 다른 릴리스 열차를 타므로(worker 30초 / 앱 1~2시간+재설치)
 * 키가 조용히 늘어나는 것을 테스트 말고는 아무것도 막지 못한다.
 */
export const VOICE_LINKAGE_RECORD_KEYS = [
  'schema', 'voice_session_id', 'cohort_id', 'user_id', 'session_id', 'trial_id', 'events',
] as const;
export const VOICE_LINKAGE_EVENT_KEYS = [
  'id', 'seq', 'at', 'kind', 'turn_id', 'request_id', 'artifact_sha256', 'error_code', 'cancel', 'heard',
] as const;

/**
 * PROVISIONAL — 공급자가 정해지기 전에는 **값을 가질 수 없는** 자리.
 *
 * 리터럴 유니온이 `'unspecified'` 하나인 것은 의도다. 타입만으로 구체값 기입이
 * 막히고, 런타임 검증까지 이중으로 막는다.
 */
export type VoiceProvisional = 'unspecified';

export interface VoiceLinkageEvent {
  /** 이벤트 고유 id. (voice_session_id, id) 가 멱등 키다. */
  id: string;
  /** 1부터. **엄격 증가**. 빈 칸은 유실로 보고하되 거부하지 않는다(아래 missing). */
  seq: number;
  /** 클라이언트가 찍은 밀리초. 판정에 쓰지 않는다 — 순서의 근거는 `seq` 뿐이다. */
  at: number;
  kind: VoiceLinkageEventKind;
  /** 기존 `x-hps-turn-id`. `validTurnId` 문법을 그대로 쓴다. */
  turn_id?: string;
  /** 기존 공급자 시도 id(`x-hps-usage-request-id`). 콜론을 포함하므로 `accessId` 문법이다. */
  request_id?: string;
  /** 기존 산출물 revision. 내용이 아니라 sha256 64 hex. */
  artifact_sha256?: string;
  /** 실패 사유 코드. 사람이 읽는 문장이 아니라 코드다(학생 텍스트가 섞이면 안 된다). */
  error_code?: string;
  /**
   * 취소 의미.
   *
   * **확정된 부분**: `attempt_dispatched` — 이미 dispatch 된 시도였는지. 이건 추측이
   * 아니라 지금 코드가 강제하는 갈림길이다. `usage-costs.ts` 는 `execution:'not_sent'`
   * 증거를 `reserved|not_sent` 상태에서만 받고, 그 외에는
   * `attempt_already_dispatched`(409) 를 던진다. 즉 취소 이벤트가 이 값을 안 들고
   * 오면 비용 증거를 어느 쪽으로 기록할지 **결정할 수 없다**.
   *
   * **PROVISIONAL**: `audio_interruption` — 끼어들기 때 공급자가 부분 출력을
   * 커밋하는지, 취소된 구간이 과금되는지, 이미 재생 중인 오디오를 잘라야 하는지.
   * 공급자가 없으므로 값을 쓸 수 없다. 확정 조건: VO-02 ADR 의 공급자 선택 +
   * 그 공급자의 interruption 동작을 실기로 관측한 기록.
   */
  cancel?: { attempt_dispatched: boolean; audio_interruption?: VoiceProvisional };
  /**
   * **PROVISIONAL** — "모델이 실제로 들은 것".
   *
   * 지금 값을 쓸 수 없는 이유가 세 겹이다:
   *  1. `budget-admission.ts` validateWire 가 `body.audio` / 비-text `modalities` /
   *     `input_audio` 블록을 `unbounded_execution_feature` · `unbounded_media_or_tool`
   *     (403) 로 **거부한다.** 오디오를 실어 보낼 경로 자체가 없다.
   *  2. `usage-costs.ts` normalizeCostUsage 는 `audio_tokens` 가 0이 아니면 토큰
   *     미터를 null 로 만들고 `non_text_tokens` 를 남긴다 — 오디오 전용 가격 차원이
   *     아직 없다.
   *  3. 공급자가 미정이라 "들은 것"의 단위(초 / 샘플 / transcript revision)도 미정이다.
   *
   * 확정 조건: VO-02 ADR 의 공급자 선택 + 오디오 미터가 들어간 `UsagePrice` 발행 +
   * validateWire 거부의 **의도적** 해제. 셋 중 하나라도 없으면 이 칸은 비워 둔다.
   */
  heard?: { status: VoiceProvisional };
}

export interface VoiceLinkageRecord {
  schema: string;
  /** 앱이 `crypto.randomUUID()` 로 찍는다 — `turn_id` 와 **같은 생성기·같은 문법**. */
  voice_session_id: string;
  cohort_id: string;
  user_id: string;
  session_id: string;
  /** 기존 대화 단위(`x-hps-trial-id`). 대화 밖에서 열린 음성 세션은 null. */
  trial_id: string | null;
  events: VoiceLinkageEvent[];
}

/**
 * 계약 위반 전용 오류.
 *
 * `AccessError` 를 재사용하지 않는다 — 그쪽은 `budgetErrorResponse` 가 이용권/예산
 * 문장으로 번역해 학생에게 보여준다. 계약 모양 불일치를 "이용권을 확인하세요"로
 * 번역하면 진짜 원인이 영원히 가려진다.
 *
 * status 팔레트는 AccessError 와 같게 맞췄다: 모양 오류 400, 버전·중복 드리프트 409.
 */
export class VoiceLinkageError extends Error {
  readonly code: string;
  readonly status: 400 | 409;
  constructor(code: string, status: 400 | 409 = 400) {
    super(code);
    this.name = 'VoiceLinkageError';
    this.code = code;
    this.status = status;
  }
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keysWithin = (v: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));
function check(ok: unknown, code: string, status: 400 | 409 = 400): asserts ok {
  if (!ok) throw new VoiceLinkageError(code, status);
}

/** 오류 코드 문법. 학생 텍스트·공급자 원문이 이 칸으로 새지 않게 좁게 잡는다. */
const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** 멱등 키. 같은 키가 다른 내용으로 다시 오면 충돌이고, 같은 내용이면 재전송이다. */
export function voiceLinkageEventKey(voiceSessionId: string, eventId: string): string {
  return `${voiceSessionId}:${eventId}`;
}

export interface VoiceLinkageValidation {
  record: VoiceLinkageRecord;
  /** 엄격 증가 중 빠진 seq. 유실을 **거부하지 않고 드러낸다** — 깨끗한 기록과 구분된다. */
  missing: number[];
}

/**
 * 기록 하나를 검증한다.
 *
 * `validateObservation`(native-observation.ts)과 **일부러 다른 점**: 저쪽은 스풀
 * 재전송 배치라 seq 로 정렬해서 역순을 흡수한다. 이쪽은 라이브 append-only 로그이고
 * **순서 자체가 주장**이다. 역순으로 올라온 기록을 조용히 정렬해 통과시키면
 * "앱이 순서를 틀렸다"는 드리프트 신호를 우리가 지워버리는 것이다. 그래서 거부한다.
 */
export function validateVoiceLinkage(
  value: unknown,
  opts?: { accept?: readonly string[] },
): VoiceLinkageValidation {
  const accept = opts?.accept ?? SUPPORTED_VOICE_LINKAGE_SCHEMAS;
  check(object(value), 'voice_linkage_not_an_object');
  // 버전을 **키 검사보다 먼저** 본다. 새 앱이 키를 늘려 보냈을 때 올바른 보고는
  // "모양이 틀렸다"가 아니라 "버전이 다르다"다. 순서를 뒤집으면 버전 드리프트가
  // 전부 모양 오류로 오진된다.
  check(typeof value.schema === 'string' && accept.includes(value.schema),
    'voice_linkage_schema_unsupported', 409);
  check(keysWithin(value, VOICE_LINKAGE_RECORD_KEYS), 'voice_linkage_unknown_field');
  for (const field of ['voice_session_id', 'cohort_id', 'user_id', 'session_id'] as const)
    check(validTurnId(value[field]), 'invalid_' + field);
  check(value.trial_id === null || (typeof value.trial_id === 'string' && isUuid(value.trial_id)),
    'invalid_trial_id');
  check(Array.isArray(value.events) && value.events.length > 0 && value.events.length <= 2000,
    'invalid_voice_linkage_events');

  const ids = new Set<string>();
  const openTurns = new Set<string>();
  const reserved = new Set<string>();
  const dispatched = new Set<string>();
  // Set 이어야 한다. 배열이면 아래 빈 칸 스캔이 `previousSeq × events.length` 가 되고,
  // `previousSeq` 는 **클라이언트가 고르는 값**이다. 두 상한(이벤트 2000 / seq 100000)
  // 안에서도 합법 입력 하나가 worker CPU 를 50ms 태운다(측정: n=2000, topSeq=100000).
  // seq 는 엄격 증가이므로 중복이 없고, 따라서 `size` 는 지금까지 본 이벤트 수와 같다.
  const seqs = new Set<number>();
  let previousSeq = 0;
  let terminal: VoiceLinkageEventKind | null = null;

  for (const raw of value.events as unknown[]) {
    check(object(raw) && keysWithin(raw, VOICE_LINKAGE_EVENT_KEYS), 'invalid_voice_event');
    const e = raw as Record<string, unknown>;
    check(validTurnId(e.id), 'invalid_voice_event_id');
    check(Number.isSafeInteger(e.seq) && (e.seq as number) > 0 && (e.seq as number) <= 100000,
      'invalid_voice_event_seq');
    check(Number.isFinite(e.at), 'invalid_voice_event_at');
    check(typeof e.kind === 'string' && (VOICE_LINKAGE_EVENT_KINDS as readonly string[]).includes(e.kind),
      'invalid_voice_event_kind');
    const kind = e.kind as VoiceLinkageEventKind;

    // 중복: 같은 id 는 한 기록 안에 한 번만. 재전송은 기록 단위로
    // `reconcileVoiceLinkage` 가 처리한다 — 한 기록 안에 같은 id 가 두 번 있는 것은
    // 재전송이 아니라 앱이 같은 이벤트를 두 번 append 한 것이다.
    check(!ids.has(e.id as string), 'duplicate_voice_event_id', 409);
    ids.add(e.id as string);
    // 역순: 엄격 증가. 같은 seq 도 역순과 같은 위반이다(둘 다 "순서를 못 적었다").
    check((e.seq as number) > previousSeq, 'voice_event_sequence_out_of_order', 409);
    previousSeq = e.seq as number;
    seqs.add(e.seq as number);
    // 지연: 종단 뒤에는 아무것도 오지 않는다.
    check(terminal === null, 'late_voice_event_after_terminal', 409);

    // 세션 개시는 첫 이벤트 하나뿐이다.
    if (seqs.size === 1) check(kind === 'voice_session_open', 'voice_session_not_opened');
    else check(kind !== 'voice_session_open', 'voice_session_reopened', 409);

    // PROVISIONAL 칸은 비어 있거나 'unspecified' 다. 구체값은 추측이므로 거부한다.
    if (e.heard !== undefined) {
      check(object(e.heard) && keysWithin(e.heard, ['status']), 'invalid_voice_heard');
      check((e.heard as Record<string, unknown>).status === 'unspecified',
        'provisional_heard_not_settled', 409);
    }

    const turn = e.turn_id;
    const request = e.request_id;
    if (turn !== undefined) check(validTurnId(turn), 'invalid_voice_event_turn_id');
    if (request !== undefined) check(accessId(request), 'invalid_voice_event_request_id');

    switch (kind) {
      case 'voice_session_open':
        check(turn === undefined && request === undefined, 'voice_session_open_carries_turn');
        break;
      case 'turn_open':
        check(typeof turn === 'string', 'missing_voice_turn_id');
        check(!openTurns.has(turn), 'voice_turn_reopened', 409);
        openTurns.add(turn);
        break;
      case 'attempt_reserved':
        check(typeof turn === 'string' && openTurns.has(turn), 'orphan_voice_turn_event');
        check(typeof request === 'string', 'missing_voice_request_id');
        check(!reserved.has(request), 'voice_attempt_reserved_twice', 409);
        reserved.add(request);
        break;
      case 'attempt_dispatched':
        check(typeof turn === 'string' && openTurns.has(turn), 'orphan_voice_turn_event');
        check(typeof request === 'string' && reserved.has(request), 'orphan_voice_attempt_dispatch');
        // 코드명을 budget-admission.ts / usage-costs.ts 와 **같게** 쓴다. 같은 불변식을
        // 다른 이름으로 부르면 로그에서 두 개의 버그처럼 보인다.
        check(!dispatched.has(request), 'attempt_already_dispatched', 409);
        dispatched.add(request);
        break;
      case 'artifact_revision':
        // 산출물은 턴 밖에서도 바뀐다 — trace.ts 의 artifactChanged 가 trial 소유
        // 게이트를 건너뛰는 이유와 같다. 그래서 turn_id 를 요구하지 않는다.
        check(isSha256Hex(e.artifact_sha256), 'invalid_voice_artifact_revision');
        break;
      case 'turn_closed':
        check(typeof turn === 'string' && openTurns.has(turn), 'orphan_voice_turn_event');
        openTurns.delete(turn);
        break;
      case 'voice_session_failed':
        check(typeof e.error_code === 'string' && ERROR_CODE_RE.test(e.error_code),
          'invalid_voice_error_code');
        terminal = kind;
        break;
      case 'voice_session_cancelled': {
        check(object(e.cancel) && keysWithin(e.cancel, ['attempt_dispatched', 'audio_interruption']),
          'invalid_voice_cancel');
        const cancel = e.cancel as Record<string, unknown>;
        check(typeof cancel.attempt_dispatched === 'boolean', 'missing_voice_cancel_dispatch_state');
        if (cancel.audio_interruption !== undefined)
          check(cancel.audio_interruption === 'unspecified',
            'provisional_cancel_semantics_not_settled', 409);
        terminal = kind;
        break;
      }
      case 'voice_session_closed':
        terminal = kind;
        break;
    }

    if (kind !== 'voice_session_failed') check(e.error_code === undefined, 'unexpected_voice_error_code');
    if (kind !== 'voice_session_cancelled') check(e.cancel === undefined, 'unexpected_voice_cancel');
    if (kind !== 'artifact_revision') check(e.artifact_sha256 === undefined, 'unexpected_voice_artifact_revision');
  }

  const missing: number[] = [];
  for (let i = 1; i <= previousSeq; i++) if (!seqs.has(i)) missing.push(i);
  return {
    record: {
      schema: value.schema as string,
      voice_session_id: value.voice_session_id as string,
      cohort_id: value.cohort_id as string,
      user_id: value.user_id as string,
      session_id: value.session_id as string,
      trial_id: value.trial_id as string | null,
      events: value.events as VoiceLinkageEvent[],
    },
    missing,
  };
}

/**
 * 멱등성 — 이미 저장된 기록에 같은 기록이 다시 올 때의 의미.
 *
 * `'replay'`: 새 이벤트가 하나도 없다. 저장된 것을 그대로 돌려준다(무동작).
 * `'append'`: 새 이벤트만 이어 붙인 뒤 **전체를 다시 검증한다** — 이어 붙이기
 *   자체가 역순이나 종단 뒤 지연을 만들 수 있고, 그걸 검증 없이 저장하면
 *   개별 요청은 전부 합법인데 누적 기록만 불법인 상태가 된다.
 *
 * 같은 멱등 키가 **다른 내용**으로 오면 충돌이다(409). `usage-costs.ts` 의
 * `cost_evidence_conflict` 와 같은 규율이다: 나중 쓰기가 과거 기록을 조용히
 * 덮어쓰면 증거가 아니라 의견이 된다.
 */
export function reconcileVoiceLinkage(
  stored: unknown,
  incoming: unknown,
  opts?: { accept?: readonly string[] },
): { decision: 'replay' | 'append'; validation: VoiceLinkageValidation } {
  const a = validateVoiceLinkage(stored, opts).record;
  const b = validateVoiceLinkage(incoming, opts).record;
  for (const field of ['voice_session_id', 'cohort_id', 'user_id', 'session_id', 'trial_id'] as const)
    check(a[field] === b[field], 'voice_linkage_identity_conflict', 409);
  const known = new Map(a.events.map((e) => [voiceLinkageEventKey(a.voice_session_id, e.id), e]));
  const fresh: VoiceLinkageEvent[] = [];
  for (const e of b.events) {
    const key = voiceLinkageEventKey(b.voice_session_id, e.id);
    const previous = known.get(key);
    if (previous) {
      check(JSON.stringify(previous) === JSON.stringify(e), 'voice_linkage_event_conflict', 409);
      continue;
    }
    fresh.push(e);
  }
  if (fresh.length === 0) return { decision: 'replay', validation: validateVoiceLinkage(a, opts) };
  return {
    decision: 'append',
    validation: validateVoiceLinkage({ ...a, events: [...a.events, ...fresh] }, opts),
  };
}
