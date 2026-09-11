// #897 (VO-01 / VO-04) — 음성 capability 를 **주장이 아니라 측정**으로 바꾼다.
//
// 왜 필요한가. 요구사항 초안은 "webview 오디오 입출력을 확인한다" 를 확인 절차로
// 적었지만, 2026-09-10 설치본(0.1.51)의 번들 코어를 읽은 결과 webview 내부 iframe 의
// Permissions-Policy allow 목록에 `microphone` 이 **0건**이고, Electron 메인 프로세스의
// webview 권한 집합에도 `media` 가 없다(`out/main.js`). 즉 `getUserMedia` 는 지금 반드시
// 거부된다 — 다만 **둘 중 어느 쪽이 거부하는지는 모른다.** 내부 iframe 은 same-origin 이라
// (`allow-same-origin` + 같은 출처 `fake.html` 로 로드) allow 속성의 누락이 실제로 비활성화를
// 뜻하는지 불확실하고, MDN 도 그 경우를 명확히 적지 않는다(2026-09-11 확인). 이전 주석은
// "CSP 와 무관하게 그 단계에서 거부된다" 고 단정했는데 그건 증거 없는 인과 주장이었다.
// 거부된다는 사실만으로 계측기의 근거는 충분하다. 그 상태에서 마이크 UI 를 만들면
// 허용·거부·장치없음·철회 네 상태가
// **전부 같은 거부로 수렴**하는 죽은 토글이 학생에게 나간다.
//
// 그래서 이 모듈은 기능이 아니라 **계측기**다. 이후 어떤 음성 코드도 capability 를
// 가정하지 못하고 이 게이트에 물어야 한다.
//
// 순수(vscode 없음, DOM 없음) — 웹뷰가 **원시 관측만** 보내고 판정은 여기서 한다.
// 관측과 판정을 같은 곳에서 하면 "측정하지 못한 것"과 "측정해서 막힌 것"이 섞인다.

/** 이 보고서의 스키마. 모양이 바뀌면 올린다 — 과거 보고서를 새 계약으로 읽지 않는다. */
export const VOICE_CAPABILITY_SCHEMA = "hps-voice-capability/1";

/** 웹뷰가 보내는 원시 관측. **판정을 담지 않는다.** */
export interface VoiceProbeObservations {
  /** `navigator.mediaDevices` 가 존재하는가. 없으면 관문 1에서 끝난다. */
  mediaDevicesPresent: boolean;
  /**
   * `getUserMedia({audio:true})` 결과.
   *
   * `errorName`/`errorMessage` 를 **둘 다** 남긴다: 세 관문(iframe allow 목록,
   * 메인 프로세스 권한 목록, Chromium 장치 권한)이 서로 다른 이름·문구로 거부하고,
   * boolean 으로 접으면 어느 관문이 걸렸는지 영영 알 수 없다.
   */
  getUserMedia: {
    attempted: boolean;
    outcome?: "granted" | "rejected" | "timeout";
    errorName?: string;
    errorMessage?: string;
    trackCount?: number;
    trackReadyState?: string;
  };
  /** Web Audio 출력. `default-src 'none'` 아래에서도 동작할 수 있다 — 그러면 `media-src` 를 **안 넣는다**. */
  audioContext: { attempted: boolean; rendered?: boolean; errorName?: string };
  /** `<audio src="data:audio/wav;…">` — `media-src` 부재를 단독으로 분리한다. */
  htmlAudioDataUri: { attempted: boolean; loaded?: boolean; errorName?: string };
  /** `audioWorklet.addModule(blob:)` — `worker-src` 를 단독으로 분리한다. */
  audioWorkletBlob: { attempted: boolean; loaded?: boolean; errorName?: string };
  /** 웹뷰가 자기 `<meta>` 에서 읽은 **실제 적용된** CSP. 소스가 말하는 값이 아니다. */
  cspObserved: string | null;
  userAgent: string | null;
}

export type InputVerdict = "allowed" | "blocked" | "unknown";
export type OutputVerdict = "full" | "web-audio-only" | "blocked" | "unknown";

