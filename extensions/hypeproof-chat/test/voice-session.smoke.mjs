// #898 V1 (VO-06 / VO-07 / VO-09) — 음성 세션 결정 계층의 대조군 포함 스모크.
//
// 이 파일이 **주장하지 않는 것**부터: 음성이 동작한다는 주장이 아니다. 마이크를 여는
// 코드는 제품에 아직 없고(REQ-R1: 출하 빌드의 webview allow 목록에 `microphone` 0건),
// 여기 있는 것은 전부 순수 함수와 합성 이벤트 열이다. VO-T06~T10 은 NOT RUN 이다.
// mock 성공을 실기 성공으로 확대하지 않는다(#898 공통 인수 규칙).
//
// 무엇을 잠그나:
//   1. 명시적 시작 **전에는 어떤 이벤트도 캡처를 열지 않는다** (VO-06)
//   2. 상태 일곱 갈래가 실제로 **구분된다** — 접히지 않는다 (VO-06)
//   3. 끼어들기의 들은 범위 네 갈래, 특히 `unknown` 을 들었다/못 들었다로 접지 않음 (VO-07)
//   4. 시작 연타·재연결이 청취 세션을 둘로 만들지 않는다 (VO-09)
//   5. 종료·오류 뒤 남는 자원이 없다 — 해제 목록으로 확인 (VO-09)
//   6. 말끝 판단이 에코·잡음·짧은 쉼을 턴으로 만들지 않는다 (VO-08 정책만)
//   7. 임계값이 **합의 전**임이 타입과 테스트에 남아 있다
//
// 계측기 규율(.claude/rules/verification.md): 모든 거절 단언에 통과 대조군을 붙인다.
// 대조군이 없으면 "전부 거절" 또는 "전부 무시" 구현이 아래를 다 통과한다.
//
// Run: node --experimental-strip-types test/voice-session.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const {
  initialVoiceSession,
  voiceTransition,
  runVoiceEvents,
  heardExtent,
  followUpContext,
  shouldEndTurn,
  releasePlan,
  assertVoiceInvariants,
  describeVoiceSession,
  PROVISIONAL_ENDPOINTING,
  VoiceInvariantError,
  VoiceMarksDisorderedError,
} = await import("../src/voiceSessionHelpers.ts");

const ALL_STATES = [
  "idle", "connecting", "listening", "preparing", "speaking", "muted", "closing", "closed", "error",
];

const open = [{ type: "start" }, { type: "transport_ready" }];

// ─── §0 계측기를 먼저 검증한다 ───────────────────────────────────────────────
// 아래 대부분이 "무시된다 / 캡처가 안 열린다" 형태의 음성 단언이다. 전이 함수가
// 아무 일도 안 하는 고장이면 그 전부가 조용히 통과한다. 그래서 **정상 경로가
// 실제로 상태를 바꾸는지** 먼저 증명한다.
{
  const s = runVoiceEvents(open);
  assert.equal(s.state, "listening", "정상 개시가 listening 에 닿지 않는다 — 전이 함수가 죽어 있다");
  assert.equal(s.captureOpen, true, "listening 인데 캡처가 닫혀 있다");
  assert.equal(s.listeningSessions, 1);
  assert.equal(s.ignored.length, 0, "정상 경로에서 무시된 이벤트가 있다");

  // 상태가 상수가 아님을 여러 갈래 출력으로 박아둔다.
  const reached = new Set();
  for (const ev of [
    [], open, [...open, { type: "user_speech_end" }],
    [...open, { type: "user_speech_end" }, { type: "response_playback_start" }],
    [...open, { type: "mute" }],
    [...open, { type: "close", reason: "user_stop" }],
    [...open, { type: "close", reason: "user_stop" }, { type: "release_done" }],
    [...open, { type: "fail", code: "device_lost" }],
    [{ type: "start" }],
  ]) reached.add(runVoiceEvents(ev).state);
  assert.deepEqual(
    [...reached].sort(),
    ALL_STATES.slice().sort(),
    `아홉 상태가 모두 도달 가능해야 한다 — 도달한 것: ${[...reached].sort().join(",")}`,
  );
}

