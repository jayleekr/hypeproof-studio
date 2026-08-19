// 게스트의 세상 — 사전 완성본 (2026-08-19).
//
// 왜: 아이가 게스트를 고르면 코치가 5KB HTML 을 생성·저장하느라 첫 턴이 30~40초
// 걸렸다(실기기). 문제 상태 기본값은 정해져 있으니 워커가 미리 채워 두고,
// Studio 가 GET /v1/worlds/:id 로 받아 **즉시** 띄운다. 코치는 게스트 첫 대사만 한다.
// 값의 정본은 curriculum/quests/WORLDS.md 와 각 스켈레톤 CONFIG 주석("문제 세상 N").
import { getSkeletonsForTier } from "../index";

export interface WorldDef {
  /** 스켈레톤 id (kq-*) */
  id: string;
  guest: string;
  emoji: string;
  /** 첫 화면 칩 문구 — 확장이 이 문구(또는 게스트 이름+세상)로 매칭한다 */
  chip: string;
  /** 게스트 이름 외에 매칭할 별칭 (예: 강아지) */
  aliases: string[];
  fill: Record<string, string>;
}

const G = (guest: string, emoji: string, aliases: string[]) => ({ guest, emoji, chip: `${emoji} ${guest} 세상에 가볼래`, aliases });

