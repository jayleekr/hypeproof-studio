// 채점기 자체를 검증한다 — 앱도 LLM도 세션도 없이, 밀리초 단위.
//
// 왜 필요한가. 2026-07-25~26 검증에서 **하네스가 9번 틀렸다.** 그중 넷은
// 정상 동작을 미달로 보고할 뻔했고, 하나는 그렇게 보고했다가 수동 확인으로
// 겨우 뒤집었다. 원인은 매번 같다 — 관측 대상을 확인하지 않고 짐작으로
// 판정 기준을 세웠고, **그 기준이 틀렸는지 알 방법이 없었다.**
//
// 대조군 두 종류가 그 구멍을 막는다:
//
//   양성 대조군  확실히 좋은 시료 → **통과해야** 함 → 너무 엄격한 계측기를 잡는다
//   음성 대조군  확실히 나쁜 시료 → **실패해야** 함 → 너무 관대한 계측기를 잡는다
//
// 오늘 오류는 대부분 "너무 엄격" 쪽이었으므로 양성 대조군이 핵심이다. 각
// 케이스에 **실제로 겪은 오판**을 주석으로 붙여, 같은 실수가 다시 나면 여기서
// 먼저 깨지게 한다.
//
// Run: node --experimental-strip-types tests/scoring.smoke.mjs

import assert from "node:assert/strict";

const { scoreDesignFloor, extractUrls, countRubricItems, claimsSuccess, isThinkingPlaceholder } =
  await import("../scoring.ts");

// ─── A1 채점기 ───────────────────────────────────────────────────────────────
{
  // 양성 대조군 — 9항목을 모두 만족하는 시료. 만점이 나와야 한다.
  const good = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --ink:#111; --gold:#b8965a; }
  body { line-height: 1.6; color: var(--ink); }
  .btn { cursor: pointer; transition: background .2s, transform .15s; }
  a:focus-visible { outline: 2px solid var(--gold); }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style></head><body>
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 1"/></svg>
  <img src="a.jpg" alt="진료실 사진">
  <a class="btn" href="#">예약하기</a>
</body></html>`;
  const g = scoreDesignFloor(good);
  const failed = g.checks.filter(([, ok]) => !ok).map(([l]) => l);
  assert.equal(g.passed, g.total, `양성 대조군은 만점이어야 한다 — 미달: ${JSON.stringify(failed)}`);

  // 실측 회귀: 산출물은 `.2s`/`.15s` 로 쓴다. ms 만 보는 검사가 통과한 디자인을
  // 8/9 로 깎았다. 초 단위 표기만 있는 시료로 그 경로를 고정한다.
  const secOnly = good.replace(/transition[^;]*/g, "transition: background .2s");
  assert.ok(
    scoreDesignFloor(secOnly).checks.find(([l]) => l.includes("150~300ms"))?.[1],
    "초 단위(.2s) 표기도 통과해야 한다 — ms 만 보면 정상 디자인을 미달로 읽는다",
  );
  const msOnly = good.replace(/transition[^;]*/g, "transition: background 200ms");
  assert.ok(
    scoreDesignFloor(msOnly).checks.find(([l]) => l.includes("150~300ms"))?.[1],
    "ms 표기도 통과해야 한다",
  );

  // 음성 대조군 — B3 에서 실제로 심었던 위반 5종. 낮게 나와야 한다.
  const bad = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>x</title>
<style>
  body { color:#bbb; background:#fff; line-height:1.2; }
  a:focus { outline: none; }
</style></head><body>
  <ul><li>🦷 임플란트</li><li>😁 교정</li><li>👶 소아치과</li></ul>
  <img src="clinic.jpg">
  <a href="#">예약하기</a>
</body></html>`;
  const b = scoreDesignFloor(bad);
  assert.ok(b.passed <= 2, `음성 대조군은 낮아야 한다 — ${b.passed}/${b.total} 나옴 (채점기가 관대하다)`);
  // 심어둔 위반이 개별적으로 잡히는지도 본다 — 총점만 보면 어느 검사가 죽었는지 모른다.
  const byLabel = Object.fromEntries(b.checks.map(([l, ok]) => [l, ok]));
  assert.equal(byLabel["아이콘이 인라인 SVG (이모지 아님)"], false, "이모지 아이콘을 잡아야 한다");
  assert.equal(byLabel["모든 이미지에 alt"], false, "alt 누락을 잡아야 한다");
  assert.equal(byLabel[":focus-visible 링"], false, "focus 링 제거를 잡아야 한다");
  assert.equal(byLabel["viewport meta"], false, "viewport 누락을 잡아야 한다");

  // 빈 입력이 만점이면 채점기가 통째로 고장난 것이다.
  assert.ok(scoreDesignFloor("").passed <= 1, "빈 문서는 만점일 수 없다");
  console.log("✓ A1 채점기 — 양성 만점 · 음성 저점 · 단위 표기 무관");
}

