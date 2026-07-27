// 실사용 세션 관찰기 v3 — 2026-07-26 계측기 오류 4건을 반영해 다시 씀.
//
// 고친 것:
//
// 1. 턴 경계를 **텍스트 정지로 판정하지 않는다.** ChatPanel.tsx:612 는 스트리밍
//    중에만 `.hps-btn-stop` 을 렌더한다. 그게 권위 있는 신호다. 텍스트 안정성으로
//    판정했더니 긴 툴 호출 중에 종료로 오판했다(규율 문서에 이미 적혀 있던 항목을
//    또 밟았다).
//
// 2. 행 정체성은 **DOM 인덱스**다. App.tsx:89-95 는 같은 id 항목을 제자리에서
//    교체하므로 "Thinking… 29 tokens" → "…54 tokens" 는 같은 행의 갱신이다.
//    라벨을 키에 넣었더니 💭 개수가 몇 배로 부풀었다.
//
// 3. 승인 모달을 **본다.** macOS 기본은 네이티브 NSAlert 라 DOM 에 없다. 측정 전에
//    `window.dialogStyle: "custom"` 을 켜 두면 워크벤치가 직접 그리므로 관측된다.
//    모달은 웹뷰가 아니라 **워크벤치 페이지**에 있으므로 CDP 연결이 두 개 필요하다.
//
// 4. 셀렉터를 짐작하지 않는다. 후보를 넓게 걸고 **실제로 잡힌 클래스 이름을 로그에
//    남긴다.** 첫 모달이 자기가 뭔지 스스로 알려 준다.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 출력·대상은 환경변수로 갈아끼운다. 기본값은 보아치과 원장 트랙 기준.
const OUT = process.env.HPS_OBSERVE_OUT
  ?? path.join(path.dirname(new URL(import.meta.url).pathname), "runs", "session.jsonl");
const WS = process.env.HPS_WORKSPACE ?? path.join(os.homedir(), "HypeProofClinic");
const PORT = process.env.HPS_CDP_PORT ?? "9333";
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const rec = (o) => fs.appendFileSync(OUT, JSON.stringify({ t: Date.now(), ...o }) + "\n");
const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP = `http://127.0.0.1:${PORT}`;

const snapWs = () => {
  const out = [];
  const walk = (dir, rel = "") => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else { try { const s = fs.statSync(p); out.push({ f: r, size: s.size, mtime: s.mtimeMs }); } catch {} }
    }
  };
  walk(WS);
  return out.sort((a, b) => a.f.localeCompare(b.f));
};

// ─── CDP ─────────────────────────────────────────────────────────────────────
async function openTarget(pick) {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const t = list.find(pick);
  if (!t) throw new Error("타깃 없음");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const send = (m, p = {}) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, [res, rej]);
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
    setTimeout(() => { if (pend.delete(i)) rej(new Error("timeout " + m)); }, 15000);
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const [res, rej] = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await send("Page.enable"); await send("Runtime.enable");
  return { ws, send };
}

/** 채팅 React 앱 — 웹뷰 셸 안의 #active-frame (별도 CDP 타깃 + 격리 월드). */
async function connectChat() {
  const c = await openTarget((x) => x.type === "iframe" && x.url.includes("hypeproof-chat"));
  const { frameTree } = await c.send("Page.getFrameTree");
  const child = (frameTree.childFrames ?? [])[0];
  if (!child) throw new Error("안쪽 프레임 없음");
  const { executionContextId } = await c.send("Page.createIsolatedWorld", { frameId: child.frame.id, worldName: "hpswatch" });
  return { ...c, ctx: executionContextId };
}

/** 워크벤치 — 승인 모달이 여기 그려진다 (dialogStyle: custom 일 때). */
async function connectWorkbench() {
  return openTarget((x) => x.type === "page" && x.url.includes("workbench"));
}

const evalIn = async (conn, expr) => {
  const r = await conn.send("Runtime.evaluate", {
    expression: expr, returnByValue: true,
    ...(conn.ctx ? { contextId: conn.ctx } : {}),
  });
  if (r.exceptionDetails) throw new Error("eval");
  return JSON.parse(r.result.value);
};

// 채팅 스냅샷. `streaming` 은 .hps-btn-stop 존재 여부 — ChatPanel.tsx:612.
const CHAT_SNAP = `JSON.stringify((() => {
  const lines = [...document.querySelectorAll('.hps-tool-log-line')].map((el, i) => ({
    i,
    icon: ((el.querySelector('.hps-tool-icon')||{}).textContent || '').trim(),
    label: ((el.querySelector('.hps-tool-label')||{}).textContent || '').trim(),
    state: /hps-tool-error/.test(el.className) ? 'error'
         : /hps-tool-running/.test(el.className) ? 'running' : 'done',
  }));
  const msgs = [...document.querySelectorAll('.hps-msg-user,.hps-msg-assistant')].map(el => ({
    role: /hps-msg-user/.test(el.className) ? 'user' : 'assistant',
    text: (((el.querySelector('.hps-msg-body')||el).textContent) || '').trim(),
  }));
  return { streaming: !!document.querySelector('.hps-btn-stop'), lines, msgs };
})())`;

