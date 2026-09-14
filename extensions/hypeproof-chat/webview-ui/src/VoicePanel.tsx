// #939 (VO-38 · VO-40 · VO-41 · VO-43 ~ VO-47) — 음성 대화 패널의 **그리는 쪽**.
//
// 결정은 하나도 여기 없다. 상태·허용 조작·문구는 전부 `src/voicePopupHelpers.ts`
// 가 정하고 이 파일은 받은 것을 배치한다. 그 분리가 필요한 이유는 취향이 아니다:
// 판정이 JSX 안에 흩어지면 "지금 마이크가 열려 있나" 를 컴포넌트 트리를 읽어야
// 답하게 되고, 그 질문에 한 곳에서 답할 수 없는 제품을 아이에게 준다.
//
// 이 파일이 **주장하지 않는 것**: 음성이 동작한다. 여기에는 `getUserMedia` 도
// 오디오 재생도 없다 — 실제 연결은 UI-2(#898 V0 전송 ADR · #901 V4 예산) 이후다.
// 그때까지 `voiceStartGate` 가 시작을 막으므로 학생에게 이 패널은 열리지 않는다.
import { useEffect, useRef, type KeyboardEvent } from "react";

import {
  COMPACT_CONTROLS,
  type DismissKind,
  type FailureView,
  type MeterView,
  type PopupState,
  type ReferenceTarget,
  type SessionInfoLine,
  voicePanelTitle,
} from "../../src/voicePopupHelpers";
import type { VoiceSession } from "../../src/voiceSessionHelpers";

export interface VoicePanelProps {
  /** 수업/강사가 정한 이름. 이 컴포넌트는 이름을 **만들지 않는다** (VO-45). */
  coachName: string;
  session: VoiceSession;
  popup: PopupState;
  /** `meterView()` 의 결과. 여기서 다시 계산하지 않는다. */
  meter: MeterView;
  /** 사용자가 보고 있는 결과물. 없으면 줄이 사라진다 — 지어내지 않는다 (VO-43). */
  reference: ReferenceTarget | null;
  info: readonly SessionInfoLine[];
  /** 확정 전사와 미확정 전사를 **구분해서** 받는다 (VO-43). */
  finalTranscript: string | null;
  partialTranscript: string | null;
  failure: FailureView | null;
  onMinimize(): void;
  onExpand(): void;
  onToggleMute(): void;
  onResume(): void;
  onStopSpeaking(): void;
  onDismiss(kind: DismissKind): void;
  onRetry(): void;
}

/** 미터 막대. 관측이 없으면(`level === null`) **정지한 모양**을 그린다 (VO-38). */
function Meter({ meter }: { meter: MeterView }) {
  const level = meter.animated ? (meter.level ?? 0) : 0;
  const bars = [0.45, 0.75, 1, 0.75, 0.45];
  return (
    <div
      className={`hps-voice-meter${meter.animated ? " hps-voice-meter-live" : ""}`}
      role="img"
      // 파형을 못 보는 사람에게도 같은 사실이 전달되어야 한다 (VO-47).
      aria-label={meter.statusName}
    >
      {bars.map((weight, i) => (
        <span
          key={i}
          className="hps-voice-bar"
          // 정지 상태의 높이는 **고정**이다. 관측 없이 흔들리면 그게 가짜 움직임이다.
          style={{ height: `${12 + (level * weight * 44)}px` }}
        />
      ))}
    </div>
  );
}

function StatusBlock({ meter, failure }: { meter: MeterView; failure: FailureView | null }) {
  return (
    <div className="hps-voice-status">
      <Meter meter={meter} />
      {/* 상태는 **문구로도** 있어야 한다 — 색과 모션만으로 구분하지 않는다 (VO-38/47). */}
      <p className="hps-voice-status-text">{failure ? failure.text : meter.statusText}</p>
      {meter.progress && !failure && <p className="hps-voice-progress" role="status">잠시만 기다려 주세요</p>}
    </div>
  );
}

