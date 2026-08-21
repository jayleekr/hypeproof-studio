// 결과지 계약 드리프트 락 — 세상이 코치에게 "무엇이 아직 문제인가"를 실제로 전달하는가.
//
// 왜 이 파일이 있나
// ----------------
// 결과지 하나에 네 주체가 관여하는데 계약이 어디에도 적혀 있지 않았다:
//
//   스켈레톤    report({...}) 에 뭘 실을지 각자 정한다
//   engineJs    report() 가 type·ok·guest·world·n 을 덮어쓴다
//   확장        sanitizeQuestResult 가 **낱개만** 통과시킨다 (중첩 객체 차단 —
//               신뢰할 수 없는 iframe 내용이 프롬프트로 타는 것을 막는 보안 경계)
//   프롬프트    코치에게 "[게스트 결과]의 world 플래그로 판단하라"고 시킨다
//
// 각 조각은 저마다 옳은데 **사슬 전체를 아무도 안 봤다.** 결과:
//
//   1) `r.world` 는 묶음이라 필터에서 통째로 사라진다 → 9개 중 8개가 원래 문제
//      상태를 코치에게 못 보낸다. 코치는 성공/실패 숫자만 보고 "고마워"로 닫는다.
//      커리큘럼이 요구하는 "우와 멋있다! 근데… 물은 아직 있는데?" 가 나올 근거가 없다.
//   2) sort 는 `report({ok: <정답 개수>})` 를 보내는데 report() 가 `r.ok` 를
//      성공여부 불리언으로 덮어쓴다 — 이름 충돌. 아이가 몇 개를 맞췄는지 사라진다.
//
// 둘 다 "설정은 맞는데 동작이 없는" 유형이라 눈으로는 안 보인다(.claude/rules/verification.md).
// 그래서 사슬을 통째로 지나는 락을 건다. 이 repo 가 이미 쓰는 기법이다
// (ALLOWED_UPLOAD_FILENAMES 클라·서버 일치, sdk-tool-drift).
//
// 새 세상을 추가할 때: worlds.ts 의 `problem` 에 원래 문제 깃발을 적고, 스켈레톤이
// 그 깃발을 **낱개로** report() 에 실으면 된다. 안 하면 여기서 걸린다.
//
// Run: node --experimental-strip-types test/quest-result-contract.test.mjs

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SK = path.join(HERE, "../src/skeletons/kids-quest");
const REPO = path.join(HERE, "../..");

// 확장의 **진짜** 필터를 쓴다. 여기서 재구현하면 드리프트 락이 아니라 복사본이 된다.
// questResultHelpers 는 vscode 를 import 하지 않는 순수 파일이라 그대로 불러진다.
const { sanitizeQuestResult } = await import(
  path.join(REPO, "extensions/hypeproof-chat/src/questResultHelpers.ts")
);

// worlds.ts 는 확장자 없는 상대 import 를 갖고 있어 Node ESM 이 못 푼다.
// 락에 필요한 것은 선언뿐이므로 텍스트로 읽는다 — 런타임 의존이 없는 편이 락으로서 낫다.
const worldsSrc = fs.readFileSync(path.join(SK, "worlds.ts"), "utf8");
const WORLDS = [...worldsSrc.matchAll(
  /\{ id: "(kq-[a-z]+)", problem: \[([^\]]*)\]/g,
)].map((m) => ({
  id: m[1],
  problem: [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]),
}));
assert.equal(WORLDS.length, 9, `worlds.ts 에서 9개 세상을 못 뽑았다 (${WORLDS.length}개) — 파서를 고쳐라`);

const engineSrc = fs.readFileSync(path.join(SK, "engineJs.ts"), "utf8");

let pass = 0;
const fails = [];
const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m) => { fails.push(m); console.log(`  ✗ ${m}`); };

