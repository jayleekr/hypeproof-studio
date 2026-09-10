// #939 (VO-36 · VO-38 · VO-40 ~ VO-47) — 음성 팝업 **표현 결정 계층**의 대조군 포함 스모크.
//
// 주장하지 않는 것부터: 음성이 동작한다는 주장이 아니다. 마이크·전송 코드는 아직
// 제품에 없고(REQ-R1), 여기 있는 것은 전부 순수 함수와 합성 입력이다.
// VO-T36~T47 은 **NOT RUN** 이며 이 파일은 그 상태를 바꾸지 않는다.
//
// 무엇을 잠그나:
//   1. 시작 게이트가 여덟 갈래를 **구분**한다 — "안 됨" 과 "아직 안 쟀음" 을 포함 (VO-36)
//   2. 연타가 시작 요청을 둘로 만들지 않는다 (VO-36)
//   3. 파형은 **관측된 오디오**에만 붙는다 — 연결 실패·무음·생성만 끝난 상태는 정지 (VO-38)
//   4. 축소는 세션을 건드리지 않고, 컨트롤이 사라지면 멈추고, 자동 재개는 없다 (VO-40)
//   5. 일시중지가 사용자의 음소거 의도를 지우지 않는다 (VO-40)
//   6. 종료 네 갈래가 같은 해제로 수렴하고 부분 전사를 자동 전송하지 않는다 (VO-41)
//   7. 팝업을 여는 것만으로 화면 캡처/전체 파일 공유가 없다 (VO-43)
//   8. 발화만으로 승인되지 않는다 (VO-44)
//   9. 이름·모델·effort 를 임의로 지어내지 않는다 (VO-45)
//  10. 확정 잔량과 예상을 섞지 않고, 자동 개인 결제가 없다 (VO-46)
//
// 계측기 규율(.claude/rules/verification.md 규칙 2): 모든 거절 단언에 **통과
// 대조군**을 붙인다. 붙이지 않으면 "전부 막음 / 전부 정지" 구현이 아래를 다 통과한다.
//
// 계약 본문: docs/studio-requirements.md 의 REQ-R6.
//
// Run: node --experimental-strip-types test/voice-popup.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const {
  voiceStartGate,
  coalesceStartRequest,
  openingPromptDecision,
  OPENING_PROMPT_TEXT,
  meterView,
  statusAnnouncement,
  initialPopupState,
  popupTransition,
  runPopupEvents,
  assertPopupInvariants,
  PopupInvariantError,
  COMPACT_CONTROLS,
  dismissPlan,
  sharedContextOnOpen,
  targetGuard,
  approvalOutcome,
  APPROVAL_PAUSE_EVENT,
  voicePanelTitle,
  sessionInfoLines,
  modelChangePlan,
  effortForVoice,
  budgetView,
  limitReachedPlan,
  applyInstructorOverrides,
  failureView,
} = await import("../src/voicePopupHelpers.ts");

const { initialVoiceSession, voiceTransition, runVoiceEvents, assertVoiceInvariants } =
  await import("../src/voiceSessionHelpers.ts");

const OK_CAPABILITY = { input: "allowed", output: "full" };
const VOICE_MODEL = { alias: "말하기", id: "voice-1", provider: "openai", supportsVoice: true, supportedEffort: ["low", "medium"] };
const FREE_BUDGET = budgetView({ source: "lesson_included", remaining: { text: "약 12분", certainty: "estimated" } });

const startInputs = (over = {}) => ({
  capability: OK_CAPABILITY,
  voiceModel: VOICE_MODEL,
  entitlement: "allowed",
  budget: FREE_BUDGET,
  sessionState: "idle",
  ...over,
});

// ─── §0 계측기부터 검증한다 ─────────────────────────────────────────────────
// 아래 단언의 대부분은 "막힌다 / 안 움직인다" 형태다. 게이트가 전부 막고 미터가
// 전부 정지인 고장이면 그 전부가 조용히 통과한다. 그래서 **정상 경로가 실제로
// 열리고 실제로 움직이는지** 먼저 증명한다 (규칙 2 의 양성 대조군).
{
  const gate = voiceStartGate(startInputs());
  assert.equal(gate.enabled, true, "정상 입력에서 시작이 막힌다 — 게이트가 죽어 있다");
  assert.equal(gate.block, null);
  assert.equal(gate.accessibleName, "음성 대화 시작");
  assert.ok(!/받아쓰기|dictation/i.test(gate.accessibleName), "시작 버튼 이름이 받아쓰기와 섞인다 (VO-36)");

  const listening = runVoiceEvents([{ type: "start" }, { type: "transport_ready" }]);
  const live = meterView(listening, { inputLevel: 0.6, outputPlaying: false, outputLevel: null });
  assert.equal(live.source, "input_level", "듣는 중 실제 입력이 있는데 미터가 붙지 않는다 — 미터가 죽어 있다");
  assert.equal(live.animated, true);
  assert.equal(live.level, 0.6);
}

