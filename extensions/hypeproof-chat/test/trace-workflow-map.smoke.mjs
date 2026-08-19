// #580 — trace 메시지 → workflow 레코드 매핑. 앱 없이, 밀리초.
//
// 이 매핑의 계약은 "필드명이 worker/src/routes/trace.ts 의 TraceEvent union
// 과 정합"이다(spool-then-forward — 후속 워커 전송이 이 payload 를 그대로
// 보낸다). 워커는 별도 패키지라 컴파일 타임 연결이 없으므로, 이 테스트가
// 기대 키 집합을 **리터럴로 박아** 무성 드리프트를 잡는다
// (test/sdk-tool-drift.smoke.mjs 와 같은 규율, #375).
//
// Run: node --experimental-strip-types test/trace-workflow-map.smoke.mjs

import assert from "node:assert/strict";

const { traceMsgToWorkflowRecord } = await import("../src/sessionSpool.ts");

// worker/src/routes/trace.ts TraceEvent union 의 필드명 — 여기 바뀌면 워커도
// 같이 바뀌어야 한다. 이 리터럴이 드리프트 락이다.
const WORKER_FIELDS = {
  trialStart: ["task_label"],
  trialEnd: ["trial_id"],
  validationRun: ["trial_id", "outcome", "errors_found", "errors_fixed"],
  humanAction: ["trial_id", "kind", "diff_chars"],
};

// ─── 양성 대조군 — 4종 전부, 풀 필드 ────────────────────────────────────────
{
  const r1 = traceMsgToWorkflowRecord({ type: "traceTrialStart", taskLabel: "게임 만들기" });
  assert.deepEqual(r1, { event: "trialStart", payload: { task_label: "게임 만들기" } });

  const r2 = traceMsgToWorkflowRecord({ type: "traceTrialEnd", trialId: "trial-1" });
  assert.deepEqual(r2, { event: "trialEnd", payload: { trial_id: "trial-1" } });

  const r3 = traceMsgToWorkflowRecord({
    type: "traceValidationRun",
    trialId: "trial-1",
    turnId: "turn-9",
    outcome: "partial",
    errorsFound: 5,
    errorsFixed: 3,
  });
  assert.deepEqual(r3, {
    turnId: "turn-9",
    event: "validationRun",
    payload: { trial_id: "trial-1", outcome: "partial", errors_found: 5, errors_fixed: 3 },
  });

  const r4 = traceMsgToWorkflowRecord({
    type: "traceHumanAction",
    trialId: "trial-1",
    turnId: "turn-9",
    kind: "edit",
    diffChars: 120,
  });
  assert.deepEqual(r4, {
    turnId: "turn-9",
    event: "humanAction",
    payload: { trial_id: "trial-1", kind: "edit", diff_chars: 120 },
  });

  // 드리프트 락: payload 키가 워커 필드명 집합의 부분집합인가.
  for (const [record, event] of [[r1, "trialStart"], [r2, "trialEnd"], [r3, "validationRun"], [r4, "humanAction"]]) {
    for (const key of Object.keys(record.payload ?? {})) {
      assert.ok(
        WORKER_FIELDS[event].includes(key),
        `${event}.${key} 는 worker trace.ts 에 없는 필드 — 드리프트`,
      );
    }
  }
  console.log("✓ 양성 — 4종 매핑 + 워커 필드명 드리프트 락");
}

// ─── 음성 대조군 — 없는 optional 은 키 자체가 없어야 한다 ───────────────────
{
  const r = traceMsgToWorkflowRecord({ type: "traceTrialStart" });
  assert.deepEqual(r, { event: "trialStart" }, "taskLabel 없음 → payload 없음");
  const v = traceMsgToWorkflowRecord({ type: "traceValidationRun", trialId: "t", outcome: "pass" });
  assert.equal(v.turnId, undefined);
  assert.deepEqual(Object.keys(v.payload), ["trial_id", "outcome"], "undefined 필드는 넣지 않는다");
  console.log("✓ 음성 — optional 미지정 시 키 부재 (undefined 를 싣지 않는다)");
}

console.log("trace-workflow-map.smoke.mjs — all green");