// ── report() 가 덮어쓰는 키 (engineJs 에서 뽑는다 — 하드코딩하면 드리프트한다) ──
const body = /function report\([^)]*\)\{(.*?)\n?function /s.exec(engineSrc)?.[1]
  ?? /function report\([^)]*\)\{(.{0,800})/s.exec(engineSrc)?.[1]
  ?? "";
assert.ok(body.length > 0, "engineJs.ts 에서 report() 본문을 못 찾았다 — 파서를 고쳐야 한다");
const OVERWRITTEN = [...new Set([...body.matchAll(/\br\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g)].map((m) => m[1]))];

console.log("## 결과지 계약");
console.log(`report() 가 덮어쓰는 키: ${OVERWRITTEN.join(", ")}`);
assert.ok(OVERWRITTEN.includes("world"), "report() 가 r.world 를 붙이지 않는다 — 계약이 바뀌었으면 이 파일도 고쳐라");

// ── 대조군: 필터가 정말 묶음을 버리는가 (락의 전제) ──────────────────────────
console.log("\n## 대조군 — 필터 거동");
{
  const out = sanitizeQuestResult({ score: 3, ok: true, world: { flood: true }, note: "hi" });
  assert.equal(out.score, 3);
  assert.equal(out.ok, true);
  assert.equal(out.note, "hi");
  assert.equal(out.world, undefined);
  ok("양성/음성 — 낱개는 통과, 묶음(world)은 버려진다");
}

// ── 세상별 검사 ──────────────────────────────────────────────────────────────
console.log("\n## 세상별");
for (const w of WORLDS) {
  const file = path.join(SK, `${w.id.replace(/^kq-/, "")}.html`);
  assert.ok(fs.existsSync(file), `${w.id}: 스켈레톤 파일이 없다 (${file})`);
  const src = fs.readFileSync(file, "utf8");

  // 1) 선언한 문제 깃발이 그 세상 WORLD 에 실재하는가
  const wm = /const WORLD=\{(.*?)\n\};/s.exec(src);
  assert.ok(wm, `${w.id}: const WORLD 블록을 못 찾았다`);
  const worldKeys = new Set([...wm[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]));
  const ghost = w.problem.filter((f) => !worldKeys.has(f));
  if (ghost.length) bad(`${w.id}: worlds.ts 가 선언한 문제 깃발이 WORLD 에 없다 — ${ghost.join(", ")}`);
  else ok(`${w.id}: 문제 깃발 [${w.problem.join(", ")}] 이 WORLD 에 실재`);

  // 2) report({...}) 가 싣는 낱개 키
  const calls = [...src.matchAll(/report\(\s*\{(.{0,300}?)\}/gs)].map((m) => m[1]);
  assert.ok(calls.length > 0, `${w.id}: report({...}) 호출을 못 찾았다`);
  const sent = new Set(calls.flatMap((c) => [...c.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((m) => m[1])));

  // 3) 🔴 이름 충돌 — report() 가 덮어쓰는 키를 스켈레톤이 쓰면 조용히 사라진다
  const clash = [...sent].filter((k) => OVERWRITTEN.includes(k));
  if (clash.length) bad(`${w.id}: report() 가 덮어쓰는 키를 싣고 있다 → 값이 사라진다 — ${clash.join(", ")}`);
  else ok(`${w.id}: 이름 충돌 없음`);

  // 4) 🔴 문제 깃발의 **값**이 코치에게 도달하는가.
  //
  // ⚠ 이름만 보면 안 된다. jump 는 `wind:SPEED, brittle:SPECIAL` 을 싣는데 이건
  // WORLD 깃발이 아니라 CONFIG 손잡이 숫자다 — 이름만 같고 뜻이 다르다
  // (WORLD.wind 는 "바람이 분다" 불리언, SPEED 는 세기). 이름만 세면 통과시켜
  // 버린다(첫 판본이 실제로 그랬다). 그래서 `WORLD.<깃발>` 이 report 인자 안에
  // 실제로 쓰였는지를 본다.
  const callSrc = calls.join(" ");
  const missing = w.problem.filter((f) => !new RegExp(`WORLD\\.${f}\\b`).test(callSrc));
  if (missing.length) {
    bad(`${w.id}: 문제 깃발 값이 결과지에 없다 → 코치가 "아직 안 고쳐졌다"를 판정할 수 없다 — ${missing.join(", ")}`);
  } else {
    // 실제 필터를 통과하는지까지 확인 — 불리언·숫자는 통과해야 한다
    const survived = sanitizeQuestResult(Object.fromEntries(w.problem.map((f) => [f, true])));
    const dropped = w.problem.filter((f) => !(f in survived));
    if (dropped.length) bad(`${w.id}: 필터가 깃발을 버린다 — ${dropped.join(", ")}`);
    else ok(`${w.id}: 문제 깃발 값이 낱개로 도달 (${w.problem.join(", ")})`);
  }

  // 5) 🔴 키 상한 — 필터는 16개까지만 통과시킨다(MAX_RESULT_KEYS). 스켈레톤 키 +
  // engineJs 가 나중에 붙이는 5개(type·ok·guest·world·n)가 넘치면 **조용히 잘린다.**
  // 무엇이 잘릴지는 객체 순서에 달려서 예측할 수 없다 — 넘치기 전에 걸러야 한다.
  const full = Object.fromEntries([
    ...[...sent].map((k) => [k, 1]),
    ...OVERWRITTEN.map((k) => [k, true]),
  ]);
  const kept = sanitizeQuestResult(full);
  const lost = Object.keys(full).filter((k) => k !== "type" && !(k in kept));
  if (lost.length) bad(`${w.id}: 키가 상한(16)을 넘어 잘린다 — ${lost.join(", ")}`);
  else ok(`${w.id}: 키 ${Object.keys(full).length - 1}개, 상한 안 (잘림 없음)`);
}

console.log(`\nTotals: PASS=${pass} FAIL=${fails.length}`);
if (fails.length) {
  console.log("\n실패한 계약:");
  for (const f of fails) console.log("  -", f);
  process.exit(1);
}
console.log("✓ 결과지 계약 유지");