// ─── §1 VO-36 시작 게이트: 여덟 갈래가 구분된다 ────────────────────────────
{
  const cases = [
    [startInputs({ entitlement: "not_allowed" }), "not_entitled"],
    [startInputs({ entitlement: "unknown" }), "entitlement_unknown"],
    [startInputs({ capability: null }), "capability_unmeasured"],
    [startInputs({ capability: { input: "unknown", output: "full" } }), "capability_unmeasured"],
    [startInputs({ capability: { input: "blocked", output: "full" } }), "input_blocked"],
    [startInputs({ capability: { input: "allowed", output: "blocked" } }), "output_blocked"],
    [startInputs({ voiceModel: null }), "no_voice_model"],
    [startInputs({ voiceModel: { ...VOICE_MODEL, supportsVoice: false } }), "no_voice_model"],
    [startInputs({ budget: budgetView({ source: "lesson_included", limitReached: true }) }), "budget_exhausted"],
    [startInputs({ sessionState: "listening" }), "session_active"],
  ];
  const seenHints = new Set();
  for (const [input, expected] of cases) {
    const gate = voiceStartGate(input);
    assert.equal(gate.enabled, false, `${expected} 인데 시작이 열린다`);
    assert.equal(gate.block, expected);
    seenHints.add(gate.hint);
  }
  // **핵심 구분**: 재서 막힌 것과 아직 재지 않은 것이 같은 문구면 REQ-R1 이 만든
  // 구분을 화면에서 다시 뭉갠 것이다.
  assert.notEqual(
    voiceStartGate(startInputs({ capability: null })).hint,
    voiceStartGate(startInputs({ capability: { input: "blocked", output: "full" } })).hint,
    "'아직 안 쟀음' 과 '재서 막힘' 이 같은 문구다 (REQ-R1 ③ 과 같은 결함)",
  );
  // 10개 fixture 중 같은 block 으로 묶이는 쌍이 둘(capability_unmeasured, no_voice_model)이므로 문구는 8개다.
  assert.equal(seenHints.size, 8, "막힘 사유들이 같은 문구로 접혔다");

  // 텍스트 대안 안내: 이미 대화 중(session_active)은 대안이 필요 없다.
  assert.equal(voiceStartGate(startInputs({ capability: null })).offersTextFallback, true);
  assert.equal(voiceStartGate(startInputs({ sessionState: "listening" })).offersTextFallback, false);
  assert.equal(voiceStartGate(startInputs()).offersTextFallback, false, "열려 있는데 대안 안내가 뜬다");
}

// ─── §2 VO-36 연타 ─────────────────────────────────────────────────────────
{
  const first = coalesceStartRequest(null, "req-1");
  assert.deepEqual(first, { requestId: "req-1", started: true });
  const second = coalesceStartRequest(first.requestId, "req-2");
  assert.equal(second.requestId, "req-1", "연타가 새 시작 요청을 만든다 (VO-36)");
  assert.equal(second.started, false);

  // 세션 계층도 같은 것을 지킨다 — 두 층 중 하나만 지키면 다른 경로로 샌다.
  const doubled = runVoiceEvents([{ type: "start" }, { type: "start" }, { type: "transport_ready" }]);
  assert.equal(doubled.listeningSessions, 1);
  assertVoiceInvariants(doubled);
}