// ─── §1 VO-06 시작 전에는 캡처가 열리지 않는다 ───────────────────────────────
// 이 절이 이 파일의 존재 이유다. `start` 없이 캡처가 열리는 경로가 하나라도 있으면
// 아이가 누르지 않은 마이크가 켜진다.
{
  const EVERY_EVENT = [
    { type: "transport_ready" }, { type: "user_speech_start" }, { type: "user_speech_end" },
    { type: "response_playback_start" }, { type: "response_playback_end" },
    { type: "mute" }, { type: "unmute" }, { type: "interrupt" },
    { type: "transport_dropped" },
    { type: "close", reason: "user_stop" }, { type: "release_done" },
    { type: "fail", code: "x" },
  ];

  // 낱개로
  for (const e of EVERY_EVENT) {
    const s = voiceTransition(initialVoiceSession(), e);
    assert.equal(s.captureOpen, false, `idle 에서 ${e.type} 가 캡처를 열었다`);
    assertVoiceInvariants(s);
  }

  // 그리고 **모든 순열에 가까운 누적** — 순서가 뒤바뀐 기기 이벤트를 흉내낸다.
  // start 를 끝까지 보내지 않는 한 캡처는 닫혀 있어야 한다.
  let s = initialVoiceSession();
  for (let round = 0; round < 3; round++) {
    for (const e of EVERY_EVENT) {
      s = voiceTransition(s, e);
      assert.equal(s.captureOpen, false, `start 없이 ${e.type} 누적에서 캡처가 열렸다 (${describeVoiceSession(s)})`);
      assert.equal(s.listeningSessions, 0, "start 없이 세션 슬롯이 생겼다");
      assertVoiceInvariants(s);
    }
  }
  assert.ok(s.ignored.length >= 30, `무시 기록이 남아야 한다: ${s.ignored.length}`);

  // 통과 대조군 — 같은 전이 함수가 `start` 를 받으면 **실제로 연다**. 이게 없으면
  // 위 전부가 "전이 함수가 항상 무시한다" 는 고장과 구별되지 않는다.
  const opened = runVoiceEvents(open, s);
  assert.equal(opened.captureOpen, true, "start 이후에도 캡처가 열리지 않는다 — 계측기/제품 확인");
}

// ─── §2 VO-06 상태가 접히지 않는다 ──────────────────────────────────────────
// "듣는 중" 과 "응답 준비" 를 하나로 접으면 화면이 둘을 같은 스피너로 그린다.
{
  const listening = runVoiceEvents(open);
  const preparing = voiceTransition(listening, { type: "user_speech_end" });
  const speaking = voiceTransition(preparing, { type: "response_playback_start" });
  assert.notEqual(listening.state, preparing.state, "듣는 중과 응답 준비가 같은 상태다");
  assert.notEqual(preparing.state, speaking.state, "응답 준비와 말하는 중이 같은 상태다");
  // 그런데 **자원 사실은 다르다**: 재생 큐는 speaking 에서만 찬다.
  assert.equal(preparing.playbackQueued, false, "재생 전인데 재생 큐가 찼다");
  assert.equal(speaking.playbackQueued, true, "재생 중인데 재생 큐가 비었다");

  // 음소거는 캡처를 **실제로** 닫는다 — 소프트 게이트면 OS 표시가 켜진 채 남는다.
  const muted = voiceTransition(listening, { type: "mute" });
  assert.equal(muted.state, "muted");
  assert.equal(muted.captureOpen, false, "음소거인데 캡처가 열려 있다 — OS 마이크 표시가 안 꺼진다");
  // 음성 대조군: 음소거가 세션을 죽이지는 않는다.
  assert.equal(muted.listeningSessions, 1, "음소거가 세션을 죽였다");
  assert.equal(voiceTransition(muted, { type: "unmute" }).captureOpen, true, "음소거 해제가 캡처를 못 연다");

  // speaking 중에도 캡처는 열려 있다 — 끼어들기를 위해서다. 이 사실이 에코 구간의
  // 근거이므로 단언으로 고정한다(바뀌면 VO-08 의 전제가 바뀐다).
  assert.equal(speaking.captureOpen, true, "재생 중 캡처가 닫혀 있으면 끼어들기가 불가능하다");
}

