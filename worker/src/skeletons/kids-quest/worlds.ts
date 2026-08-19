// 게스트의 세상 — 사전 완성본 (2026-08-19).
//
// 왜: 아이가 게스트를 고르면 코치가 5KB HTML 을 생성·저장하느라 첫 턴이 30~40초
// 걸렸다(실기기). 문제 상태 기본값은 정해져 있으니 워커가 미리 채워 두고,
// Studio 가 GET /v1/worlds/:id 로 받아 **즉시** 띄운다. 코치는 게스트 첫 대사만 한다.
// 값의 정본은 curriculum/quests/WORLDS.md 와 각 스켈레톤 CONFIG 주석("문제 세상 N").
import { getSkeletonsForTier } from "../index";
import { ENGINE_JS } from "./engineJs";

export interface WorldDef {
  /** 스켈레톤 id (kq-*) */
  id: string;
  guest: string;
  emoji: string;
  /** 첫 화면 칩 문구 — 확장이 이 문구(또는 게스트 이름+세상)로 매칭한다 */
  chip: string;
  /** 게스트 이름 외에 매칭할 별칭. 2글자 이상만 — "쥐" 가 "다람쥐" 에 걸려 오매칭했다. */
  aliases: string[];
  /** 한 줄 소개 — "다른 친구도 있어?" 에 앱이 즉시 답한다(LLM 왕복 없음). */
  line: string;
  fill: Record<string, string>;
}

const G = (guest: string, emoji: string, aliases: string[], line: string) =>
  ({ guest, emoji, chip: `${emoji} ${guest} 세상에 가볼래`, aliases, line });