// ─── §3 VO-38 미터: 관측 없으면 움직이지 않는다 ─────────────────────────────
{
  const listening = runVoiceEvents([{ type: "start" }, { type: "transport_ready" }]);
  const speaking = runVoiceEvents([
    { type: "start" }, { type: "transport_ready" }, { type: "user_speech_end" }, { type: "response_playback_start" },
  ]);
  const connecting = runVoiceEvents([{ type: "start" }]);
  const preparing = runVoiceEvents([{ type: "start" }, { type: "transport_ready" }, { type: "user_speech_end" }]);
  const muted = runVoiceEvents([{ type: "start" }, { type: "transport_ready" }, { type: "mute" }]);

  // 음성 대조군 1 — 연결 중에는 입력 반응이 없다. 진행 표시는 **따로** 있다.
  const c = meterView(connecting, { inputLevel: 0.9, outputPlaying: true, outputLevel: 0.9 });
  assert.equal(c.source, null, "연결 중인데 파형이 붙는다 (VO-38: 가짜 듣기 움직임)");
  assert.equal(c.animated, false);
  assert.equal(c.progress, true, "연결 중 진행 표시가 없다 — 입력 반응과 구별할 것이 사라진다");

  // 음성 대조군 2 — 응답 준비는 재생이 아니다.
  const p = meterView(preparing, { inputLevel: 0.8, outputPlaying: true, outputLevel: 0.8 });
  assert.equal(p.source, null, "응답 준비 중인데 파형이 붙는다");
  assert.equal(p.progress, true);
  assert.notEqual(p.statusText, meterView(speaking, null).statusText, "'답변 준비' 와 '말하는 중' 이 같은 문구다");

  // 음성 대조군 3 — 생성은 끝났지만 **재생 중이 아니다**.
  const generatedNotPlaying = meterView(speaking, { inputLevel: null, outputPlaying: false, outputLevel: 0.9 });
  assert.equal(generatedNotPlaying.source, null, "재생 중이 아닌데 출력 파형이 반응한다 (VO-38)");
  assert.equal(generatedNotPlaying.animated, false);

  // 음성 대조군 4 — 무음/미보고는 0 이 아니라 null 이다.
  const silent = meterView(listening, { inputLevel: null, outputPlaying: false, outputLevel: null });
  assert.equal(silent.level, null, "미보고를 0 으로 접으면 '무음' 과 '측정 안 됨' 이 같아진다");
  assert.equal(silent.animated, false);

  // 음성 대조군 5 — 음소거는 정지한다. 관측이 들어와도 마찬가지다.
  const m = meterView(muted, { inputLevel: 0.7, outputPlaying: false, outputLevel: null });
  assert.equal(m.source, null, "음소거인데 파형이 움직인다");
  assert.equal(m.statusName, "마이크 꺼짐");

  // 양성 대조군 — 실제 재생 중이면 출력 파형이 붙는다.
  const playing = meterView(speaking, { inputLevel: null, outputPlaying: true, outputLevel: 0.4 });
  assert.equal(playing.source, "output_level");
  assert.equal(playing.level, 0.4);

  // 모션 감소: 움직임만 끄고 **상태 구분은 유지**한다 (VO-47).
  const reduced = meterView(listening, { inputLevel: 0.5, outputPlaying: false, outputLevel: null }, { reduceMotion: true });
  assert.equal(reduced.animated, false);
  assert.equal(reduced.source, "input_level", "모션 감소가 상태 자체를 지운다");
  assert.equal(reduced.statusName, "듣는 중");

  // 상태 이름이 서로 다르다 — 색·모션 없이도 구분 가능해야 한다 (VO-38/47).
  const names = new Set(["idle", "connecting", "listening", "preparing", "speaking", "muted", "closing", "closed", "error"]
    .map(state => meterView({ state, captureOpen: false, muteRequested: false }, null).statusName));
  assert.equal(names.size, 9, "상태 이름이 접혔다 — 텍스트만으로 구분할 수 없다");

  // 안내는 상태가 바뀔 때만. 음량 tick 마다 읽지 않는다 (VO-47).
  assert.equal(statusAnnouncement("listening", "listening"), null, "같은 상태에서 다시 안내한다");
  assert.equal(statusAnnouncement("listening", "speaking"), "말하는 중");
}

