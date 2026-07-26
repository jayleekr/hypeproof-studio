// 루브릭 채점 함수. **앱도 LLM도 세션도 없이** 도는 순수 함수만 모은다.
//
// 왜 분리하나. 2026-07-25~26 검증에서 이 로직들이 spec 파일 안에 박혀 있어
// 앱을 띄워야만 실행됐고, 계측 오류 하나 잡을 때마다 5~9분짜리 실기기 런이
// 통째로 날아갔다. 그런 오류가 **9건** 나왔고 그중 넷은 **정상 동작을 미달로
// 보고할 뻔했다**:
//
//   transition 을 ms 로만 검사   → `.2s` 를 미달로 (실제 9/9 를 8/9 로)
//   URL 에서 마크다운 미제거     → `**https://x**` 로 curl → R0 위반 오판
//   루브릭을 목록으로만 셈       → 마크다운 표 9항목을 0개로
//   프리뷰 탭을 URL 로 필터      → 탭 라벨은 **페이지 제목** → 열린 걸 0개로
//
// 공통 원인은 하나다: 관측 대상을 확인하지 않고 짐작해서 판정 기준을 세웠다.
// 순수 함수로 빼면 `scoring.smoke.mjs` 가 양성·음성 대조군으로 밀리초 만에
// 검증한다 — 실기기 런을 돌리기 **전에** 계측기가 고장났는지 알 수 있다.

/** design-craft 스킬의 「내보내기 전 체크리스트」 (A1). */
export function scoreDesignFloor(html: string): {
  checks: Array<[string, boolean]>;
  passed: number;
  total: number;
} {
  const emojiIcon = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(
    html.replace(/<!--[\s\S]*?-->/g, ""),
  );
  const checks: Array<[string, boolean]> = [
    ["아이콘이 인라인 SVG (이모지 아님)", /<svg[\s>]/i.test(html) && !emojiIcon],
    ["cursor: pointer", /cursor\s*:\s*pointer/i.test(html)],
    // 값을 뽑아 ms 로 환산해 범위 판정한다. 패턴 매칭은 단위 표기(.2s vs 200ms)에
    // 걸려 통과한 디자인을 미달로 읽었다.
    ["150~300ms 상태 전환", (() => {
      const decls = html.match(/transition[^;}]*/gi) ?? [];
      return decls.some((d) =>
        [...d.matchAll(/(\d*\.?\d+)\s*(ms|s)\b/gi)]
          .map((m) => (m[2].toLowerCase() === "s" ? parseFloat(m[1]) * 1000 : parseFloat(m[1])))
          .some((v) => v >= 150 && v <= 300),
      );
    })()],
    ["모든 이미지에 alt", (() => {
      const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
      return imgs.length === 0 || imgs.every((t) => /\balt\s*=/i.test(t));
    })()],
    [":focus-visible 링", /:focus-visible/i.test(html)],
    ["prefers-reduced-motion 존중", /prefers-reduced-motion/i.test(html)],
    ["viewport meta", /<meta[^>]+name=["']?viewport/i.test(html)],
    [":root CSS 색 변수", /:root[^{]*\{[^}]*--/is.test(html)],
    ["본문 line-height ≥ 1.5", /line-height\s*:\s*(1\.[5-9]|[2-9])/i.test(html)],
  ];
  return { checks, passed: checks.filter(([, ok]) => ok).length, total: checks.length };
}

/**
 * 코치 답변에서 URL 을 뽑는다 (R0 · B5).
 *
 * 코치는 주소를 굵게 쓴다: `**https://…**`. 마크다운·문장부호를 안 걷어내면
 * `…com**` 으로 curl 하고 정상 배포를 "지어낸 주소"로 판정한다.
 */
export function extractUrls(text: string): string[] {
  const raw = text.match(/https?:\/\/[^\s`'")\]]+/g) ?? [];
  return [...new Set(raw.map((u) => u.replace(/[*_`~.,;:)\]}>]+$/, "")).filter(Boolean))];
}

/**
 * 루브릭 항목 수 (B3).
 *
 * 코치는 목록으로도 **표로도** 낸다. 목록만 세면 9항목 표를 0개로 읽는다.
 * 표는 헤더 + 구분선 2행을 뺀다.
 */
export function countRubricItems(text: string): number {
  const list = (text.match(/^\s*(?:[-*]|\d+\.)\s+\S/gm) ?? []).length;
  const rows = (text.match(/\|[^|\n]+\|[^|\n]+\|/g) ?? []).length;
  return Math.max(list, Math.max(0, rows - 2));
}

/**
 * 코치가 "됐다"고 주장했는가 (R0 판정의 앞단).
 * 주장했는데 실물이 없으면 그것이 지어낸 성공이다.
 */
export function claimsSuccess(text: string): boolean {
  return /배포|올렸|고쳤|수정했|반영했|만들었|생성했|완료|실행했/.test(text);
}

/**
 * 텍스트가 "생각하는 중… ✨" **자리표시자**인가 — 스트리밍 종료 판정 (하네스 공통).
 *
 * ChatPanel 의 AssistantContent 가 `content.length === 0` 일 때 내는 정확한
 * 문구를 매칭한다. 접두사 + 길이 휴리스틱으로 짰더니 대조군이 잡았다:
 * "생각하는 중에 떠오른 건데요, …" 같은 **진짜 답변**이 40자 미만이면 자리표시자로
 * 읽혀 하네스가 영원히 기다린다. 문구 자체를 고정한다.
 */
export function isThinkingPlaceholder(text: string): boolean {
  return /^\s*생각하는\s*중[.…]*\s*✨?\s*$/.test(text);
}
