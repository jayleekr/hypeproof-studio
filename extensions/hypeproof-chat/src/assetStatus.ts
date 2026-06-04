import type { AssetKey, AssetScores } from "./protocol";

export const ASSET_ORDER: AssetKey[] = [
  "taste",
  "intent_clarity",
  "context_design",
  "verification_reflex",
  "delegation_judgment",
  "iteration_reflex",
  "ownership",
];

export const ASSET_LABELS: Record<AssetKey, { short: string; label: string }> = {
  taste: { short: "Taste", label: "감각" },
  intent_clarity: { short: "Intent", label: "의도 선명도" },
  context_design: { short: "Context", label: "맥락 설계" },
  verification_reflex: { short: "Verify", label: "검증 습관" },
  delegation_judgment: { short: "Deleg", label: "위임 판단" },
  iteration_reflex: { short: "Iter", label: "반복 개선" },
  ownership: { short: "Own", label: "주도권" },
};

export function emptyAssetScores(): AssetScores {
  return {
    taste: 0,
    intent_clarity: 0,
    context_design: 0,
    verification_reflex: 0,
    delegation_judgment: 0,
    iteration_reflex: 0,
    ownership: 0,
  };
}

export function mergeAssetScores(current: AssetScores, next: AssetScores): AssetScores {
  const merged = emptyAssetScores();
  for (const key of ASSET_ORDER) {
    merged[key] = Math.max(normalizeScore(current[key]), normalizeScore(next[key]));
  }
  return merged;
}

export function countSeenAssets(scores: AssetScores): number {
  return ASSET_ORDER.filter((key) => normalizeScore(scores[key]) >= 0.33).length;
}

export function formatAssetStatusText(scores: AssetScores): string {
  const markers = ASSET_ORDER
    .map((key) => `${markerFor(scores[key])} ${ASSET_LABELS[key].short}`)
    .join("  ");
  return `$(graph) 7자산 ${countSeenAssets(scores)}/7  ${markers}`;
}

export function formatAssetTooltip(scores: AssetScores): string {
  return ["7 AI Native Assets", "", ...formatAssetHistogramLines(scores)].join("\n");
}

export function formatAssetHistogramLines(scores: AssetScores): string[] {
  return ASSET_ORDER.map((key) => {
    const value = normalizeScore(scores[key]);
    const filled = Math.round(value * 10);
    const bar = "#".repeat(filled).padEnd(10, "-");
    const pct = Math.round(value * 100).toString().padStart(3, " ");
    return `${ASSET_LABELS[key].label.padEnd(8, " ")} [${bar}] ${pct}%`;
  });
}

function markerFor(score: number): string {
  const value = normalizeScore(score);
  if (value >= 0.66) return "✓";
  if (value >= 0.33) return "◐";
  return "·";
}

function normalizeScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score));
}