// ─── §4 VO-40 축소·일시중지·명시 재개 ───────────────────────────────────────
{
  // 축소/펼치기는 **세션을 건드리지 않는다**.
  const minimized = runPopupEvents([{ type: "open" }, { type: "minimize" }]);
  assert.equal(minimized.state.presentation, "compact");
  assert.deepEqual(minimized.voiceEvents, [], "축소가 세션 이벤트를 낸다 (VO-40: 같은 세션 유지)");
  const expanded = runPopupEvents([{ type: "open" }, { type: "minimize" }, { type: "expand" }]);
  assert.equal(expanded.state.presentation, "expanded");
  assert.deepEqual(expanded.voiceEvents, []);

  // 작은 컨트롤은 세 조작을 **항상** 제공한다.
  assert.deepEqual([...COMPACT_CONTROLS], ["mute", "stop", "expand"]);

  // 컨트롤이 사라지면 멈춘다 — 그리고 조건이 풀려도 **자동 재개하지 않는다**.
  const hidden = runPopupEvents([{ type: "open" }, { type: "pause", reason: "controls_hidden" }]);
  assert.equal(hidden.state.paused, true);
  assert.deepEqual(hidden.voiceEvents, [{ type: "mute" }], "멈춤이 캡처를 실제로 닫지 않는다");

  const back = popupTransition(hidden.state, { type: "unpause", reason: "controls_hidden" });
  assert.equal(back.state.paused, true, "조건이 풀리자 자동으로 재개됐다 (VO-40 위반)");
  assert.equal(back.state.awaitingResume, true);
  assert.deepEqual(back.voiceEvents, [], "자동 재개가 캡처를 다시 열었다");

  const resumed = popupTransition(back.state, { type: "resume_requested" });
  assert.equal(resumed.state.paused, false);
  assert.deepEqual(resumed.voiceEvents, [{ type: "unmute" }]);

  // 멈춤 이유가 둘이면 하나가 풀려도 계속 멈춰 있다.
  const two = runPopupEvents([
    { type: "open" }, { type: "pause", reason: "app_inactive" }, { type: "pause", reason: "system_sleep" },
  ]);
  assert.equal(two.voiceEvents.length, 1, "이미 멈춰 있는데 mute 를 또 보낸다");
  const one = popupTransition(two.state, { type: "unpause", reason: "system_sleep" });
  assert.equal(one.state.awaitingResume, false);
  assert.equal(popupTransition(one.state, { type: "resume_requested" }).ignored, "resume_blocked_by_app_inactive");
}

// ─── §5 VO-40 일시중지가 음소거 의도를 지우지 않는다 ────────────────────────
{
  // 사용자가 스스로 음소거 → 화면이 가려짐 → 돌아옴 → 명시 재개.
  // **음소거는 유지되어야 한다.** 여기가 이 층에서 가장 틀리기 쉬운 곳이다:
  // 멈춤과 음소거를 같은 플래그로 두면 재개가 사용자의 음소거를 풀어 버린다.
  const seq = runPopupEvents([
    { type: "open" },
    { type: "user_mute" },
    { type: "pause", reason: "controls_hidden" },
    { type: "unpause", reason: "controls_hidden" },
    { type: "resume_requested" },
  ]);
  assert.equal(seq.state.userMuteIntent, true);
  assert.deepEqual(seq.voiceEvents, [{ type: "mute" }], "일시중지·재개가 사용자의 음소거를 풀었다 (VO-40)");

  // 양성 대조군 — 음소거하지 않았다면 같은 순서가 실제로 재개된다.
  const notMuted = runPopupEvents([
    { type: "open" },
    { type: "pause", reason: "controls_hidden" },
    { type: "unpause", reason: "controls_hidden" },
    { type: "resume_requested" },
  ]);
  assert.deepEqual(notMuted.voiceEvents, [{ type: "mute" }, { type: "unmute" }]);

  // 멈춘 동안의 음소거 해제는 **의도만** 지운다 — 여기서 캡처를 열면 보이지 않는 청취다.
  const unmutedWhilePaused = runPopupEvents([
    { type: "open" }, { type: "user_mute" }, { type: "pause", reason: "app_inactive" }, { type: "user_unmute" },
  ]);
  assert.equal(unmutedWhilePaused.state.userMuteIntent, false);
  assert.deepEqual(unmutedWhilePaused.voiceEvents, [{ type: "mute" }], "멈춘 동안 해제가 캡처를 열었다");
}

