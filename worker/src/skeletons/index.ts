import type { Skeleton, SkeletonTier } from "./types";
// @ts-ignore — bundled as text by wrangler [[rules]] (globs **/*.html)
import catcherHtml from "./kids-basic/catcher.html";
// @ts-ignore
import jumperHtml from "./kids-basic/jumper.html";
// @ts-ignore
import dodgeHtml from "./kids-basic/dodge.html";
// @ts-ignore
import kqCatcherHtml from "./kids-quest/catcher.html";
// @ts-ignore
import kqRunnerHtml from "./kids-quest/runner.html";
// @ts-ignore
import kqCollectHtml from "./kids-quest/collect.html";
// @ts-ignore
import kqStackHtml from "./kids-quest/stack.html";
// @ts-ignore
import kqRunHtml from "./kids-quest/run.html";
// @ts-ignore
import kqWhackHtml from "./kids-quest/whack.html";
// @ts-ignore
import kqMemoryHtml from "./kids-quest/memory.html";
// @ts-ignore
import kqJumpHtml from "./kids-quest/jump.html";
// @ts-ignore
import kqSortHtml from "./kids-quest/sort.html";
// @ts-ignore
import dentalV1Html from "./search-webapp/dental-v1.html";
// @ts-ignore
import verdictCardHtml from "./search-webapp/verdict-card.html";

