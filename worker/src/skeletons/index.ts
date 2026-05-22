import type { Skeleton, SkeletonTier } from "./types";
// @ts-ignore — bundled as text by wrangler [[rules]] (globs **/*.html)
import catcherHtml from "./kids-basic/catcher.html";
// @ts-ignore
import jumperHtml from "./kids-basic/jumper.html";
// @ts-ignore
import dodgeHtml from "./kids-basic/dodge.html";
// @ts-ignore
import dentalV1Html from "./search-webapp/dental-v1.html";
// @ts-ignore
import verdictCardHtml from "./search-webapp/verdict-card.html";

const REGISTRY: Skeleton[] = [
  {
    id: "kb-catcher",
    tier: "kids-basic",
    genre: "catcher",
    summary_ko: "위에서 떨어지는 좋은 것을 받고 나쁜 것은 피하는 게임",
    tags: ["받기", "떨어지는", "별", "생선", "사과", "바구니", "잡기", "모으기"],
    html: catcherHtml as unknown as string,
  },
  {
    id: "kb-jumper",
    tier: "kids-basic",
    genre: "jumper",
    summary_ko: "장애물을 점프해서 넘는 끝없이 달리기 게임",
    tags: ["점프", "뛰기", "넘기", "장애물", "달리기", "공룡", "고양이 점프"],
    html: jumperHtml as unknown as string,
  },
  {
    id: "kb-dodge",
    tier: "kids-basic",
    genre: "dodge",
    summary_ko: "사방에서 오는 적/운석을 움직여서 피하는 게임",
    tags: ["피하기", "도망", "적", "운석", "우주선", "회피", "생존"],
    html: dodgeHtml as unknown as string,
  },
  // ─── search-webapp tier (clinical/professional workshops) ───────────────
  {
    id: "sw-dental-v1",
    tier: "search-webapp",
    genre: "clinical-search",
    summary_ko:
      "치과/의료 직군용 검색엔진 V1 — 출처 신뢰도 4단계(학회·가이드라인·블로그·광고) 필터 + 결정 reframe + 결과 리스트",
    tags: ["검색", "찾기", "출처", "신뢰도", "엔진", "V1", "치과", "병원", "환자", "임상"],
    html: dentalV1Html as unknown as string,
  },
  {
    id: "sw-verdict-card",
    tier: "search-webapp",
    genre: "verdict-card",
    summary_ko:
      "원장님 판정 카드 — PASS/더 확인/위험 3-state + 깨진 이유 + 검색 규칙 저장 (manual-approve modal 연동)",
    tags: ["판정", "PASS", "위험", "더 확인", "원장님", "검증", "규칙", "저장"],
    html: verdictCardHtml as unknown as string,
  },
];

export function getSkeletonsForTier(tier: SkeletonTier): Skeleton[] {
  return REGISTRY.filter((s) => s.tier === tier);
}

export function listTiers(): SkeletonTier[] {
  return Array.from(new Set(REGISTRY.map((s) => s.tier)));
}

export type { Skeleton, SkeletonTier } from "./types";