// ─── §6 팝업 불변식: 안 보이는데 열린 마이크는 없다 ─────────────────────────
{
  const live = runVoiceEvents([{ type: "start" }, { type: "transport_ready" }]);
  assert.equal(live.captureOpen, true);
  assert.throws(
    () => assertPopupInvariants(initialPopupState(), live),
    PopupInvariantError,
    "숨긴 팝업 + 열린 캡처가 통과한다 (VO-40: 보이지 않는 청취)",
  );
  // 양성 대조군 — 실제 조합은 통과해야 한다. 아니면 '항상 던짐' 구현이 위를 통과한다.
  assertPopupInvariants(runPopupEvents([{ type: "open" }]).state, live);
  assertPopupInvariants(runPopupEvents([{ type: "open" }, { type: "minimize" }]).state, live);

  const paused = runPopupEvents([{ type: "open" }, { type: "pause", reason: "app_inactive" }]);
  const pausedSession = paused.voiceEvents.reduce(voiceTransition, live);
  assert.equal(pausedSession.captureOpen, false);
  assertPopupInvariants(paused.state, pausedSession);
}

// ─── §7 VO-44 승인: 말로 승인하지 않는다 ───────────────────────────────────
{
  for (const utterance of ["네", "네 좋아요", "응", "yes", "그렇게 해줘"]) {
    assert.equal(approvalOutcome({ uiChoice: null, utterance }), "pending", `발화 "${utterance}" 가 승인이 됐다 (VO-44)`);
  }
  // 양성 대조군 — 화면에서 누른 것은 실제로 승인된다.
  assert.equal(approvalOutcome({ uiChoice: "approved", utterance: null }), "approved");
  assert.equal(approvalOutcome({ uiChoice: "denied", utterance: "네" }), "denied", "발화가 화면 거부를 덮었다");

  // 승인 검토 중에는 큰 패널이 접히고 캡처·재생이 멈춘다.
  const review = runPopupEvents([{ type: "open" }, APPROVAL_PAUSE_EVENT]);
  assert.equal(review.state.presentation, "compact", "승인 대상을 큰 패널이 가린다 (VO-44)");
  assert.deepEqual(review.voiceEvents, [{ type: "mute" }]);
  assert.equal(popupTransition(review.state, { type: "expand" }).ignored, "expand_blocked_by_approval");

  // 승인이 끝나도 **자동 재개는 없다**.
  const afterApproval = popupTransition(review.state, { type: "unpause", reason: "approval_review" });
  assert.equal(afterApproval.state.paused, true);
  assert.equal(afterApproval.state.awaitingResume, true);
  assert.deepEqual(popupTransition(afterApproval.state, { type: "resume_requested" }).voiceEvents, [{ type: "unmute" }]);
}

// ─── §8 VO-41 종료 ─────────────────────────────────────────────────────────
{
  const kinds = ["stop_button", "panel_close", "escape", "switch_to_text", "window_closed", "app_quit", "permission_revoked"];
  for (const kind of kinds) {
    const plan = dismissPlan(kind);
    assert.equal(plan.voiceEvents.length, 1, `${kind} 이 종료 이벤트를 내지 않는다`);
    assert.equal(plan.voiceEvents[0].type, "close");
    assert.equal(plan.keepFinalTranscript, true);
    assert.equal(plan.autoSendPartial, false, `${kind} 이 미확정 전사를 자동 전송한다 (VO-41)`);
    assert.equal(plan.toolRunClaim, "unchanged", `${kind} 이 도구 작업 취소를 주장한다 (VO-39/41)`);

    // 실제 세션에 넣어 자원이 남지 않는지 확인한다 — 계획만 맞고 해제가 없으면 의미 없다.
    const live = runVoiceEvents([{ type: "start" }, { type: "transport_ready" }]);
    const closed = voiceTransition(plan.voiceEvents.reduce(voiceTransition, live), { type: "release_done" });
    assert.equal(closed.state, "closed");
    assert.equal(closed.captureOpen, false);
    assert.equal(closed.playbackQueued, false);
    assertVoiceInvariants(closed);
  }

  // 세 갈래(종료·X·Escape)는 **같은 종료**다.
  const same = kinds.slice(0, 3).map(k => JSON.stringify(dismissPlan(k).voiceEvents));
  assert.equal(new Set(same).size, 1, "종료·X·Escape 가 서로 다른 종료로 갈린다 (VO-41)");

  // 포커스: 텍스트 전환만 입력창으로, 나머지는 시작 버튼으로 돌아온다 (VO-47).
  assert.equal(dismissPlan("switch_to_text").focus, "composer");
  assert.equal(dismissPlan("switch_to_text").seedComposerWithPartial, true);
  assert.equal(dismissPlan("stop_button").focus, "voice_start_button");
  assert.equal(dismissPlan("stop_button").seedComposerWithPartial, false, "종료가 미확정 전사를 입력창에 남긴다");

  // 팝업 층도 닫힌다.
  assert.deepEqual(runPopupEvents([{ type: "open" }, { type: "dismissed" }]).state, initialPopupState());
}

