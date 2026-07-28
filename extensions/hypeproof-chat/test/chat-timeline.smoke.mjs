// Smoke tests for the single chat timeline (#503). Pure — no React, no vscode.
//
// 무엇을 재는가: **화면에 그려질 배열의 순서**다. 실제 실행은
// 말풍선 → 툴 → 말풍선 순서로 일어나는데, 화면은 [말풍선 A+B+C] 아래 [툴 전부]
// 로 그려졌다. 원인은 리듀서가 messages 와 toolLog 두 배열로 갈라 담은 것이고,
// 그 순간 "이 툴이 몇 번째 델타 뒤였는지"를 복원할 방법이 사라진다.
//
// .claude/rules/verification.md §2 — 대조군 없는 채점기는 신뢰하지 않는다:
//   · 양성 대조군: 정상 인터리브 시료가 **통과**해야 한다 (너무 엄격한 계측기 탐지)
//   · 음성 대조군: 순서가 뭉개진(옛 동작) 시료가 **실패**해야 한다 (너무 관대한 계측기 탐지)
// 옛 리듀서를 그대로 재현해 두고 같은 판정기에 통과시켜 본다 — 그게 음성 대조군이다.
// Run: node --experimental-strip-types test/chat-timeline.smoke.mjs

import assert from "node:assert/strict";

const {
  clampTimeline,
  emptyTimeline,
  hasActivityThisTurn,
  hasOpenFence,
  modelHistory,
  timelineCitations,
  timelineDelta,
  timelineEnd,
  timelineReset,
  timelineStart,
  timelineTool,
} = await import("../src/chatTimeline.ts");

/** 판정기: 타임라인을 사람이 읽는 모양("말풍선"/"툴:라벨")으로 압축한다. */
const shape = (items) =>
  items.map((m) => (m.role === "tool" ? `tool:${m.tool.label}` : `${m.role}:${m.content}`));

const T0 = 1_700_000_000_000;
const tool = (id, label, state = "running") => ({ id, icon: "🔧", label, state });

// ─── 양성 대조군: 텍스트 → 툴 → 텍스트가 그 순서로 남는다 ────────────────────
{
  let s = emptyTimeline();
  s = timelineStart(s, "a1", T0);
  s = timelineDelta(s, "만들어 볼게요. ", T0);
  s = timelineTool(s, tool("t1", "Write(index.html)"), T0);
  s = timelineTool(s, { ...tool("t1", "Write(index.html)"), state: "done" }, T0);
  s = timelineDelta(s, "저장했어요. ", T0);
  s = timelineTool(s, tool("t2", "Bash(npx serve)"), T0);
  s = timelineDelta(s, "열었습니다.", T0);
  s = timelineEnd(s, T0);

  assert.deepEqual(shape(s.items), [
    "assistant:만들어 볼게요. ",
    "tool:Write(index.html)",
    "assistant:저장했어요. ",
    "tool:Bash(npx serve)",
    "assistant:열었습니다.",
  ]);
  // running → done 은 **제자리** 갱신이다. 줄이 늘어나면 같은 툴이 두 번 실행된
  // 것처럼 보인다.
  assert.equal(s.items.filter((m) => m.role === "tool").length, 2);
  assert.equal(s.items.find((m) => m.id === "t1").tool.state, "done");
  console.log("✓ 양성: 텍스트 → 툴 → 텍스트가 일어난 순서 그대로 남는다");
}

// ─── 음성 대조군: 옛 동작(두 배열)은 이 판정을 통과하면 안 된다 ──────────────
{
  // #503 이전 리듀서를 그대로 재현: 델타는 말풍선 하나에 다 이어붙고, 툴은 옆
  // 배열에 쌓이며, 렌더는 말풍선 전부 → 툴 전부 순으로 그린다.
  const legacy = { bubble: "", toolLog: [] };
  const legacyDelta = (d) => (legacy.bubble += d);
  const legacyTool = (e) => {
    const i = legacy.toolLog.findIndex((x) => x.id === e.id);
    if (i >= 0) legacy.toolLog[i] = e;
    else legacy.toolLog.push(e);
  };
  legacyDelta("만들어 볼게요. ");
  legacyTool(tool("t1", "Write(index.html)"));
  legacyDelta("저장했어요. ");
  legacyTool(tool("t2", "Bash(npx serve)"));
  legacyDelta("열었습니다.");
  const legacyItems = [
    { role: "assistant", content: legacy.bubble },
    ...legacy.toolLog.map((e) => ({ role: "tool", tool: e })),
  ];

  assert.notDeepEqual(shape(legacyItems), [
    "assistant:만들어 볼게요. ",
    "tool:Write(index.html)",
    "assistant:저장했어요. ",
    "tool:Bash(npx serve)",
    "assistant:열었습니다.",
  ]);
  // 구체적으로 무엇이 틀렸는지까지 못 박는다: 말풍선이 한 덩어리로 뭉쳤고,
  // 툴 두 줄이 그 뒤에 몰려 있다.
  assert.deepEqual(shape(legacyItems), [
    "assistant:만들어 볼게요. 저장했어요. 열었습니다.",
    "tool:Write(index.html)",
    "tool:Bash(npx serve)",
  ]);
  console.log("✓ 음성: 옛 두-배열 동작은 같은 판정기에서 떨어진다");
}

