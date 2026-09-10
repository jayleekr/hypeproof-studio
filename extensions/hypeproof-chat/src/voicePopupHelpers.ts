// #939 (VO-36 · VO-38 · VO-40 · VO-41 · VO-43 ~ VO-47) — 음성 **팝업의 표현 결정 계층**.
//
// `voiceSessionHelpers.ts` 는 "마이크가 열려 있나" 를 소유한다. 이 파일은 그 위에서
// **화면이 무엇을 보이고 무엇을 허용하나** 를 소유한다. 두 층을 나누는 이유는 파일
// 개수가 아니라 #939 이 만든 새 상태 때문이다: 팝업은 **접혀도 세션이 살아 있다**.
// 즉 "보이는 상태" 와 "자원 상태" 가 처음으로 서로 다를 수 있고, 그 둘을 한 곳에
// 두면 축소가 세션을 죽이거나(사용자가 잃는다) 안 보이는 채로 마이크가 열린 채
// 남는다(VO-40 이 금지하는 바로 그것).
//
// 계약: docs/studio-requirements.md 의 **REQ-R6**. 회귀: `test/voice-popup.smoke.mjs`.
//
// 순수하다 — `vscode` 도 DOM 도 import 하지 않는다(extension-dev.md 의 helpers /
// orchestration 분리). 웹뷰의 `VoicePanel.tsx` 와 호스트가 **같은 규칙**을 부른다.
//
// 이 파일이 **주장하지 않는 것**:
//   - 음성이 동작한다. 마이크·전송 코드는 여기에도, 아직 이 레포 어디에도 없다
//     (REQ-R1: 출하 빌드의 webview iframe allow 목록에 `microphone` 이 0건).
//   - VO-37 의 안내 발화가 실제로 재생된다 (재생 경로는 UI-2 이후)
//   - VO-42 의 권한 갈래를 **관측**한다 (여기서는 관측된 갈래를 어떻게 **표시**할지만 정한다)
//   - 크기·색 같은 시안값이 실기에서 맞다 (#940 의 480×520 은 제안값이다)

import type { CloseReason, VoiceEvent, VoiceSession, VoiceState } from './voiceSessionHelpers';

// ─────────────────────────────────────────────────────────────────────────────
// VO-36 — 시작 게이트. 클릭 **이전에** 캡처도 유료 연결도 없다.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 시작을 막는 이유. **하나의 `disabled` 로 접지 않는다** — 접으면 "이 수업은 음성이
 * 없다"(정상) 와 "아직 재보지 않았다"(측정 안 됨) 와 "마이크가 막혔다"(고장일 수도)
 * 가 전부 같은 회색 버튼이 되고, 그건 REQ-R1 이 계측기까지 만들어 가른 구분을 화면에서
 * 다시 뭉개는 것이다.
 */
export type VoiceStartBlock =
  | 'capability_unmeasured'   // 아직 재지 않았다 — 막혔다는 뜻이 아니다
  | 'input_blocked'           // 재서 막혔다 (마이크)
  | 'output_blocked'          // 재서 막혔다 (재생)
  | 'no_voice_model'          // 이 수업의 허용 모델 중 실제 음성 지원이 없다
  | 'not_entitled'            // 수업/이용권이 음성을 허용하지 않는다
  | 'entitlement_unknown'     // 허용 여부를 확인하지 못했다
  | 'budget_exhausted'        // 한도 도달 — 개인 결제로 우회하지 않는다
  | 'session_active';         // 이미 살아 있다 (연타 · 재진입)

/**
 * 이 수업에서 실제로 쓸 수 있는 음성 모델.
 *
 * `supportsVoice` 를 **필수 필드로** 둔 이유는 VO-45 다: 텍스트 모델 선택지가 전부
 * 음성을 지원한다고 가정하면, 지원하지 않는 모델로 세션을 열고 그 실패를 학생이
 * "마이크 고장" 으로 읽는다. 모르면 `null` 을 넘긴다 — 추정 금지.
 */
export interface VoiceModelOption {
  readonly alias: string;
  readonly id: string;
  readonly provider: string;
  readonly supportsVoice: boolean;
  /** 이 경로가 실제로 지원하는 effort 값. 없으면 effort 를 보내지 않는다(VO-45). */
  readonly supportedEffort?: readonly string[];
}

export interface VoiceStartInputs {
  /** REQ-R1 보고서의 판정. 아직 안 쟀으면 `null`. */
  readonly capability: { readonly input: 'allowed' | 'blocked' | 'unknown'; readonly output: 'full' | 'web-audio-only' | 'blocked' | 'unknown' } | null;
  readonly voiceModel: VoiceModelOption | null;
  readonly entitlement: 'allowed' | 'not_allowed' | 'unknown';
  readonly budget: BudgetView;
  readonly sessionState: VoiceState;
}

