// #503 — 대화와 툴 실행을 **하나의 타임라인**으로 합치는 순수 리듀서.
//
// 왜 이 모듈이 별도로 있나: 같은 규칙을 두 곳이 써야 한다.
//   · 웹뷰(App.tsx)   — 스트리밍 중 화면에 그리는 순서
//   · 호스트(chatPanelProvider) — 그 순서 그대로 workspaceState 에 영속화
// 규칙이 두 벌이면 "창을 다시 열면 순서가 달라지는" 증상이 다시 생긴다. 그리고
// 순수 함수라 vscode/React 없이 대조군 테스트로 잠글 수 있다
// (.claude/rules/verification.md §2 — 양성/음성 대조군).
//
// 순서의 출처: 툴 로그와 텍스트 델타는 **같은 postMessage 채널**로 도착순 그대로
// 온다. 별도 시퀀스 번호를 발명하지 않는 이유는 그것으로 충분하기 때문이다 —
// 2026-07-28 벤더 SDK(@anthropic-ai/claude-agent-sdk 0.3.207) 실측에서 assistant
// 메시지 12개 전수의 `message.content` 길이가 1이었다. SDK 는 하나의 API 메시지를
// thinking / text / tool_use 세 개의 SDK 메시지로 **쪼개서 순서대로** 내보내므로,
// 한 메시지가 텍스트와 툴을 동시에 내는 일이 없다. 즉 도착순 = 발생순이다.

import type { ChatMessage } from "./protocol";

export interface ToolEntry {
  id: string;
  icon: string;
  label: string;
  state: "running" | "done" | "error";
  /** SDK 가 실어 보낸 자기 시각(ISO). 없으면 호출자가 시계를 준다. */
  at?: number;
}

export interface TimelineState {
  /** 화면에 그려지는 단일 타임라인. user / assistant / tool 이 섞여 있다. */
  items: ChatMessage[];
  /** 지금 텍스트가 쌓이고 있는 어시스턴트 말풍선. 닫혀 있으면 null. */
  openId: string | null;
  /** 이 스트림의 말풍선 id 접두사(= streamStart 의 messageId). */
  baseId: string | null;
  /** 이 스트림에서 연 말풍선 수 — 두 번째부터 `${baseId}#2` 로 나뉜다. */
  seg: number;
  /**
   * 코드펜스가 아직 안 닫힌 동안 도착한 툴. 지금 말풍선을 끊으면 ```html 펜스가
   * 두 말풍선에 걸쳐 `extractRenderableHtml` 이 못 찾는다 → REQ-D2(자동 프리뷰)가
   * 죽는다. 펜스가 닫히거나 스트림이 끝날 때 순서 그대로 흘려 넣는다.
   */
  pending: ToolEntry[];
}

export const emptyTimeline = (): TimelineState => ({
  items: [],
  openId: null,
  baseId: null,
  seg: 0,
  pending: [],
});

/** 열려 있는(짝이 안 맞는) 코드펜스가 있나. ``` 개수가 홀수면 열려 있다. */
export function hasOpenFence(text: string): boolean {
  const fences = text.match(/```/g);
  return !!fences && fences.length % 2 === 1;
}

function toolMessage(e: ToolEntry, now: number): ChatMessage {
  return {
    id: e.id,
    role: "tool",
    content: "",
    createdAt: e.at ?? now,
    tool: { icon: e.icon, label: e.label, state: e.state },
  };
}

/** 열린 말풍선을 닫는다. 내용이 비어 있으면 흔적을 남기지 않고 지운다. */
function closeOpen(state: TimelineState): TimelineState {
  if (!state.openId) return state;
  const open = state.items.find((m) => m.id === state.openId);
  const items =
    open && open.content.length === 0
      ? state.items.filter((m) => m.id !== state.openId)
      : state.items;
  return { ...state, items, openId: null };
}

/** 보류 중인 툴을 순서대로 타임라인에 붙인다(= 말풍선도 닫힌다). */
function flushPending(state: TimelineState, now: number): TimelineState {
  if (state.pending.length === 0) return state;
  const closed = closeOpen(state);
  return {
    ...closed,
    items: [...closed.items, ...state.pending.map((e) => toolMessage(e, now))],
    pending: [],
  };
}

/** 새 턴 시작. 빈 어시스턴트 말풍선을 열어 스피너가 붙을 자리를 만든다. */
export function timelineStart(
  state: TimelineState,
  messageId: string,
  now: number,
): TimelineState {
  return {
    ...state,
    items: [
      ...state.items,
      { id: messageId, role: "assistant", content: "", createdAt: now },
    ],
    openId: messageId,
    baseId: messageId,
    seg: 1,
    pending: [],
  };
}

/**
 * 텍스트 델타. 열린 말풍선이 없으면(직전에 툴이 말풍선을 끊었다면) **새 말풍선을
 * 연다** — 이게 [말풍선] → [툴] → [말풍선] 을 만드는 지점이다.
 */
export function timelineDelta(
  state: TimelineState,
  delta: string,
  now: number,
): TimelineState {
  let next = state;
  if (!next.openId) {
    const seg = next.seg + 1;
    const id = next.baseId ? `${next.baseId}#${seg}` : `seg-${now}-${seg}`;
    next = {
      ...next,
      items: [...next.items, { id, role: "assistant", content: "", createdAt: now }],
      openId: id,
      seg,
    };
  }
  next = {
    ...next,
    items: next.items.map((m) =>
      m.id === next.openId ? { ...m, content: m.content + delta } : m,
    ),
  };
  // 펜스가 닫혔으면 그동안 참았던 툴을 지금 흘려 넣는다.
  const open = next.items.find((m) => m.id === next.openId);
  if (next.pending.length > 0 && open && !hasOpenFence(open.content)) {
    next = flushPending(next, now);
  }
  return next;
}