export function VoicePanel(props: VoicePanelProps) {
  const { popup, session, meter } = props;
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 패널이 열리면 포커스를 안으로 옮긴다. Escape 를 받으려면 포커스가 여기 있어야
  // 하고(VO-41), 키보드 사용자가 패널을 찾지 못하면 종료도 못 한다(VO-47).
  useEffect(() => {
    if (popup.presentation !== "hidden") panelRef.current?.focus();
  }, [popup.presentation]);

  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    // 축소 상태에서도 Escape 는 종료다. 작업 영역의 키 입력은 가로채지 않는다.
    e.stopPropagation();
    props.onDismiss("escape");
  };

  if (popup.presentation === "hidden") return null;

  const muted = popup.userMuteIntent || session.state === "muted";
  const controls = new Set<string>(COMPACT_CONTROLS);

  if (popup.presentation === "compact") {
    return (
      <div ref={panelRef} tabIndex={-1} onKeyDown={onPanelKeyDown} className="hps-voice-compact" role="region" aria-label={voicePanelTitle(props.coachName)}>
        <span className="hps-voice-compact-status">
          {/* 작은 컨트롤에서도 **캡처 상태**를 숨기지 않는다 (VO-40). */}
          <span className={`hps-voice-dot${session.captureOpen ? " hps-voice-dot-on" : ""}`} aria-hidden="true" />
          {popup.awaitingResume ? "일시중지됨" : meter.statusName}
        </span>
        {controls.has("mute") && (
          <button type="button" onClick={props.onToggleMute} aria-pressed={muted}>
            {muted ? "음소거 해제" : "음소거"}
          </button>
        )}
        {popup.awaitingResume && (
          <button type="button" onClick={props.onResume}>다시 시작</button>
        )}
        {controls.has("stop") && (
          <button type="button" onClick={() => props.onDismiss("stop_button")}>종료</button>
        )}
        {controls.has("expand") && (
          <button type="button" onClick={props.onExpand}>펼치기</button>
        )}
      </div>
    );
  }

  return (
    <div
      className="hps-voice-panel"
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      // **비모달**이다. 대화 중에도 작업 화면에 접근할 수 있어야 한다 (VO-40/47).
      aria-modal={false}
      aria-label={voicePanelTitle(props.coachName)}
      onKeyDown={onPanelKeyDown}
    >
      <header className="hps-voice-head">
        <h2>{voicePanelTitle(props.coachName)}</h2>
        <div className="hps-voice-head-buttons">
          <button type="button" onClick={props.onMinimize} aria-label="음성 대화 축소">축소</button>
          <button type="button" onClick={() => props.onDismiss("panel_close")} aria-label="음성 대화 종료">✕</button>
        </div>
      </header>

      <StatusBlock meter={meter} failure={props.failure} />

      <div className="hps-voice-body" tabIndex={0} aria-label="대화 전사와 세션 정보">
        {popup.awaitingResume && (
          <div className="hps-voice-resume" role="status">
            <p>잠시 멈춰 뒀어요. 다시 시작하려면 눌러 주세요.</p>
            <button type="button" onClick={props.onResume}>다시 시작</button>
          </div>
        )}

        {props.failure?.offersRetry && (
          <button type="button" className="hps-voice-retry" onClick={props.onRetry}>다시 시도</button>
        )}

        <div className="hps-voice-transcript">
          {props.finalTranscript && <p className="hps-voice-final">{props.finalTranscript}</p>}
          {props.partialTranscript && (
            <p className="hps-voice-partial">
              {props.partialTranscript}
              {/* 미확정임을 **글자로** 말한다. 흐린 색만으로는 구분되지 않는다. */}
              <span className="hps-voice-partial-tag"> · 아직 확정되지 않았어요</span>
            </p>
          )}
        </div>

        {props.reference && (
          <p className="hps-voice-reference">
            참조: {props.reference.title}
            {props.reference.revision ? ` · ${props.reference.revision}` : " · 버전 확인 안 됨"}
          </p>
        )}

        <ul className="hps-voice-info">
          {props.info.map((line) => (
            <li key={line.label}>
              {line.label}: {line.value}
              {/* 예상값을 확정처럼 적지 않는다 (VO-46). */}
              {line.certainty === "estimated" && <span className="hps-voice-est"> (예상)</span>}
              {line.certainty === "unknown" && <span className="hps-voice-est"> (확인 안 됨)</span>}
            </li>
          ))}
        </ul>
      </div>

      <div className="hps-voice-actions">
        <button type="button" onClick={props.onToggleMute} aria-pressed={muted}>
          {muted ? "음소거 해제" : "음소거"}
        </button>
        <button type="button" onClick={props.onStopSpeaking} disabled={session.state !== "speaking" && session.state !== "preparing"}>
          말 멈추기
        </button>
        <button type="button" className="hps-voice-to-text" onClick={() => props.onDismiss("switch_to_text")}>
          텍스트로 전환
        </button>
      </div>
    </div>
  );
}