export interface VoiceStartGate {
  readonly enabled: boolean;
  readonly block: VoiceStartBlock | null;
  /** 버튼의 접근 가능한 이름. 받아쓰기(dictation)와 **구별되어야** 한다(VO-36). */
  readonly accessibleName: string;
  /** 버튼 옆/툴팁 한 줄. 막혔으면 이유와 대안을 말한다. */
  readonly hint: string;
  /** 막혔을 때 텍스트 대안을 안내하나. 안내가 없으면 학생은 그냥 멈춘다. */
  readonly offersTextFallback: boolean;
}

const START_ACCESSIBLE_NAME = '음성 대화 시작';

function startHint(block: VoiceStartBlock | null): string {
  switch (block) {
    case null: return '버튼을 누르면 음성 대화 패널이 열려요.';
    case 'capability_unmeasured': return '이 컴퓨터에서 음성을 쓸 수 있는지 아직 확인하지 않았어요.';
    case 'input_blocked': return '이 앱에서 마이크를 열 수 없어요. 지금은 글로 이어가 주세요.';
    case 'output_blocked': return '이 앱에서 소리를 낼 수 없어요. 지금은 글로 이어가 주세요.';
    case 'no_voice_model': return '이 수업에서 고른 모델은 아직 음성을 지원하지 않아요.';
    case 'not_entitled': return '이 수업에서는 음성 대화를 쓰지 않아요.';
    case 'entitlement_unknown': return '음성 사용 가능 여부를 확인하지 못했어요.';
    case 'budget_exhausted': return '이번 수업의 음성 사용량을 다 썼어요. 글로는 계속할 수 있어요.';
    case 'session_active': return '이미 음성 대화 중이에요.';
  }
}

/**
 * 시작 가능 여부. **순서가 의미를 가진다.**
 *
 * 이미 살아 있는 세션을 먼저 본다 — 연타(VO-36)와 재진입은 "왜 안 되나" 가 아니라
 * "이미 되고 있다" 이고, 그 둘을 같은 문구로 말하면 학생이 버튼을 계속 누른다.
 * 그 다음이 capability 다: 측정하지 않은 것을 막혔다고 적지 않는다(REQ-R1 ③).
 */
export function voiceStartGate(input: VoiceStartInputs): VoiceStartGate {
  const block = ((): VoiceStartBlock | null => {
    if (input.sessionState !== 'idle' && input.sessionState !== 'closed' && input.sessionState !== 'error') {
      return 'session_active';
    }
    if (input.entitlement === 'not_allowed') return 'not_entitled';
    if (input.entitlement === 'unknown') return 'entitlement_unknown';
    if (input.capability === null) return 'capability_unmeasured';
    if (input.capability.input === 'unknown' || input.capability.output === 'unknown') return 'capability_unmeasured';
    if (input.capability.input === 'blocked') return 'input_blocked';
    if (input.capability.output === 'blocked') return 'output_blocked';
    if (!input.voiceModel || !input.voiceModel.supportsVoice) return 'no_voice_model';
    if (input.budget.blocksNewPaidResponse) return 'budget_exhausted';
    return null;
  })();
  return {
    enabled: block === null,
    block,
    accessibleName: START_ACCESSIBLE_NAME,
    hint: startHint(block),
    offersTextFallback: block !== null && block !== 'session_active',
  };
}

/**
 * 연타 합치기 (VO-36).
 *
 * 버튼 비활성화는 게이트가 아니다 — REQ-M37 ③ 과 같은 교훈이고, 여기서는 더 싸게
 * 틀린다: 첫 클릭의 연결이 뜨기 전에 두 번째 클릭이 들어오면 유료 세션이 둘 열린다.
 * 그래서 **진행 중인 시작 요청 id 를 그대로 돌려준다** — 새 id 를 만들지 않는 것이
 * 이 함수의 전부다.
 */