export interface VoiceCapabilityReport {
  schema: typeof VOICE_CAPABILITY_SCHEMA;
  probed_at: string;
  /**
   * 설치된 **앱** 버전과 **확장** 버전을 따로 적는다. 2026-09-10 기준 설치본은
   * 0.1.51, 소스 트리의 확장은 0.1.5 다 — "버전" 한 칸만 쓰면 어느 쪽을 읽은
   * 보고서인지 알 수 없고, 그 모호함이 그대로 인수 기록에 박힌다.
   */
  app_version: string | null;
  extension_version: string | null;
  platform: string | null;
  surface: "chat-webview";
  csp_observed: string | null;
  user_agent: string | null;
  input: VoiceProbeObservations["getUserMedia"] & { mediaDevicesPresent: boolean };
  output: {
    audioContext: VoiceProbeObservations["audioContext"];
    htmlAudioDataUri: VoiceProbeObservations["htmlAudioDataUri"];
    audioWorkletBlob: VoiceProbeObservations["audioWorkletBlob"];
  };
  verdict: { input: InputVerdict; output: OutputVerdict };
  notes: string[];
}

export class VoiceProbeMalformedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`관측이 모양에 안 맞는다: ${reason}`);
    this.name = "VoiceProbeMalformedError";
    this.reason = reason;
  }
}

/**
 * 관측이 스스로 모순되는지 먼저 본다.
 *
 * VO-T05 의 규칙("미실행 시나리오를 PASS 로 기록한 fixture 는 검사가 거부한다")을
 * **내 산출물에** 적용한 것이다. 시도하지 않았는데 결과가 있다거나, 허용됐다면서
 * 트랙 수가 없는 관측은 판정 대상이 아니라 거부 대상이다 — 그걸 분류하면 거짓
 * 초록이 보고서 형식을 입고 나간다.
 */
function assertWellFormed(o: VoiceProbeObservations): void {
  const g = o.getUserMedia;
  if (!g.attempted && (g.outcome !== undefined || g.errorName !== undefined)) {
    throw new VoiceProbeMalformedError("getUserMedia 를 시도하지 않았는데 결과가 있다");
  }
  if (g.outcome === "granted" && (g.trackCount === undefined || g.trackCount <= 0)) {
    throw new VoiceProbeMalformedError("granted 인데 오디오 트랙이 없다");
  }
  if (g.outcome === "rejected" && !g.errorName) {
    throw new VoiceProbeMalformedError("rejected 인데 오류 이름이 없다 — 어느 관문인지 알 수 없다");
  }
  for (const [key, probe] of [
    ["audioContext", o.audioContext],
    ["htmlAudioDataUri", o.htmlAudioDataUri],
    ["audioWorkletBlob", o.audioWorkletBlob],
  ] as const) {
    const r = probe as { attempted: boolean; rendered?: boolean; loaded?: boolean; errorName?: string };
    if (!r.attempted && (r.rendered !== undefined || r.loaded !== undefined || r.errorName !== undefined)) {
      throw new VoiceProbeMalformedError(`${key} 를 시도하지 않았는데 결과가 있다`);
    }
  }
}

/** 입력 판정. **측정하지 않은 것을 막혔다고 적지 않는다** — 그게 unknown 이다. */
function inputVerdict(o: VoiceProbeObservations): InputVerdict {
  const g = o.getUserMedia;
  if (!o.mediaDevicesPresent) return "blocked";
  if (!g.attempted) return "unknown";
  if (g.outcome === "granted") {
    // 트랙이 살아 있지 않으면 허용이 아니다. 열렸다가 즉시 죽는 경우를 허용으로
    // 적으면 그 위에 세운 UI 가 "켜졌는데 소리가 안 들어온다" 로 나타난다.
    return g.trackReadyState === "live" ? "allowed" : "blocked";
  }
  if (g.outcome === "rejected" || g.outcome === "timeout") return "blocked";
  return "unknown";
}