// ─── 코드펜스는 툴 때문에 쪼개지지 않는다 (REQ-D2 자동 프리뷰) ───────────────
{
  let s = emptyTimeline();
  s = timelineStart(s, "a1", T0);
  s = timelineDelta(s, "만들었어요:\n```html\n<h1>hi</h1>\n", T0);
  // 펜스가 열려 있는 동안 도착한 툴은 보류된다 — 여기서 말풍선을 끊으면
  // ```html 이 두 말풍선에 걸려 extractRenderableHtml 이 못 찾는다.
  s = timelineTool(s, tool("t1", "Write(index.html)"), T0);
  assert.equal(s.pending.length, 1, "펜스가 열려 있으면 보류");
  assert.equal(s.items.filter((m) => m.role === "tool").length, 0);
  // 보류 중에도 running → done 갱신은 먹는다.
  s = timelineTool(s, { ...tool("t1", "Write(index.html)"), state: "done" }, T0);
  assert.equal(s.pending.length, 1);
  assert.equal(s.pending[0].state, "done");
  // 펜스가 닫히는 순간 흘려 넣는다.
  s = timelineDelta(s, "```\n", T0);
  s = timelineDelta(s, "저장했어요.", T0);
  s = timelineEnd(s, T0);

  assert.deepEqual(shape(s.items), [
    "assistant:만들었어요:\n```html\n<h1>hi</h1>\n```\n",
    "tool:Write(index.html)",
    "assistant:저장했어요.",
  ]);
  // 양성 대조군의 핵심: 펜스가 **한 말풍선 안에** 온전히 들어 있다.
  const bubble = s.items[0].content;
  assert.ok(/```html\n[\s\S]*\n```/.test(bubble), "펜스가 한 말풍선 안에서 닫힌다");
  console.log("✓ 펜스 보류: 툴이 코드펜스를 쪼개지 않는다 (REQ-D2)");
}

// ─── 펜스가 끝내 안 닫혀도 보류분은 반드시 나온다 ────────────────────────────
{
  let s = emptyTimeline();
  s = timelineStart(s, "a1", T0);
  s = timelineDelta(s, "```html\n<h1>hi</h1>\n", T0);
  s = timelineTool(s, tool("t1", "Write(index.html)"), T0);
  s = timelineEnd(s, T0);
  assert.equal(s.pending.length, 0, "턴이 끝나면 보류가 남으면 안 된다");
  assert.deepEqual(shape(s.items).slice(-1), ["tool:Write(index.html)"]);
  console.log("✓ 미완성 펜스로 턴이 끝나도 툴 줄이 증발하지 않는다");
}

// ─── 턴이 넘어가도 직전 턴의 툴 줄이 남는다 (두 번째 결함) ───────────────────
{
  let s = emptyTimeline();
  s = timelineStart(s, "a1", T0);
  s = timelineDelta(s, "1턴", T0);
  s = timelineTool(s, tool("t1", "Write(index.html)", "done"), T0);
  s = timelineEnd(s, T0);
  // 다음 턴 시작 — 예전에는 여기서 toolLog: [] 로 직전 턴 기록이 통째로 증발했다.
  s = timelineStart(s, "a2", T0 + 1);
  s = timelineDelta(s, "2턴", T0 + 1);
  s = timelineEnd(s, T0 + 1);

  assert.deepEqual(shape(s.items), ["assistant:1턴", "tool:Write(index.html)", "assistant:2턴"]);
  console.log("✓ 다음 턴이 시작돼도 직전 턴의 툴 줄이 남는다");
}

// ─── Clear / 히스토리 재로드는 대화와 툴을 함께 비운다 ───────────────────────
{
  let s = emptyTimeline();
  s = timelineStart(s, "a1", T0);
  s = timelineTool(s, tool("t1", "Write(index.html)", "done"), T0);
  s = timelineReset([]);
  assert.deepEqual(s.items, []);
  assert.equal(s.openId, null);
  assert.deepEqual(s.pending, []);
  console.log("✓ Clear 는 대화와 툴 기록을 함께 비운다");
}

