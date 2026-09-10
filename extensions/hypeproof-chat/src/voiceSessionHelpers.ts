// #898 (VO-06 / VO-07 / VO-09) — 음성 세션의 **순수 결정 계층**.
//
// 왜 기기 코드 없이 이것만 먼저 쓰나.
//
// V0(#897)에서 확인한 사실: 출하된 빌드의 webview iframe Permissions-Policy allow
// 목록은 `clipboard-read`·`clipboard-write` 뿐이고 `microphone` 은 0건이다. 즉
// **실제 음성 세션은 아직 존재할 수 없다**(REQ-R1). 그런데 #898 은 "V0 계약 및 V4의
// 인증·예산 경계. 그 전에는 합성 세션으로 개발 가능" 이라고 적어뒀다. 그래서 기기에
// 닿지 않는 부분 — 상태 구분, 끼어들기 의미, 자원 해제 불변식 — 만 여기 짠다.
//
// 이 파일이 **순수**한 이유는 테스트 편의가 아니다. 상태 전이를 DOM 이벤트 핸들러
// 안에 흩어놓으면 "지금 마이크가 열려 있나" 를 아무도 한 곳에서 답할 수 없게 되고,
// 그 질문에 답할 수 없는 제품을 아이에게 주는 것이 VO-06 이 막으려는 일이다.
// (extension-dev.md 의 helpers/orchestration 분리와 같은 이유·같은 규칙: vscode 도
// DOM 도 import 하지 않는다.)
//
// 이 파일이 **주장하지 않는 것**:
//   - 음성이 동작한다 (마이크를 여는 코드는 여기 없다)
//   - VO-08 의 임계값이 맞다 (아래 PROVISIONAL_ENDPOINTING 주석 참조)
//   - VO-10 (한국어 오인식·고유명사 정정) — 전부 실기·사람 판단
//   - 공급자·전송 (VO-02 미정) — 이 모듈은 공급자 비의존이다

/**
 * 세션 상태. **구분 가능해야** 한다는 것이 VO-06 의 요구이므로, "듣는 중" 과
 * "응답 준비" 를 하나의 `busy` 로 접지 않는다 — 사용자에게 그 둘은 완전히 다른
 * 상황이고, 접으면 화면이 둘을 같은 스피너로 그리게 된다.
 */
export type VoiceState =
  | 'idle'        // 시작 전. **캡처 없음** — 이 불변식이 VO-06 의 핵심
  | 'connecting'  // 전송 경로 수립 중. 아직 캡처 없음
  | 'listening'   // 사용자 발화를 받는 중
  | 'preparing'   // 모델이 응답을 만드는 중. 아직 재생 없음
  | 'speaking'    // 응답 재생 중
  | 'muted'       // 사용자가 음소거. 세션은 살아 있음
  | 'closing'     // 해제 진행 중
  | 'closed'      // 끝. 캡처·재생·세션 자원 모두 없음
  | 'error';      // 오류. 캡처 없음

export type VoiceEvent =
  | { type: 'start' }
  | { type: 'transport_ready' }
  | { type: 'user_speech_start' }
  | { type: 'user_speech_end' }
  | { type: 'response_playback_start' }
  | { type: 'response_playback_end' }
  | { type: 'mute' }
  | { type: 'unmute' }
  | { type: 'interrupt' }          // 사용자 끼어들기 (VO-07)
  // 전송이 **복구 가능하게** 끊겼다 (VO-09 의 "재연결"). `close{reason:'transport_lost'}`
  // 와 다르다 — 그쪽은 포기하고 닫는 것이고, 이쪽은 같은 세션이 다시 붙는 것이다.
  // 둘을 한 이벤트로 접으면 재연결마다 세션이 하나씩 늘거나, 반대로 복구 가능한
  // 끊김에서 아이의 세션을 그냥 죽이게 된다.
  | { type: 'transport_dropped' }
  | { type: 'close'; reason: CloseReason }
  | { type: 'release_done' }
  | { type: 'fail'; code: string };

