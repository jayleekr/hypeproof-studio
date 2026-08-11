// resolveCoachRuntime — 미성년은 어느 경로로도 SDK 런타임에 닿지 않는다.
//
// 왜 이 TC 가 있나 (2026-08-11 실측):
//   판단이 chatPanelProvider 안에 인라인이었을 때 **프로필 경로만** 미성년을
//   걸렀고 머신 설정 경로는 안 걸렀다:
//
//     const profileWantsSdk = profile?.coach_runtime === "agent-sdk" && profile?.minor_cohort !== true;
//     const runtime = settingRuntime === "agent-sdk" || profileWantsSdk ? "agent-sdk" : "proxy";
//                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ 미성년 검사 없음
//
//   워커는 미성년 프로필의 coach_runtime 을 무조건 proxy 로 강제하는데,
//   `hypeproofChat.coachRuntime` 이 agent-sdk 인 기기에서는 그 핀이 우회됐다.
//   권한 침해는 아니다(도구는 프로필이 소유하고 미성년은 빈 배열) — 대신
//   도구 0개로 SDK 루프가 돌면서 툴 호출 원문이 아이 화면에 렌더되고 쓰지도
//   않은 파일을 썼다고 단언했다. 실기기에서 관측한 증상이다.
//
// 네 조합(설정 × 프로필)을 미성년/성인 양쪽으로 전부 고정한다.

import assert from "node:assert/strict";
import { resolveCoachRuntime } from "../src/chatPanelHelpers.ts";

let n = 0;
const t = (name, fn) => {
  fn();
  n++;
  console.log(`  ok   ${name}`);
};

console.log("=== 미성년 — 어느 경로로도 proxy 여야 한다 ===");

t("설정 agent-sdk + 프로필 proxy → proxy (이게 뚫려 있던 구멍)", () => {
  assert.equal(
    resolveCoachRuntime({ settingRuntime: "agent-sdk", profileRuntime: "proxy", minorCohort: true }),
    "proxy",
  );
});

t("설정 proxy + 프로필 agent-sdk → proxy (워커 실수 방어)", () => {
  assert.equal(
    resolveCoachRuntime({ settingRuntime: "proxy", profileRuntime: "agent-sdk", minorCohort: true }),
    "proxy",
  );
});

t("설정·프로필 둘 다 agent-sdk → proxy", () => {
  assert.equal(
    resolveCoachRuntime({
      settingRuntime: "agent-sdk",
      profileRuntime: "agent-sdk",
      minorCohort: true,
    }),
    "proxy",
  );
});

t("둘 다 proxy → proxy", () => {
  assert.equal(
    resolveCoachRuntime({ settingRuntime: "proxy", profileRuntime: "proxy", minorCohort: true }),
    "proxy",
  );
});

console.log("");
console.log("=== 성인 — 기존 동작이 그대로여야 한다 (과잉 차단 방지) ===");

t("설정 agent-sdk → agent-sdk", () => {
  assert.equal(
    resolveCoachRuntime({ settingRuntime: "agent-sdk", profileRuntime: "proxy", minorCohort: false }),
    "agent-sdk",
  );
});

t("프로필 agent-sdk → agent-sdk (보아 원장 트랙)", () => {
  assert.equal(
    resolveCoachRuntime({ settingRuntime: "proxy", profileRuntime: "agent-sdk", minorCohort: false }),
    "agent-sdk",
  );
});

t("둘 다 proxy → proxy", () => {
  assert.equal(
    resolveCoachRuntime({ settingRuntime: "proxy", profileRuntime: "proxy", minorCohort: false }),
    "proxy",
  );
});

console.log("");
console.log("=== minor_cohort 미상 — 기존 동작을 깨지 않는다 ===");

t("minorCohort undefined + 설정 agent-sdk → agent-sdk (구 워커 응답 호환)", () => {
  assert.equal(resolveCoachRuntime({ settingRuntime: "agent-sdk" }), "agent-sdk");
});

t("프로필 없음 + 설정 proxy → proxy", () => {
  assert.equal(resolveCoachRuntime({ settingRuntime: "proxy" }), "proxy");
});

console.log("");
console.log("=== 회귀 가드 — 인라인 판단이 되살아나지 않았는가 ===");

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "chatPanelProvider.ts"),
  "utf8",
);
t("chatPanelProvider 가 resolveCoachRuntime 를 쓴다", () => {
  assert.ok(src.includes("resolveCoachRuntime({"), "resolveCoachRuntime 호출이 없다");
});
t("옛 인라인 OR 판단이 남아 있지 않다", () => {
  assert.ok(
    !/settingRuntime === "agent-sdk" \|\| profileWantsSdk/.test(src),
    "인라인 판단이 되살아났다 — 미성년 검사가 다시 비대칭이 된다",
  );
});

console.log("");
console.log(`PASS — resolveCoachRuntime ${n}건`);