// ─── §3 VO-09 시작 연타·재연결이 세션을 둘로 만들지 않는다 ──────────────────
{
  // 연타 20회 + 중간에 transport_ready 재도착까지 섞는다.
  let s = initialVoiceSession();
  for (let i = 0; i < 20; i++) {
    s = voiceTransition(s, { type: "start" });
    s = voiceTransition(s, { type: "transport_ready" });
    assertVoiceInvariants(s);
    assert.ok(s.listeningSessions <= 1, `연타 ${i}회에서 세션이 ${s.listeningSessions}개다`);
  }
  assert.equal(s.listeningSessions, 1, "연타 끝에 정확히 하나여야 한다");
  assert.ok(s.ignored.some((x) => x.startsWith("start_ignored_in")), "두 번째 start 가 무시 기록을 남겨야 한다");

  // 재연결 — VO-09 의 나머지 절반. **이 단언이 없어서 변이가 살아남았고, 그 변이가
  // 실제로는 "재연결이 모델링되어 있지 않다" 는 제품 구멍을 드러냈다.** 처음 작성본에는
  // `transport_dropped` 이벤트가 아예 없었고, 그래서 전송이 흔들렸을 때 갈 곳이
  // `error`(세션 사망) 뿐이었다. 지금은 복구 가능한 끊김이 같은 세션으로 돌아온다.
  {
    let r = runVoiceEvents(open);
    for (let i = 0; i < 30; i++) {
      r = voiceTransition(r, { type: "transport_dropped" });
      assert.equal(r.state, "connecting", `재연결 ${i}회: 끊김이 connecting 으로 가지 않았다`);
      assert.equal(r.captureOpen, false, `재연결 ${i}회: 끊긴 동안 캡처를 쥐고 있다`);
      assert.equal(r.playbackQueued, false, `재연결 ${i}회: 끊긴 구간의 재생이 큐에 남았다`);
      assert.equal(r.listeningSessions, 1, `재연결 ${i}회: 세션 슬롯이 ${r.listeningSessions}개 — 끊김에서 반납하면 재연결이 새 세션으로 집계된다`);

      r = voiceTransition(r, { type: "transport_ready" });
      assert.equal(r.state, "listening", `재연결 ${i}회: 복구되지 않았다`);
      assert.equal(
        r.listeningSessions, 1,
        `재연결 ${i}회에서 세션이 ${r.listeningSessions}개다 — transport_ready 가 대입이 아니라 증가다`,
      );
      assertVoiceInvariants(r);
    }
    // 음성 대조군 — 끊김은 죽은 세션에서는 의미가 없다.
    const deadDrop = voiceTransition(runVoiceEvents([{ type: "close", reason: "user_stop" }, { type: "release_done" }], r), {
      type: "transport_dropped",
    });
    assert.equal(deadDrop.state, "closed", "닫힌 세션이 끊김으로 되살아났다");
    assert.ok(deadDrop.ignored.includes("transport_dropped_in_closed"));
  }

  // 종료 중 응답 도착 — 재생이 되살아나면 안 된다.
  const closing = voiceTransition(runVoiceEvents([...open, { type: "user_speech_end" }, { type: "response_playback_start" }]), {
    type: "close", reason: "window_closed",
  });
  assert.equal(closing.playbackQueued, false, "종료 중인데 재생 큐가 남아 있다");
  const late = voiceTransition(closing, { type: "response_playback_start" });
  assert.equal(late.playbackQueued, false, "종료 중 도착한 재생이 큐를 되살렸다");
  assert.equal(late.state, "closing", "늦게 온 재생이 상태를 되돌렸다");

  // 통과 대조군 — 닫힌 뒤 **새 start** 는 정상적으로 새 세션을 연다. 이게 없으면
  // 위 단언들은 "start 를 영구히 막는" 구현도 통과시킨다.
  const reopened = runVoiceEvents(open, voiceTransition(closing, { type: "release_done" }));
  assert.equal(reopened.state, "listening", "닫은 뒤 다시 시작할 수 없다");
  assert.equal(reopened.listeningSessions, 1);
}