// ─── §9 VO-43 문맥 ─────────────────────────────────────────────────────────
{
  const artifact = { artifactId: "a1", title: "발표자료", revision: "r3" };
  const shared = sharedContextOnOpen("conv-1", artifact);
  assert.equal(shared.screenCapture, false, "팝업을 여는 것만으로 화면을 캡처한다 (VO-43)");
  assert.equal(shared.allWorkspaceFiles, false, "팝업을 여는 것만으로 모든 파일을 보낸다 (VO-43)");
  assert.deepEqual(shared.selectedArtifact, artifact);
  assert.equal(sharedContextOnOpen("conv-1", null).selectedArtifact, null, "선택하지 않은 결과물을 지어낸다");

  assert.deepEqual(targetGuard(artifact, artifact), { action: "proceed" });
  assert.deepEqual(targetGuard(artifact, { ...artifact, artifactId: "a2" }), { action: "confirm", why: "target_changed" });
  assert.deepEqual(targetGuard(artifact, { ...artifact, revision: "r4" }), { action: "block", why: "revision_mismatch" });
  assert.deepEqual(targetGuard(artifact, { ...artifact, revision: null }), { action: "confirm", why: "target_ambiguous" });
  assert.deepEqual(targetGuard(null, artifact), { action: "confirm", why: "target_unknown" });
}

// ─── §10 VO-45 이름·모델·effort ────────────────────────────────────────────
{
  assert.equal(voicePanelTitle("별똥별"), "별똥별 · 음성 대화");
  assert.equal(voicePanelTitle("제작 파트너"), "제작 파트너 · 음성 대화");
  // 하드코딩된 '코치' 를 **새로** 만들지 않는다 — 이름이 오면 그 이름을 쓴다.
  assert.ok(!voicePanelTitle("별똥별").includes("코치"), "설정된 이름 옆에 '코치' 가 붙는다 (VO-45)");

  assert.deepEqual(modelChangePlan(VOICE_MODEL), { allowed: true, requiresReconnect: true });
  assert.equal(modelChangePlan({ ...VOICE_MODEL, supportsVoice: false }).allowed, false);
  assert.equal(modelChangePlan(VOICE_MODEL).requiresReconnect, true, "세션 중 모델을 갈아끼운다 (VO-45)");

  // effort 는 **실제 지원할 때만**. 임의 매핑 금지.
  assert.equal(effortForVoice(VOICE_MODEL, "medium"), "medium");
  assert.equal(effortForVoice(VOICE_MODEL, "high"), null, "지원하지 않는 effort 를 그대로 보낸다 (VO-45)");
  assert.equal(effortForVoice({ ...VOICE_MODEL, supportedEffort: undefined }, "low"), null);
  assert.equal(effortForVoice(null, "low"), null);

  const lines = sessionInfoLines(null, FREE_BUDGET);
  assert.equal(lines[0].certainty, "unknown", "모르는 모델을 아는 것처럼 적는다");
  assert.equal(sessionInfoLines(VOICE_MODEL, FREE_BUDGET)[0].certainty, "known");
}