export type CloseReason = 'user_stop' | 'window_closed' | 'app_quit' | 'permission_revoked' | 'transport_lost';

/** 한 세션의 전체 상태. 이 객체만이 진실이고, UI 는 이걸 그린다(그 반대가 아니다). */
export interface VoiceSession {
  readonly state: VoiceState;
  /** 캡처(마이크 track)가 열려 있는가. 화면 표시가 아니라 **자원 사실**이다. */
  readonly captureOpen: boolean;
  /** 사용자 음소거 의도는 전송 재연결 상태와 독립적으로 보존한다. */
  readonly muteRequested: boolean;
  /** 재생 대기/진행 중인 응답. 해제 시 반드시 비워야 한다. */
  readonly playbackQueued: boolean;
  /** 이 좌석에서 동시에 살아 있는 청취 세션 수. 1 을 넘으면 버그다 (VO-09). */
  readonly listeningSessions: number;
  readonly closeReason: CloseReason | null;
  readonly errorCode: string | null;
  /** 무시된 이벤트 기록. "눌렀는데 아무 일도 없었다" 를 디버깅 가능하게 남긴다. */
  readonly ignored: readonly string[];
}

export function initialVoiceSession(): VoiceSession {
  return {
    state: 'idle',
    captureOpen: false,
    muteRequested: false,
    playbackQueued: false,
    listeningSessions: 0,
    closeReason: null,
    errorCode: null,
    ignored: [],
  };
}

/**
 * `speaking` 중에도 캡처는 **열린 채로 둔다** — 그래야 끼어들기(VO-07)가 가능하다.
 *
 * 그 대가로 스피커 출력이 마이크로 돌아오는 에코를 사용자 명령으로 오인할 수 있고,
 * 그것이 VO-08 의 "스피커 에코를 사용자 명령으로 실행하지 않는다" 다. **에코 억제는
 * 이 모듈이 해결하지 않는다** — 실제 기기·스피커 조합으로만 정해진다. 여기서는
 * 캡처가 열려 있다는 사실만 정직하게 들고 있고, 그래야 실기 검증이 이 칸을 보고
 * "언제 에코가 들어올 수 있나" 를 답할 수 있다.
 */
const CAPTURE_OPEN_STATES: ReadonlySet<VoiceState> = new Set<VoiceState>(['listening', 'preparing', 'speaking']);

/** 세션이 살아 있는 상태 — 여기서만 `close` 가 의미를 가진다. */
const LIVE_STATES: ReadonlySet<VoiceState> = new Set<VoiceState>([
  'connecting', 'listening', 'preparing', 'speaking', 'muted',
]);

function ignore(s: VoiceSession, why: string): VoiceSession {
  return { ...s, ignored: [...s.ignored, why] };
}

/** 상태에 맞게 자원 플래그를 다시 유도한다 — 전이마다 손으로 적으면 어긋난다. */
function settle(s: VoiceSession, next: VoiceState, patch: Partial<VoiceSession> = {}): VoiceSession {
  const merged = { ...s, ...patch, state: next };
  const captureOpen = CAPTURE_OPEN_STATES.has(next) && !merged.muteRequested;
  return {
    ...merged,
    captureOpen,
    // 종료·오류는 재생 큐를 **반드시** 비운다. 비우지 않으면 창을 닫은 뒤에도
    // 스피커에서 말이 나오고, 그건 사용자가 끈 것이 안 꺼진 것이다.
    playbackQueued: next === 'closed' || next === 'closing' || next === 'error' ? false : merged.playbackQueued,
    listeningSessions: next === 'closed' || next === 'error' ? 0 : merged.listeningSessions,
  };
}