/** 출력 판정. Web Audio 만 되면 `media-src` 를 **넣지 않는** 근거가 된다. */
function outputVerdict(o: VoiceProbeObservations): OutputVerdict {
  const web = o.audioContext.attempted ? o.audioContext.rendered === true : undefined;
  const html = o.htmlAudioDataUri.attempted ? o.htmlAudioDataUri.loaded === true : undefined;
  if (web === undefined && html === undefined) return "unknown";
  if (web === true && html === true) return "full";
  if (web === true) return "web-audio-only";
  if (html === true) return "web-audio-only";
  return "blocked";
}

/**
 * 계측기 자신을 의심하는 줄(verification.md 규칙 6).
 *
 * CSP 에 `media-src` 가 **있는데** data: 오디오가 안 실렸다면, 제품이 막은 게
 * 아니라 프로브가 잘못 재고 있을 가능성이 먼저다. 그 경우 제품 판정을 내지 않고
 * `instrument_suspect` 를 남긴다.
 */
function instrumentNotes(o: VoiceProbeObservations): string[] {
  const notes: string[] = [];
  const csp = o.cspObserved ?? "";
  if (csp.includes("media-src") && o.htmlAudioDataUri.attempted && o.htmlAudioDataUri.loaded === false) {
    notes.push("instrument_suspect: CSP 에 media-src 가 있는데 data: 오디오가 실리지 않았다 — 프로브를 먼저 의심한다");
  }
  if (!o.cspObserved) {
    notes.push("csp_unobserved: 적용된 CSP 를 읽지 못했다 — 출력 판정의 근거가 약하다");
  }
  if (o.mediaDevicesPresent && o.getUserMedia.outcome === "rejected") {
    notes.push(
      `gate: mediaDevices 는 있는데 거부됐다 (${o.getUserMedia.errorName ?? "이름없음"}) — ` +
        "iframe allow 목록 / 메인 프로세스 권한 목록 / Chromium 장치 권한 중 어느 관문인지는 patch 된 빌드로만 가른다",
    );
  }
  if (!o.mediaDevicesPresent) {
    notes.push("gate: navigator.mediaDevices 자체가 없다 — 관문 1에서 끝났다");
  }
  return notes;
}

/** 원시 관측 → 보고서. 모순된 관측은 분류하지 않고 던진다. */
export function buildVoiceCapabilityReport(
  observations: VoiceProbeObservations,
  meta: { probedAt: string; appVersion?: string | null; extensionVersion?: string | null; platform?: string | null },
): VoiceCapabilityReport {
  assertWellFormed(observations);
  return {
    schema: VOICE_CAPABILITY_SCHEMA,
    probed_at: meta.probedAt,
    app_version: meta.appVersion ?? null,
    extension_version: meta.extensionVersion ?? null,
    platform: meta.platform ?? null,
    surface: "chat-webview",
    csp_observed: observations.cspObserved,
    user_agent: observations.userAgent,
    input: { ...observations.getUserMedia, mediaDevicesPresent: observations.mediaDevicesPresent },
    output: {
      audioContext: observations.audioContext,
      htmlAudioDataUri: observations.htmlAudioDataUri,
      audioWorkletBlob: observations.audioWorkletBlob,
    },
    verdict: { input: inputVerdict(observations), output: outputVerdict(observations) },
    notes: instrumentNotes(observations),
  };
}

/**
 * 사람이 읽는 한 줄. 보고서를 그대로 보여주면 아무도 안 읽는다.
 *
 * **"안 됨" 을 "아직 안 쟀음" 과 구분해서 쓴다** — 오늘 이 레포에서 비용이 컸던
 * 구분이다.
 */
export function summarizeVoiceCapability(report: VoiceCapabilityReport): string {
  const i =
    report.verdict.input === "allowed"
      ? "마이크 입력: 가능"
      : report.verdict.input === "blocked"
        ? "마이크 입력: 막힘"
        : "마이크 입력: 측정 안 됨";
  const o =
    report.verdict.output === "full"
      ? "오디오 출력: 전부 가능"
      : report.verdict.output === "web-audio-only"
        ? "오디오 출력: Web Audio 만"
        : report.verdict.output === "blocked"
          ? "오디오 출력: 막힘"
          : "오디오 출력: 측정 안 됨";
  return `${i} · ${o}`;
}
