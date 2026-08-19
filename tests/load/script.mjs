// The turn script a virtual student plays.
//
// Not invented. Every line below traces to a real source:
//   - guest roster + flow steps 1-7:
//       worker/src/prompts/sk-biopharm-kids-quest-3-4.md
//   - "[Studio 안내: 아이가 …]" prefix, verbatim shape:
//       extensions/hypeproof-chat/src/chatPanelProvider.ts:1368
//   - "[게스트 결과] 성공|실패 · k=v …" + the trailing instruction line:
//       extensions/hypeproof-chat/src/chatPanelProvider.ts:290
//
// Why it matters for LOAD (not just realism): steps 4 and 6 ("바꿔줘") make the
// coach re-emit a WHOLE index.html. Those are the multi-thousand-output-token
// turns that produced the dental p99 of 211s. A script that only chats would
// measure a class that does not exist.

import { pick } from "./rng.mjs";

/** The nine guests, from the prompt's table. */
export const GUESTS = [
  { emoji: "🐕", name: "초코", pick: "🐕 초코 세상에 가볼래", world: "flood:false hot:true", trouble: "마당이 너무 뜨거워요" },
  { emoji: "🐈", name: "나비", pick: "🐈 나비 세상에 가볼래", world: "flood:true", trouble: "골목이 물에 잠겨서 집에 못 가요" },
  { emoji: "🐝", name: "붕붕", pick: "🐝 붕붕 세상에 가볼래", world: "smog:true", trouble: "매연 때문에 꽃이 안 보여요" },
  { emoji: "🐧", name: "뽀로", pick: "🐧 뽀로 세상에 가볼래", world: "melt:true", trouble: "얼음이 자꾸 녹아서 집이 무너져요" },
  { emoji: "🐁", name: "찍찍", pick: "🐁 찍찍 세상에 가볼래", world: "dark:true", trouble: "하수구가 너무 캄캄해요" },
  { emoji: "🐹", name: "햄찌", pick: "🐹 햄찌 세상에 가볼래", world: "moles:true", trouble: "두더지가 새싹을 다 먹어요" },
  { emoji: "🦜", name: "앵무", pick: "🦜 앵무 세상에 가볼래", world: "noisy:true", trouble: "너무 시끄러워서 순서를 못 외워요" },
  { emoji: "🐿️", name: "도토", pick: "🐿️ 도토 세상에 가볼래", world: "windy:true", trouble: "바람에 밀려서 위로 못 올라가요" },
  { emoji: "🦝", name: "라쿤", pick: "🦝 라쿤 세상에 가볼래", world: "trash:true", trouble: "쓰레기가 너무 빨리 떠내려와요" },
];

/** Child-flavoured "what I want changed" ideas — the 나만 아는 것 step. */
const IDEAS = [
  "우리 집 강아지 초코도 나오게 해주세요",
  "제가 제일 좋아하는 딸기 아이스크림이 떨어지게 해주세요",
  "우리 아파트 화단처럼 꽃을 많이 심어주세요",
  "하늘을 분홍색 노을로 바꿔주세요",
  "친구 이름 지민이도 같이 나오게 해주세요",
];

/**
 * The exact prefix the Studio prepends when the child picks a guest.
 * chatPanelProvider.ts:1368 — kept byte-shaped so the cached system prefix and
 * the per-turn tail are the same size they will be in class.
 */
function studioNotice(guest) {
  return (
    `[Studio 안내: 아이가 ${guest.emoji} ${guest.name} 세상을 골랐고, Studio 가 그 세상(문제 상태 기본값)을 ` +
    `이미 작업 폴더 index.html 에 저장하고 오른쪽 화면에 띄웠다. 코드나 파일 도구 없이 — ` +
    `${guest.name}의 첫 대사 한 줄과 "한번 해보세요" 만 짧게 말해라. 이후 바꾸기 요청부터 index.html 을 Read 하고 고쳐라.]`
  );
}

/** chatPanelProvider.ts:290 — the quest-result line the Studio folds in. */
function questResult(ok, kv, attempt) {
  return (
    `[게스트 결과] ${ok ? "성공" : "실패"} · ${kv}` +
    (attempt > 1 ? ` · ${attempt}번째 시도` : "") +
    `\n위 결과를 게스트 목소리로 한 줄 반응한 뒤 아이에게 넘겨줘. 결과에 없는 숫자는 지어내지 마.`
  );
}

/**
 * Build one student's ordered user turns.
 *
 * `heavy: true` marks the turns that force a full-HTML re-emit — the reporter
 * splits latency by this flag, because mixing them hides both distributions.
 */
export function buildTurns(rng, turnCount) {
  const guest = pick(rng, GUESTS);
  const idea = pick(rng, IDEAS);

  const base = [
    // 1. Guest pick — Studio already rendered the world, coach says one line.
    { label: "pick", heavy: false, text: `${studioNotice(guest)}\n\n${guest.pick}` },
    // 2. Child tried it and failed. Coach asks (no code).
    { label: "tried", heavy: false, text: "해봤어요. 잘 안 됐어요" },
    // 3. Child names the problem in their own words.
    { label: "name-problem", heavy: false, text: guest.trouble },
    // 4. Child says how they want it changed (still no code).
    { label: "idea", heavy: false, text: idea },
    // 5. "바꿔줘" → whole index.html re-emitted. THE expensive turn.
    { label: "build-1", heavy: true, text: "그렇게 바꿔줘" },
    // 6. Child ran it, still failing.
    { label: "result-fail", heavy: false, text: questResult(false, `score=0 time=30 world=${guest.world}`, 1) },
    // 7. Second build — history is now long AND the output is long again.
    { label: "build-2", heavy: true, text: "너무 빨라요. 조금 느리게 하고 하늘도 분홍색으로 바꿔줘" },
    // 8. Success.
    { label: "result-ok", heavy: false, text: questResult(true, `score=7 time=30 world=${guest.world.replace("true", "false")}`, 2) },
  ];

  // Longer runs loop the build → try → build cycle, which is what a 4-hour
  // workshop actually is.
  const out = [];
  for (let i = 0; i < turnCount; i++) {
    if (i < base.length) {
      out.push({ ...base[i], idx: i });
    } else {
      const even = (i - base.length) % 2 === 0;
      out.push(
        even
          ? { label: `build-${Math.floor((i - base.length) / 2) + 3}`, heavy: true, idx: i, text: "더 재밌게 바꿔줘. 새로운 것도 하나 넣어줘" }
          : { label: `result-${i}`, heavy: false, idx: i, text: questResult(true, `score=${9 + i} time=30 world=${guest.world.replace("true", "false")}`, 1) },
      );
    }
  }
  return { guest, turns: out };
}