// 모달 스냅샷. 셀렉터를 짐작하지 않는다 — 후보를 넓게 걸고 잡힌 것의 **실제 클래스**를
// 같이 돌려받아 첫 모달이 스스로를 설명하게 한다.
const MODAL_SNAP = `JSON.stringify((() => {
  const sel = '.monaco-dialog-box, .dialog-box, [role=dialog], .monaco-dialog-modal-block';
  const el = document.querySelector(sel);
  if (!el) return { open: false };
  const buttons = [...el.querySelectorAll('button, .monaco-button')].map(b => (b.textContent||'').trim()).filter(Boolean);
  const text = (el.textContent || '').trim();
  // 코치 승인만 센다. 워크벤치 모달은 전부 같은 셀렉터에 걸리므로 VS Code 자신의
  // 다이얼로그(파일 삭제 확인 등)까지 승인으로 세어 통계가 오염된다 — 실측에서
  // 원장이 index.html 을 지울 때 뜬 "Move to Trash" 가 [승인 1] 로 찍혔다.
  //
  // 코치 모달은 우리가 문구를 소유하므로 접두사로 가른다(chatPanelProvider 의
  // APPROVAL_COPY + 셸/브라우저 분기). 새 문구를 추가하면 여기도 같이 고쳐야 한다.
  const isCoach = /코치가 .*(하려고|열려고|실행하려고|저장하려고|입력하려고) 해요|되돌리기 어려운 명령/.test(text);
  return {
    open: true,
    coach: isCoach,
    cls: el.className,
    text: text.slice(0, 400),
    buttons,
  };
})())`;

// ─── 상태 ────────────────────────────────────────────────────────────────────
let seen = new Map(), turn = 0, turnStart = 0, lastUserCount = 0;
let wasStreaming = false, wsBefore = snapWs(), primed = false;
let modalOpenAt = null, modalWaitMs = 0, modalCount = 0, modalSeen = [];

const flushTurn = () => {
  if (!turn) return;
  const entries = [...seen.values()].sort((a, b) => a.i - b.i);
  const after = snapWs();
  const bm = new Map(wsBefore.map((f) => [f.f, f]));
  const changed = after.filter((f) => { const b = bm.get(f.f); return !b || b.mtime !== f.mtime || b.size !== f.size; });
  const tools = entries.filter((e) => e.icon.includes("🔧"));
  const el = Date.now() - turnStart;
  rec({
    ev: "turn_end", turn, elapsed_ms: el,
    coach_ms: el - modalWaitMs, approval_wait_ms: modalWaitMs, approvals: modalCount,
    tools: tools.length,
    thinks: entries.filter((e) => e.icon.includes("💭")).length,
    errors: entries.filter((e) => e.state === "error").length,
    entries, files: changed.map((f) => ({ f: f.f, size: f.size })),
  });
  console.log(
    `[${hhmm(Date.now())}] ■ 턴 ${turn} 종료 — ${Math.round(el / 1000)}s ` +
    `(코치 ${Math.round((el - modalWaitMs) / 1000)}s + 승인대기 ${Math.round(modalWaitMs / 1000)}s) · ` +
    `🔧${tools.length} ⚠️${entries.filter((e) => e.state === "error").length} · 승인 ${modalCount}회 · 파일 ${changed.length}` +
    (changed.length ? ` (${changed.map((f) => f.f).join(", ")})` : ""),
  );
  wsBefore = after;
};

// ─── 루프 ────────────────────────────────────────────────────────────────────
let chat = null, wb = null;
rec({ ev: "start", ws: WS });
console.log(`[${hhmm(Date.now())}] 관찰 시작 v3 — ${WS}`);

