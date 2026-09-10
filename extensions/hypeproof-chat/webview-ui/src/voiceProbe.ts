// #897 (VO-01) — 음성 capability 프로브의 DOM 절반.
//
// **원시 관측만 돌려준다. 판정하지 않는다.** 판정은 호스트의
// `voiceCapabilityHelpers.buildVoiceCapabilityReport` 가 한다. 같은 곳에서 재고
// 판정하면 "측정하지 못한 것" 과 "측정해서 막힌 것" 이 한 boolean 으로 섞이고,
// 그러면 core patch 가 들어간 뒤에도 보고서가 계속 "막힘" 이라고 말한다.
//
// 세 관문을 **따로** 잰다. 설치본 0.1.51 에서 webview iframe 의 allow 목록에
// `microphone` 이 없음을 확인했으므로 오늘은 전부 거부로 나오지만, 어느 관문이
// 걸렸는지는 오류 **이름과 문구**로만 갈린다.

type Probe = { attempted: boolean; rendered?: boolean; loaded?: boolean; errorName?: string };

const GUM_TIMEOUT_MS = 4000;

function errName(e: unknown): string {
  if (e && typeof e === 'object' && 'name' in e && typeof (e as { name?: unknown }).name === 'string') {
    return (e as { name: string }).name;
  }
  return 'UnknownError';
}
function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message.slice(0, 200);
  return String(e).slice(0, 200);
}

/** 적용된 CSP 를 웹뷰 자신의 `<meta>` 에서 읽는다 — 소스가 말하는 값이 아니다. */
function observedCsp(): string | null {
  try {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    return meta?.getAttribute('content') ?? null;
  } catch {
    return null;
  }
}

async function probeMic(): Promise<{
  attempted: boolean;
  outcome?: 'granted' | 'rejected' | 'timeout';
  errorName?: string;
  errorMessage?: string;
  trackCount?: number;
  trackReadyState?: string;
}> {
  const md = (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices;
  if (!md || typeof md.getUserMedia !== 'function') return { attempted: false };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 타임아웃을 두는 이유: 관문 중 하나가 **응답하지 않는** 형태로 막을 수 있고,
    // 그때 프로브가 영원히 매달리면 "측정 안 됨" 조차 남지 않는다.
    const stream = await Promise.race([
      md.getUserMedia({ audio: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('probe timeout'), { name: 'ProbeTimeout' })), GUM_TIMEOUT_MS);
      }),
    ]);
    const tracks = stream.getAudioTracks();
    const readyState = tracks[0]?.readyState;
    // 즉시 해제한다. 계측기가 마이크를 쥔 채로 남으면 그 자체가 사고다.
    for (const t of stream.getTracks()) t.stop();
    return { attempted: true, outcome: 'granted', trackCount: tracks.length, trackReadyState: readyState };
  } catch (e) {
    const name = errName(e);
    return {
      attempted: true,
      outcome: name === 'ProbeTimeout' ? 'timeout' : 'rejected',
      errorName: name,
      errorMessage: errMessage(e),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Web Audio 출력. 이게 되면 `media-src` 를 **넣지 않을** 근거가 된다. */
async function probeAudioContext(): Promise<Probe> {
  const Ctor =
    (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Ctor) return { attempted: false };
  try {
    // Offline 으로 렌더한다 — 소리를 내지 않고 경로만 확인한다. 교실에서 진단이
    // 삑 소리를 내면 안 된다.
    const ctx = new Ctor(1, 128, 44100);
    const osc = ctx.createOscillator();
    osc.connect(ctx.destination);
    osc.start(0);
    const buf = await ctx.startRendering();
    return { attempted: true, rendered: buf.length > 0 };
  } catch (e) {
    return { attempted: true, rendered: false, errorName: errName(e) };
  }
}

/** `<audio src="data:…">` — `media-src` 부재를 단독으로 분리한다. */
function probeHtmlAudioDataUri(): Promise<Probe> {
  return new Promise((resolve) => {
    try {
      // 44-byte WAV 헤더 + 무음 한 샘플. 실제로 들리지 않는다.
      const wav =
        'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
      const el = document.createElement('audio');
      let settled = false;
      const done = (p: Probe) => {
        if (settled) return;
        settled = true;
        el.src = '';
        resolve(p);
      };
      el.addEventListener('loadedmetadata', () => done({ attempted: true, loaded: true }), { once: true });
      el.addEventListener('error', () => done({ attempted: true, loaded: false, errorName: 'MediaError' }), { once: true });
      setTimeout(() => done({ attempted: true, loaded: false, errorName: 'ProbeTimeout' }), 2000);
      el.preload = 'metadata';
      el.src = wav;
    } catch (e) {
      resolve({ attempted: true, loaded: false, errorName: errName(e) });
    }
  });
}

/** `audioWorklet.addModule(blob:)` — `worker-src` 를 단독으로 분리한다. */
async function probeAudioWorkletBlob(): Promise<Probe> {
  const Ctor = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctor) return { attempted: false };
  let ctx: AudioContext | undefined;
  try {
    ctx = new Ctor();
    if (!ctx.audioWorklet) return { attempted: true, loaded: false, errorName: 'NoAudioWorklet' };
    const url = URL.createObjectURL(new Blob(['registerProcessor("hps-probe",class extends AudioWorkletProcessor{process(){return false}})'], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
      return { attempted: true, loaded: true };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (e) {
    return { attempted: true, loaded: false, errorName: errName(e) };
  } finally {
    try { await ctx?.close(); } catch { /* best effort */ }
  }
}

/**
 * 네 가지를 따로 재서 원시 관측을 돌려준다.
 *
 * 마이크를 **맨 마지막에** 잰다: core patch 가 들어간 뒤에는 이 호출이 OS 권한
 * 프롬프트를 띄우므로, 그 앞의 출력 측정은 프롬프트와 무관하게 끝나 있어야 한다.
 */
export async function runVoiceCapabilityProbe(): Promise<{
  mediaDevicesPresent: boolean;
  getUserMedia: Awaited<ReturnType<typeof probeMic>>;
  audioContext: Probe;
  htmlAudioDataUri: Probe;
  audioWorkletBlob: Probe;
  cspObserved: string | null;
  userAgent: string | null;
}> {
  const cspObserved = observedCsp();
  const userAgent = typeof navigator?.userAgent === 'string' ? navigator.userAgent : null;
  const mediaDevicesPresent = Boolean(
    (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices?.getUserMedia,
  );
  const audioContext = await probeAudioContext();
  const htmlAudioDataUri = await probeHtmlAudioDataUri();
  const audioWorkletBlob = await probeAudioWorkletBlob();
  const getUserMedia = await probeMic();
  return { mediaDevicesPresent, getUserMedia, audioContext, htmlAudioDataUri, audioWorkletBlob, cspObserved, userAgent };
}