// ─── §11 VO-46 이용량 ──────────────────────────────────────────────────────
{
  const estimated = budgetView({ source: "lesson_included", remaining: { text: "약 12분", certainty: "estimated" } });
  assert.equal(estimated.remaining.certainty, "estimated", "예측값을 확정으로 표시한다 (VO-46)");
  assert.equal(estimated.blocksNewPaidResponse, false);
  assert.equal(estimated.autoFallbackToPersonalPayment, false);
  assert.equal(limitReachedPlan(estimated, true), null, "한도에 닿지 않았는데 차단 안내가 뜬다");

  for (const over of [{ limitReached: true }, { entitlementRevoked: true }]) {
    const blocked = budgetView({ source: "instructor_assigned", ...over });
    const plan = limitReachedPlan(blocked, true);
    assert.equal(plan.blocksNewPaidResponse, true);
    assert.equal(plan.allowsStop, true, "한도 도달이 종료까지 막는다 (VO-46)");
    assert.equal(plan.allowsViewingArtifacts, true, "한도 도달이 결과 열람까지 막는다 (VO-46)");
    assert.equal(blocked.autoFallbackToPersonalPayment, false, "자동 개인 결제로 넘어간다 (VO-46)");
    assert.equal(voiceStartGate(startInputs({ budget: blocked })).block, "budget_exhausted");
  }

  // 자금원 세 갈래가 구분된다 — 별도 잔액 시스템을 만들지 않고 이름만 붙인다.
  const labels = new Set(["lesson_included", "instructor_assigned", "personal_subscription", "unknown"]
    .map(source => budgetView({ source }).sourceLabel));
  assert.equal(labels.size, 4);
  assert.equal(budgetView({ source: "unknown" }).sourceCertainty, "unknown");

  // 강사는 이름·안내 문구만 바꾼다. 상태·종료·서버 정책은 숨길 수 없다.
  const applied = applyInstructorOverrides({ coachName: "별똥별", openingPrompt: "오늘 뭐 만들까요?", hidesStatus: true });
  assert.equal(applied.coachName, "별똥별");
  assert.equal(applied.hidesStatus, false, "강사 설정이 상태 표시를 숨긴다 (VO-46)");
  assert.equal(applied.hidesStopControl, false, "강사 설정이 종료를 숨긴다 (VO-46)");
  assert.equal(applied.bypassesServerPolicy, false);
  assert.equal(applyInstructorOverrides(null).coachName, null);
}

// ─── §12 VO-37 첫 안내 ─────────────────────────────────────────────────────
{
  const base = { transportReady: true, conversationIsNew: true, alreadyGreetedThisSession: false, userSpokeFirst: false, pendingRequestIsClear: false };
  assert.deepEqual(openingPromptDecision(base), { speak: true, text: OPENING_PROMPT_TEXT });
  assert.equal(openingPromptDecision({ ...base, transportReady: false }).reason, "not_ready", "준비 전에 안내를 재생한다 (VO-37)");
  assert.equal(openingPromptDecision({ ...base, alreadyGreetedThisSession: true }).reason, "already_greeted", "안내를 반복한다 (VO-37)");
  assert.equal(openingPromptDecision({ ...base, conversationIsNew: false }).reason, "resumed_conversation");
  assert.equal(openingPromptDecision({ ...base, userSpokeFirst: true }).reason, "user_spoke_first", "사용자 발화를 안내가 덮는다 (VO-37/39)");
  assert.equal(openingPromptDecision({ ...base, pendingRequestIsClear: true }).reason, "request_already_clear", "이미 명확한 요청을 다시 인터뷰한다 (VO-37)");
}

// ─── §13 VO-42 실패 갈래 표시 ──────────────────────────────────────────────
{
  const kinds = ["permission_denied", "no_input_device", "permission_revoked", "late_permission_after_cancel", "output_device_failed", "transport_failed", "reconnect_failed"];
  const texts = new Set();
  for (const kind of kinds) {
    const v = failureView(kind);
    texts.add(v.text);
    assert.equal(v.offersTextFallback, true, `${kind} 에 텍스트 대안 안내가 없다`);
  }
  assert.equal(texts.size, kinds.length, "실패 갈래가 같은 문구로 접혔다 — '연결됨' 하나로 합치는 것과 같은 결함 (VO-42)");
  // 취소 뒤 늦게 온 허용은 **반드시** 받은 stream 을 닫는다.
  assert.equal(failureView("late_permission_after_cancel").mustReleaseCapture, true, "늦은 허용의 마이크가 남는다 (VO-42)");
  assert.equal(failureView("permission_denied").mustReleaseCapture, false, "열린 적 없는 캡처를 해제 대상으로 적는다");
}

// ─── §14 순수 계층 유지 — vscode / DOM 을 끌어들이지 않는다 ─────────────────
{
  const src = readFileSync(join(here, "..", "src", "voicePopupHelpers.ts"), "utf8");
  assert.ok(!/from ['"]vscode['"]/.test(src), "순수 계층이 vscode 를 import 한다 (extension-dev.md)");
  assert.ok(!/\b(document|window|navigator|getUserMedia|AudioContext)\b/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")),
    "순수 계층이 DOM/미디어 API 를 참조한다 — 판정과 관측이 섞인다");
}

console.log("voice-popup.smoke: ok");
