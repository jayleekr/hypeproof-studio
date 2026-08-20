#!/usr/bin/env node
/**
 * kq-live — 아동 코치 루브릭 실측 하네스 (2026-08-20).
 *
 * Studio 가 하는 것을 그대로 한다: 실제 `claude` CLI 를 실제 게이트웨이
 * (ANTHROPIC_BASE_URL=api.hypeproof-ai.xyz) 에 실제 학생 토큰으로 붙여, 사전완성 세상을
 * 작업 폴더에 놓고 아이의 말을 보낸 뒤 **파일과 트랜스크립트로** 채점한다.
 * 시스템 프롬프트·모델·effort 는 게이트웨이가 주입하므로(Studio 와 동일) 여기서 흉내내지 않는다.
 *
 *   HPS_TOKEN=... node e2e/kq-live/run.mjs [--runs 3] [--only S1,S5] [--files index.html,engine.js]
 *
 * 출력: 표(시나리오 × 회차 PASS/FAIL + 시간) + JSON 리포트(e2e/kq-live/report.json).
 * 종료 코드 1 = 하드 항목 중 하나라도 실패.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GW = process.env.HPS_GATEWAY ?? "https://api.hypeproof-ai.xyz";
const TOKEN = process.env.HPS_TOKEN ?? (existsSync("/tmp/hps-token.txt") ? readFileSync("/tmp/hps-token.txt", "utf8").trim() : "");
if (!TOKEN) { console.error("HPS_TOKEN 이 필요하다 (학생 토큰)."); process.exit(2); }
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const RUNS = Number(arg("--runs", "3"));
const ONLY = (arg("--only", "") || "").split(",").filter(Boolean);
const FILES = (arg("--files", "index.html") || "").split(",").filter(Boolean); // 코치에게 보이는 파일 목록 (49 = index.html 만)
const TURN_MAX_S = Number(arg("--turn-max", "150"));

// ── 세상 가져오기 (실제 GET) ─────────────────────────────────────────────────
async function getText(path) {
  const t0 = Date.now();
  const r = await fetch(`${GW}/v1${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text, ms: Date.now() - t0 };
}
const WORLDS = ["kq-catcher","kq-runner","kq-collect","kq-stack","kq-run","kq-whack","kq-memory","kq-jump","kq-sort"];
const GUEST = { "kq-catcher": ["🐕","초코"], "kq-runner": ["🐈","나비"], "kq-collect": ["🐝","붕붕"], "kq-stack": ["🐧","뽀로"], "kq-run": ["🐁","찍찍"], "kq-whack": ["🐹","햄찌"], "kq-memory": ["🦜","앵무"], "kq-jump": ["🐿️","도토"], "kq-sort": ["🦝","라쿤"] };

function studioNote(id) {
  const [e, g] = GUEST[id];
  return `[Studio 안내: 아이가 ${e} ${g} 세상을 골랐고, Studio 가 그 세상(문제 상태 기본값)을 이미 작업 폴더 index.html 에 저장하고 오른쪽 화면에 띄웠다. 코드나 파일 도구 없이 — ${g}의 첫 대사 한 줄과 "한번 해보세요" 만 짧게 말해라. 이후 바꾸기 요청부터 index.html 을 Read 하고 고쳐라.]`;
}
// Studio 의 SDK 코치는 히스토리를 `user: …\nassistant: …` 로 접어 보낸다(#647 전까지). 같은 형식.
function fold(history, userText) {
  const t = history.map((m) => `${m.role}: ${m.content}`).join("\n");
  return t ? `${t}\nuser: ${userText}` : userText;
}

// ── 한 턴 실행 ──────────────────────────────────────────────────────────────
async function runTurn({ cwd, prompt, label }) {
  const cfg = mkdtempSync(join(tmpdir(), "kq-cfg-"));
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.CLAUDE_CODE_USE_BEDROCK; delete env.CLAUDE_CODE_USE_VERTEX;
  env.ANTHROPIC_BASE_URL = GW;
  env.ANTHROPIC_AUTH_TOKEN = TOKEN;
  env.CLAUDE_CONFIG_DIR = cfg;
  env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = "2";
  env.ANTHROPIC_CUSTOM_HEADERS = [
    `x-hps-workspace: ${encodeURIComponent(cwd)}`,
    `x-hps-workspace-files: ${encodeURIComponent(FILES.join("\n"))}`,
  ].join("\n");
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--model", "hypeproof-default",
    "--max-turns", "20", "--permission-mode", "bypassPermissions", "--system-prompt", "",
    "--allowedTools", "Read,Grep,Glob,Edit,MultiEdit,Write", "--disallowedTools", "Bash,WebFetch,WebSearch,Task,NotebookEdit"];
  const t0 = Date.now();
  const ev = { tools: [], texts: [], thinking: 0, errors: [], usage: null, result: null };
  await new Promise((resolve) => {
    const p = spawn(CLAUDE, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const timer = setTimeout(() => { ev.errors.push(`timeout ${TURN_MAX_S * 2}s`); p.kill("SIGKILL"); }, TURN_MAX_S * 2000);
    p.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.type === "assistant" && Array.isArray(j.message?.content)) {
          for (const b of j.message.content) {
            if (b.type === "tool_use") ev.tools.push({ t: (Date.now() - t0) / 1000, name: b.name, input: b.input });
            else if (b.type === "text") ev.texts.push(b.text);
            else if (b.type === "thinking") ev.thinking += (b.thinking ?? "").length;
          }
        } else if (j.type === "user" && Array.isArray(j.message?.content)) {
          for (const b of j.message.content) if (b.type === "tool_result" && b.is_error) ev.errors.push(String(typeof b.content === "string" ? b.content : JSON.stringify(b.content)).slice(0, 200));
        } else if (j.type === "result") { ev.result = j.subtype; ev.usage = j.usage ?? null; }
      }
    });
    p.stderr.on("data", (d) => { const s = d.toString(); if (/error/i.test(s)) ev.errors.push(s.slice(0, 200)); });
    p.on("close", () => { clearTimeout(timer); resolve(); });
  });
  ev.seconds = (Date.now() - t0) / 1000;
  ev.finalText = ev.texts.join("\n");
  return ev;
}

async function prepWorld(id) {
  const cwd = mkdtempSync(join(tmpdir(), "kq-ws-"));
  const html = await getText(`/worlds/${id}`);
  const eng = await getText(`/worlds/${id}/engine.js`);
  if (!html.ok || !eng.ok) throw new Error(`world fetch failed ${id} ${html.status}/${eng.status}`);
  writeFileSync(join(cwd, "index.html"), html.text);
  writeFileSync(join(cwd, "engine.js"), eng.text);
  return { cwd, html: html.text, engine: eng.text, ms: Math.max(html.ms, eng.ms) };
}

// ── 공통 판정 ───────────────────────────────────────────────────────────────
const TITLE = (h) => (/<title>([^<]*)<\/title>/.exec(h) ?? [])[1] ?? "";
const checks = {
  noGameWord: (ev) => ({ ok: !/게임/.test(ev.finalText), why: "답에 '게임' 낱말" }),
  noLabels: (ev) => ({ ok: !/^\s*(User|Assistant|user|assistant|\[아이\]|\[코치\])\s*:/m.test(ev.finalText) && !/\bUser:\s/.test(ev.finalText), why: "답에 User:/assistant: 라벨" }),
  onlyIndex: (ev) => { const bad = ev.tools.filter((t) => { const p = t.input?.file_path ?? t.input?.path ?? ""; return p && !/index\.html$/.test(p) && !(t.name === "Grep" && !p.includes(".")); }); return { ok: bad.length === 0, why: `index.html 외 파일 접근: ${bad.map((b) => `${b.name}(${b.input?.file_path ?? b.input?.path})`).join(", ")}` }; },
  noEngineRead: (ev) => ({ ok: !ev.tools.some((t) => /engine\.js/.test(JSON.stringify(t.input ?? {}))), why: "engine.js 를 읽거나 만짐" }),
  noWholeWrite: (ev) => ({ ok: !ev.tools.some((t) => t.name === "Write"), why: "Write(전체 재작성) 사용" }),
  noToolErrors: (ev) => ({ ok: ev.errors.length === 0, why: `도구 오류 ${ev.errors.length}: ${ev.errors[0] ?? ""}` }),
  underTime: (ev) => ({ ok: ev.seconds <= TURN_MAX_S, why: `${ev.seconds.toFixed(0)}s > ${TURN_MAX_S}s` }),
  finished: (ev) => ({ ok: ev.result === "success", why: `result=${ev.result}` }),
};
const fileHas = (cwd, re) => re.test(readFileSync(join(cwd, "index.html"), "utf8"));
const engineIntact = (cwd) => /function report\(/.test(readFileSync(join(cwd, "engine.js"), "utf8"));

// ── 시나리오 ────────────────────────────────────────────────────────────────
const SCENARIOS = [
  { id: "S1", hard: true, title: "R4 점수판 왼쪽 위 (hud 한 줄)", world: "kq-catcher",
    history: (w) => [{ role: "user", content: `${studioNote(w)}\n\n🐕 초코 세상에 가볼래` }, { role: "assistant", content: "🐕 초코: \"헥헥… 마당이 너무 뜨거워. 불덩이만 떨어져…\" 한번 해보세요!" }],
    user: "점수판 만들어서 왼쪽 위에 붙여줘",
    grade: (ev, ws) => [ { name: "hud 왼쪽 위", ...(() => { const ok = fileHas(ws.cwd, /hud\(\s*['"]왼쪽 위['"]/); return { ok, why: ok ? "" : "index.html 에 hud('왼쪽 위' 없음" }; })() },
      { name: "loop 안", ...(() => { const h = readFileSync(join(ws.cwd, "index.html"), "utf8"); const i = h.indexOf("hud("); const l = h.indexOf("function loop"); return { ok: i > l && l >= 0, why: i > l ? "" : "hud 호출이 loop() 밖" }; })() },
      ...["noGameWord","noLabels","onlyIndex","noEngineRead","noWholeWrite","noToolErrors","underTime","finished"].map((k) => ({ name: k, ...checks[k](ev) })) ] },
  { id: "S2", hard: true, title: "R4 점수판 오른쪽 위로 옮기기", world: "kq-catcher",
    pre: (ws) => { const h = readFileSync(join(ws.cwd, "index.html"), "utf8"); const h2 = h.replace(/(function loop\(\)\{[^\n]*\n)/, `$1  hud('왼쪽 위', '점수 '+(typeof score==='undefined'?0:score));\n`); writeFileSync(join(ws.cwd, "index.html"), h2); },
    history: (w) => [{ role: "user", content: `${studioNote(w)}\n\n🐕 초코 세상에 가볼래` }, { role: "assistant", content: "🐕 초코: \"헥헥… 마당이 너무 뜨거워.\" 한번 해보세요!" }, { role: "user", content: "점수판 만들어서 왼쪽 위에 붙여줘" }, { role: "assistant", content: "왼쪽 위에 점수판을 붙였어요! 확인해 볼래요?" }],
    user: "아니 오른쪽 위로 옮겨줘",
    grade: (ev, ws) => [ { name: "hud 오른쪽 위", ...(() => { const ok = fileHas(ws.cwd, /hud\(\s*['"]오른쪽 위['"]/) && !fileHas(ws.cwd, /hud\(\s*['"]왼쪽 위['"]/); return { ok, why: ok ? "" : "오른쪽 위로 안 옮겨짐(또는 왼쪽 위 잔존)" }; })() },
      ...["noGameWord","noLabels","onlyIndex","noEngineRead","noWholeWrite","noToolErrors","underTime","finished"].map((k) => ({ name: k, ...checks[k](ev) })) ] },
  { id: "S3", hard: true, title: "R2 다른 세상 캐릭터 데려오기 — 세상을 갈아엎지 않는다", world: "kq-catcher",
    history: (w) => [{ role: "user", content: `${studioNote(w)}\n\n🐕 초코 세상에 가볼래` }, { role: "assistant", content: "🐕 초코: \"헥헥… 마당이 너무 뜨거워.\" 한번 해보세요!" }],
    user: "초코 세상에 다람쥐 데려와줘",
    grade: (ev, ws) => [ { name: "제목 유지(초코)", ...(() => { const t = TITLE(readFileSync(join(ws.cwd, "index.html"), "utf8")); return { ok: /초코/.test(t), why: `title=${t}` }; })() },
      { name: "엔진 유지", ...(() => ({ ok: engineIntact(ws.cwd), why: "engine.js 훼손" }))() },
      ...["noGameWord","noLabels","onlyIndex","noEngineRead","noWholeWrite","noToolErrors","underTime","finished"].map((k) => ({ name: k, ...checks[k](ev) })) ] },
  { id: "S4", hard: true, title: "R2 이름만 타이핑 — 세상을 직접 만들지 않고 버튼으로 안내", world: "kq-catcher",
    history: (w) => [{ role: "user", content: `${studioNote(w)}\n\n🐕 초코 세상에 가볼래` }, { role: "assistant", content: "🐕 초코: \"헥헥… 마당이 너무 뜨거워.\" 한번 해보세요!" }],
    user: "도토",
    grade: (ev, ws) => [ { name: "파일 무변경", ...(() => ({ ok: readFileSync(join(ws.cwd, "index.html"), "utf8") === ws.html, why: "index.html 이 바뀜" }))() },
      { name: "버튼 안내", ...(() => ({ ok: /눌러|버튼|Clear/.test(ev.finalText), why: `안내 없음: ${ev.finalText.slice(0, 80)}` }))() },
      { name: "빠름(≤40s)", ...(() => ({ ok: ev.seconds <= 40, why: `${ev.seconds.toFixed(0)}s` }))() },
      ...["noGameWord","noLabels","noWholeWrite","finished"].map((k) => ({ name: k, ...checks[k](ev) })) ] },
  { id: "S5", hard: true, title: "R5 대화 라벨이 답에 찍히지 않는다", world: "kq-runner",
    history: (w) => [{ role: "user", content: `${studioNote(w)}\n\n🐈 나비 세상에 가볼래` }, { role: "assistant", content: "🐈 나비: \"골목이 물에 잠겼어…\" 한번 해보세요!" }, { role: "user", content: "비 그치게 해줘" }, { role: "assistant", content: "비를 그치게 했어요! 어때요?" }, { role: "user", content: "맑은하늘이요" }, { role: "assistant", content: "맑은 하늘로 바꿨어요 ☀️" }],
    user: "해도 하나 띄워줘",
    grade: (ev, ws) => [ ...["noLabels","noGameWord","onlyIndex","noEngineRead","noWholeWrite","noToolErrors","underTime","finished"].map((k) => ({ name: k, ...checks[k](ev) })) ] },
  { id: "S6", hard: false, title: "R3/속도 큰 수정(다리 8개) — engine.js 안 읽고 시간", world: "kq-runner",
    history: (w) => [{ role: "user", content: `${studioNote(w)}\n\n🐈 나비 세상에 가볼래` }, { role: "assistant", content: "🐈 나비: \"골목이 물에 잠겼어…\" 한번 해보세요!" }],
    user: "고양이 다리가 8개였으면 좋겠어",
    grade: (ev, ws) => [ { name: "수정됨", ...(() => ({ ok: readFileSync(join(ws.cwd, "index.html"), "utf8") !== ws.html, why: "index.html 무변경" }))() },
      { name: "≤90s", ...(() => ({ ok: ev.seconds <= 90, why: `${ev.seconds.toFixed(0)}s` }))() },
      ...["noGameWord","noLabels","onlyIndex","noEngineRead","noWholeWrite","noToolErrors","underTime","finished"].map((k) => ({ name: k, ...checks[k](ev) })) ] },
  { id: "S7", hard: true, title: "R3 engine.js 가 목록에 있어도 안 읽는다(48 현실) + 다른 세상 안 섞임", world: "kq-catcher", files: ["index.html", "engine.js"],
    history: (w) => [{ role: "user", content: `${studioNote(w)}\n\n🐕 초코 세상에 가볼래` }, { role: "assistant", content: "🐕 초코: \"헥헥… 마당이 너무 뜨거워.\" 한번 해보세요!" }],
    user: "점수판 만들어줘",
    grade: (ev, ws) => [ { name: "얼음/펭귄 언급 없음", ...(() => ({ ok: !/얼음|펭귄|뽀로|너구리|라쿤/.test(ev.finalText), why: ev.finalText.slice(0, 80) }))() },
      ...["noEngineRead","onlyIndex","noGameWord","noLabels","noWholeWrite","noToolErrors","underTime","finished"].map((k) => ({ name: k, ...checks[k](ev) })) ] },
];

// ── R0: GET 속도 (결정적) ───────────────────────────────────────────────────
async function speedCheck() {
  const rows = [];
  for (const id of WORLDS) {
    const a = await getText(`/worlds/${id}`); const b = await getText(`/worlds/${id}/engine.js`);
    rows.push({ id, html: a.ms, eng: b.ms, ok: a.ok && b.ok && a.ms < 1000 && b.ms < 1000, alien: /S_PENG|S_ICE/.test(b.text) && id !== "kq-stack" });
  }
  return rows;
}

// ── 실행 ────────────────────────────────────────────────────────────────────
const report = { at: new Date().toISOString(), gateway: GW, runs: RUNS, files: FILES, speed: [], scenarios: [] };
console.log(`kq-live — ${GW} · runs=${RUNS} · 코치에게 보이는 파일=${FILES.join(",")}`);
report.speed = await speedCheck();
const speedOk = report.speed.every((r) => r.ok && !r.alien);
console.log(`R0 GET 속도/세상별 엔진: ${speedOk ? "PASS" : "FAIL"}  ` + report.speed.map((r) => `${r.id.slice(3)}=${r.html}/${r.eng}ms${r.alien ? "⚠alien" : ""}`).join(" "));

let hardFail = !speedOk;
for (const sc of SCENARIOS) {
  if (ONLY.length && !ONLY.includes(sc.id)) continue;
  const out = { id: sc.id, title: sc.title, hard: sc.hard, runs: [] };
  const savedFiles = FILES.slice();
  if (sc.files) { FILES.length = 0; FILES.push(...sc.files); }
  for (let r = 1; r <= RUNS; r++) {
    const ws = await prepWorld(sc.world);
    if (sc.pre) sc.pre(ws);
    const prompt = fold(sc.history(sc.world), sc.user);
    const ev = await runTurn({ cwd: ws.cwd, prompt, label: `${sc.id}#${r}` });
    const grades = sc.grade(ev, ws);
    const pass = grades.every((g) => g.ok);
    out.runs.push({ run: r, pass, seconds: +ev.seconds.toFixed(1), tools: ev.tools.map((t) => t.name), thinkingChars: ev.thinking, usage: ev.usage, fails: grades.filter((g) => !g.ok).map((g) => `${g.name}: ${g.why}`), text: ev.finalText.slice(0, 300), cwd: ws.cwd });
    console.log(`${sc.id}#${r} ${pass ? "PASS" : "FAIL"} ${ev.seconds.toFixed(0)}s tools=[${ev.tools.map((t) => t.name).join(",")}]${pass ? "" : "  ✗ " + out.runs.at(-1).fails.join(" | ")}`);
  }
  FILES.length = 0; FILES.push(...savedFiles);
  out.pass = out.runs.every((x) => x.pass);
  if (sc.hard && !out.pass) hardFail = true;
  report.scenarios.push(out);
}
mkdirSync(HERE, { recursive: true });
writeFileSync(join(HERE, "report.json"), JSON.stringify(report, null, 1));
console.log("\n요약:");
for (const s of report.scenarios) console.log(`  ${s.id} ${s.pass ? "PASS" : "FAIL"}${s.hard ? "" : " (soft)"} — ${s.title} — ${s.runs.map((r) => `${r.seconds}s`).join("/")}`);
console.log(`리포트: ${join(HERE, "report.json")}`);
process.exit(hardFail ? 1 : 0);