/**
 * 전이 함수. **상태를 바꾸는 유일한 길**이다.
 *
 * 알 수 없는 이벤트나 지금 상태에서 의미가 없는 이벤트는 **상태를 바꾸지 않고**
 * `ignored` 에 남긴다. 던지지 않는 이유: 음성 세션은 기기·네트워크에서 순서가
 * 뒤바뀐 이벤트가 정상적으로 들어오고(재생 종료가 끼어들기 뒤에 도착하는 등),
 * 거기서 예외를 던지면 세션 전체가 죽는다. 대신 무시한 사실을 남겨 실기 관측이
 * "왜 아무 일도 없었나" 를 추적할 수 있게 한다.
 */
export function voiceTransition(s: VoiceSession, e: VoiceEvent): VoiceSession {
  switch (e.type) {
    case 'start':
      // VO-09 — 시작 연타. **두 번째 세션을 만들지 않는다.** UI 버튼 비활성화는
      // 게이트가 아니다(REQ-M37 ③ 과 같은 교훈: 화면 상태는 자원 상태가 아니다).
      if (s.state !== 'idle' && s.state !== 'closed' && s.state !== 'error') {
        return ignore(s, `start_ignored_in_${s.state}`);
      }
      return settle(s, 'connecting', { closeReason: null, errorCode: null, listeningSessions: 0, muteRequested: false });

    case 'transport_ready':
      if (s.state !== 'connecting') return ignore(s, `transport_ready_in_${s.state}`);
      // 청취 세션 수는 **대입**이다. 증가가 아니다 — 재연결(`transport_dropped` →
      // `connecting` → `transport_ready`)이 이 분기를 다시 지나가므로, `+1` 이면
      // 전송이 흔들릴 때마다 세션이 하나씩 쌓인다. 그게 VO-09 의
      // "재연결이 복수 청취 세션을 만들지 않는다" 가 막으려는 것이다.
      return settle(s, s.muteRequested ? 'muted' : 'listening', { listeningSessions: 1 });

    case 'transport_dropped':
      // 복구 가능한 끊김. 캡처는 닫고(자원을 쥔 채 기다리지 않는다) 재생 큐는 버린다
      // — 끊긴 구간의 응답을 나중에 이어 재생하면 사용자는 맥락 없는 말을 듣는다.
      // 세션 슬롯은 **유지한다**: 같은 세션이 다시 붙는 것이므로 여기서 반납하면
      // 재연결이 새 세션으로 집계된다.
      if (!LIVE_STATES.has(s.state)) return ignore(s, `transport_dropped_in_${s.state}`);
      return settle(s, 'connecting', { playbackQueued: false });

    case 'user_speech_start':
      if (s.muteRequested) return ignore(s, 'speech_while_muted');
      if (s.state === 'connecting') return ignore(s, 'speech_before_transport_ready');
      if (!LIVE_STATES.has(s.state)) return ignore(s, `speech_start_in_${s.state}`);
      return settle(s, 'listening');

    case 'user_speech_end':
      if (s.state !== 'listening') return ignore(s, `speech_end_in_${s.state}`);
      return settle(s, 'preparing');

    case 'response_playback_start':
      if (s.state !== 'preparing') return ignore(s, `playback_start_in_${s.state}`);
      return settle(s, 'speaking', { playbackQueued: true });

    case 'response_playback_end':
      if (s.state !== 'speaking') return ignore(s, `playback_end_in_${s.state}`);
      return settle(s, 'listening', { playbackQueued: false });

    case 'mute':
      if (!LIVE_STATES.has(s.state) || s.state === 'muted') return ignore(s, `mute_in_${s.state}`);
      // 음소거는 캡처를 **실제로 닫는다**. 소프트 게이트(들어온 샘플을 버리기)로
      // 구현하면 OS 의 마이크 사용 표시가 켜진 채로 남고, 아이는 꺼졌다고 듣고도
      // 켜진 표시를 본다. 그 불일치 자체가 VO-06 위반이다.
      return settle(s, s.state === 'connecting' ? 'connecting' : 'muted', { playbackQueued: false, muteRequested: true });

    case 'unmute':
      if (s.state === 'connecting' && s.muteRequested) return settle(s, 'connecting', { muteRequested: false });
      if (s.state !== 'muted') return ignore(s, `unmute_in_${s.state}`);
      return settle(s, 'listening', { muteRequested: false });

    case 'interrupt':
      // VO-07 — 재생 중이든 재생 직전(`preparing`)이든 끼어들기는 유효하다.
      // `preparing` 에서의 끼어들기가 특히 중요하다: 아직 한 글자도 안 들린
      // 응답을 취소하는 경우이고, 그 응답을 "들었다" 로 기록하면 다음 턴이 거짓
      // 전제로 돈다.
      if (s.state !== 'speaking' && s.state !== 'preparing') return ignore(s, `interrupt_in_${s.state}`);
      return settle(s, 'listening', { playbackQueued: false });

    case 'close':
      if (!LIVE_STATES.has(s.state)) return ignore(s, `close_in_${s.state}`);
      return settle(s, 'closing', { closeReason: e.reason });

    case 'release_done':
      if (s.state !== 'closing') return ignore(s, `release_done_in_${s.state}`);
      return settle(s, 'closed');

    case 'fail':
      if (s.state === 'closed') return ignore(s, 'fail_after_closed');
      return settle(s, 'error', { errorCode: e.code });

    default: {
      // 열거로 끝내지 않는다 — 새 이벤트가 생겨도 침묵이 생기지 않는다
      // (REQ-M39 ② 와 같은 형태).
      const unknown = e as { type?: unknown };
      return ignore(s, `unknown_event_${String(unknown?.type)}`);
    }
  }
}