for (;;) {
  if (!chat) {
    try { chat = await connectChat(); rec({ ev: "attach_chat" }); console.log(`[${hhmm(Date.now())}] ✓ 채팅 붙음`); }
    catch { await sleep(2000); continue; }
  }
  if (!wb) {
    try { wb = await connectWorkbench(); rec({ ev: "attach_workbench" }); console.log(`[${hhmm(Date.now())}] ✓ 워크벤치 붙음 (모달 관측 가능)`); }
    catch { /* 없어도 채팅 관측은 계속한다 */ }
  }

  let s;
  try { s = await evalIn(chat, CHAT_SNAP); }
  catch { try { chat.ws.close(); } catch {} chat = null; await sleep(1500); continue; }

  // ── 승인 모달 ──
  if (wb) {
    try {
      const m = await evalIn(wb, MODAL_SNAP);
      if (m.open && !m.coach) {
        // 시스템 다이얼로그 — 기록만 하고 승인 통계에는 넣지 않는다.
        rec({ ev: "system_modal", turn, text: m.text.slice(0, 120) });
      } else if (m.open && modalOpenAt === null) {
        modalOpenAt = Date.now();
        modalCount += 1;
        const first = modalSeen.length === 0;
        modalSeen.push(m.cls);
        rec({ ev: "modal_open", turn, cls: m.cls, text: m.text, buttons: m.buttons, at: Date.now() - turnStart });
        console.log(`   [승인 ${modalCount}] ${(m.text || "").split("\n")[0].slice(0, 70)}`);
        // 첫 모달은 셀렉터가 맞았는지 스스로 증명하게 한다 — 짐작으로 두지 않는다.
        if (first) console.log(`             (셀렉터 확인: class="${m.cls}" 버튼=${JSON.stringify(m.buttons)})`);
      } else if (!m.open && modalOpenAt !== null) {
        const w = Date.now() - modalOpenAt;
        modalWaitMs += w;
        rec({ ev: "modal_close", turn, wait_ms: w });
        console.log(`             → ${(w / 1000).toFixed(1)}s 만에 응답`);
        modalOpenAt = null;
      }
    } catch { try { wb.ws.close(); } catch {} wb = null; }
  }

  // ── 첫 스냅샷은 기준선만 잡는다 ──
  // 붙는 순간 DOM 에는 **지난 턴의 잔여물**이 남아 있다: 사용자 메시지 N개와
  // 직전 턴의 toolLog. 그걸 새 턴으로 세면 시작하자마자 유령 턴이 하나 생기고
  // 남의 도구 호출이 그 턴 것으로 기록된다(실제로 그렇게 나왔다).
  if (!primed) {
    primed = true;
    lastUserCount = s.msgs.filter((m) => m.role === "user").length;
    wasStreaming = s.streaming;
    for (const l of s.lines) seen.set(l.i, { i: l.i, at: 0, icon: l.icon.trim(), label: l.label, state: l.state, stale: true });
    rec({ ev: "primed", users: lastUserCount, stale_lines: s.lines.length, streaming: s.streaming });
    console.log(`[${hhmm(Date.now())}] 기준선 — 기존 대화 ${lastUserCount}턴 · 잔여 로그 ${s.lines.length}행 무시`);
    await sleep(1000);
    continue;
  }

  // ── 턴 경계: 새 사용자 메시지 또는 스트리밍 시작 ──
  const userCount = s.msgs.filter((m) => m.role === "user").length;
  const started = (userCount > lastUserCount) || (s.streaming && !wasStreaming);
  if (started) {
    if (turn && wasStreaming) flushTurn();   // 이전 턴이 안 닫혔으면 닫고 간다
    lastUserCount = Math.max(lastUserCount, userCount);
    turn++; turnStart = Date.now(); seen = new Map();   // 잔여 행도 함께 버려진다
    modalWaitMs = 0; modalCount = 0; modalOpenAt = null;
    const q = [...s.msgs].reverse().find((m) => m.role === "user")?.text ?? "";
    rec({ ev: "turn_start", turn, prompt: q });
    console.log(`\n[${hhmm(Date.now())}] ▶ 턴 ${turn} — "${q.slice(0, 80).replace(/\s+/g, " ")}"`);
  }

  // ── 툴/생각 행 (정체성 = DOM 인덱스) ──
  for (const l of s.lines) {
    const prev = seen.get(l.i);
    if (!prev) {
      const e = { i: l.i, at: Date.now() - turnStart, icon: l.icon.trim(), label: l.label, state: l.state };
      seen.set(l.i, e);
      rec({ ev: "tool", turn, ...e });
      console.log(`   +${(e.at / 1000).toFixed(1).padStart(6)}s ${e.icon} ${l.label.slice(0, 80)}`);
      continue;
    }
    if (prev.label !== l.label) { prev.label = l.label; rec({ ev: "tool_label", turn, i: l.i, label: l.label }); }
    if (prev.state !== l.state) {
      prev.state = l.state;
      rec({ ev: "tool_state", turn, i: l.i, label: l.label, state: l.state, at: Date.now() - turnStart });
      if (l.state === "error") console.log(`            ⚠️  실패 → ${l.label.slice(0, 70)}`);
    }
  }

  // ── 턴 종료: 스트리밍이 꺼진 그 순간 (텍스트 정지가 아니다) ──
  if (wasStreaming && !s.streaming) flushTurn();
  wasStreaming = s.streaming;

  await sleep(1000);
}