export const WORLDS: WorldDef[] = [
  { id: "kq-catcher", ...G("초코", "🐕", ["강아지", "마당"], "마당이 너무 뜨거워"), fill: { TITLE: "초코의 불볕 마당", GUEST_EMOJI: "🐕", GUEST_NAME: "초코", GUEST_LINE: "헥헥… 마당이 너무 뜨거워. 시원한 게 하나도 안 떨어져. 불덩이만 떨어져…", PLAYER_EMOJI: "🐕", ITEM_A: "", ITEM_B: "🔥", SPEED: "6", RATE: "6", GOAL: "8", SPECIAL: "1", BG_TOP: "#ff6a00", BG_BOT: "#ffb347" } },
  { id: "kq-runner", ...G("나비", "🐈", ["고양이", "골목"], "골목이 물에 잠겼어"), fill: { TITLE: "나비의 물난리 골목", GUEST_EMOJI: "🐈", GUEST_NAME: "나비", GUEST_LINE: "골목이 물에 잠겼어… 비는 계속 오고, 통나무가 떠내려와. 집에 못 가겠어…", PLAYER_EMOJI: "🐈", ITEM_A: "🏠", ITEM_B: "🪵", SPEED: "4", RATE: "6", GOAL: "15", SPECIAL: "2", BG_TOP: "#1a2233", BG_BOT: "#334a66" } },
  { id: "kq-collect", ...G("붕붕", "🐝", ["꿀벌", "꽃밭"], "매연에 꽃이 다 시들었어"), fill: { TITLE: "붕붕의 매연 꽃밭", GUEST_EMOJI: "🐝", GUEST_NAME: "붕붕", GUEST_LINE: "꽃밭에 매연이 껴서 앞이 안 보여… 꽃도 다 시들어서 꿀이 안 나와…", PLAYER_EMOJI: "🐝", ITEM_A: "🥀", ITEM_B: "🏭", SPEED: "5", RATE: "6", GOAL: "8", SPECIAL: "30", BG_TOP: "#6b6b6b", BG_BOT: "#9a9a8a" } },
  { id: "kq-stack", ...G("뽀로", "🐧", ["펭귄", "얼음"], "해가 뜨거워 얼음집이 녹아"), fill: { TITLE: "뽀로의 녹는 얼음집", GUEST_EMOJI: "🐧", GUEST_NAME: "뽀로", GUEST_LINE: "집이 무너졌어… 얼음을 쌓는데 해가 너무 뜨거워서 쌓는 족족 녹아…", PLAYER_EMOJI: "🐧", ITEM_A: "🧊", ITEM_B: "🏠", SPEED: "4", RATE: "0", GOAL: "8", SPECIAL: "0", BG_TOP: "#ffb347", BG_BOT: "#7fb3d5" } },
  { id: "kq-run", ...G("찍찍", "🐁", ["생쥐", "하수구"], "캄캄한데 뒤에서 물이 밀려와"), fill: { TITLE: "찍찍의 캄캄한 하수구", GUEST_EMOJI: "🐁", GUEST_NAME: "찍찍", GUEST_LINE: "하수구가 너무 캄캄해… 웅덩이도 많고, 뒤에서 물이 밀려와. 치즈까지 어떻게 가지…", PLAYER_EMOJI: "🐁", ITEM_A: "🧀", ITEM_B: "💧", SPEED: "6", RATE: "6", GOAL: "60", SPECIAL: "1", BG_TOP: "#111318", BG_BOT: "#23262f" } },
  { id: "kq-whack", ...G("햄찌", "🐹", ["햄스터", "텃밭", "두더지"], "두더지가 새싹을 다 먹어"), fill: { TITLE: "햄찌의 두더지 텃밭", GUEST_EMOJI: "🐹", GUEST_NAME: "햄찌", GUEST_LINE: "텃밭에 두더지가 떼로 나와서 새싹을 다 먹어… 너무 많고 너무 빨라…", PLAYER_EMOJI: "🐹", ITEM_A: "🐭", ITEM_B: "🐝", SPEED: "7", RATE: "4", GOAL: "15", SPECIAL: "30", BG_TOP: "#3a5a2c", BG_BOT: "#7fa86b" } },
  { id: "kq-memory", ...G("앵무", "🦜", ["앵무새", "숲"], "너무 시끄러워 노래를 못 외워"), fill: { TITLE: "앵무의 시끄러운 숲", GUEST_EMOJI: "🦜", GUEST_NAME: "앵무", GUEST_LINE: "숲이 너무 시끄러워… 노래 순서를 보여줘도 다른 게 막 깜빡여서 뭐가 진짜인지 모르겠어…", PLAYER_EMOJI: "🦜", ITEM_A: "🎵", ITEM_B: "⭐", SPEED: "8", RATE: "4", GOAL: "5", SPECIAL: "1", BG_TOP: "#1b2340", BG_BOT: "#3a4a80" } },
  { id: "kq-jump", ...G("도토", "🐿️", ["다람쥐", "도토리", "나무"], "가지가 부러져 위로 못 올라가"), fill: { TITLE: "도토의 부러진 나무", GUEST_EMOJI: "🐿️", GUEST_NAME: "도토", GUEST_LINE: "폭풍이 지나가서 나뭇가지가 다 부러졌어… 도토리집은 저 위인데, 밟으면 부러지고 바람에 자꾸 밀려…", PLAYER_EMOJI: "🐿️", ITEM_A: "🌰", ITEM_B: "🍂", SPEED: "6", RATE: "6", GOAL: "30", SPECIAL: "7", BG_TOP: "#3a4a5c", BG_BOT: "#8fa3b3" } },
  { id: "kq-sort", ...G("라쿤", "🦝", ["너구리", "냇물"], "쓰레기가 빨리 와 냇물이 더러워"), fill: { TITLE: "라쿤의 쓰레기 냇물", GUEST_EMOJI: "🦝", GUEST_NAME: "라쿤", GUEST_LINE: "냇물에 쓰레기가 자꾸 떠내려와… 캔은 왼쪽 통, 병은 오른쪽 통에 넣어야 하는데 너무 빨라. 못 건지면 물고기가 사라져…", PLAYER_EMOJI: "🦝", ITEM_A: "🥫", ITEM_B: "🍾", SPEED: "8", RATE: "6", GOAL: "12", SPECIAL: "2", BG_TOP: "#5a4a3a", BG_BOT: "#8a7a5a" } },
];

/** 클라이언트에 내려주는 목록 (html 없음). */
export function listWorlds(): Array<Pick<WorldDef, "id" | "guest" | "emoji" | "chip" | "aliases" | "line">> {
  return WORLDS.map(({ id, guest, emoji, chip, aliases, line }) => ({ id, guest, emoji, chip, aliases, line }));
}

/**
 * 공용 도트 엔진 + 스프라이트 (9개 세상이 같은 파일을 쓴다).
 * 2026-08-19 — index.html 에서 떼어냈다: 코치가 매 턴 12KB(스프라이트 맵 포함)를
 * 읽고 그 안을 고치다 생성이 폭주했다(#629). 이제 코치가 보는 파일은 세상 코드뿐이다.
 */