/** 편의: 이벤트 열을 한 번에 돌린다. 테스트와 합성 세션이 쓴다. */
export function runVoiceEvents(events: readonly VoiceEvent[], from: VoiceSession = initialVoiceSession()): VoiceSession {
  return events.reduce(voiceTransition, from);
}

// ─────────────────────────────────────────────────────────────────────────────
// VO-07 — 사용자가 **실제로 들은 범위**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 끼어들기 시점에 사용자가 들은 양.
 *
 * `unknown` 이 따로 있는 것이 이 타입의 요점이다. 재생기가 경계를 보고하지 않는
 * 경우가 실제로 있고(전송 계층 교체, 버퍼 경계 유실), 그때 `none` 이나 `all` 로
 * 접으면 **측정하지 못한 것을 사실로 적는** 것이 된다. V0 의 `attempted:false →
 * unknown` 과 같은 규칙이다(REQ-R1 ③).
 */
export type HeardExtent =
  | { kind: 'none' }
  | { kind: 'partial'; playedMs: number; throughCharIndex: number | null }
  | { kind: 'all' }
  | { kind: 'unknown'; why: string };

export interface PendingResponse {
  readonly id: string;
  /** 만들어진 응답 전문. 재생 여부와 무관하다. */
  readonly text: string;
  /** 재생기가 보고한 실제 재생 경과. 재생 전이면 0. */
  readonly playedMs: number;
  /** 전체 길이. 생성 중이면 null — 모르면 모른다고 둔다. */
  readonly totalMs: number | null;
  /**
   * 재생 경과 → 글자 위치 매핑. 전송 계층이 타임마크를 줄 때만 존재한다.
   * **없으면 글자 단위 범위를 추정하지 않는다** — 추정한 값이 다음 턴의 문맥으로
   * 들어가면 그 거짓말이 대화 내내 남는다.
   */
  readonly marks: readonly { atMs: number; charIndex: number }[] | null;
  readonly playbackStarted: boolean;
}

/** 타임마크에서 `atMs` 이하의 마지막 글자 위치를 찾는다. 없으면 null. */
function charIndexAt(marks: readonly { atMs: number; charIndex: number }[], atMs: number): number | null {
  let found: number | null = null;
  for (const m of marks) {
    if (m.atMs <= atMs) found = m.charIndex;
    else break; // marks 는 atMs 오름차순이어야 한다 — 아래 assert 참조
  }
  return found;
}

