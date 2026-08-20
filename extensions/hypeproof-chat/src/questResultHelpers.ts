// 결과지 정화 — 순수 로직 (vscode 의존 없음).
//
// 왜 여기로 나왔나: 이 함수는 세상(iframe) → 코치 프롬프트로 가는 **보안 경계**이자,
// "코치가 무엇을 근거로 판단하는가" 를 결정하는 계약 지점이다. previewProvider.ts
// 안에 있으면 vscode 를 import 하는 파일이라 앱 없이 테스트할 수 없었고, 그래서
// 이 경계를 지나는 테스트가 하나도 없었다. 그 사이에 결함 두 개가 자랐다:
//
//   1) `r.world` 묶음이 여기서 통째로 사라진다 — 그런데 프롬프트는 코치에게
//      "world 플래그로 판단하라" 고 시킨다. 9개 세상 중 8개가 원래 문제 상태를
//      코치에게 못 보낸다.
//   2) sort 는 `report({ok: <정답 개수>})` 를 보내는데 engineJs 의 report() 가
//      `r.ok` 를 성공여부 불리언으로 덮어쓴다 — 이름 충돌로 개수가 사라진다.
//
// 둘 다 "설정은 맞는데 동작이 없는" 유형이라 눈으로는 안 보인다
// (.claude/rules/verification.md). 계약을 `worker/test/quest-result-contract.test.mjs`
// 가 고정한다 — 순수 함수라 앱 없이 돈다.
//
// 이 repo 규약: 순수 로직은 xxxHelpers.ts, 오케스트레이션은 xxx.ts.

/** 한 결과지가 코치 프롬프트로 실어 나를 수 있는 최대 키 수. */
export const MAX_RESULT_KEYS = 16;
/** 문자열 값의 최대 길이 — 긴 산문이 프롬프트로 타는 것을 막는다. */
export const MAX_RESULT_STRING = 40;

/**
 * `hp:result` 페이로드에서 **낱개 원시값만** 남긴다 — iframe 은 신뢰할 수 없는
 * 내용이라 중첩된 것이나 긴 것은 프롬프트로 태우지 않는다.
 *
 * ⚠ 중첩 객체는 버려진다. 세상이 "원래 문제가 아직 남아 있다" 를 코치에게
 * 알리려면 깃발을 **낱개로** 실어야 한다(`report({ flood: true })`), 묶음으로
 * 보내면(`r.world = {...}`) 여기서 사라진다.
 */
export function sanitizeQuestResult(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object") return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "type") continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,23}$/.test(k)) continue;
    if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, MAX_RESULT_STRING);
    else continue;
    if (++n >= MAX_RESULT_KEYS) break;
  }
  return out;
}
