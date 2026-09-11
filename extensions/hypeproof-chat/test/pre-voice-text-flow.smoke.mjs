// #897 (VO-04 / VO-T04) — **음성이 들어오기 전** 텍스트 흐름의 기준선.
//
// 왜 지금 찍나: VO-04 는 "음성 부재·모듈 오류·기능 비활성 상태에서 기존 텍스트
// 진입→수정→저장 흐름이 유지된다" 를 요구한다. 그 판정에는 **유지돼야 할 것이
// 무엇이었는지**가 필요하다. 음성 코드가 들어온 뒤에 기억으로 복원하면 그건
// 기준선이 아니라 사후 서술이다. 그래서 아직 음성 세션이 존재할 수 없는
// 오늘 찍는다 — 설치본의 webview iframe allow 목록에 `microphone` 이 0회이고,
// Electron 메인 프로세스의 webview 권한 집합에 `media` 가 없다(둘 다 2026-09-11 실측).
// **어느 쪽이 거부하는지는 모른다** — 내부 iframe 이 same-origin 이라 allow 속성의
// 누락이 실제로 비활성화를 뜻하는지 불확실하다. 패치된 빌드로만 가른다.
//
// 이 파일이 잠그는 것:
//   1. 진입→수정→저장이 **실제로 돌아간다** (순수 모듈을 돌려서 확인한다)
//   2. 저장되는 모양(ChatMessage)에 오디오 필드가 없다 — 기록 모양 불변
//   3. 채팅 패널 CSP 에 media-src / blob: / worker-src 가 없다 (오디오 구멍 없음)
//   4. 음성 진단 명령은 존재하지만 **학생이 보는 메뉴에 0회** 등장한다
//   5. 프로브는 명령으로만 돈다 — 활성화 경로에서 도달 불가
//   6. 텍스트 경로 파일들이 음성 심볼을 **한 번도** 참조하지 않는다, 그리고 음성을
//      참조하는 파일의 **목록 자체**가 잠겨 있다 (exit plan 의 실제 범위)
//
// 계측기 주의 (verification.md §1, 한국어 단일어 함정):
//   스캐너에서 한국어 토큰 `음성` 을 **뺐다**. `chatTimeline.ts` 헤더에 "양성/음성
//   대조군" 이 있어서 `음성` 으로 긁으면 정상 파일이 음성 오염으로 잡힌다. 실제
//   음성 코드가 쓰는 것은 ASCII 심볼(getUserMedia·AudioContext·MediaRecorder…)
//   이므로 스캐너는 ASCII 만 본다. 그 스캐너가 멀쩡한지는 §0 에서 **양성 대조군**
//   으로 먼저 증명한다.
//
// Run: node --experimental-strip-types test/pre-voice-text-flow.smoke.mjs

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (...p) => readFileSync(join(here, "..", ...p), "utf8");

// 웹뷰(vite 앱)와 호스트(vscode 결합)는 단독 import 가 안 된다. 그래서 순수 모듈은
// **실제로 돌리고**, 돌릴 수 없는 표면은 소스로 잠근다 — history-identity.smoke 와
// 같은 방식.
const { decideEnter, draftAfterStop, shouldFlushQueue } =
  await import("../webview-ui/src/sendQueue.ts");
const {
  timelineReset, timelineStart, timelineDelta, timelineTool, timelineEnd,
  clampTimeline, modelHistory,
} = await import("../src/chatTimeline.ts");
const { buildChatPanelCsp, buildPreviewShellCsp } = await import("../src/cspBuilder.ts");

const panel = src("webview-ui", "src", "ChatPanel.tsx");
const app = src("webview-ui", "src", "App.tsx");
const queue = src("webview-ui", "src", "sendQueue.ts");
const timelineSrc = src("src", "chatTimeline.ts");
const panelHelpers = src("src", "chatPanelHelpers.ts");
const hostSrc = src("src", "chatPanelProvider.ts");
const extSrc = src("src", "extension.ts");
const protoSrc = src("src", "protocol.ts");
const pkg = JSON.parse(src("package.json"));

// ─── §0 계측기를 먼저 검증한다 (verification.md §2) ─────────────────────────
// 아래 §6 은 전부 "0회 등장" 단언이다. 스캐너가 고장나 있으면 그 전부가 조용히
// 통과한다. 그러니 **확실히 음성인 시료가 반드시 걸려야** 한다.
// `mic` 계열을 **단어 경계로** 넣는다. 맨 `mic` 를 부분문자열로 긁으면 `dynamic`·
// `semicolon`·`atomic` 이 걸려 정상 파일이 음성 오염으로 잡힌다(korean-regex 단일어
// 함정의 ASCII 판). 처음 이 스캐너에는 mic 계열이 아예 없었고, 그래서
// `import { startMicCapture, MicStream } from "./micStream"` 와
// `private micRecorder: unknown = null;` 이 **둘 다 통과했다** — 마이크 기능이
// 실제로 들어올 때의 가장 그럴듯한 모양이 바로 그 둘이다.
const VOICE_SYMBOL =
  /voice|audio|microphone|getUserMedia|mediaDevices|MediaRecorder|SpeechRecognition|speech|transcri|\bstt\b|\btts\b|\bmic\b|\bmics\b|\b[Mm]ic(?:Stream|Capture|Recorder|Permission)|startMic|stopMic|AudioWorklet|ScriptProcessor/gi;