export class VoiceMarksDisorderedError extends Error {
  readonly atMs: number;
  constructor(atMs: number) {
    super(`voice marks are not ascending at ${atMs}ms`);
    this.name = 'VoiceMarksDisorderedError';
    this.atMs = atMs;
  }
}

/**
 * 끼어들기 시점의 들은 범위를 계산한다.
 *
 * 세 갈래를 **구분**하는 것이 전부다:
 *   - 재생 시작 전 취소            → `none`   (한 글자도 안 들렸다)
 *   - 재생 중 취소 + 타임마크 있음 → `partial` (글자 위치까지 안다)
 *   - 재생 중 취소 + 타임마크 없음 → `partial` with `throughCharIndex: null`
 *   - 재생기가 경과조차 안 줌      → `unknown` (모른다 — 추정하지 않는다)
 */
export function heardExtent(r: PendingResponse): HeardExtent {
  if (!r.playbackStarted) return { kind: 'none' };
  if (!Number.isFinite(r.playedMs) || r.playedMs < 0) {
    return { kind: 'unknown', why: 'playback_position_not_reported' };
  }
  if (r.playedMs === 0) return { kind: 'none' };
  if (r.totalMs !== null && Number.isFinite(r.totalMs) && r.playedMs >= r.totalMs) return { kind: 'all' };

  let through: number | null = null;
  if (r.marks) {
    for (let i = 1; i < r.marks.length; i++) {
      if (r.marks[i].atMs < r.marks[i - 1].atMs) throw new VoiceMarksDisorderedError(r.marks[i].atMs);
    }
    through = charIndexAt(r.marks, r.playedMs);
  }
  return { kind: 'partial', playedMs: r.playedMs, throughCharIndex: through };
}

/**
 * 다음 턴의 문맥에 실을 내용.
 *
 * 취소된 잔여는 **다시 재생되지도, 들은 것으로 처리되지도 않는다**(VO-07). 그래서
 * 반환값은 "들은 부분" 과 "안 들린 부분" 을 나눠 들고 있고, 확신할 수 없을 때는
 * `uncertain` 을 켠다 — 모델 불확실성을 확정 사실로 저장하지 않는다(VO-10 와 같은 규칙).
 */
export interface FollowUpContext {
  readonly heardText: string;
  readonly unheardText: string;
  /** 들은 범위를 글자 단위로 확정할 수 없었나. 켜져 있으면 문맥에 그 사실을 적는다. */
  readonly uncertain: boolean;
  /** 재생 큐에 남아서는 안 되는 응답 id — 호출자가 이걸로 큐를 비운다. */
  readonly discardPlaybackFor: string;
  readonly note: string;
}