export const WORLDS: WorldDef[] = [
  { id: "kq-catcher", ...G("초코", "🐕", ["강아지", "마당"]), fill: { TITLE: "초코의 불볕 마당", GUEST_EMOJI: "🐕", GUEST_NAME: "초코", GUEST_LINE: "헥헥… 마당이 너무 뜨거워. 시원한 게 하나도 안 떨어져. 불덩이만 떨어져…", PLAYER_EMOJI: "🐕", ITEM_A: "", ITEM_B: "🔥", SPEED: "6", RATE: "6", GOAL: "8", SPECIAL: "1", BG_TOP: "#ff6a00", BG_BOT: "#ffb347" } },
  { id: "kq-runner", ...G("나비", "🐈", ["고양이", "골목"]), fill: { TITLE: "나비의 물난리 골목", GUEST_EMOJI: "🐈", GUEST_NAME: "나비", GUEST_LINE: "골목이 물에 잠겼어… 비는 계속 오고, 통나무가 떠내려와. 집에 못 가겠어…", PLAYER_EMOJI: "🐈", ITEM_A: "🏠", ITEM_B: "🪵", SPEED: "4", RATE: "6", GOAL: "15", SPECIAL: "2", BG_TOP: "#1a2233", BG_BOT: "#334a66" } },
  { id: "kq-collect", ...G("붕붕", "🐝", ["꿀벌", "벌", "꽃밭"]), fill: { TITLE: "붕붕의 매연 꽃밭", GUEST_EMOJI: "🐝", GUEST_NAME: "붕붕", GUEST_LINE: "꽃밭에 매연이 껴서 앞이 안 보여… 꽃도 다 시들어서 꿀이 안 나와…", PLAYER_EMOJI: "🐝", ITEM_A: "🥀", ITEM_B: "🏭", SPEED: "5", RATE: "6", GOAL: "8", SPECIAL: "30", BG_TOP: "#6b6b6b", BG_BOT: "#9a9a8a" } },
  { id: "kq-stack", ...G("뽀로", "🐧", ["펭귄", "얼음"]), fill: { TITLE: "뽀로의 녹는 얼음집", GUEST_EMOJI: "🐧", GUEST_NAME: "뽀로", GUEST_LINE: "집이 무너졌어… 얼음을 쌓는데 해가 너무 뜨거워서 쌓는 족족 녹아…", PLAYER_EMOJI: "🐧", ITEM_A: "🧊", ITEM_B: "🏠", SPEED: "4", RATE: "0", GOAL: "8", SPECIAL: "0", BG_TOP: "#ffb347", BG_BOT: "#7fb3d5" } },
  { id: "kq-maze", ...G("찍찍", "🐁", ["생쥐", "쥐", "하수구"]), fill: { TITLE: "찍찍의 캄캄한 하수구", GUEST_EMOJI: "🐁", GUEST_NAME: "찍찍", GUEST_LINE: "하수구가 너무 캄캄해… 웅덩이도 많고. 치즈까지 어떻게 가지…", PLAYER_EMOJI: "🐁", ITEM_A: "🧀", ITEM_B: "💧", SPEED: "6", RATE: "5", GOAL: "60", SPECIAL: "1", BG_TOP: "#111318", BG_BOT: "#23262f" } },
  { id: "kq-whack", ...G("햄찌", "🐹", ["햄스터", "텃밭", "두더지"]), fill: { TITLE: "햄찌의 두더지 텃밭", GUEST_EMOJI: "🐹", GUEST_NAME: "햄찌", GUEST_LINE: "텃밭에 두더지가 떼로 나와서 새싹을 다 먹어… 너무 많고 너무 빨라…", PLAYER_EMOJI: "🐹", ITEM_A: "🐭", ITEM_B: "🐝", SPEED: "7", RATE: "4", GOAL: "15", SPECIAL: "30", BG_TOP: "#3a5a2c", BG_BOT: "#7fa86b" } },
  { id: "kq-memory", ...G("앵무", "🦜", ["앵무새", "숲"]), fill: { TITLE: "앵무의 시끄러운 숲", GUEST_EMOJI: "🦜", GUEST_NAME: "앵무", GUEST_LINE: "숲이 너무 시끄러워… 노래 순서를 보여줘도 다른 게 막 깜빡여서 뭐가 진짜인지 모르겠어…", PLAYER_EMOJI: "🦜", ITEM_A: "🎵", ITEM_B: "⭐", SPEED: "8", RATE: "4", GOAL: "5", SPECIAL: "1", BG_TOP: "#1b2340", BG_BOT: "#3a4a80" } },
  { id: "kq-water", ...G("해바", "🌻", ["해바라기", "꽃", "화분"]), fill: { TITLE: "해바의 가뭄 화분", GUEST_EMOJI: "🌻", GUEST_NAME: "해바", GUEST_LINE: "가뭄이야… 해가 계속 떠서 물을 줘도 금방 말라. 물뿌리개도 너무 작아…", PLAYER_EMOJI: "🌻", ITEM_A: "💧", ITEM_B: "☀️", SPEED: "8", RATE: "2", GOAL: "20", SPECIAL: "2", BG_TOP: "#ffb347", BG_BOT: "#e0c080" } },
  { id: "kq-sort", ...G("라쿤", "🦝", ["너구리", "냇물"]), fill: { TITLE: "라쿤의 쓰레기 냇물", GUEST_EMOJI: "🦝", GUEST_NAME: "라쿤", GUEST_LINE: "냇물에 쓰레기가 자꾸 떠내려와… 캔은 왼쪽 통, 병은 오른쪽 통에 넣어야 하는데 너무 빨라. 못 건지면 물고기가 사라져…", PLAYER_EMOJI: "🦝", ITEM_A: "🥫", ITEM_B: "🍾", SPEED: "8", RATE: "6", GOAL: "12", SPECIAL: "2", BG_TOP: "#5a4a3a", BG_BOT: "#8a7a5a" } },
];

/** 클라이언트에 내려주는 목록 (html 없음). */
export function listWorlds(): Array<Pick<WorldDef, "id" | "guest" | "emoji" | "chip" | "aliases">> {
  return WORLDS.map(({ id, guest, emoji, chip, aliases }) => ({ id, guest, emoji, chip, aliases }));
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
  for (const w of WORLDS) if (t === w.chip || t === w.chip.replace(/^\S+\s/, "")) return w;
  const wantsWorld = /세상|가볼래|들어가|가보자|보여줘|만나볼래|얘기/.test(t);
  if (!wantsWorld) return null;
  for (const w of WORLDS) if (t.includes(w.guest) || t.includes(w.emoji) || w.aliases.some((a) => t.includes(a))) return w;
  return null;
}