export function coalesceStartRequest(pending: string | null, newId: string): { readonly requestId: string; readonly started: boolean } {
  if (pending) return { requestId: pending, started: false };
  return { requestId: newId, started: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// VO-37 — 첫 안내 발화. 한 번, 준비된 뒤에만, 그리고 끊을 수 있게.
// ─────────────────────────────────────────────────────────────────────────────

export interface OpeningPromptInputs {
  readonly transportReady: boolean;
  readonly conversationIsNew: boolean;
  readonly alreadyGreetedThisSession: boolean;
  /** 사용자가 먼저 말했다 — 안내는 끊긴다(재생 중이었다면 폐기). */
  readonly userSpokeFirst: boolean;
  /** 이미 명확한 요청이 있다 — 다시 인터뷰하지 않는다. */
  readonly pendingRequestIsClear: boolean;
}

export type OpeningPromptDecision =
  | { readonly speak: true; readonly text: string }
  | { readonly speak: false; readonly reason: 'not_ready' | 'already_greeted' | 'resumed_conversation' | 'user_spoke_first' | 'request_already_clear' };

export const OPENING_PROMPT_TEXT = '어떤 작업을 같이 해볼까요?';

export function openingPromptDecision(i: OpeningPromptInputs): OpeningPromptDecision {
  // 준비 이전 안내는 **금지**다. 재생도 못 하면서 "듣고 있어요" 로 보이는 화면이
  // 정확히 VO-37 이 막으려는 연출이다.
  if (!i.transportReady) return { speak: false, reason: 'not_ready' };
  if (i.userSpokeFirst) return { speak: false, reason: 'user_spoke_first' };
  if (i.alreadyGreetedThisSession) return { speak: false, reason: 'already_greeted' };
  if (!i.conversationIsNew) return { speak: false, reason: 'resumed_conversation' };
  if (i.pendingRequestIsClear) return { speak: false, reason: 'request_already_clear' };
  return { speak: true, text: OPENING_PROMPT_TEXT };
}

// ─────────────────────────────────────────────────────────────────────────────
// VO-38 · VO-47 — 상태 표시와 움직임. 움직임은 **관측된 오디오**에만 붙는다.
// ─────────────────────────────────────────────────────────────────────────────

/** 미터가 무엇을 그리고 있나. `null` 은 "그릴 것이 없다" 이지 0 이 아니다. */
export type MeterSource = 'input_level' | 'output_level' | null;

/** 재생기·캡처가 보고한 **원시 관측**. 판정을 담지 않는다(REQ-R1 과 같은 규칙). */
export interface AudioObservation {
  /** 캡처가 보고한 입력 레벨 0..1. 보고가 없으면 `null`. */
  readonly inputLevel: number | null;
  /** 재생기가 **실제 재생 중**이라고 보고했나. 생성 완료는 재생이 아니다. */
  readonly outputPlaying: boolean;
  /** 재생기가 보고한 출력 레벨 0..1. 보고가 없으면 `null`. */
  readonly outputLevel: number | null;
}

export interface MeterView {
  readonly source: MeterSource;
  /** 0..1. 그릴 것이 없으면 `null` — 0 으로 접으면 "무음" 과 "미보고" 가 같아진다. */
  readonly level: number | null;
  /** 파형이 움직여도 되나. 연결/생성 대기는 **입력 반응이 아니다**. */
  readonly animated: boolean;
  /** 별도의 진행 표시(불확정)를 띄우나. 입력 반응과 구별해야 한다(VO-38). */
  readonly progress: boolean;
  /** 모션 없이도 읽히는 상태 이름 — 스크린리더와 모션 감소가 이걸 쓴다(VO-47). */
  readonly statusName: string;
  /** 화면 문구. */
  readonly statusText: string;
}

const STATUS_TEXT: Record<VoiceState, { name: string; text: string }> = {
  idle:       { name: '대기', text: '음성 대화를 시작할 수 있어요' },
  connecting: { name: '연결 중', text: '연결하고 있어요' },
  listening:  { name: '듣는 중', text: '듣고 있어요' },
  preparing:  { name: '응답 준비', text: '답변을 준비하고 있어요' },
  speaking:   { name: '말하는 중', text: '말하고 있어요' },
  muted:      { name: '마이크 꺼짐', text: '마이크가 꺼져 있어요' },
  closing:    { name: '종료 중', text: '대화를 마치는 중이에요' },
  closed:     { name: '종료됨', text: '음성 대화를 마쳤어요' },
  error:      { name: '오류', text: '음성 대화에 문제가 생겼어요' },
};

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 상태 + 관측 → 화면.
 *
 * **관측이 없으면 움직이지 않는다.** 이 한 줄이 이 함수의 존재 이유다. 서버가 보낸
 * 길이나 생성된 글자 수로 파형을 돌리면 연결이 죽은 뒤에도 화면은 계속 춤추고,
 * 학생은 자기 말이 전달되고 있다고 믿는다 — 그게 VO-38 의 "가짜 듣기 움직임" 이다.
 *
 * `reduceMotion` 은 움직임만 끈다. **상태 구분은 끄지 않는다** — 텍스트와 상태 이름이
 * 남아야 VO-47 을 만족한다.
 */
export function meterView(
  session: Pick<VoiceSession, 'state' | 'captureOpen' | 'muteRequested'>,
  obs: AudioObservation | null,
  opts: { readonly reduceMotion?: boolean } = {},
): MeterView {
  const label = STATUS_TEXT[session.state];
  const base = { statusName: label.name, statusText: label.text };
  const still = (progress: boolean): MeterView => ({ source: null, level: null, animated: false, progress, ...base });

  if (session.state === 'connecting') return still(true);
  if (session.state === 'preparing') return still(true);
  if (session.muteRequested || session.state === 'muted') return still(false);
  if (session.state === 'listening') {
    // 캡처가 닫혀 있으면 들어올 소리가 없다 — 레벨 보고가 있더라도 **그건 stale 이다**.
    if (!session.captureOpen || !obs || obs.inputLevel === null) return still(false);
    const level = clamp01(obs.inputLevel);
    return { source: 'input_level', level, animated: !opts.reduceMotion, progress: false, ...base };
  }
  if (session.state === 'speaking') {
    // 생성이 끝났어도 **재생 중이 아니면** 출력 파형은 반응하지 않는다.
    if (!obs || !obs.outputPlaying || obs.outputLevel === null) return still(false);
    const level = clamp01(obs.outputLevel);
    return { source: 'output_level', level, animated: !opts.reduceMotion, progress: false, ...base };
  }
  return still(false);
}

/**
 * 스크린리더 안내 (VO-47).
 *
 * **상태가 바뀔 때만** 낸다. 음량 tick 마다 읽으면 스크린리더 사용자는 아무것도 못
 * 듣는다 — 그 자체가 접근성 결함이지 성실한 안내가 아니다.
 */
export function statusAnnouncement(prev: VoiceState | null, next: VoiceState): string | null {
  if (prev === next) return null;
  return STATUS_TEXT[next].name;
}

// ─────────────────────────────────────────────────────────────────────────────
// VO-40 · VO-44 — 표현 상태와 일시중지. **보이지 않는 청취는 없다.**
// ─────────────────────────────────────────────────────────────────────────────

export type Presentation = 'hidden' | 'expanded' | 'compact';

/** 왜 멈췄나. 여러 개가 동시에 성립할 수 있어서 집합으로 든다. */
export type PauseReason = 'controls_hidden' | 'app_inactive' | 'system_sleep' | 'approval_review';

export interface PopupState {
  readonly presentation: Presentation;
  /** 캡처/재생이 멈춰 있나. `muted` 상태로 나타나지만 **의미가 다르다**(아래 참조). */
  readonly paused: boolean;
  readonly pauseReasons: readonly PauseReason[];
  /**
   * 사용자가 스스로 음소거했나. 일시중지와 **반드시** 구분한다 — 합치면 화면을
   * 잠깐 가렸다 돌아온 것만으로 학생이 눌러 둔 음소거가 풀린다(VO-40 의
   * "재연결은 명시적 해제를 대신하지 않는다" 와 같은 결함 계열).
   */
  readonly userMuteIntent: boolean;
  /** 멈춤 조건이 풀렸지만 **자동 재개하지 않는다** — 사용자가 눌러야 한다. */
  readonly awaitingResume: boolean;
}

export function initialPopupState(): PopupState {
  return { presentation: 'hidden', paused: false, pauseReasons: [], userMuteIntent: false, awaitingResume: false };
}

export type PopupEvent =
  | { readonly type: 'open' }
  | { readonly type: 'minimize' }
  | { readonly type: 'expand' }
  | { readonly type: 'user_mute' }
  | { readonly type: 'user_unmute' }
  | { readonly type: 'pause'; readonly reason: PauseReason }
  | { readonly type: 'unpause'; readonly reason: PauseReason }
  | { readonly type: 'resume_requested' }
  | { readonly type: 'dismissed' };

export interface PopupTransition {
  readonly state: PopupState;
  /** 세션 계층에 넣어야 하는 이벤트. 호출자가 `voiceTransition` 에 그대로 흘린다. */
  readonly voiceEvents: readonly VoiceEvent[];
  /** 무시한 이벤트 기록 — "눌렀는데 아무 일도 없었다" 를 추적 가능하게 남긴다. */
  readonly ignored: string | null;
}

function withoutReason(list: readonly PauseReason[], reason: PauseReason): PauseReason[] {
  return list.filter(r => r !== reason);
}

/**
 * 표현 상태 전이.
 *
 * 지켜야 할 세 가지가 전부 여기서 나온다:
 *
 * 1. **축소는 세션을 건드리지 않는다** (VO-40). `minimize`/`expand` 가 내는
 *    `voiceEvents` 는 항상 비어 있다 — 이게 "확대/축소가 새 세션을 만들지 않는다" 의
 *    실제 구현이다.
 * 2. **컨트롤이 사라지면 멈춘다** (VO-40). 멈춤은 `mute` 로 내려간다 — 캡처를 실제로
 *    닫아야 OS 마이크 표시가 꺼진다(soft gate 금지, `voiceSessionHelpers` 의 mute 주석).
 * 3. **자동 재개는 없다.** 조건이 풀려도 `awaitingResume` 로 남고, `resume_requested`
 *    가 와야 푼다. 그리고 그때도 사용자가 원래 음소거해 뒀다면 **음소거를 유지한다**.
 */
export function popupTransition(s: PopupState, e: PopupEvent): PopupTransition {
  const keep = (ignored: string): PopupTransition => ({ state: s, voiceEvents: [], ignored });
  const next = (state: PopupState, voiceEvents: readonly VoiceEvent[] = []): PopupTransition => ({ state, voiceEvents, ignored: null });

  switch (e.type) {
    case 'open':
      return next({ ...s, presentation: 'expanded' });

    case 'minimize':
      if (s.presentation !== 'expanded') return keep(`minimize_in_${s.presentation}`);
      return next({ ...s, presentation: 'compact' });

    case 'expand':
      if (s.presentation !== 'compact') return keep(`expand_in_${s.presentation}`);
      // 승인 검토 중에는 펼치지 않는다 — 큰 패널이 승인 대상을 가린다(VO-44).
      if (s.pauseReasons.includes('approval_review')) return keep('expand_blocked_by_approval');
      return next({ ...s, presentation: 'expanded' });

    case 'user_mute':
      if (s.userMuteIntent) return keep('mute_already_requested');
      // 이미 멈춰 있으면 세션은 이미 muted 다 — 의도만 기록한다.
      return next({ ...s, userMuteIntent: true }, s.paused ? [] : [{ type: 'mute' }]);

    case 'user_unmute':
      if (!s.userMuteIntent) return keep('unmute_without_mute');
      // 멈춰 있는 동안의 해제는 **의도만** 지운다. 캡처를 여기서 열면 보이지 않는
      // 청취가 된다 — 그건 VO-40 이 금지한다. 재개는 `resume_requested` 가 한다.
      return next({ ...s, userMuteIntent: false }, s.paused ? [] : [{ type: 'unmute' }]);

    case 'pause': {
      if (s.pauseReasons.includes(e.reason)) return keep(`pause_duplicate_${e.reason}`);
      const reasons = [...s.pauseReasons, e.reason];
      const presentation = e.reason === 'approval_review' && s.presentation === 'expanded' ? 'compact' : s.presentation;
      // 이미 멈춰 있거나 **사용자가 이미 음소거해 둔** 경우 `mute` 를 또 보내지
      // 않는다. 세션 계층은 무시하지만 `ignored` 기록이 쌓여 실기 관측이 오염되고,
      // 무엇보다 "몇 번 멈췄나" 를 재는 쪽이 중복을 실제 멈춤으로 센다.
      const alreadySilent = s.paused || s.userMuteIntent;
      return next({ ...s, presentation, paused: true, pauseReasons: reasons, awaitingResume: false }, alreadySilent ? [] : [{ type: 'mute' }]);
    }

    case 'unpause': {
      if (!s.pauseReasons.includes(e.reason)) return keep(`unpause_unknown_${e.reason}`);
      const reasons = withoutReason(s.pauseReasons, e.reason);
      if (reasons.length > 0) return next({ ...s, pauseReasons: reasons });
      // 조건은 다 풀렸다. **여기서 캡처를 열지 않는다.**
      return next({ ...s, pauseReasons: reasons, awaitingResume: true });
    }

    case 'resume_requested': {
      if (!s.paused) return keep('resume_without_pause');
      if (s.pauseReasons.length > 0) return keep(`resume_blocked_by_${s.pauseReasons.join('+')}`);
      const resumed: PopupState = { ...s, paused: false, awaitingResume: false };
      // 사용자가 원래 음소거해 뒀다면 재개는 **음소거 상태로** 돌아간다.
      return next(resumed, s.userMuteIntent ? [] : [{ type: 'unmute' }]);
    }

    case 'dismissed':
      return next({ ...initialPopupState() });

    default: {
      const unknown = e as { type?: unknown };
      return keep(`unknown_popup_event_${String(unknown?.type)}`);
    }
  }
}

export function runPopupEvents(events: readonly PopupEvent[], from: PopupState = initialPopupState()): { state: PopupState; voiceEvents: VoiceEvent[]; ignored: string[] } {
  let state = from;
  const voiceEvents: VoiceEvent[] = [];
  const ignored: string[] = [];
  for (const e of events) {
    const t = popupTransition(state, e);
    state = t.state;
    voiceEvents.push(...t.voiceEvents);
    if (t.ignored) ignored.push(t.ignored);
  }
  return { state, voiceEvents, ignored };
}

/**
 * 불변식. 팝업 층에도 필요한 이유: 여기서 어긋나면 **화면과 자원이 갈라진다**.
 */
export class PopupInvariantError extends Error {
  readonly violations: readonly string[];
  constructor(violations: readonly string[]) {
    super('voice popup invariant violated: ' + violations.join('; '));
    this.name = 'PopupInvariantError';
    this.violations = violations;
  }
}

export function assertPopupInvariants(p: PopupState, s: Pick<VoiceSession, 'captureOpen' | 'state'>): void {
  const bad: string[] = [];
  // 이 한 줄이 VO-40 의 "보이지 않는 청취는 허용하지 않는다" 다.
  if (p.presentation === 'hidden' && s.captureOpen) bad.push('hidden_with_capture_open');
  if (p.paused && s.captureOpen) bad.push('paused_with_capture_open');
  if (p.awaitingResume && !p.paused) bad.push('awaiting_resume_without_pause');
  if (p.paused && p.pauseReasons.length === 0 && !p.awaitingResume) bad.push('paused_without_reason');
  if (p.pauseReasons.includes('approval_review') && p.presentation === 'expanded') bad.push('approval_review_with_expanded_panel');
  if (bad.length > 0) throw new PopupInvariantError(bad);
}

/** 작은 컨트롤이 **항상** 제공해야 하는 조작 (VO-40). 목록이 줄면 테스트가 깨진다. */
export const COMPACT_CONTROLS = ['mute', 'stop', 'expand'] as const;
export type CompactControl = (typeof COMPACT_CONTROLS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// VO-41 — 종료. 네 갈래가 **같은 해제**로 수렴하고, 부분 전사는 자동 전송되지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

export type DismissKind =
  | 'stop_button'
  | 'panel_close'      // 큰 패널의 X
  | 'escape'           // 패널에 포커스가 있을 때만. 승인 모달의 Escape 는 그쪽 의미다
  | 'switch_to_text'
  | 'window_closed'
  | 'app_quit'
  | 'permission_revoked';

export interface DismissPlan {
  readonly voiceEvents: readonly VoiceEvent[];
  /** 해제 뒤 포커스가 갈 곳. 잃어버리면 키보드 사용자는 길을 잃는다(VO-47). */
  readonly focus: 'voice_start_button' | 'composer';
  /** 확정 전사는 남는다. */
  readonly keepFinalTranscript: true;
  /** 미확정 전사를 자동 전송/실행하지 않는다. */
  readonly autoSendPartial: false;
  /** 미확정 전사를 입력창 초안으로 옮기나 — 텍스트 전환일 때만. */
  readonly seedComposerWithPartial: boolean;
  /**
   * 실행 중이던 도구 작업에 대한 주장. **'unchanged' 밖에 없다** — 음성 종료가
   * 도구 작업을 취소했다고 말하면 학생은 파일이 원래대로 돌아갔다고 믿는다(VO-39/41).
   */
  readonly toolRunClaim: 'unchanged';
}

const CLOSE_REASON: Record<DismissKind, CloseReason> = {
  stop_button: 'user_stop',
  panel_close: 'user_stop',
  escape: 'user_stop',
  switch_to_text: 'user_stop',
  window_closed: 'window_closed',
  app_quit: 'app_quit',
  permission_revoked: 'permission_revoked',
};

export function dismissPlan(kind: DismissKind): DismissPlan {
  return {
    voiceEvents: [{ type: 'close', reason: CLOSE_REASON[kind] }],
    focus: kind === 'switch_to_text' ? 'composer' : 'voice_start_button',
    keepFinalTranscript: true,
    autoSendPartial: false,
    seedComposerWithPartial: kind === 'switch_to_text',
    toolRunClaim: 'unchanged',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VO-43 — 문맥. 팝업을 열었다는 이유로 화면 전체를 공유하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReferenceTarget {
  readonly artifactId: string;
  readonly title: string;
  /** 사용자가 보고 있는 revision. 모르면 `null` — 추정하지 않는다. */
  readonly revision: string | null;
}

/** 팝업이 여는 것만으로 코치에게 가는 것. **목록 자체가 계약이다.** */
export interface SharedContextOnOpen {
  readonly conversationId: string;
  /** 사용자가 **선택한** 결과물 하나. 선택이 없으면 null. */
  readonly selectedArtifact: ReferenceTarget | null;
  readonly screenCapture: false;
  readonly allWorkspaceFiles: false;
}

export function sharedContextOnOpen(conversationId: string, selected: ReferenceTarget | null): SharedContextOnOpen {
  return { conversationId, selectedArtifact: selected, screenCapture: false, allWorkspaceFiles: false };
}

export type TargetGuard =
  | { readonly action: 'proceed' }
  | { readonly action: 'confirm'; readonly why: 'target_changed' | 'target_ambiguous' | 'target_unknown' }
  | { readonly action: 'block'; readonly why: 'revision_mismatch' };

/**
 * 발화 시점의 대상과 지금 대상을 대조한다 (VO-43 / 기존 VO-12).
 *
 * revision 불일치를 `confirm` 이 아니라 `block` 으로 두는 이유: 그 사이 결과물이
 * 바뀌었다면 "이 부분" 이 가리키던 곳이 이미 없을 수 있고, 확인 문구 하나로 아이가
 * 넘길 결정이 아니다. 대상 자체가 바뀐 경우(`target_changed`)는 사람에게 물으면
 * 답할 수 있으니 `confirm` 이다.
 */
export function targetGuard(atUtterance: ReferenceTarget | null, now: ReferenceTarget | null): TargetGuard {
  if (!atUtterance || !now) return { action: 'confirm', why: 'target_unknown' };
  if (atUtterance.artifactId !== now.artifactId) return { action: 'confirm', why: 'target_changed' };
  if (atUtterance.revision === null || now.revision === null) return { action: 'confirm', why: 'target_ambiguous' };
  if (atUtterance.revision !== now.revision) return { action: 'block', why: 'revision_mismatch' };
  return { action: 'proceed' };
}

// ─────────────────────────────────────────────────────────────────────────────
// VO-44 — 승인. 말로 승인하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

export interface ApprovalDecisionInputs {
  /** 사용자가 승인 화면에서 실제로 누른 결과. `null` = 아직 안 눌렀다. */
  readonly uiChoice: 'approved' | 'denied' | null;
  /** 같은 시점의 발화. **어떤 값이 와도 승인이 되지 않는다.** */
  readonly utterance: string | null;
}

export type ApprovalOutcome = 'approved' | 'denied' | 'pending';

/**
 * 승인 판정.
 *
 * `utterance` 를 인자로 **받아 놓고 쓰지 않는** 것이 의도다. 받지 않으면 나중에
 * 누군가 "네 라고 하면 통과" 를 다른 곳에 추가해도 이 함수는 아무 말도 못 한다.
 * 인자로 들고 있으면서 무시하면, 테스트가 "'네' 를 넣어도 pending" 을 **음성
 * 대조군으로** 잠글 수 있다.
 */
export function approvalOutcome(i: ApprovalDecisionInputs): ApprovalOutcome {
  if (i.uiChoice === 'approved') return 'approved';
  if (i.uiChoice === 'denied') return 'denied';
  return 'pending';
}

/** 승인 대기 진입 시 팝업이 해야 하는 일 (VO-44). */
export const APPROVAL_PAUSE_EVENT: PopupEvent = { type: 'pause', reason: 'approval_review' };

// ─────────────────────────────────────────────────────────────────────────────
// VO-45 — 이름·모델. 하드코딩된 '코치' 를 새로 만들지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

/** 패널 제목. 이름은 **호출자가 `resolveCoachIdentity` 로 정해서** 넘긴다. */
export function voicePanelTitle(coachName: string): string {
  const name = coachName.trim();
  return `${name || '코치'} · 음성 대화`;
}

export interface SessionInfoLine {
  readonly label: string;
  readonly value: string;
  /** 서버가 보장한 값인가. 아니면 화면이 '예상' 으로 표시한다. */
  readonly certainty: 'known' | 'estimated' | 'unknown';
}

export function sessionInfoLines(model: VoiceModelOption | null, budget: BudgetView): readonly SessionInfoLine[] {
  const lines: SessionInfoLine[] = [];
  lines.push(model
    ? { label: '음성 모델', value: `${model.provider} · ${model.alias}`, certainty: 'known' }
    : { label: '음성 모델', value: '확인되지 않음', certainty: 'unknown' });
  lines.push({ label: '비용 출처', value: budget.sourceLabel, certainty: budget.sourceCertainty });
  if (budget.remaining) {
    lines.push({ label: '남은 사용량', value: budget.remaining.text, certainty: budget.remaining.certainty });
  }
  return lines;
}

/**
 * 세션 중 모델 변경 (VO-45).
 *
 * 첫 구현은 **바꿔 끼우지 않는다** — 종료 후 새로 연결한다. 대화 문맥은 유지된다
 * (기존 conversation 을 그대로 쓰므로 이 층이 할 일은 없다). 중간에 바꾸는 경로를
 * 열면 "어느 모델이 이 말을 했나" 를 아무도 답할 수 없게 된다.
 */
export function modelChangePlan(next: VoiceModelOption): { readonly allowed: boolean; readonly requiresReconnect: true; readonly reason?: string } {
  if (!next.supportsVoice) return { allowed: false, requiresReconnect: true, reason: 'model_has_no_voice' };
  return { allowed: true, requiresReconnect: true };
}

/** effort 는 **그 경로가 실제 지원할 때만** 보낸다. 임의 매핑 금지(VO-45). */
export function effortForVoice(model: VoiceModelOption | null, requested: string | null): string | null {
  if (!model || !requested) return null;
  const allowed = model.supportedEffort ?? [];
  return allowed.includes(requested) ? requested : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// VO-46 — 이용량. 확정과 예상을 섞지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

export type CostSource = 'lesson_included' | 'instructor_assigned' | 'personal_subscription' | 'unknown';

export interface BudgetView {
  readonly source: CostSource;
  readonly sourceLabel: string;
  readonly sourceCertainty: 'known' | 'unknown';
  /** 서버가 단위를 보장하는 잔량만 값으로 든다. 예측은 `estimated` 로 표시한다. */
  readonly remaining: { readonly text: string; readonly certainty: 'known' | 'estimated' | 'unknown' } | null;
  /** 새 **유료** 응답을 막나. 종료·결과 열람은 계속 된다. */
  readonly blocksNewPaidResponse: boolean;
  /** 개인 결제/다른 모델로 자동 전환하나. **항상 false** — 계약이다. */
  readonly autoFallbackToPersonalPayment: false;
}

const COST_LABEL: Record<CostSource, string> = {
  lesson_included: '강의 포함',
  instructor_assigned: '강사 배정',
  personal_subscription: '개인 구독',
  unknown: '확인되지 않음',
};

export function budgetView(input: {
  readonly source: CostSource;
  readonly remaining?: { readonly text: string; readonly certainty: 'known' | 'estimated' } | null;
  readonly limitReached?: boolean;
  readonly entitlementRevoked?: boolean;
}): BudgetView {
  return {
    source: input.source,
    sourceLabel: COST_LABEL[input.source],
    sourceCertainty: input.source === 'unknown' ? 'unknown' : 'known',
    remaining: input.remaining ?? null,
    blocksNewPaidResponse: Boolean(input.limitReached || input.entitlementRevoked),
    autoFallbackToPersonalPayment: false,
  };
}

/** 한도 도달/권한 철회 시 무엇이 **계속 되는가**. 여기 있는 것을 막으면 결함이다. */
export interface LimitReachedPlan {
  readonly blocksNewPaidResponse: true;
  readonly allowsStop: true;
  readonly allowsViewingArtifacts: true;
  readonly allowsTextConversation: boolean;
  readonly message: string;
}

export function limitReachedPlan(budget: BudgetView, textStillAllowed: boolean): LimitReachedPlan | null {
  if (!budget.blocksNewPaidResponse) return null;
  return {
    blocksNewPaidResponse: true,
    allowsStop: true,
    allowsViewingArtifacts: true,
    allowsTextConversation: textStillAllowed,
    message: textStillAllowed
      ? '이번 수업의 음성 사용량을 다 썼어요. 만든 것은 그대로 있고, 글로는 계속할 수 있어요.'
      : '이번 수업의 음성 사용량을 다 썼어요. 만든 것은 그대로 볼 수 있어요.',
  };
}

/**
 * 강사가 바꿀 수 있는 것 (VO-46).
 *
 * 이름과 시작 안내 문구뿐이다. 상태 표시·종료·서버 정책은 **끌 수 없다** — 숨길 수
 * 있으면 "마이크가 켜져 있는지" 를 학생이 알 수 없는 교실을 강사가 만들 수 있다.
 */
export interface InstructorVoiceOverrides {
  readonly coachName?: string;
  readonly openingPrompt?: string;
}
export interface AppliedVoiceOverrides {
  readonly coachName: string | null;
  readonly openingPrompt: string | null;
  readonly hidesStatus: false;
  readonly hidesStopControl: false;
  readonly bypassesServerPolicy: false;
}
export function applyInstructorOverrides(o: InstructorVoiceOverrides | null | undefined): AppliedVoiceOverrides {
  return {
    coachName: o?.coachName?.trim() || null,
    openingPrompt: o?.openingPrompt?.trim() || null,
    hidesStatus: false,
    hidesStopControl: false,
    bypassesServerPolicy: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VO-42 — 실패 갈래의 **표시**. 관측은 여기서 하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

export type VoiceFailureKind =
  | 'permission_denied'
  | 'no_input_device'
  | 'permission_revoked'
  | 'late_permission_after_cancel'
  | 'output_device_failed'
  | 'transport_failed'
  | 'reconnect_failed';

export interface FailureView {
  readonly text: string;
  /** 재시도 버튼을 주나. **자동 재시도는 없다** — 중복 캡처/세션의 원인이다. */
  readonly offersRetry: boolean;
  /** 남아 있을 수 있는 캡처를 반드시 해제해야 하나. */
  readonly mustReleaseCapture: boolean;
  readonly offersTextFallback: true;
}

const FAILURE_TEXT: Record<VoiceFailureKind, { text: string; retry: boolean; release: boolean }> = {
  permission_denied: { text: '마이크 사용이 허용되지 않았어요.', retry: true, release: false },
  no_input_device: { text: '연결된 마이크를 찾지 못했어요.', retry: true, release: false },
  permission_revoked: { text: '마이크 사용 권한이 해제됐어요.', retry: true, release: true },
  // 취소한 뒤 늦게 도착한 허용. **받은 stream 을 반드시 닫는다** — 안 닫으면 학생
  // 화면엔 아무것도 없는데 OS 마이크 표시만 켜져 있다.
  late_permission_after_cancel: { text: '마이크 허용이 늦게 도착했어요. 시작하지 않고 마이크를 껐어요.', retry: true, release: true },
  output_device_failed: { text: '소리를 낼 장치를 열지 못했어요.', retry: true, release: false },
  transport_failed: { text: '음성 연결에 실패했어요.', retry: true, release: true },
  reconnect_failed: { text: '연결을 되살리지 못했어요.', retry: true, release: true },
};

export function failureView(kind: VoiceFailureKind): FailureView {
  const f = FAILURE_TEXT[kind];
  return { text: f.text, offersRetry: f.retry, mustReleaseCapture: f.release, offersTextFallback: true };
}
