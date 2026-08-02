// #476 — 폴백을 참가자·개발자에게 보이게 하는 문구의 순수 테스트.
//
// 여기서 재지 않는 것: 세션 1회 게이트와 출력 채널 생성은 `ChatPanelProvider`
// 필드라 vscode 없이 못 돈다. 그 계약은 PR 본문의 실기기 판정법에 적었다.
// (`AiDisclosureGate` 처럼 클래스로 뽑을 수도 있었지만, 상태가 boolean 하나라
//  뽑는 것이 계약을 더 분명하게 만들지 않는다.)

import assert from "node:assert/strict";
import {
  COACH_DEGRADED_NOTICE,
  sdkFallbackLogLine,
  AI_DISCLOSURE_TEXT,
} from "../src/chatPanelHelpers.ts";

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ── 참가자 문구 — 두 가지를 동시에 해야 한다 ──────────────────────────────

ok("무엇이 **안 되는지** 구체적으로 말한다", () => {
  // "문제가 생겼어요" 류 제네릭 문구는 참가자가 자기 탓이라고 느끼게 만들고,
  // 무엇을 포기해야 하는지도 안 알려준다.
  assert.ok(COACH_DEGRADED_NOTICE.includes("파일 저장"));
  assert.ok(COACH_DEGRADED_NOTICE.includes("명령 실행"));
  assert.ok(COACH_DEGRADED_NOTICE.includes("배포"));
});

ok("무엇이 **여전히 되는지**도 말한다", () => {
  // 이걸 빼면 참가자가 수업을 통째로 포기한다. 프록시에서도 오늘의 핵심
  // (페이지를 만들고 눈으로 확인하기)은 끝까지 된다.
  assert.ok(COACH_DEGRADED_NOTICE.includes("만들기"));
  assert.ok(COACH_DEGRADED_NOTICE.includes("미리보기"));
});

ok("다음 행동을 준다 (무한 대기를 막는다)", () => {
  assert.ok(COACH_DEGRADED_NOTICE.includes("스태프"));
});

ok("한 줄이다 (이슈가 '한 줄이면 충분'이라고 명시)", () => {
  assert.ok(!COACH_DEGRADED_NOTICE.includes("\n"));
  assert.ok(COACH_DEGRADED_NOTICE.length <= 160, COACH_DEGRADED_NOTICE.length);
});

ok("AI 고지(#320)와 다른 문구다 — 둘이 겹치면 하나가 묻힌다", () => {
  assert.notEqual(COACH_DEGRADED_NOTICE, AI_DISCLOSURE_TEXT);
});

// ── 개발자 로그 — 이게 없어서 사후 확인이 불가능했다 ──────────────────────

ok("로그 줄이 사유를 **원문 그대로** 싣는다", () => {
  // SdkUnavailableError 메시지가 해석 후보 4개를 나열한다. 요약하면 진단이
  // 사라진다 — 사고 당일 "어느 후보가 없었나"가 정확히 필요한 정보였다.
  const reason =
    "no usable claude binary: setting unset, HPS_SDK_BINARY unset, seed missing, node_modules absent";
  const line = sdkFallbackLogLine(reason, new Date(Date.UTC(2026, 7, 2, 5, 30, 0)));
  assert.ok(line.includes(reason), line);
});

ok("로그 줄에 타임스탬프가 있다 (교실에서 언제 떨어졌는지)", () => {
  const line = sdkFallbackLogLine("x", new Date(Date.UTC(2026, 7, 2, 5, 30, 0)));
  assert.ok(line.includes("2026-08-02T05:30:00.000Z"), line);
});

ok("로그 줄이 폴백임을 명시한다 (grep 가능한 표지)", () => {
  const line = sdkFallbackLogLine("x", new Date(Date.UTC(2026, 7, 2, 5, 30, 0)));
  assert.ok(line.includes("agent-sdk → proxy fallback"), line);
});

console.log(`\n#476 coach-fallback-notice: ${passed} checks passed`);
