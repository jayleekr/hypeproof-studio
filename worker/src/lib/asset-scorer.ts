import type { AssetFocus } from "../profiles/types.ts";

export type AssetScores = Record<AssetFocus, number>;

export interface AssetScoreResult {
  version: 1;
  method: "heuristic-v1";
  scores: AssetScores;
  matched: Partial<Record<AssetFocus, string[]>>;
}

const ASSETS: AssetFocus[] = [
  "taste",
  "intent_clarity",
  "context_design",
  "verification_reflex",
  "delegation_judgment",
  "iteration_reflex",
  "ownership",
];

const PATTERNS: Record<AssetFocus, RegExp[]> = {
  taste: [
    /환자용|내부용|원장님(?:께|용)?|표현|톤|한\s*줄|비교|더\s*좋은|좋아 보이는|taste/i,
  ],
  intent_clarity: [
    /무엇을 알고|뭘 원하는|원하는지|목적|결정|알고 싶은 것|질문|intent/i,
  ],
  context_design: [
    /맥락|상황|환자군|금지표현|판단 기준|조건|자료|출처 후보|context/i,
  ],
  verification_reflex: [
    /검증|확인|의심|틀리게|위험 신호|근거|출처|PASS|더 확인|위험|verification/i,
  ],
  delegation_judgment: [
    /AI가|맡기|위임|원장님(?:이|께|에게)?|임상 판단|물어볼 질문|delegation/i,
  ],
  iteration_reflex: [
    /V2|다시|반복|바꿔|수정|개선|변주|한 번 더|iteration/i,
  ],
  ownership: [
    /저장|규칙|다음 검색|재사용|내 것|소유|축적|업데이트|ownership/i,
  ],
};

const emptyScores = (): AssetScores => ({
  taste: 0,
  intent_clarity: 0,
  context_design: 0,
  verification_reflex: 0,
  delegation_judgment: 0,
  iteration_reflex: 0,
  ownership: 0,
});

function scoreFor(matches: number, textLength: number): number {
  if (matches <= 0 || textLength <= 0) return 0;
  const lengthBoost = textLength >= 240 ? 0.2 : textLength >= 120 ? 0.1 : 0;
  return Math.min(1, 0.35 + matches * 0.2 + lengthBoost);
}

export function scoreTurnAssets(text: string): AssetScoreResult {
  const scores = emptyScores();
  const matched: Partial<Record<AssetFocus, string[]>> = {};
  const body = text.trim();

  for (const asset of ASSETS) {
    const hits: string[] = [];
    for (const pattern of PATTERNS[asset]) {
      const match = body.match(pattern);
      if (match?.[0]) hits.push(match[0]);
    }
    if (hits.length > 0) {
      matched[asset] = hits;
      scores[asset] = scoreFor(hits.length, body.length);
    }
  }

  return {
    version: 1,
    method: "heuristic-v1",
    scores,
    matched,
  };
}

export function clampAssetScores(scores: Partial<Record<AssetFocus, number>>): AssetScores {
  const out = emptyScores();
  for (const asset of ASSETS) {
    const value = scores[asset] ?? 0;
    out[asset] = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  }
  return out;
}

export function assetKeys(): AssetFocus[] {
  return ASSETS.slice();
}