// ─── §4 VO-09 종료·오류 뒤 남는 자원이 없다 ─────────────────────────────────
{
  for (const reason of ["user_stop", "window_closed", "app_quit", "permission_revoked", "transport_lost"]) {
    const live = runVoiceEvents([...open, { type: "user_speech_end" }, { type: "response_playback_start" }]);
    // 살아 있을 때는 해제할 것이 **있어야** 한다 — 양성 대조군. 없으면 아래 빈 목록이
    // "releasePlan 이 항상 빈 배열을 돌려준다" 와 구별되지 않는다.
    const before = releasePlan(live);
    assert.deepEqual(
      before.slice().sort(),
      ["capture_tracks", "playback_queue", "session_slot", "transport"],
      `살아 있는 세션의 해제 목록이 네 개여야 한다: ${before.join(",")}`,
    );

    const closed = runVoiceEvents([{ type: "close", reason }, { type: "release_done" }], live);
    assert.equal(closed.state, "closed");
    assert.equal(closed.closeReason, reason, "종료 사유가 보존되지 않았다");
    assert.deepEqual(releasePlan(closed), [], `${reason}: 종료 뒤 남은 자원이 있다`);
    assertVoiceInvariants(closed);
  }

  // 오류도 같다 — 오류 경로가 자원을 남기는 것이 가장 흔한 누수다.
  const failed = voiceTransition(runVoiceEvents([...open, { type: "user_speech_end" }, { type: "response_playback_start" }]), {
    type: "fail", code: "transport_reset",
  });
  assert.equal(failed.state, "error");
  assert.equal(failed.errorCode, "transport_reset", "오류 코드가 보존되지 않았다");
  assert.deepEqual(releasePlan(failed), [], "오류 뒤 남은 자원이 있다");
  assertVoiceInvariants(failed);
}

// ─── §5 불변식 자체가 잡아내는가 (계측기 검증) ──────────────────────────────
// 불변식이 항상 통과하는 고장이면 §1·§3·§4 가 전부 공짜로 통과한다.
{
  const good = runVoiceEvents(open);
  assertVoiceInvariants(good); // 양성 대조군: 정상 상태는 통과

  const broken = [
    [{ ...good, state: "idle", captureOpen: true }, "idle_with_capture_open"],
    [{ ...good, state: "muted", captureOpen: true }, "muted_with_capture_open"],
    [{ ...good, state: "closed", captureOpen: true }, "closed_with_capture_open"],
    [{ ...good, state: "closed", captureOpen: false, playbackQueued: true }, "closed_with_playback_queued"],
    [{ ...good, listeningSessions: 2 }, "2_concurrent_listening_sessions"],
    [{ ...good, listeningSessions: -1 }, "negative_listening_sessions"],
    [{ ...good, state: "idle", captureOpen: false, listeningSessions: 3 }, "idle_with_session_slot"],
  ];
  for (const [bad, token] of broken) {
    assert.throws(() => assertVoiceInvariants(bad), VoiceInvariantError, `불변식이 ${token} 를 놓쳤다`);
    try {
      assertVoiceInvariants(bad);
    } catch (err) {
      assert.ok(err.violations.some((v) => v.includes(token.split("_")[0])), `위반 사유에 단서가 없다: ${err.violations}`);
    }
  }
}

