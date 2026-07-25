// Smoke tests for the mid-turn send queue (#416, REQ-C16). Pure — no React, no
// DOM, no vscode. 2026-07-24 실강의 중 발견: 코치가 응답하는 동안 입력창이
// `disabled={streaming}` 라 **타이핑조차** 안 됐다. 프록시 시절 20~30초짜리 턴
// 에서는 티가 안 났는데 agent-sdk 턴은 실측 5~10분(9분 사례) — 참가자는 그동안
// 떠오른 것을 적어둘 수조차 없다. 적어두지 못한 생각은 사라진다(iteration_reflex).
//
// 여기서 검증하는 것은 '보이는 것'이 아니라 **잃어버리는 것**이다:
// ① 턴 위에 두 번째 턴을 겹쳐 쏘지 않는다, ② 예약한 문장을 어떤 경로로도
// 버리지 않는다(Stop·취소·재입력), ③ 스트림이 아직 열려 있을 때 flush 하지
// 않는다 — submit() 의 자체 가드에 걸려 **에러 없이** 사라지기 때문. 셋 다
// 논리 문제라 DOM 없이 잠글 수 있고, 그래서 순수 모듈로 떼어냈다.
// Run: node --experimental-strip-types test/send-queue.smoke.mjs

import assert from "node:assert/strict";

const { decideEnter, draftAfterStop, shouldFlushQueue } = await import(
  "../webview-ui/src/sendQueue.ts"
);

// ─── 유휴 상태: 예전 그대로 즉시 전송 ───────────────────────────────────────
{
  assert.deepEqual(decideEnter({ draft: "안녕", streaming: false, queued: null }), { action: "send" });
  // 이미지만 붙여도 보낼 턴이 있다(스크린샷 한 장 = 유효한 입력).
  assert.deepEqual(decideEnter({ draft: "  ", streaming: false, queued: null, hasImages: true }), {
    action: "send",
  });
  // 빈 입력 Enter 는 조용히 무시(빈 턴을 게이트웨이로 보내지 않는다).
  assert.deepEqual(decideEnter({ draft: "   \n ", streaming: false, queued: null }), { action: "ignore" });
}

// ─── 응답 중: 즉시 전송이 아니라 '예약' ─────────────────────────────────────
{
  assert.deepEqual(decideEnter({ draft: "가격표도 넣어줘", streaming: true, queued: null }), {
    action: "queue",
    queued: "가격표도 넣어줘",
  });
  // 턴이 도는 중엔 이미지를 붙일 턴 자체가 아직 없다 → 빈 draft 는 예약할 게 없다.
  assert.deepEqual(decideEnter({ draft: "", streaming: true, queued: null, hasImages: true }), {
    action: "ignore",
  });
}

// ─── 예약은 정확히 1건: 다시 Enter 하면 '덮어쓰기'가 아니라 '덧붙이기' ──────
// 큐를 무한히 쌓으면 다음에 뭐가 갈지 예측할 수 없고, 교체하면 먼저 친 문장이
// 사라진다. 한 건을 유지하면서 아무것도 안 버리는 유일한 방법이 덧붙이기다.
{
  assert.deepEqual(decideEnter({ draft: "그리고 전화번호도", streaming: true, queued: "가격표도 넣어줘" }), {
    action: "queue",
    queued: "가격표도 넣어줘\n그리고 전화번호도",
  });
  // 세 번째도 같은 규칙으로 한 건에 누적된다.
  const second = decideEnter({ draft: "B", streaming: true, queued: "A" });
  const third = decideEnter({ draft: "C", streaming: true, queued: second.queued });
  assert.equal(third.queued, "A\nB\nC");
}

// ─── Stop / 예약 취소 = draft 복원. 절대 삭제가 아니다 ──────────────────────
{
  // 예약만 있고 이후 입력이 없으면 그대로 돌아온다.
  assert.equal(draftAfterStop("", "가격표도 넣어줘"), "가격표도 넣어줘");
  // 예약 후 더 친 문장이 있으면 둘 다 살리고, 친 순서대로 둔다.
  assert.equal(draftAfterStop("그리고 전화번호", "가격표"), "가격표\n그리고 전화번호");
  // 예약이 없으면 draft 는 손대지 않는다(공백 포함 원문 유지).
  assert.equal(draftAfterStop("쓰던 중  ", null), "쓰던 중  ");
  assert.equal(draftAfterStop("쓰던 중", "   "), "쓰던 중", "공백뿐인 예약은 없는 것과 같다");
  assert.equal(draftAfterStop("", null), "");
}

// ─── flush 는 streaming → idle '엣지'에서만 ─────────────────────────────────
// 스트림이 아직 열려 있는데 쏘면 submit() 가 막고 메시지는 에러 없이 증발한다.
{
  assert.equal(shouldFlushQueue(true, false, "예약된 말"), true, "턴이 끝난 순간 발사");
  assert.equal(shouldFlushQueue(true, true, "예약된 말"), false, "아직 응답 중이면 안 된다");
  assert.equal(shouldFlushQueue(false, false, "예약된 말"), false, "이미 유휴면 재발사 금지");
  assert.equal(shouldFlushQueue(false, true, "예약된 말"), false, "턴 시작 엣지는 발사 지점이 아니다");
  assert.equal(shouldFlushQueue(true, false, null), false, "예약이 없으면 아무 일도 없다");
  assert.equal(shouldFlushQueue(true, false, "  \n "), false, "공백뿐인 예약은 보내지 않는다");
}

// ─── 실강의 시나리오 전체를 순서대로 ────────────────────────────────────────
{
  let draft = "";
  let queued = null;
  let streaming = false;
  const sent = [];
  const enter = () => {
    const d = decideEnter({ draft, streaming, queued });
    if (d.action === "send") {
      sent.push(draft.trim());
      draft = "";
      streaming = true;
    } else if (d.action === "queue") {
      queued = d.queued;
      draft = "";
    }
  };
  const turnEnds = () => {
    const prev = streaming;
    streaming = false;
    if (shouldFlushQueue(prev, streaming, queued)) {
      sent.push(queued);
      queued = null;
      streaming = true;
    }
  };

  draft = "치과 홈페이지 만들어줘";
  enter();                                   // 첫 턴 전송
  assert.deepEqual(sent, ["치과 홈페이지 만들어줘"]);

  draft = "가격표도";                          // 9분짜리 턴 중에 떠오른 것
  enter();
  assert.equal(queued, "가격표도");
  assert.equal(draft, "", "예약하면 입력창은 비워진다");

  draft = "전화번호도";                        // 아직도 응답 중, 하나 더
  enter();
  assert.equal(queued, "가격표도\n전화번호도", "예약은 여전히 1건");

  turnEnds();
  assert.deepEqual(sent, ["치과 홈페이지 만들어줘", "가격표도\n전화번호도"], "턴 종료 즉시 자동 전송");
  assert.equal(queued, null);

  // 두 번째 턴 도중 예약했다가 Stop → 입력창으로 되돌아온다.
  draft = "역시 지도도";
  enter();
  assert.equal(queued, "역시 지도도");
  draft = draftAfterStop(draft, queued);
  queued = null;
  streaming = false;
  assert.equal(draft, "역시 지도도", "Stop 은 예약을 draft 로 되돌린다 — 삭제가 아니다");
  assert.equal(sent.length, 2, "Stop 후 자동 전송은 일어나지 않는다");
}

console.log("✓ #416: 응답 중 입력 — Enter 예약(1건 누적) · 턴 종료 엣지에서만 자동 전송 · Stop/취소는 draft 복원");