// ─── 모델에 보내는 히스토리에는 툴 줄이 없다 ─────────────────────────────────
{
  const items = [
    { id: "u1", role: "user", content: "안녕", createdAt: T0 },
    { id: "a1", role: "assistant", content: "네", createdAt: T0 },
    { id: "t1", role: "tool", content: "", createdAt: T0, tool: { icon: "🔧", label: "Write", state: "done" } },
    { id: "a2", role: "assistant", content: "저장했어요", createdAt: T0 },
  ];
  const sent = modelHistory(items);
  assert.deepEqual(sent.map((m) => m.id), ["u1", "a1", "a2"]);
  assert.ok(!sent.some((m) => m.role === "tool"), "role:'tool' 이 모델로 새면 안 된다");
  // 음성 대조군: 거르지 않으면 이 단언이 깨진다.
  assert.ok(items.some((m) => m.role === "tool"));
  console.log("✓ 모델 히스토리에는 role:'tool' 이 섞이지 않는다");
}

// ─── 빈 말풍선은 흔적을 남기지 않는다 ────────────────────────────────────────
{
  // 텍스트 한 글자도 오기 전에 툴부터 도는 턴(SDK 코치의 흔한 시작 모양).
  let s = emptyTimeline();
  s = timelineStart(s, "a1", T0);
  s = timelineTool(s, tool("t1", "Read(index.html)", "done"), T0);
  s = timelineDelta(s, "읽었어요.", T0);
  s = timelineEnd(s, T0);
  assert.deepEqual(shape(s.items), ["tool:Read(index.html)", "assistant:읽었어요."]);
  console.log("✓ 내용 없는 말풍선은 남지 않는다");
}

// ─── 인용은 열린 말풍선(없으면 마지막 말풍선)에 붙는다 ───────────────────────
{
  const cite = [{ url: "https://a.b", title: "t", domain: "a.b", tier: 1 }];
  let s = emptyTimeline();
  s = timelineStart(s, "a1", T0);
  s = timelineDelta(s, "찾아봤어요.", T0);
  s = timelineTool(s, tool("t1", "WebSearch(임플란트)", "done"), T0);
  // 말풍선이 닫힌 뒤 도착한 인용도 잃지 않는다.
  s = timelineCitations(s, cite);
  assert.deepEqual(s.items.find((m) => m.id === "a1").citations, cite);
  console.log("✓ 인용은 말풍선이 닫힌 뒤 도착해도 붙는다");
}

// ─── 보조 함수 ───────────────────────────────────────────────────────────────
{
  assert.equal(hasOpenFence("```html\ncode"), true);
  assert.equal(hasOpenFence("```html\ncode\n```"), false);
  assert.equal(hasOpenFence("펜스 없음"), false);

  const withTool = [
    { id: "u1", role: "user", content: "x", createdAt: T0 },
    { id: "t1", role: "tool", content: "", createdAt: T0, tool: { icon: "🔧", label: "L", state: "done" } },
  ];
  assert.equal(hasActivityThisTurn(withTool), true);
  // 직전 턴의 툴은 이번 턴의 활동이 아니다 — 그걸 세면 새 턴에서 활동이 없는데도
  // 있다고 잘못 말하게 된다.
  assert.equal(hasActivityThisTurn([...withTool, { id: "u2", role: "user", content: "y", createdAt: T0 }]), false);
  console.log("✓ hasOpenFence / hasActivityThisTurn");
}

// ─── 히스토리 상한은 '말한 것' 기준으로 센다 ─────────────────────────────────
{
  const spoken = (n) => ({ id: `s${n}`, role: n % 2 ? "assistant" : "user", content: `${n}`, createdAt: T0 });
  const toolRow = (n) => ({ id: `k${n}`, role: "tool", content: "", createdAt: T0, tool: { icon: "🔧", label: `L${n}`, state: "done" } });
  // 말풍선 4개 사이사이에 툴 20줄이 낀 기록. 상한 4 → 말풍선 4개가 다 남아야 한다.
  const items = [];
  for (let n = 0; n < 4; n++) {
    items.push(spoken(n));
    for (let k = 0; k < 5; k++) items.push(toolRow(n * 5 + k));
  }
  const kept = clampTimeline(items, 4);
  assert.equal(kept.filter((m) => m.role !== "tool").length, 4, "말풍선 4개가 다 남는다");

  // 상한 2 → 뒤에서 말풍선 2개 + 그 구간의 툴만. 잘린 턴의 앞머리 툴 줄은 버린다.
  const two = clampTimeline(items, 2);
  assert.deepEqual(two.filter((m) => m.role !== "tool").map((m) => m.id), ["s2", "s3"]);
  assert.equal(two[0].id, "s2", "주인 없는 앞머리 툴 줄은 남기지 않는다");
  // 음성 대조군: 옛 방식(전체 메시지 수로 자르기)은 말풍선을 하나도 못 남긴다.
  assert.equal(items.slice(-2).filter((m) => m.role !== "tool").length, 0);
  assert.deepEqual(clampTimeline(items, 0), []);
  console.log("✓ 히스토리 상한: 툴 줄이 대화를 밀어내지 않는다");
}

console.log("All chat-timeline smoke tests passed.");