// ─── §6 VO-07 들은 범위 네 갈래 ─────────────────────────────────────────────
const RESP = {
  id: "r1",
  text: "먼저 버튼 색을 바꾸고, 그다음 글자 크기를 키울게요.",
  playedMs: 0,
  totalMs: 4000,
  marks: null,
  playbackStarted: false,
};
{
  // (a) 재생 시작 전 취소 — 한 글자도 안 들렸다
  const none = heardExtent({ ...RESP, playbackStarted: false, playedMs: 0 });
  assert.deepEqual(none, { kind: "none" });
  const ctxNone = followUpContext({ ...RESP }, none);
  assert.equal(ctxNone.heardText, "", "듣지 않은 응답이 들은 것으로 기록됐다");
  assert.equal(ctxNone.unheardText, RESP.text);
  assert.equal(ctxNone.uncertain, false, "안 들린 것은 불확실이 아니다 — 확실히 안 들렸다");
  assert.equal(ctxNone.discardPlaybackFor, "r1", "취소된 응답 id 를 알려주지 않으면 큐를 비울 수 없다");

  // (b) 끝까지 들었다
  const all = heardExtent({ ...RESP, playbackStarted: true, playedMs: 4000 });
  assert.deepEqual(all, { kind: "all" });
  assert.equal(followUpContext(RESP, all).heardText, RESP.text);
  assert.equal(followUpContext(RESP, all).unheardText, "");

  // (c) 재생 중 취소 + 타임마크 있음 → 글자 경계까지 안다
  const marks = [{ atMs: 0, charIndex: 0 }, { atMs: 1000, charIndex: 12 }, { atMs: 2500, charIndex: 24 }];
  const partial = heardExtent({ ...RESP, playbackStarted: true, playedMs: 1500, marks });
  assert.equal(partial.kind, "partial");
  assert.equal(partial.throughCharIndex, 12, "1500ms 면 1000ms 마크까지다 — 2500ms 마크를 당겨쓰면 안 된다");
  const ctxPartial = followUpContext(RESP, partial);
  assert.equal(ctxPartial.heardText, RESP.text.slice(0, 12));
  assert.equal(ctxPartial.unheardText, RESP.text.slice(12));
  assert.equal(ctxPartial.uncertain, false);
  // 들은 것 + 안 들은 것 = 전문. 조각이 사라지거나 겹치면 안 된다.
  assert.equal(ctxPartial.heardText + ctxPartial.unheardText, RESP.text, "들은/안 들은 조각이 전문과 다르다");

  // (d) 재생 중 취소 + 타임마크 없음 → 경과는 알지만 **문장을 추정하지 않는다**
  const noMarks = heardExtent({ ...RESP, playbackStarted: true, playedMs: 1500, marks: null });
  assert.equal(noMarks.kind, "partial");
  assert.equal(noMarks.throughCharIndex, null, "타임마크가 없는데 글자 위치를 만들어냈다");
  const ctxNoMarks = followUpContext(RESP, noMarks);
  assert.equal(ctxNoMarks.uncertain, true, "글자 경계를 모르는데 확실하다고 적었다");
  assert.equal(ctxNoMarks.heardText, "", "추정한 문장을 들은 것으로 적었다");
  assert.equal(ctxNoMarks.unheardText, "", "추정한 문장을 안 들은 것으로도 적지 않는다");
  assert.match(ctxNoMarks.note, /추정하지 않는다/, "무엇을 하지 않았는지 기록에 남아야 한다");

  // (e) **음성 대조군** — 재생기가 경과조차 주지 않으면 `unknown`.
  // 이것이 이 절의 핵심이다: 모르는 것을 "다 들었다" 나 "못 들었다" 로 접으면
  // 다음 턴이 거짓 전제로 돈다 (V0 의 attempted:false → unknown 과 같은 규칙).
  for (const badPos of [NaN, -1, Infinity]) {
    const unknown = heardExtent({ ...RESP, playbackStarted: true, playedMs: badPos });
    assert.equal(unknown.kind, "unknown", `playedMs=${badPos} 를 분류해버렸다`);
    const ctx = followUpContext(RESP, unknown);
    assert.equal(ctx.uncertain, true);
    assert.equal(ctx.heardText, "", "모르는데 들었다고 적었다");
    assert.equal(ctx.unheardText, "", "모르는데 못 들었다고 적었다");
    assert.match(ctx.note, /알 수 없다/);
    assert.notEqual(ctx.heardText, RESP.text, "모르는 것을 전부 들었다로 접었다");
  }

  // (f) 네 갈래가 실제로 **다른** 결과를 낸다 — 분류기가 상수가 아니라는 증거
  const kinds = new Set([none.kind, all.kind, partial.kind, heardExtent({ ...RESP, playbackStarted: true, playedMs: NaN }).kind]);
  assert.deepEqual([...kinds].sort(), ["all", "none", "partial", "unknown"]);
}

// ─── §7 VO-07 타임마크가 거짓이면 분류하지 않고 거부한다 ────────────────────
// 정렬되지 않은 마크를 그대로 쓰면 `charIndexAt` 이 엉뚱한 위치를 돌려주고, 그 값이
// 문맥으로 들어간다. 모순된 관측은 분류하지 않는다(V0 의 VoiceProbeMalformedError 와
// 같은 규칙).
{
  const disordered = [{ atMs: 0, charIndex: 0 }, { atMs: 2500, charIndex: 24 }, { atMs: 1000, charIndex: 12 }];
  assert.throws(
    () => heardExtent({ ...RESP, playbackStarted: true, playedMs: 1500, marks: disordered }),
    VoiceMarksDisorderedError,
    "정렬되지 않은 타임마크를 그대로 썼다",
  );
  // 통과 대조군 — 정렬된 마크는 거부되지 않는다.
  assert.doesNotThrow(() =>
    heardExtent({ ...RESP, playbackStarted: true, playedMs: 1500, marks: [{ atMs: 0, charIndex: 0 }, { atMs: 1000, charIndex: 12 }] }),
  );
}