export function renderEngine(): string {
  return ENGINE_JS;
}

/**
 * 그 세상만의 엔진 (2026-08-20, 컨텍스트 오염 대책).
 *
 * 공용 engine.js 에는 9개 세상의 스프라이트가 전부 들어 있다(S_PENG 펭귄, S_ICE 얼음,
 * S_RAC 너구리…). 작업 폴더 파일 목록은 코치에게 전달되므로, 코치가 그 파일을 한 번
 * 읽으면 **남의 세상 이야기가 섞인다** — 실기기: 초코(강아지) 세상에서 점수판을
 * 부탁했더니 얼음을 꺼냈다. 프롬프트로 "읽지 마라" 라고 막는 건 확률적이다.
 *
 * 그래서 파일 자체에서 없앤다: 이 세상 HTML 이 실제로 쓰는 `S_*` 만 남긴다.
 * 남는 것은 엔진 함수 + 그 세상 그림뿐 — 읽어도 오염될 내용이 없다.
 */
export function renderEngineFor(id: string): string | null {
  const html = renderWorld(id);
  if (!html) return null;
  const engine = ENGINE_JS;
  const used = new Set<string>();
  for (const m of html.matchAll(/\bS_[A-Z_]+/g)) if (m[0]) used.add(m[0]);
  // 엔진 안에서 서로 참조하는 스프라이트도 함께 남긴다(예: 배열 안 다른 이름).
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of engine.matchAll(/^const (S_[A-Z_]+)=(.*)$/gm)) {
      const name = m[1];
      const body = m[2] ?? "";
      if (!name || !used.has(name)) continue;
      for (const r of body.matchAll(/\bS_[A-Z_]+/g)) {
        const ref = r[0];
        if (ref && !used.has(ref)) { used.add(ref); grew = true; }
      }
    }
  }
  const kept: string[] = [];
  for (const lineText of engine.split("\n")) {
    const decl = /^const (S_[A-Z_]+)=/.exec(lineText);
    if (decl && decl[1] && !used.has(decl[1])) continue;
    kept.push(lineText);
  }
  return kept.join("\n");
}

/** 자리표시자를 문제 상태 기본값으로 채운 완전한 HTML. 모르는 id 면 null. */
export function renderWorld(id: string): string | null {
  const w = WORLDS.find((x) => x.id === id);
  if (!w) return null;
  const sk = getSkeletonsForTier("kids-quest").find((s) => s.id === id);
  if (!sk) return null;
  let html = sk.html;
  for (const [k, v] of Object.entries(w.fill)) html = html.split(`%%${k}%%`).join(v);
  if (/%%[A-Z_]+%%/.test(html)) throw new Error(`world ${id}: unfilled placeholder`);
  return html;
}

/** 아이의 말에서 세상을 고른다 — 칩 문구 그대로, 또는 게스트 이름/별칭 + 세상 표현. */
export function matchWorld(text: string): WorldDef | null {
  const t = text.trim();
  const bare = t.replace(/[!?.\u2026~\s]/g, "");
  // 1) 칩 그대로 · 이름만 · 이모지만 — 아이가 "도토!" 한 마디만 해도 잡는다.
  //    2026-08-19 실측: 이름만 치면 MISS 라 사전완성본(0.45초 GET) 대신 코치가
  //    직접 만들어 몇 분씩 걸렸다. 빠른 경로를 놓치는 것이 곧 느림이다.
  for (const w of WORLDS) {
    if (t === w.chip || t === w.chip.replace(/^\S+\s/, "")) return w;
    if (bare === w.guest || bare === w.emoji || bare === w.emoji + w.guest) return w;
  }
  // 2) 가겠다는 표현 + 이름·이모지·별칭 (별칭은 2글자 이상 — "쥐" 가 "다람쥐" 를 먹었다)
  if (!/세상|가볼래|들어가|가보자|보여줘|만나볼래|얘기|한테|에게|고를래|할래/.test(t)) return null;
  for (const w of WORLDS) if (t.includes(w.guest) || t.includes(w.emoji)) return w;
  for (const w of WORLDS) if (w.aliases.some((a) => a.length >= 2 && t.includes(a))) return w;
  return null;
}