const REGISTRY: Skeleton[] = [
  // ─── kids-quest tier — 게스트 퀘스트 (SK 2026-08-22 워크숍 산출물) ─────────
  // 게스트(NPC)가 문제를 말하고, 아이가 스켈레톤을 골라 CONFIG(룰 숫자·오브젝트·
  // 배경)를 말로 바꾼다. 결과는 스켈레톤이 `hp:result` 로 부모창에 보내고 코치가
  // 게스트 목소리로 반응한다. 10개 모두 같은 자리표시자 규격(curriculum/quests/QUESTS.md).
  // 핵심 조작이 서로 겹치지 않게 고른다: 받기·횡스크롤 점프·모으기·쌓기·톱다운 달리기(쫓김)·반응·기억·수직 점프(두들점프)·분류. 전부 320×180 도트 엔진(R42). dodge·maze·water 는 겹치거나 심심해서 교체.
  {
    id: "kq-catcher",
    tier: "kids-quest",
    genre: "catcher",
    summary_ko:
      "🐕 초코 · 더위 — 위에서 떨어지는 시원한 것(ITEM_A)을 받고 뜨거운 것(ITEM_B)은 피한다. SPECIAL=목숨(LIVES)",
    tags: ["초코", "강아지", "더워", "덥다", "받기", "떨어지는", "시원한", "얼음", "아이스크림", "받아먹기"],
    html: kqCatcherHtml as unknown as string,
  },
  {
    id: "kq-runner",
    tier: "kids-quest",
    genre: "runner",
    summary_ko:
      "🐈 나비 · 밤이 무서워 — 어두운 길을 달리며 장애물(ITEM_B)을 점프로 넘어 집(ITEM_A)까지 간다. SPECIAL=밝기(LIGHT, 장애물이 보이는 거리)",
    tags: ["나비", "고양이", "밤", "무서워", "어두워", "달리기", "점프", "집", "길", "가로등", "별"],
    html: kqRunnerHtml as unknown as string,
  },
  {
    id: "kq-collect",
    tier: "kids-quest",
    genre: "collect",
    summary_ko:
      "🐝 붕붕 · 꽃을 못 찾아 — 날아다니며 흩어진 것(ITEM_A)을 시간 안에 모은다. 방해꾼(ITEM_B). RATE=흩어짐, SPECIAL=제한시간(TIME초, 0=무제한)",
    tags: ["붕붕", "꿀벌", "벌", "꽃", "꿀", "모으기", "찾기", "날기", "화단", "시간"],
    html: kqCollectHtml as unknown as string,
  },
  {
    id: "kq-stack",
    tier: "kids-quest",
    genre: "stack",
    summary_ko:
      "🐧 뽀로 · 집이 무너져 — 좌우로 움직이는 블록(ITEM_A)을 타이밍 맞춰 GOAL층 쌓는다. 완성하면 지붕(ITEM_B). SPECIAL=삐뚤어도 봐주는 정도(TOLERANCE)",
    tags: ["뽀로", "펭귄", "얼음", "집", "쌓기", "블록", "무너져", "탑", "층", "타이밍"],
    html: kqStackHtml as unknown as string,
  },
  {
    id: "kq-run",
    tier: "kids-quest",
    genre: "run",
    summary_ko:
      "🐁 찍찍 · 캄캄한 하수구 — 위에서 내려다보는 자동 달리기(3레인). ←→ 로 길 바꾸기, 스페이스로 웅덩이(ITEM_B) 점프, 뒤에서 물이 밀려온다. SPEED=뒤 물 빠르기, RATE=웅덩이·막힌 길 빈도, GOAL=미터, SPECIAL=밝기",
    tags: ["찍찍", "생쥐", "쥐", "하수구", "달리기", "도망", "물", "웅덩이", "치즈", "어두워", "터널"],
    html: kqRunHtml as unknown as string,
  },
  {
    id: "kq-whack",
    tier: "kids-quest",
    genre: "whack",
    summary_ko:
      "🐹 햄찌 · 두더지가 새싹을 갉아먹어 — 구멍에서 나오는 것(ITEM_A)을 클릭으로 잡는다, 잡으면 안 되는 것(ITEM_B). SPEED=나왔다 들어가는 빠르기, RATE=한 번에 몇 마리, GOAL=몇 마리, SPECIAL=제한시간",
    tags: ["햄찌", "햄스터", "두더지", "새싹", "잡기", "콩", "반응", "빨라", "클릭", "탭"],
    html: kqWhackHtml as unknown as string,
  },
  {
    id: "kq-memory",
    tier: "kids-quest",
    genre: "memory",
    summary_ko:
      "🦜 앵무 · 노래 순서를 잊어 — 불빛 순서를 보고 똑같이 누른다(순서 기억). SPEED=불빛 빠르기, RATE=단추 개수 2~6, GOAL=몇 단계까지, SPECIAL=틀려도 되는 횟수",
    tags: ["앵무", "앵무새", "노래", "순서", "기억", "외우기", "따라하기", "잊어버려", "음악"],
    html: kqMemoryHtml as unknown as string,
  },
  {
    id: "kq-jump",
    tier: "kids-quest",
    genre: "jump",
    summary_ko:
      "🐿️ 도토 · 부러진 나무 — 발판(가지)을 밟고 위로 튀어오른다(두들점프). ←→ 좌우, 부러지는 가지·바람·안개. SPEED=바람, RATE=발판 간격, GOAL=미터, SPECIAL=부러지는 발판 비율",
    tags: ["도토", "다람쥐", "나무", "가지", "점프", "위로", "올라가기", "바람", "도토리", "부러져"],
    html: kqJumpHtml as unknown as string,
  },
  {
    id: "kq-sort",
    tier: "kids-quest",
    genre: "sort",
    summary_ko:
      "🦝 라쿤 · 쓰레기가 섞여 — 나오는 것을 왼쪽 통(ITEM_A)/오른쪽 통(ITEM_B)으로 판단해 보낸다, 둘 다 아닌 건 기다린다(분류). SPEED=다음 것 오는 빠르기, RATE=헷갈리는 것 비율, GOAL=몇 개, SPECIAL=틀려도 되는 횟수",
    tags: ["라쿤", "너구리", "쓰레기", "분리수거", "냇물", "캔", "병", "나누기", "고르기", "왼쪽", "오른쪽", "판단"],
    html: kqSortHtml as unknown as string,
  },
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