// ─── §8 VO-07 끼어들기가 상태와 맞물린다 ────────────────────────────────────
{
  const speaking = runVoiceEvents([...open, { type: "user_speech_end" }, { type: "response_playback_start" }]);
  const afterInterrupt = voiceTransition(speaking, { type: "interrupt" });
  assert.equal(afterInterrupt.state, "listening", "끼어들기 뒤 다시 들어야 한다");
  assert.equal(afterInterrupt.playbackQueued, false, "끼어들기가 재생 큐를 비우지 않았다");

  // 재생 시작 **직전**(preparing) 끼어들기 — 들은 양 0인 경우. 이게 빠지면
  // 아직 한 글자도 안 들린 응답이 "들었다" 로 기록된다.
  const preparing = runVoiceEvents([...open, { type: "user_speech_end" }]);
  const interruptedEarly = voiceTransition(preparing, { type: "interrupt" });
  assert.equal(interruptedEarly.state, "listening", "재생 직전 끼어들기가 무시됐다");
  assert.equal(interruptedEarly.ignored.length, 0, "재생 직전 끼어들기는 유효해야 한다");

  // 연속 끼어들기 — 취소된 잔여가 되살아나지 않는다.
  let s = speaking;
  for (let i = 0; i < 5; i++) {
    s = voiceTransition(s, { type: "interrupt" });
    assert.equal(s.playbackQueued, false, `연속 끼어들기 ${i}회에서 재생이 되살아났다`);
  }
  // 늦게 도착한 재생 종료가 상태를 흔들지 않는다.
  const lateEnd = voiceTransition(s, { type: "response_playback_end" });
  assert.equal(lateEnd.state, "listening");
  assert.ok(lateEnd.ignored.some((x) => x.startsWith("playback_end_in")), "늦은 재생 종료가 기록되지 않았다");

  // 음성 대조군 — 듣는 중에는 끼어들 대상이 없다. 무시되어야 한다.
  const nothingToInterrupt = voiceTransition(runVoiceEvents(open), { type: "interrupt" });
  assert.equal(nothingToInterrupt.state, "listening");
  assert.ok(nothingToInterrupt.ignored.includes("interrupt_in_listening"));
}

// ─── §9 VO-08 말끝 판단 정책 (임계값은 합의 전) ─────────────────────────────
{
  const cfg = PROVISIONAL_ENDPOINTING;
  const obs = (o) => ({ silenceMs: 0, speechMs: 1000, peakDb: -20, playbackActive: false, ...o });

  // 양성 대조군 — 충분히 말한 뒤 충분히 조용하면 끝낸다.
  assert.deepEqual(shouldEndTurn(obs({ silenceMs: cfg.silenceMs })), { end: true, reason: "silence_after_speech" });

  // 짧은 쉼은 끝이 아니다 — 한국어 문장 중 쉼을 턴으로 끊으면 말이 반복 차단된다.
  assert.equal(shouldEndTurn(obs({ silenceMs: cfg.silenceMs - 1 })).end, false);
  assert.equal(shouldEndTurn(obs({ silenceMs: cfg.silenceMs - 1 })).reason, "pause_too_short");

  // 잡음 바닥 이하는 발화가 아니다 — **먼저** 본다. 순서가 뒤바뀌면 조용한 방의
  // 배경 소음이 speechMs 를 쌓아 계속 턴을 만든다.
  assert.equal(shouldEndTurn(obs({ peakDb: cfg.noiseFloorDb, silenceMs: 9999 })).reason, "below_noise_floor");
  assert.equal(shouldEndTurn(obs({ peakDb: cfg.noiseFloorDb - 10, silenceMs: 9999 })).reason, "below_noise_floor");

  // 기침·짧은 잡음은 턴이 아니다.
  assert.equal(shouldEndTurn(obs({ speechMs: cfg.minSpeechMs - 1, silenceMs: 9999 })).reason, "speech_too_short");

  // 재생 중 입력은 에코일 수 있다 — 끝내지 않고 미룬다. 이게 없으면 AI 자기 목소리가
  // 사용자 발화로 들어간다.
  assert.equal(shouldEndTurn(obs({ playbackActive: true, silenceMs: 9999 })).reason, "still_speaking");

  // 판정이 상수가 아님을 출력 집합으로 박아둔다.
  const reasons = new Set([
    shouldEndTurn(obs({ silenceMs: cfg.silenceMs })).reason,
    shouldEndTurn(obs({ silenceMs: 0 })).reason,
    shouldEndTurn(obs({ peakDb: -99 })).reason,
    shouldEndTurn(obs({ speechMs: 0, silenceMs: 9999 })).reason,
    shouldEndTurn(obs({ playbackActive: true })).reason,
  ]);
  assert.equal(reasons.size, 5, `다섯 사유가 모두 나와야 한다: ${[...reasons].join(",")}`);

  // 임계값은 주입 가능하고, 주입이 **실제로 판정을 바꾼다**. 하드코딩이면 실기 튜닝이 불가능하다.
  const strict = { ...cfg, silenceMs: 2000 };
  assert.equal(shouldEndTurn(obs({ silenceMs: 1000 }), cfg).end, true);
  assert.equal(shouldEndTurn(obs({ silenceMs: 1000 }), strict).end, false, "임계값 주입이 판정을 바꾸지 않는다");
}