export function followUpContext(r: PendingResponse, extent: HeardExtent = heardExtent(r)): FollowUpContext {
  const discard = r.id;
  if (extent.kind === 'none') {
    return {
      heardText: '',
      unheardText: r.text,
      uncertain: false,
      discardPlaybackFor: discard,
      note: '사용자는 이 응답을 듣지 못했다 (재생 전 취소).',
    };
  }
  if (extent.kind === 'all') {
    return {
      heardText: r.text,
      unheardText: '',
      uncertain: false,
      discardPlaybackFor: discard,
      note: '사용자는 이 응답을 끝까지 들었다.',
    };
  }
  if (extent.kind === 'unknown') {
    // **전부 들었다고도, 못 들었다고도 적지 않는다.** 모르는 것이 사실이다.
    return {
      heardText: '',
      unheardText: '',
      uncertain: true,
      discardPlaybackFor: discard,
      note: `사용자가 들은 범위를 알 수 없다 (${extent.why}). 들었다고 가정하지 않는다.`,
    };
  }
  if (extent.throughCharIndex === null) {
    // 경과는 알지만 글자 경계를 모른다 — 중간에서 잘라 추정하지 않는다.
    return {
      heardText: '',
      unheardText: '',
      uncertain: true,
      discardPlaybackFor: discard,
      note: `약 ${extent.playedMs}ms 재생됐으나 글자 경계를 알 수 없다. 들은 문장을 추정하지 않는다.`,
    };
  }
  const cut = Math.max(0, Math.min(extent.throughCharIndex, r.text.length));
  return {
    heardText: r.text.slice(0, cut),
    unheardText: r.text.slice(cut),
    uncertain: false,
    discardPlaybackFor: discard,
    note: `사용자는 앞 ${cut}자까지 들었고 나머지는 취소됐다.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VO-08 — 말끝 판단 **정책**. 임계값은 합의 전이다.
// ─────────────────────────────────────────────────────────────────────────────

export interface EndpointingConfig {
  /** 발화 종료로 볼 무음 길이. */
  readonly silenceMs: number;
  /** 이보다 짧은 발화는 턴으로 보지 않는다 (기침·잡음). */
  readonly minSpeechMs: number;
  /** 이 값 이하의 에너지는 발화로 세지 않는다. */
  readonly noiseFloorDb: number;
  /**
   * **합의된 값이 아님을 타입에 남긴다.** 주석으로만 적으면 다음 사람이 그대로
   * 기본값으로 배포하고, 그게 계약처럼 굳는다. 이 레포는 그 비용을 이미 치렀다.
   */
  readonly provisional: true;
}

/**
 * 출발점 제안값. **운영 기본값도 합의된 SLA도 아니다**(#898 공통 인수 규칙).
 *
 * 이 숫자들은 한국어 발화의 문장 중 쉼이 보통 이보다 짧다는 일반적 관찰에서
 * 출발한 것이고, **이 제품의 실제 기기·마이크·스피커로 측정한 값이 아니다.**
 * VO-T08 이 실제 헤드셋/내장 스피커 fixture 로 오탐·누락 비율을 재고 나서
 * 고쳐야 한다. 그때까지 이 값을 "튜닝 완료" 로 읽어서는 안 된다.
 */
export const PROVISIONAL_ENDPOINTING: EndpointingConfig = {
  silenceMs: 700,
  minSpeechMs: 300,
  noiseFloorDb: -45,
  provisional: true,
};

export interface SpeechObservation {
  /** 연속 무음 길이 (ms). */
  readonly silenceMs: number;
  /** 이번 발화에서 실제로 말한 누적 길이 (ms). */
  readonly speechMs: number;
  /** 관측된 최대 에너지 (dB, 음수). */
  readonly peakDb: number;
  /** 지금 스피커가 응답을 재생 중인가 — 에코 구간 표시. */
  readonly playbackActive: boolean;
}

export type EndTurnDecision =
  | { end: false; reason: 'still_speaking' | 'pause_too_short' | 'below_noise_floor' | 'speech_too_short' }
  | { end: true; reason: 'silence_after_speech' };

/**
 * 말끝 판단. 순수 함수이고 임계값은 주입된다.
 *
 * 규칙 순서가 의미를 가진다: **잡음 바닥을 먼저 본다.** 그렇지 않으면 조용한 방의
 * 배경 소음이 `speechMs` 를 쌓아 "짧은 쉼" 을 계속 턴으로 만들고, 그게 VO-08 의
 * "소음·침묵을 사용자 명령으로 실행하지 않는다" 위반이다.
 *
 * `playbackActive` 중의 입력은 에코일 수 있다. **이 함수는 그것을 구분하지 못한다** —
 * 그래서 끝내지 않고(`still_speaking`) 판단을 미룬다. 에코 억제 없이 여기서 턴을
 * 끊으면 AI 자기 목소리가 사용자 발화로 들어간다.
 */
export function shouldEndTurn(obs: SpeechObservation, cfg: EndpointingConfig = PROVISIONAL_ENDPOINTING): EndTurnDecision {
  if (obs.peakDb <= cfg.noiseFloorDb) return { end: false, reason: 'below_noise_floor' };
  if (obs.playbackActive) return { end: false, reason: 'still_speaking' };
  if (obs.speechMs < cfg.minSpeechMs) return { end: false, reason: 'speech_too_short' };
  if (obs.silenceMs < cfg.silenceMs) return { end: false, reason: 'pause_too_short' };
  return { end: true, reason: 'silence_after_speech' };
}

// ─────────────────────────────────────────────────────────────────────────────
// VO-09 — 해제 계획과 불변식
// ─────────────────────────────────────────────────────────────────────────────

export type VoiceResource = 'capture_tracks' | 'transport' | 'playback_queue' | 'session_slot';

/**
 * 지금 상태에서 **반드시 해제해야 하는** 자원 목록.
 *
 * 목록으로 돌려주는 이유: 호출자가 하나를 빠뜨렸는지 테스트가 확인할 수 있어야
 * 한다. "닫았다" 를 boolean 하나로 두면 track 은 남고 transport 만 닫힌 상태가
 * 성공으로 보고된다 — 그게 아이 노트북에서 마이크 표시가 안 꺼지는 모양이다.
 */
export function releasePlan(s: VoiceSession): VoiceResource[] {
  const plan: VoiceResource[] = [];
  if (s.captureOpen) plan.push('capture_tracks');
  if (LIVE_STATES.has(s.state) || s.state === 'closing') plan.push('transport');
  if (s.playbackQueued) plan.push('playback_queue');
  if (s.listeningSessions > 0) plan.push('session_slot');
  return plan;
}

export class VoiceInvariantError extends Error {
  readonly violations: readonly string[];
  constructor(violations: readonly string[]) {
    super('voice session invariant violated: ' + violations.join('; '));
    this.name = 'VoiceInvariantError';
    this.violations = violations;
  }
}

/**
 * 불변식. 전이 뒤마다 호출할 수 있고, 테스트는 **모든** 이벤트 열 뒤에 호출한다.
 *
 * 던지는 쪽을 택한 이유: 이건 기기에서 오는 순서 뒤바뀜이 아니라 **우리 코드의
 * 논리 오류**다. 조용히 넘기면 "마이크가 열린 채 closed" 같은 상태가 화면에는
 * 꺼진 것으로 그려진다.
 */
export function assertVoiceInvariants(s: VoiceSession): void {
  const bad: string[] = [];
  if (s.muteRequested && s.captureOpen) bad.push('mute_requested_with_capture_open');
  if (s.state === 'idle' && s.captureOpen) bad.push('idle_with_capture_open');
  if (s.state === 'connecting' && s.captureOpen) bad.push('connecting_with_capture_open');
  if (s.state === 'muted' && s.captureOpen) bad.push('muted_with_capture_open');
  if ((s.state === 'closed' || s.state === 'error') && s.captureOpen) bad.push(`${s.state}_with_capture_open`);
  if ((s.state === 'closed' || s.state === 'error') && s.playbackQueued) bad.push(`${s.state}_with_playback_queued`);
  if ((s.state === 'closed' || s.state === 'error') && s.listeningSessions !== 0) {
    bad.push(`${s.state}_with_${s.listeningSessions}_sessions`);
  }
  if (s.listeningSessions > 1) bad.push(`${s.listeningSessions}_concurrent_listening_sessions`);
  if (s.listeningSessions < 0) bad.push('negative_listening_sessions');
  if (s.state === 'idle' && s.listeningSessions !== 0) bad.push('idle_with_session_slot');
  if (bad.length > 0) throw new VoiceInvariantError(bad);
}

/** 사람이 읽을 한 줄 — 로그·진단용. 화면 문구가 아니다(그건 UX 결정이다). */
export function describeVoiceSession(s: VoiceSession): string {
  const bits = [`state=${s.state}`, `capture=${s.captureOpen ? 'open' : 'closed'}`, `sessions=${s.listeningSessions}`];
  if (s.playbackQueued) bits.push('playback=queued');
  if (s.closeReason) bits.push(`close=${s.closeReason}`);
  if (s.errorCode) bits.push(`error=${s.errorCode}`);
  if (s.ignored.length) bits.push(`ignored=${s.ignored.length}`);
  return bits.join(' ');
}
