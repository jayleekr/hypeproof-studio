// #897 — `probeMic` 의 마이크 수명. **늦게 허용된 권한이 새지 않는지** 잰다.
//
// 출처: Codex 독립 인수가 2026-09-10 에 FAIL 로 재현했다. `Promise.race` 는 패배한
// `getUserMedia` 요청을 **취소하지 않는다.** 타임아웃이 이기면 프로브는
// `outcome: 'timeout'` 을 돌려주지만 원래 요청은 살아 있고, 사용자가 뒤늦게 "허용" 을
// 누르면 live track 을 가진 stream 이 도착해 아무도 `stop()` 을 부르지 않았다.
//
// 단순 누수보다 나쁘다: **보고서는 마이크를 못 얻었다고 적는데 실제로는 쥐고 있다.**
// 아이 노트북의 OS 마이크 표시가 켜진 채 남고 제품의 어떤 화면도 설명하지 못한다.
//
// 계측 방식: 제품 소스를 **다시 쓰지 않는다.** 실제 `voiceProbe.ts` 를 그대로 불러
// `navigator.mediaDevices` 만 합성한다 — Codex 재현과 같은 원칙이다. 제품 함수를
// 흉내낸 사본을 검사하면 사본만 검증된다.
//
// Run: node --experimental-strip-types test/voice-probe-lifecycle.smoke.mjs

import assert from "node:assert/strict";

/** 합성 오디오 track. `stop()` 호출 여부와 상태를 관측 가능하게 남긴다. */
function fakeTrack() {
  const t = {
    readyState: "live",
    stopped: 0,
    stop() { t.stopped += 1; t.readyState = "ended"; },
  };
  return t;
}
function fakeStream(tracks) {
  return { getAudioTracks: () => tracks, getTracks: () => tracks };
}

/**
 * `getUserMedia` 를 제어 가능하게 만든다. 제품이 부르면 promise 를 돌려주고,
 * 테스트가 원하는 시점에 resolve/reject 한다.
 */
function install() {
  let resolveGum, rejectGum, announce;
  // 마이크는 **맨 마지막**에 재므로(소스의 순서 계약) 앞의 출력 프로브들이 끝나기를
  // 기다려야 한다. 고정 지연으로 짐작하지 않고 실제 호출 시점을 신호로 받는다.
  const called = new Promise((r) => { announce = r; });
  const calls = [];
  const md = {
    getUserMedia(constraints) {
      calls.push(constraints);
      const p = new Promise((res, rej) => { resolveGum = res; rejectGum = rej; });
      announce();
      return p;
    },
  };
  // Node 24 의 `navigator` 는 getter-only 이므로 대입이 아니라 재정의한다.
  const def = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  def("navigator", { mediaDevices: md, userAgent: "probe-test" });
  def("document", {
    querySelector: () => null,
    createElement: () => ({ addEventListener() {}, set src(_v) {}, preload: "" }),
  });
  def("window", {});
  return { calls, called, resolve: (s) => resolveGum(s), reject: (e) => rejectGum(e) };
}

const mod = await import("../webview-ui/src/voiceProbe.ts");
// 제품이 `probeMic` 을 직접 내보내지 않으므로, 전체 프로브를 통해 구동한다.
// (마이크는 **맨 마지막**에 재므로 다른 관문이 먼저 끝난다 — 소스 주석의 순서 계약.)
const run = mod.runVoiceCapabilityProbe;
assert.equal(typeof run, "function", "runVoiceCapabilityProbe 를 못 찾았다 — 계측 대상이 사라졌다");

// ─── §1 양성 대조군 — 즉시 허용되면 정상 보고 + 즉시 해제 ────────────────────
// 이게 없으면 아래 누수 단언들이 "프로브가 아예 안 돈다" 와 구별되지 않는다.
{
  const track = fakeTrack();
  const ctl = install();
  const p = run();
  await ctl.called;
  ctl.resolve(fakeStream([track]));
  const obs = await p;

  assert.equal(obs.getUserMedia.attempted, true, "마이크를 시도하지 않았다");
  assert.equal(obs.getUserMedia.outcome, "granted", `허용인데 ${obs.getUserMedia.outcome}`);
  assert.equal(obs.getUserMedia.trackCount, 1);
  assert.equal(obs.getUserMedia.trackReadyState, "live", "해제 **전에** 상태를 읽어야 한다 — 순서가 뒤집혔다");
  assert.equal(track.stopped, 1, "성공 경로에서 track 을 해제하지 않았다");
  assert.equal(track.readyState, "ended");
}