// ─── §10 임계값이 합의 전임이 남아 있는가 ───────────────────────────────────
// 주석으로만 적으면 다음 사람이 그대로 기본값으로 배포하고 그게 계약처럼 굳는다.
{
  assert.equal(PROVISIONAL_ENDPOINTING.provisional, true, "임계값이 합의 전임을 표시하는 칸이 사라졌다");
  const src = readFileSync(join(here, "..", "src", "voiceSessionHelpers.ts"), "utf8");
  assert.match(src, /운영 기본값도 합의된 SLA도 아니다/, "합의 전임을 알리는 문구가 사라졌다");
  assert.match(src, /VO-T08/, "어느 시험이 이 값을 고쳐야 하는지 적혀 있어야 한다");
}

// ─── §11 범위 락 — 이 슬라이스가 음성 기능을 켜지 않았는가 ──────────────────
// V1 은 결정 계층만이다. 마이크를 여는 코드나 CSP 변경이 슬그머니 따라 들어오는
// 것을 막는다. #898 이 "합성 세션으로 개발 가능" 이라고 한 범위를 지킨다.
{
  const src = readFileSync(join(here, "..", "src", "voiceSessionHelpers.ts"), "utf8");
  // 순수성: vscode 도 DOM 도 import 하지 않는다.
  assert.doesNotMatch(src, /^import .*from ["']vscode["']/m, "결정 계층이 vscode 를 import 한다");
  assert.doesNotMatch(src, /\bdocument\.|\bwindow\.|navigator\./, "결정 계층이 DOM 을 만진다");
  // 기기를 여는 호출이 없다.
  for (const forbidden of [/getUserMedia/, /mediaDevices/, /MediaRecorder/, /AudioContext/, /audioWorklet/]) {
    assert.doesNotMatch(src, forbidden, `결정 계층에 ${forbidden} 가 들어왔다`);
  }
  // 탐침 양성 대조군 — 같은 탐침이 **있는 곳에서는 찾아낸다**. 없으면 위 단언들은
  // "정규식이 고장났는지" 와 구별되지 않는다.
  const probe = readFileSync(join(here, "..", "webview-ui", "src", "voiceProbe.ts"), "utf8");
  assert.match(probe, /getUserMedia/, "탐침이 고장났다 — voiceProbe.ts 에서도 못 찾는다");
  assert.match(probe, /mediaDevices/, "탐침이 고장났다");

  // 채팅 패널 CSP 를 건드리지 않았다 (REQ-R2 ④ 와 같은 락).
  const { buildChatPanelCsp } = await import("../src/cspBuilder.ts");
  const csp = buildChatPanelCsp({ cspSource: "vscode-webview://v1", nonce: "n" });
  assert.doesNotMatch(csp, /media-src|microphone|blob:/, "V1 이 채팅 패널 CSP 를 열었다");

  // 매니페스트에 음성 명령·설정이 새로 생기지 않았다.
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  const cmds = (pkg.contributes?.commands ?? []).map((c) => c.command);
  assert.deepEqual(
    cmds.filter((c) => /voice|Voice/.test(c)),
    ["hypeproof-chat.diagnoseVoiceCapability"],
    "V1 이 새 음성 명령을 추가했다 — 학생에게 보이는 표면은 이 슬라이스 범위가 아니다",
  );
  const conf = JSON.stringify(pkg.contributes?.configuration ?? {});
  assert.doesNotMatch(conf, /voice|Voice|audio|mic[A-Z]/, "V1 이 음성 설정을 추가했다 (기본값 논쟁이 먼저다)");
}

console.log("voice-session smoke OK — 결정 계층만, 기기 코드 아님 (VO-T06~T10 은 NOT RUN)");