/**
 * 툴 한 줄. 같은 id 가 이미 있으면 제자리에서 갱신한다(running → done/error).
 * 새 툴이면 열린 말풍선을 닫고 그 **아래**에 놓는다 — 단, 펜스가 열려 있으면
 * 보류한다.
 */
export function timelineTool(
  state: TimelineState,
  entry: ToolEntry,
  now: number,
): TimelineState {
  const known = state.items.some((m) => m.id === entry.id && m.role === "tool");
  if (known) {
    return {
      ...state,
      items: state.items.map((m) =>
        m.id === entry.id && m.role === "tool" ? toolMessage(entry, m.createdAt) : m,
      ),
    };
  }
  if (state.pending.some((p) => p.id === entry.id)) {
    return {
      ...state,
      pending: state.pending.map((p) => (p.id === entry.id ? { ...p, ...entry } : p)),
    };
  }
  const open = state.openId ? state.items.find((m) => m.id === state.openId) : undefined;
  if (open && hasOpenFence(open.content)) {
    return { ...state, pending: [...state.pending, entry] };
  }
  const closed = closeOpen(state);
  return { ...closed, items: [...closed.items, toolMessage(entry, now)] };
}

/** 인용을 열린 말풍선에(없으면 마지막 어시스턴트 말풍선에) 붙인다. */
export function timelineCitations(
  state: TimelineState,
  citations: NonNullable<ChatMessage["citations"]>,
): TimelineState {
  let targetId = state.openId;
  if (!targetId) {
    for (let i = state.items.length - 1; i >= 0; i--) {
      if (state.items[i].role === "assistant") {
        targetId = state.items[i].id;
        break;
      }
    }
  }
  if (!targetId) return state;
  return {
    ...state,
    items: state.items.map((m) =>
      m.id === targetId ? { ...m, citations: [...(m.citations ?? []), ...citations] } : m,
    ),
  };
}

/** 턴 종료. 펜스가 끝내 안 닫혔더라도 보류분은 반드시 흘려 넣는다. */
export function timelineEnd(state: TimelineState, now: number): TimelineState {
  const flushed = flushPending(state, now);
  return { ...closeOpen(flushed), baseId: null, seg: 0 };
}

/** 히스토리 교체 / Clear — 타임라인을 통째로 갈아끼운다. */
export function timelineReset(items: ChatMessage[]): TimelineState {
  return { ...emptyTimeline(), items };
}

/**
 * 모델에 보내는 히스토리에서 툴 줄을 걷어낸다. 툴 아이템은 화면과 영속화의
 * 것이지 모델 컨텍스트의 것이 아니다 — user/assistant 만 아는 프록시·SDK 게이트웨이에
 * `role:"tool"` 이 섞여 들어가면 400 이거나 조용히 무시된다.
 */
export function modelHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role === "user" || m.role === "assistant");
}

/**
 * 이번 턴에 툴 활동이 있었나(마지막 사용자 메시지 이후 기준). 스피너가 가짜
 * 단계를 지어내지 않게 하는 #414 신호 — 직전 턴의 툴까지 세면 새 턴에서 활동이
 * 없는데도 활동이 있다고 잘못 말하게 된다.
 */
export function hasActivityThisTurn(messages: ChatMessage[]): boolean {
  let from = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      from = i + 1;
      break;
    }
  }
  for (let i = from; i < messages.length; i++) {
    if (messages[i].role === "tool") return true;
  }
  return false;
}

/**
 * #503 — 히스토리 상한. 툴 줄이 기록의 일부가 되면서 "메시지 200개"를 그대로
 * 세면 SDK 턴 한 번이 수십 줄을 먹어 **대화가 서너 턴 만에 잘려 나간다**. 상한은
 * 지금까지대로 **말한 것(user/assistant) 기준**으로 세고, 그 구간에 섞인 툴 줄은
 * 덤으로 함께 남긴다. 잘린 턴에 딸린 앞머리 툴 줄은 주인 없는 줄이라 버린다.
 */
export function clampTimeline(items: ChatMessage[], maxSpoken: number): ChatMessage[] {
  if (maxSpoken <= 0) return [];
  let spoken = 0;
  let cut = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].role === "tool") continue;
    spoken += 1;
    if (spoken > maxSpoken) {
      cut = i + 1;
      break;
    }
  }
  let out = items.slice(cut);
  while (out.length > 0 && out[0].role === "tool") out = out.slice(1);
  return out;
}