// ─── §2 거부는 해제할 것이 없다 ──────────────────────────────────────────────
{
  const ctl = install();
  const p = run();
  await ctl.called;
  ctl.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
  const obs = await p;
  assert.equal(obs.getUserMedia.outcome, "rejected");
  assert.equal(obs.getUserMedia.errorName, "NotAllowedError", "오류 이름을 잃어버렸다");
  assert.match(obs.getUserMedia.errorMessage ?? "", /Permission denied/);
}

// ─── §3 **늦은 허용이 새지 않는다** (Codex 재현) ─────────────────────────────
// 타임아웃이 이긴 뒤 사용자가 "허용" 을 누른다. 보고서는 timeout 이어야 하고,
// 늦게 도착한 track 은 **반드시 stop 되어야 한다.**
{
  const track = fakeTrack();
  const ctl = install();
  const p = run();

  // 프로브의 4초 타임아웃을 실제로 태운다. 가짜 타이머를 쓰지 않는 이유: 제품이
  // `setTimeout` 을 어떻게 쓰는지 바꿔 끼우면 그 배선 자체가 검증에서 빠진다.
  const obs = await p;
  assert.equal(obs.getUserMedia.outcome, "timeout", `타임아웃이 나야 한다: ${JSON.stringify(obs.getUserMedia)}`);
  assert.equal(obs.getUserMedia.errorName, "ProbeTimeout");

  // 보고서가 나간 **뒤에** 사용자가 허용한다 — 실제 순서 그대로.
  assert.equal(track.stopped, 0, "아직 허용 전인데 해제됐다 — 재현 시나리오가 틀렸다");
  ctl.resolve(fakeStream([track]));
  // 늦은 해제는 microtask 로 일어난다.
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(
    track.stopped, 1,
    "늦게 허용된 마이크가 해제되지 않았다 — 보고서는 timeout 인데 마이크는 켜져 있다",
  );
  assert.equal(track.readyState, "ended", "늦게 허용된 track 이 live 로 남았다");

  // 그리고 늦은 허용이 **보고서를 바꾸지 않는다** — 이미 나간 판정을 소급해서 고치면
  // 그 보고서를 읽는 쪽이 시점을 알 수 없게 된다.
  assert.equal(obs.getUserMedia.outcome, "timeout", "늦은 허용이 이미 나간 보고서를 바꿨다");
}

// ─── §4 늦은 **거부**는 아무 일도 일으키지 않는다 ────────────────────────────
// 늦은 경로에 unhandled rejection 이 남으면 웹뷰 콘솔이 오염되고, 그게 진짜 오류를 덮는다.
{
  const ctl = install();
  const p = run();
  const obs = await p;
  assert.equal(obs.getUserMedia.outcome, "timeout");

  let unhandled = null;
  const onUnhandled = (e) => { unhandled = e; };
  process.on("unhandledRejection", onUnhandled);
  ctl.reject(Object.assign(new Error("late deny"), { name: "NotAllowedError" }));
  await new Promise((r) => setTimeout(r, 10));
  process.off("unhandledRejection", onUnhandled);
  assert.equal(unhandled, null, "늦은 거부가 처리되지 않은 rejection 으로 샜다");
}

// ─── §5 여러 track 이 와도 전부 해제한다 ────────────────────────────────────
// `getAudioTracks()` 만 보고 해제하면 비디오 track 이 남는다. 제품은 `getTracks()` 를
// 써야 하고, 그 구분이 실제로 지켜지는지 본다.
{
  const audio = fakeTrack();
  const extra = fakeTrack();
  const ctl = install();
  const p = run();
  const obs = await p;
  assert.equal(obs.getUserMedia.outcome, "timeout");
  ctl.resolve({ getAudioTracks: () => [audio], getTracks: () => [audio, extra] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(audio.stopped, 1, "오디오 track 이 해제되지 않았다");
  assert.equal(extra.stopped, 1, "오디오가 아닌 track 이 남았다 — getTracks() 전체를 해제해야 한다");
}

console.log("voice-probe-lifecycle: 늦은 허용도 해제된다 · 보고서는 소급 변경되지 않는다 — OK");