// 음성 모듈 import 탐침도 같이 넓힌다 — 파일명이 `voice` 를 안 쓰면 이전 탐침은 못 봤다.
// `\b` 가 없으면 `./dynamicLayout` 의 `micL` 이 걸린다 — 이 대조군을 안 넣었으면
// 멀쩡한 import 를 음성으로 잡는 계측기를 그대로 병합했다.
const VOICE_MODULE_IMPORT = /from "\.[^"]*(?:[Vv]oice|\b[Mm]ic[A-Z]|[Aa]udio|[Ss]peech|[Ss]tt|[Tt]ts)[^"]*"/;
const voiceHits = (text) => (text.match(VOICE_SYMBOL) ?? []).length;

{
  // 양성 대조군 — 음성 프로브 두 파일은 반드시 잡힌다.
  const probe = src("webview-ui", "src", "voiceProbe.ts");
  const capability = src("src", "voiceCapability.ts");
  assert.ok(voiceHits(probe) > 20, `스캐너가 voiceProbe.ts 를 못 잡는다 (hits=${voiceHits(probe)})`);
  assert.ok(voiceHits(capability) > 10, `스캐너가 voiceCapability.ts 를 못 잡는다 (hits=${voiceHits(capability)})`);

  // 음성 대조군 — 호스트↔웹뷰 계약 파일 전체는 **잡혀야 한다**(프로브 메시지가
  // 거기 있다). 이게 0 이면 §2 의 ChatMessage 블록 추출이 엉뚱한 곳을 보고 있다는
  // 신호다.
  assert.ok(voiceHits(protoSrc) > 0, "protocol.ts 전체에는 프로브 메시지가 있어야 한다");

  // 스캐너가 "항상 걸린다" 는 상수도 아니라는 증거 — 합성 시료로만 본다(제품
  // 파일을 여기서 쓰면 §6 의 판정과 섞인다).
  assert.equal(voiceHits("const draft = trim(text); send(draft);"), 0);
  assert.equal(voiceHits("await navigator.mediaDevices.getUserMedia({ audio: true })"), 3);
}

// ─── §1 진입 → 수정 → 저장을 실제로 돌린다 ──────────────────────────────────
// 이게 "음성이 생기기 전에는 됐다" 의 내용이다. 소스 스냅샷이 아니라 실행이다.
{
  const typed = "파란 버튼 세 개를 나란히 놓아줘";

  // (진입) 유휴 상태 + 글자 있음 → 즉시 보낸다.
  assert.deepEqual(decideEnter({ draft: typed, streaming: false, queued: null }), { action: "send" });

  // (진입, 음성 대조군) 빈 입력은 삼킨다. 이게 없으면 "항상 send" 상수 구현이
  // 위를 통과한다.
  assert.deepEqual(decideEnter({ draft: "   ", streaming: false, queued: null }), { action: "ignore" });
  // 이미지만 있어도 한 턴이다 (오늘 존재하는 유일한 비텍스트 첨부).
  assert.deepEqual(
    decideEnter({ draft: "", streaming: false, queued: null, hasImages: true }),
    { action: "send" },
  );

  // (수정) 턴 도중 Enter 는 예약이다. 한 번 더 치면 **덧붙인다** — 버리지 않는다.
  const first = decideEnter({ draft: "그리고 글자를 크게", streaming: true, queued: null });
  assert.deepEqual(first, { action: "queue", queued: "그리고 글자를 크게" });
  const second = decideEnter({ draft: "아니 가운데로", streaming: true, queued: first.queued });
  assert.deepEqual(second, { action: "queue", queued: "그리고 글자를 크게\n아니 가운데로" });

  // (수정) Stop 을 눌러도 예약분은 draft 로 돌아온다 — 쓴 순서 그대로.
  assert.equal(draftAfterStop("세 번째 줄", "첫째\n둘째"), "첫째\n둘째\n세 번째 줄");
  assert.equal(draftAfterStop("", "첫째"), "첫째");
  assert.equal(draftAfterStop("그대로", null), "그대로");

  // (저장 직전) 예약분은 streaming → idle **경계에서만** 나간다.
  assert.equal(shouldFlushQueue(true, false, "보낼 것"), true);
  assert.equal(shouldFlushQueue(true, true, "보낼 것"), false, "스트림이 열려 있으면 안 나간다");
  assert.equal(shouldFlushQueue(false, false, "보낼 것"), false, "경계가 아니면 재발사 안 한다");
  assert.equal(shouldFlushQueue(true, false, "   "), false);

  // decideEnter 가 상수가 아님을 세 갈래 출력으로 박아둔다.
  const actions = new Set([
    decideEnter({ draft: "", streaming: false, queued: null }).action,
    decideEnter({ draft: "x", streaming: false, queued: null }).action,
    decideEnter({ draft: "x", streaming: true, queued: null }).action,
  ]);
  assert.deepEqual([...actions].sort(), ["ignore", "queue", "send"]);

  // (저장) 턴 하나가 타임라인에 쌓이고, 호스트 상한을 거쳐 영속화 모양이 된다.
  let t = timelineReset([
    {
      id: "u1",
      role: "user",
      content: typed,
      createdAt: 1,
      // 오늘 존재하는 유일한 첨부 경로. 여기에 audio 가 끼어드는 날 §2 가 터진다.
      images: ["data:image/png;base64,AAAA"],
    },
  ]);
  t = timelineStart(t, "a1", 2);
  // 델타를 **두 번** 넣는다. 한 번만 넣으면 누적(`content + delta`)과 덮어쓰기
  // (`content = delta`)가 구별되지 않는다 — 실제로 `content: m.content + delta` 를
  // `content: delta` 로 바꾸는 변이가 단일 델타 fixture 를 통과했다. 그건 VO-04 가
  // 지키려는 흐름 **중간에서 글자가 사라지는** 결함이다.
  t = timelineDelta(t, "좋아, ", 3);
  t = timelineDelta(t, "먼저 버튼부터.", 3);
  assert.equal(
    t.items.at(-1).content,
    "좋아, 먼저 버튼부터.",
    "어시스턴트 델타가 누적되지 않는다 — 앞 조각이 버려졌다",
  );
  t = timelineTool(t, { id: "tool1", icon: "🔧", label: "Write(index.html) ✓", state: "done" }, 4);
  t = timelineDelta(t, "다 만들었어.", 5);
  t = timelineEnd(t, 6);

  const persisted = clampTimeline(t.items, 200);

  // 양성 대조군: 좋은 시료가 **통과해야** 한다. 순서·내용이 그대로 남는다.
  assert.equal(persisted.length, 4, `저장 줄 수가 4가 아니다: ${JSON.stringify(persisted.map((m) => m.role))}`);
  assert.deepEqual(persisted.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(persisted[0].content, typed, "입력한 문자열이 바이트 동일하게 저장된다");
  assert.equal(persisted[1].content, "좋아, 먼저 버튼부터.");
  assert.equal(persisted[3].content, "다 만들었어.");

  // 모델에 나가는 히스토리에서는 툴 줄이 빠진다 (오늘의 계약).
  assert.deepEqual(modelHistory(persisted).map((m) => m.role), ["user", "assistant", "assistant"]);

  // ─── §2 저장 모양 — 오디오 필드가 들어올 자리가 없다 ─────────────────────
  // (a) 타입 선언에 적힌 필드 목록. `export interface ChatMessage { … }` 를
  //     중괄호 짝으로 떼어낸다(정규식으로 블록 경계를 짐작하지 않는다).
  const open = protoSrc.indexOf("export interface ChatMessage {");
  assert.ok(open >= 0, "ChatMessage 선언을 못 찾았다 — 추출 기준이 틀렸다");
  let depth = 0;
  let close = -1;
  for (let i = protoSrc.indexOf("{", open); i < protoSrc.length; i++) {
    const ch = protoSrc[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) { close = i + 1; break; }
    }
  }
  assert.ok(close > open, "ChatMessage 블록의 끝을 못 찾았다");
  const block = protoSrc.slice(open, close);

  const declared = [...block.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
  // 추출이 진짜 됐다는 증거 — 빈 목록이면 아래 단언이 공허하게 통과한다.
  assert.ok(declared.length >= 6, `필드 추출이 실패했다: ${JSON.stringify(declared)}`);
  assert.deepEqual(
    declared,
    ["id", "role", "content", "createdAt", "tool", "citations", "images", "assistantName"],
    "ChatMessage 필드가 늘었다/줄었다 — 음성이 기록 모양을 바꾸려 한다면 여기서 멈춰라",
  );
  assert.equal(voiceHits(block), 0, "ChatMessage 가 오디오 필드를 들고 다닌다");

  // (b) 저장 경로가 **실제로 내놓는** 키가 선언 밖으로 새지 않는다.
  const stray = (items) => [...new Set(items.flatMap((m) => Object.keys(m)))].filter((k) => !declared.includes(k));
  const seen = new Set(persisted.flatMap((m) => Object.keys(m)));
  assert.ok(seen.size >= 5, `키를 못 모았다: ${JSON.stringify([...seen])}`);
  for (const k of ["id", "role", "content", "createdAt", "tool", "images"]) {
    assert.ok(seen.has(k), `${k} 가 저장 모양에 없다 — 게이트가 빈 배열을 보고 있다`);
  }
  assert.deepEqual(stray(persisted), [], "저장 경로가 선언에 없는 필드를 내놓는다");

  // 이 게이트 자체의 음성 대조군 — 넣으면 잡히나. 이게 없으면 stray() 가
  // `() => []` 여도 위가 전부 통과한다.
  assert.deepEqual(
    stray([{ ...persisted[0], audio: { durationMs: 1200 } }]),
    ["audio"],
    "게이트가 새 필드를 못 잡는다 — 이 테스트는 공허하다",
  );
}

// ─── §1b 판정을 **화면이 실제로 따르는가** ──────────────────────────────────
// §1 은 순수 리듀서(`decideEnter`)만 돌린다. 그 답을 동작으로 바꾸는 곳은
// ChatPanel.tsx 의 Enter 핸들러 하나뿐이고, 처음엔 거기를 `assert.match(panel,
// /decideEnter\(/)` 한 줄로만 잠가 뒀다. 그래서 **예약 메시지를 조용히 버리는 변경이
// 통과했다**: `setQueued(decision.queued);` 를 지우면 턴 도중 Enter 가 draft 를 비우고
// 아무것도 남기지 않는다. 아이가 쓴 문장이 사라지는 것이 VO-04 가 지키려는 흐름의
// 정확히 가운데다. 그래서 세 갈래 배선을 소스에서 직접 잠근다.
//
// 웹뷰는 단독 실행이 안 되니(DOM + acquireVsCodeApi) 소스 단언이다 — 대신 추출
// 앵커를 먼저 확인해서 "엉뚱한 곳을 보고 0건" 이 되지 않게 한다.
{
  const at = panel.indexOf("const decision = decideEnter({");
  assert.ok(at > 0, "Enter 핸들러의 decideEnter 호출을 못 찾았다 — 배선이 옮겨졌다");
  const end = panel.indexOf("submit();", at);
  assert.ok(end > at, "decideEnter 뒤에 submit() 호출이 없다 — 보내는 갈래가 사라졌다");
  const wiring = panel.slice(at, end + "submit();".length);
  // 추출 앵커 — 슬라이스가 핸들러 본문을 담고 있다.
  assert.ok(wiring.length > 120 && wiring.length < 900, `배선 슬라이스 길이가 수상하다: ${wiring.length}`);
  assert.match(wiring, /hasImages: pendingImages\.length > 0/, "배선 슬라이스 추출이 틀렸다");

  // (ignore) 아무 일도 일어나지 않는다.
  assert.match(wiring, /if \(decision\.action === "ignore"\) return;/, "ignore 갈래가 사라졌다 — 빈 입력이 턴을 만든다");
  // (queue) **예약을 실제로 저장하고** 입력창을 비운 뒤 멈춘다. 세 조각 전부 필요하다:
  // setQueued 가 빠지면 글자가 사라지고, return 이 빠지면 예약과 전송이 동시에 난다.
  assert.match(wiring, /if \(decision\.action === "queue"\) \{/, "queue 갈래가 사라졌다");
  assert.match(wiring, /setQueued\(decision\.queued\);/, "예약값을 저장하지 않는다 — 아이가 쓴 문장이 버려진다");
  assert.match(wiring, /setDraft\(""\);/, "예약 후 입력창을 비우지 않는다");
  const queueBranch = wiring.slice(wiring.indexOf('=== "queue"'));
  assert.match(queueBranch, /return;/, "queue 갈래가 멈추지 않는다 — 예약과 전송이 겹친다");
  // (send) 그 밖에는 보낸다.
  assert.match(wiring, /submit\(\);$/, "기본 갈래가 submit() 이 아니다");

  // 탐침 음성 대조군 — 이 단언들이 파일 전체를 긁어 통과하는 게 아니다. 위 리터럴들은
  // **슬라이스 안에서만** 찾았고, 슬라이스 밖 문자열은 보이지 않아야 한다.
  assert.doesNotMatch(wiring, /placeholder=/, "슬라이스가 핸들러를 넘어 번졌다 — 단언 범위가 무의미해진다");
}

// ─── §3 채팅 패널 CSP 에 오디오 구멍이 없다 ─────────────────────────────────
{
  const CSP_SOURCE = "vscode-webview://pre-voice";
  const chat = buildChatPanelCsp({ cspSource: CSP_SOURCE, nonce: "n0nce" });

  // 지시자 집합을 **완전 일치**로 잠근다. media-src 하나가 조용히 붙는 것이
  // VO-04 가 막으려는 바로 그 변화다.
  const directives = chat.split("; ").map((d) => d.split(" ")[0]);
  assert.deepEqual(
    directives,
    ["default-src", "img-src", "style-src", "script-src", "font-src", "connect-src"],
    "채팅 패널 CSP 지시자 집합이 바뀌었다",
  );
  for (const forbidden of [/media-src/, /worker-src/, /microphone/, /blob:/]) {
    assert.doesNotMatch(chat, forbidden, `채팅 패널 CSP 에 ${forbidden} 가 생겼다`);
  }

  // **값까지 잠근다.** 지시자 이름만 재면 음성 유출 경로가 전부 통과한다: 이름 검사만
  // 있던 동안 `connect-src` 에 스트리밍 STT 주소를 붙이는 변경(`https://api.deepgram.com
  // wss://api.deepgram.com`)과 `default-src 'none'` → `'self' mediastream:`, `script-src`
  // 에 `'unsafe-eval'` 추가가 모두 초록으로 지나갔다. cspBuilder.ts 자신이 "Do NOT loosen
  // `connect-src` to https:" 라고 적어둔 바로 그 구멍이다.
  //
  // 전체 문자열 완전 일치가 유일하게 새는 곳이 없는 단언이다. 정당한 변경으로 여기가
  // 터지면 **값을 다시 읽고** 이 리터럴을 고쳐라 — 느슨하게 바꾸지 마라.
  assert.equal(
    chat,
    "default-src 'none'; " +
      `img-src ${CSP_SOURCE} data:; ` +
      `style-src ${CSP_SOURCE} 'unsafe-inline'; ` +
      `script-src 'nonce-n0nce' ${CSP_SOURCE}; ` +
      `font-src ${CSP_SOURCE}; ` +
      `connect-src ${CSP_SOURCE}`,
    "채팅 패널 CSP 의 값이 바뀌었다 — 음성/원격 전송 구멍인지 확인하고 고쳐라",
  );

  // 그리고 유출에 직접 쓰이는 두 지시자는 따로 이름 붙여 잠근다. 위 완전일치가
  // 터질 때 무엇이 위험한지 읽히도록.
  const valueOf = (name) =>
    chat.split("; ").find((d) => d.startsWith(name + " "))?.slice(name.length + 1) ?? "";
  assert.equal(valueOf("connect-src"), CSP_SOURCE, "connect-src 가 웹뷰 출처 하나만 허용해야 한다 (원격 STT/TTS 차단)");
  assert.equal(valueOf("default-src"), "'none'", "default-src 가 'none' 이 아니면 mediastream: 같은 스킴이 새어든다");
  // 탐침 양성 대조군 — valueOf 가 실제로 값을 떼어낸다(빈 문자열을 돌려주는 고장이면
  // 위 두 단언이 공짜로 통과한다).
  assert.equal(valueOf("font-src"), CSP_SOURCE, "valueOf 탐침이 고장났다");
  assert.equal(valueOf("없는지시자"), "", "valueOf 가 아무 이름에나 값을 만들어낸다");

  // 양성 대조군 — 같은 탐침이 **있는 곳에서는 찾아낸다**. 프리뷰 셸은 오디오
  // 재생용으로 media-src/blob: 을 이미 허용한다(cspBuilder.ts 주석). 이 대조군이
  // 없으면 위 doesNotMatch 들은 "탐침이 고장났는지" 구분하지 못한다.
  const preview = buildPreviewShellCsp({ cspSource: CSP_SOURCE });
  assert.match(preview, /media-src/, "탐침이 media-src 를 못 찾는다 — 탐침이 고장났다");
  assert.match(preview, /blob:/, "탐침이 blob: 을 못 찾는다 — 탐침이 고장났다");
  // 그리고 둘은 같은 정책이 아니다 — 재생 허용(프리뷰)과 입력 허용(패널)은 별개다.
  assert.notEqual(chat, preview);
}

// ─── §4 음성 진단 명령은 학생 화면에 없다 ───────────────────────────────────
{
  const VOICE_CMD = "hypeproof-chat.diagnoseVoiceCapability";
  const commands = pkg.contributes.commands ?? [];
  const voiceCmd = commands.find((c) => c.command === VOICE_CMD);
  assert.ok(voiceCmd, "음성 진단 명령이 매니페스트에 없다 — 단언 대상이 사라졌다");
  assert.match(voiceCmd.title, /개발용/, "제목에 개발용 표식이 없다 — 학생이 명령판에서 그냥 보게 된다");

  // 클릭 자리 스캔에서 `commandPalette` 는 **제외한다.** 거기 들어가는 항목은
  // 누를 자리를 만드는 게 아니라 **반대로 지우는** 선언이다(`when: "false"`).
  // 처음엔 전체 menus 를 평탄화해서 "항목 0개" 를 요구했는데, 그러면 팔레트에서
  // 숨기는 유일한 문서화된 방법이 이 단언에 막힌다 — 단언이 결함을 고정한다.
  const clickableMenus = Object.entries(pkg.contributes.menus ?? {}).filter(([k]) => k !== "commandPalette");
  const menuEntries = clickableMenus.flatMap(([, v]) => v);
  // 양성 대조군 — 메뉴 스캔이 실제로 명령을 찾아낸다.
  assert.ok(menuEntries.length > 0, "메뉴 항목을 하나도 못 읽었다");
  assert.ok(
    menuEntries.some((e) => e.command === "hypeproof-chat.openBrowser"),
    "메뉴 스캔이 기존 명령을 못 찾는다 — 스캔이 고장났다",
  );
  assert.deepEqual(
    menuEntries.filter((e) => e.command === VOICE_CMD),
    [],
    "음성 진단 명령이 메뉴에 붙었다 — 아이가 누를 수 있는 자리다",
  );

  // 그리고 명령판에서는 **명시적으로** 지워져 있어야 한다. 기여된 명령의 기본값은
  // "명령판에 보임" 이므로, 메뉴에 없다는 사실은 비노출의 근거가 되지 않는다.
  const palette = pkg.contributes.menus?.commandPalette ?? [];
  const hidden = palette.find((e) => e.command === VOICE_CMD);
  assert.ok(hidden, "명령판 숨김 선언이 없다 — 기본값은 '보임' 이고 아이가 팔레트에서 본다");
  assert.equal(hidden.when, "false", "명령판에서 숨기려면 when 이 false 여야 한다");

  // 설정에도 음성 스위치가 없다 (있으면 기본값 논쟁이 먼저다).
  const conf = JSON.stringify(pkg.contributes.configuration ?? {});
  const confDefaults = JSON.stringify(pkg.contributes.configurationDefaults ?? {});
  assert.ok(Object.keys(pkg.contributes.configuration?.properties ?? {}).length > 0, "설정을 못 읽었다");
  assert.equal(voiceHits(conf), 0, "설정에 음성 키가 생겼다");
  assert.equal(voiceHits(confDefaults), 0, "설정 기본값에 음성 키가 생겼다");
}

// ─── §5 프로브는 명령으로만 돈다 — 활성화에서 도달 불가 ─────────────────────
{
  // 호스트: voiceCapability 모듈은 **정적 import 가 아니다**. 즉 명령을 누르기
  // 전까지 모듈이 로드조차 되지 않는다.
  assert.doesNotMatch(
    extSrc,
    /^import[^\n]*voiceCapability/m,
    "extension.ts 가 voiceCapability 를 정적 import 한다 — 활성화 시 모듈이 로드된다",
  );
  assert.equal(
    (extSrc.match(/probeVoiceCapability/g) ?? []).length,
    0,
    "활성화 파일이 프로브를 직접 부른다",
  );

  // diagnoseVoiceCapability 언급 **전부**가 그 명령 등록 블록 안에 있다.
  const regAt = extSrc.indexOf('registerCommand("hypeproof-chat.diagnoseVoiceCapability"');
  assert.ok(regAt > 0, "명령 등록 지점을 못 찾았다");
  const regEnd = extSrc.indexOf("\n  );", regAt);
  assert.ok(regEnd > regAt, "등록 블록의 끝을 못 찾았다");
  const regBlock = extSrc.slice(regAt, regEnd);
  assert.match(regBlock, /await import\("\.\/voiceCapability"\)/, "등록 블록 추출이 틀렸다");
  assert.equal(
    (regBlock.match(/diagnoseVoiceCapability/g) ?? []).length,
    (extSrc.match(/diagnoseVoiceCapability/g) ?? []).length,
    "명령 등록 블록 밖에서 진단을 부르는 곳이 생겼다",
  );

  // 웹뷰: 프로브 호출 지점은 호스트 메시지 분기 **안에 하나**뿐이다. 마운트
  // 이펙트에서 부르면 패널을 여는 것만으로 권한 프롬프트가 뜬다.
  const calls = (app.match(/runVoiceCapabilityProbe\(/g) ?? []).length;
  assert.equal(calls, 1, `프로브 호출 지점이 ${calls}개다 — 하나여야 한다`);
  const caseAt = app.indexOf('case "probeVoiceCapability"');
  assert.ok(caseAt > 0, "프로브 분기를 못 찾았다");
  const nextCaseAt = app.indexOf('case "', caseAt + 10);
  assert.ok(nextCaseAt > caseAt, "다음 분기를 못 찾았다 — 슬라이스가 파일 끝까지 먹었다");
  const arm = app.slice(caseAt, nextCaseAt);
  assert.match(arm, /postToHost/, "분기 슬라이스 추출이 틀렸다");
  assert.equal(
    (arm.match(/runVoiceCapabilityProbe\(/g) ?? []).length,
    1,
    "프로브 호출이 메시지 분기 밖으로 나갔다",
  );
}

// ─── §6 텍스트 경로는 음성을 모른다 (exit plan) ─────────────────────────────
// 처음 이 절의 머리말은 "음성 3파일을 지워도 아래 파일들은 그대로 컴파일된다" 였다.
// **직접 재보니 거짓이다.** 세 파일을 지우고 `tsc --noEmit` 을 돌리면 host 5건 ·
// webview 3건이 뜬다(protocol.ts:261, chatPanelProvider.ts:247·252·255,
// extension.ts:96, App.tsx:15·203). 참조 0회인 것은 **텍스트 흐름 파일들**이고,
// 프로젝트 전체가 아니다.
//
// 그래서 두 가지를 따로 잠근다:
//   (a) 텍스트 흐름 파일 4개 — 음성 심볼 참조 0회. 음성을 떼어내도 **동작이 안 바뀐다.**
//   (b) 음성을 참조하는 파일 **목록** — 이게 exit plan 의 실제 범위다. 목록이
//       늘어나면 "떼어내기" 의 비용이 조용히 커진 것이므로 이 단언이 터져야 한다.
{
  for (const [name, text] of [
    ["webview-ui/src/ChatPanel.tsx", panel],
    ["webview-ui/src/sendQueue.ts", queue],
    ["src/chatTimeline.ts", timelineSrc],
    ["src/chatPanelHelpers.ts", panelHelpers],
  ]) {
    assert.equal(voiceHits(text), 0, `${name} 가 음성 심볼을 참조한다`);
  }

  // 추출이 엉뚱한 파일을 보고 있지 않다는 증거(앵커). 이게 없으면 빈 문자열을
  // 스캔해도 0 이 나와 통과한다.
  assert.match(panel, /hps-btn-send/, "ChatPanel.tsx 를 읽은 게 아니다");
  assert.match(panel, /decideEnter\(/, "ChatPanel.tsx 가 진입 판정을 안 쓴다");
  assert.match(queue, /export function decideEnter/, "sendQueue.ts 를 읽은 게 아니다");
  assert.match(timelineSrc, /export function clampTimeline/, "chatTimeline.ts 를 읽은 게 아니다");
  assert.match(panelHelpers, /export/, "chatPanelHelpers.ts 를 읽은 게 아니다");

  // 보내는 경로(handleSend) 본문도 음성을 모른다. 메서드 경계를 줄 번호로
  // 짐작하지 않고 같은 들여쓰기의 다음 `private` 까지 떼어낸다.
  const sendAt = hostSrc.indexOf("private async handleSend(");
  assert.ok(sendAt > 0, "handleSend 를 못 찾았다");
  const sendEnd = hostSrc.indexOf("\n  private ", sendAt + 10);
  assert.ok(sendEnd > sendAt, "handleSend 의 끝을 못 찾았다");
  const sendBody = hostSrc.slice(sendAt, sendEnd);
  // 추출 앵커 — 보내는 경로의 알맹이가 슬라이스 안에 있어야 한다.
  assert.match(sendBody, /modelHistory\(/, "handleSend 슬라이스 추출이 틀렸다");
  assert.match(sendBody, /appendHistory\(/, "handleSend 슬라이스에 저장 호출이 없다");
  assert.ok(sendBody.length > 5000, `handleSend 슬라이스가 너무 짧다: ${sendBody.length}`);
  assert.equal(voiceHits(sendBody), 0, "보내는 경로가 음성 심볼을 참조한다");

  // handleSend 만 보면 같은 파일의 **진입 분기**가 사각지대로 남는다. 텍스트 턴이
  // 호스트에 들어오는 자리(`case "sendMessage"` / `case "retryMessage"`)가 음성을
  // 경유하게 되는 변경은 위 슬라이스 밖에서 일어난다. 두 분기 본문만 떼어 따로 잰다.
  for (const arm of ['case "sendMessage":', 'case "retryMessage":']) {
    const armAt = hostSrc.indexOf(arm);
    assert.ok(armAt > 0, `${arm} 를 못 찾았다 — 텍스트 진입 분기가 옮겨졌다`);
    const armEnd = hostSrc.indexOf("\n      case ", armAt + arm.length);
    assert.ok(armEnd > armAt, `${arm} 의 끝을 못 찾았다`);
    const armBody = hostSrc.slice(armAt, armEnd);
    // 추출 앵커 — 이 분기는 실제로 handleSend 를 부른다.
    assert.match(armBody, /this\.handleSend\(/, `${arm} 슬라이스 추출이 틀렸다`);
    assert.equal(voiceHits(armBody), 0, `${arm} 가 음성 심볼을 참조한다`);
  }

  // import 스캔의 양성 대조군 — App.tsx 는 음성 모듈을 **실제로** import 한다.
  // 이게 없으면 위의 "참조 0회" 들이 스캐너 고장과 구분되지 않는다.
  assert.match(app, /from "\.\/voiceProbe"/, "음성 모듈 import 스캔이 고장났다");
  // 넓힌 탐침의 양성/음성 대조군 — 합성 시료로만 본다. mic 계열 파일명을 잡아야 하고,
  // `dynamic`·`semicolon` 같은 멀쩡한 이름을 잡아서는 안 된다.
  assert.match('import { startMicCapture } from "./micStream";', VOICE_MODULE_IMPORT, "mic 계열 파일명을 못 잡는다");
  assert.match('import { x } from "./audioBridge";', VOICE_MODULE_IMPORT);
  assert.doesNotMatch('import { useDynamicLayout } from "./dynamicLayout";', VOICE_MODULE_IMPORT, "dynamic 을 mic 으로 잡는다");
  assert.doesNotMatch('import { s } from "./semicolonUtils";', VOICE_MODULE_IMPORT);
  // 같은 함정을 심볼 스캐너에도 적용한다.
  assert.equal(voiceHits("const dynamic = atomic ? semicolon : x;"), 0, "dynamic/atomic/semicolon 을 mic 으로 잡는다");
  assert.equal(voiceHits("const dynamicStream = makeDynamicRecorder();"), 0, "dynamicStream/DynamicRecorder 를 mic 으로 잡는다");
  assert.ok(voiceHits("private micRecorder: unknown = null;") > 0, "micRecorder 를 못 잡는다");
  assert.ok(voiceHits("const mic = await openMic();") > 0, "단어 mic 을 못 잡는다");
  for (const [name, text] of [
    ["webview-ui/src/ChatPanel.tsx", panel],
    ["webview-ui/src/sendQueue.ts", queue],
    ["src/chatTimeline.ts", timelineSrc],
    ["src/chatPanelHelpers.ts", panelHelpers],
  ]) {
    assert.doesNotMatch(text, VOICE_MODULE_IMPORT, `${name} 가 음성 모듈을 import 한다`);
  }
}

// ─── §6b exit plan 의 범위를 잠근다 ─────────────────────────────────────────
// "음성을 떼어낸다" 가 실제로 건드려야 하는 파일의 전체 목록. 2026-09-10 에
// 음성 3파일을 지우고 `tsc --noEmit` 을 돌려 확인한 집합과 **일치한다**:
// 정의 3개 + 참조 4개 = 7개. 여기서 자라면 exit plan 이 더 이상 "파일 3개 삭제" 가
// 아니고, 그걸 모른 채로 "되돌릴 수 있다" 고 말하게 된다.
{
  const DEFINES = ["src/voiceCapability.ts", "src/voiceCapabilityHelpers.ts", "webview-ui/src/voiceProbe.ts"];
  const REFERENCES = ["src/chatPanelProvider.ts", "src/extension.ts", "src/protocol.ts", "webview-ui/src/App.tsx"];
  const MODULE_REF = /voiceCapability|voiceProbe|VoiceProbe|VoiceCapability/;

  const scanned = [
    ...readdirSync(join(here, "..", "src")).filter((f) => f.endsWith(".ts")).map((f) => `src/${f}`),
    ...readdirSync(join(here, "..", "webview-ui", "src"))
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
      .map((f) => `webview-ui/src/${f}`),
  ];
  // 양성 대조군 — 스캔이 실제로 파일을 읽고 있다. 빈 목록이면 아래 비교가 공짜로 통과한다.
  assert.ok(scanned.length > 30, `소스 스캔이 너무 적다: ${scanned.length}`);
  for (const f of [...DEFINES, ...REFERENCES]) {
    assert.ok(scanned.includes(f), `스캔 범위가 ${f} 를 놓쳤다 — 스캐너가 고장났다`);
  }

  const touching = scanned.filter((f) => MODULE_REF.test(src(...f.split("/")))).sort();
  assert.deepEqual(
    touching,
    [...DEFINES, ...REFERENCES].sort(),
    `음성 모듈을 참조하는 파일 목록이 바뀌었다 — exit plan 의 범위가 달라졌으므로 다시 재고 머리말을 고쳐라:\n  ${touching.join("\n  ")}`,
  );
  // 참조 4개는 **음성 3파일을 지웠을 때 tsc 가 가리킨 파일들**과 같다. 하나라도
  // 줄면 그건 좋은 일이지만 머리말의 숫자가 거짓이 되므로 역시 터뜨린다.
  assert.equal(touching.length, 7, "정의 3 + 참조 4 = 7 이어야 한다");
}

console.log("pre-voice-text-flow smoke OK");