// ─── URL 추출 (R0 · B5) ──────────────────────────────────────────────────────
{
  // 실측 회귀: 코치는 주소를 굵게 쓴다. `**` 가 붙은 채로 curl 하면 정상 배포가
  // "지어낸 주소"로 판정된다 — 실제로 그렇게 오판했다.
  assert.deepEqual(extractUrls("👉 **https://mother-kitty.trycloudflare.com**"),
    ["https://mother-kitty.trycloudflare.com"], "마크다운 볼드를 걷어내야 한다");
  assert.deepEqual(extractUrls("주소는 https://ico1036.github.io/repo/ 입니다."),
    ["https://ico1036.github.io/repo/"], "문장 끝 마침표");
  assert.deepEqual(extractUrls("(https://x.com)"), ["https://x.com"], "괄호");
  assert.deepEqual(extractUrls("`https://y.com`"), ["https://y.com"], "백틱");
  // 같은 주소가 여러 번 나와도 하나로.
  assert.equal(extractUrls("https://a.com 과 **https://a.com**").length, 1, "중복 제거");
  // 음성 대조군 — 주소가 없으면 빈 배열. 아무거나 URL 로 읽으면 안 된다.
  assert.deepEqual(extractUrls("배포했어요! 확인해보세요."), [], "URL 없는 문장");
  assert.deepEqual(extractUrls(""), [], "빈 입력");
  console.log("✓ URL 추출 — 마크다운·문장부호 제거 · 오탐 없음");
}

// ─── 루브릭 항목 수 (B3) ─────────────────────────────────────────────────────
{
  // 실측 회귀: 코치가 9항목 **표**로 냈는데 목록만 세는 검사가 0개로 읽어
  // "루브릭 수립 FAIL" 로 오판했다.
  const table = ["## 루브릭", "| # | 항목 | 판정 |", "|---|---|---|",
    ...Array.from({ length: 9 }, (_, i) => `| ${i + 1} | 항목${i + 1} | ❌ |`)].join("\n");
  assert.equal(countRubricItems(table), 9, "마크다운 표 9항목");

  const list = ["체크리스트:", "- 접근성", "- 반응형", "- 타이포", "- 색 토큰", "- 모션"].join("\n");
  assert.equal(countRubricItems(list), 5, "불릿 목록 5항목");

  const numbered = ["1. 하나", "2. 둘", "3. 셋"].join("\n");
  assert.equal(countRubricItems(numbered), 3, "번호 목록");

  // 음성 대조군 — 산문에 항목이 없으면 0. 아무 텍스트나 항목으로 세면 안 된다.
  assert.equal(countRubricItems("루브릭을 세우려면 먼저 기준이 필요합니다."), 0, "산문은 0개");
  assert.equal(countRubricItems(""), 0, "빈 입력");
  console.log("✓ 루브릭 항목 수 — 표·목록 둘 다 · 산문 오탐 없음");
}

// ─── 성공 주장 감지 (R0 앞단) ────────────────────────────────────────────────
{
  assert.equal(claimsSuccess("배포 완료했어요! 주소는 …"), true);
  assert.equal(claimsSuccess("index.html 을 고쳤습니다."), true);
  // 음성 대조군 — 아직 안 된 것을 성공으로 읽으면 R0 판정이 통째로 망가진다.
  assert.equal(claimsSuccess("아직 빌드 중이에요. 1분 뒤 확인할게요."), false, "진행 중은 주장이 아니다");
  assert.equal(claimsSuccess("어떤 것부터 할까요?"), false, "질문은 주장이 아니다");
  console.log("✓ 성공 주장 감지 — 진행 중·질문을 주장으로 읽지 않음");
}

// ─── 스트리밍 자리표시자 (하네스 공통) ───────────────────────────────────────
{
  // 실측 회귀: content 가 비었을 때 ChatPanel 은 "생각하는 중… ✨" 텍스트만
  // 렌더하고 진행 칩은 안 붙인다. 칩만 보면 이 문구를 "안정된 답변"으로 읽고
  // 18초 만에 종료 오판한다 — 실제로 그렇게 빈 답변을 기록했다.
  assert.equal(isThinkingPlaceholder("생각하는 중… ✨"), true);
  assert.equal(isThinkingPlaceholder("  생각하는 중… ✨  "), true, "공백 무관");
  // 음성 대조군 — 진짜 답변을 자리표시자로 읽으면 영원히 기다린다.
  assert.equal(
    isThinkingPlaceholder("생각하는 중에 떠오른 건데요, 이 화면은 크게 다섯 덩어리로 나뉩니다."),
    false,
    "같은 어절로 시작하는 긴 답변은 자리표시자가 아니다",
  );
  assert.equal(isThinkingPlaceholder("배포 완료했어요!"), false);
  console.log("✓ 스트리밍 자리표시자 — 긴 답변 오탐 없음");
}

console.log("\n✓ scoring smoke 통과 — 계측기가 살아 있다");
