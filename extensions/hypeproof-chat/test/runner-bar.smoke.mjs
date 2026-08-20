// #642 — "코치가 일하는 동안 살아있는 화면" (달리는 게스트, 2026-08-20 실기기).
//
// 증상: 코치가 "Read ✓" 를 찍고 나면 1~3분 동안 화면이 통째로 정적이다. 초3·4 는
// 그 정적을 **고장**으로 읽어 사이드바를 다시 누르거나 같은 말을 또 보냈고(턴이
// 겹친다), 옆에 앉은 어른도 "멈춘 것 같다" 고 말했다. 툴 로그의 "✍️ 고치는 중…"
// 한 줄로는 부족했다 — 글자는 서 있다.
//
// 여기서 잠그는 것은 그림이 아니라 **판단**이다: ① 언제 달리나(끝난 뒤에도 달리면
// 거짓말), ② 4초마다 무슨 문구인가(빈 줄이 새면 화면이 비어 보인다), ③ 누구 얼굴인가
// (열린 세상이 없으면 남의 이모지를 빌려 오지 않는다). 셋 다 DOM 없이 검증된다.
// 컴포넌트 렌더는 테스트하지 않는다 — 움직임은 CSS 가 가지고, 배선은 아래 회귀 가드가 본다.
//
// Run: node --experimental-strip-types test/runner-bar.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const {
  RUNNER_PHRASE_MS,
  isRunnerCohort,
  runnerFace,
  runnerLines,
  runnerPhrase,
  runnerPhraseIndex,
  shouldShowRunner,
} = await import("../webview-ui/src/runner.ts");

const WORLDS = [
  { id: "kq-catcher", guest: "초코", emoji: "🐕", chip: "🐕 초코 세상에 가볼래", aliases: [] },
  { id: "kq-run", guest: "도토", emoji: "🐿️", chip: "🐿️ 도토 세상에 가볼래", aliases: [] },
];

// ─── ① 언제 달리는가 ───────────────────────────────────────────────────────
{
  const kids = { worldCount: WORLDS.length, tone: "quest" };
  assert.equal(shouldShowRunner({ streaming: true, ...kids }), true);
  // 턴이 끝나면 즉시 멈춘다. 다 끝난 뒤에도 달리면 아이는 아직 일하는 중이라 믿는다.
  assert.equal(shouldShowRunner({ streaming: false, ...kids }), false);

  // 세상이 실려 오면 톤을 몰라도 아이 트랙이다(프로필이 worlds 를 주는 코호트).
  assert.equal(shouldShowRunner({ streaming: true, worldCount: 9, tone: "game" }), true);
  // 반대로 톤이 quest 면 세상 목록이 아직 안 와도 아이 화면이다.
  assert.equal(shouldShowRunner({ streaming: true, worldCount: 0, tone: "quest" }), true);
  // 성인 트랙(웹사이트·검색엔진)에는 붙지 않는다 — 그쪽 진행 표시는 툴 로그가 한다.
  assert.equal(shouldShowRunner({ streaming: true, worldCount: 0, tone: "site" }), false);
  assert.equal(shouldShowRunner({ streaming: true, worldCount: 0, tone: "search" }), false);
  assert.equal(shouldShowRunner({ streaming: true, worldCount: 0, tone: "game" }), false);

  // 코호트 판정은 streaming 과 독립이다 — 턴이 없을 때도 접힌 자리를 남겨야
  // 나타나고 사라질 때 작성란이 튀지 않는다.
  assert.equal(isRunnerCohort({ worldCount: 0, tone: "quest" }), true);
  assert.equal(isRunnerCohort({ worldCount: 0, tone: "site" }), false);
  console.log("✓ 러너 표시 조건 9건");
}

// ─── ② 4초마다 도는 문구 ───────────────────────────────────────────────────
{
  assert.equal(RUNNER_PHRASE_MS, 4000);

  const lines = runnerLines("초코");
  assert.equal(lines.length, 4, "게스트를 알면 이름을 부르는 줄까지 넷");
  assert.equal(lines[3], "초코가 지켜보고 있어요");
  // 이름을 모르면 "가 지켜보고 있어요" 같은 조각 대신 세 줄로 돈다.
  assert.deepEqual(runnerLines(null).length, 3);
  assert.deepEqual(runnerLines("  ").length, 3, "공백뿐인 이름은 이름이 아니다");
  // 조사 (2026-08-20 검토) — 아홉 친구 중 셋이 받침을 가진다. 늘 "가" 로 붙였더니
  // "붕붕가 지켜보고 있어요" 가 1~3분 동안 4초마다 반복됐다.
  assert.equal(runnerLines("붕붕")[3], "붕붕이 지켜보고 있어요", "받침이 있으면 '이'");
  assert.equal(runnerLines("찍찍")[3], "찍찍이 지켜보고 있어요");
  assert.equal(runnerLines("라쿤")[3], "라쿤이 지켜보고 있어요");
  assert.equal(runnerLines("나비")[3], "나비가 지켜보고 있어요", "받침이 없으면 '가'");
  assert.equal(runnerLines("뽀로")[3], "뽀로가 지켜보고 있어요");
  assert.equal(runnerLines("Choco")[3], "Choco가 지켜보고 있어요", "한글 밖 이름은 '가' 로 둔다");
  for (const line of runnerLines("초코")) {
    assert.ok(line.trim().length > 0, "빈 문구는 화면을 비어 보이게 한다");
    assert.ok(!line.includes("게임"), "이건 '세상' 이다 — '게임' 이라는 낱말을 쓰지 않는다");
  }

  // 0~4초는 첫 줄, 4~8초는 둘째 줄 … 끝나면 처음으로 돌아온다.
  assert.equal(runnerPhraseIndex(0, 4), 0);
  assert.equal(runnerPhraseIndex(3999, 4), 0);
  assert.equal(runnerPhraseIndex(4000, 4), 1);
  assert.equal(runnerPhraseIndex(11999, 4), 2);
  assert.equal(runnerPhraseIndex(16000, 4), 0, "네 줄을 다 돌면 처음부터");
  // 첫 렌더(0) · 시계 되감김(음수) · 목록이 빈 경우에도 유효한 인덱스여야 한다.
  assert.equal(runnerPhraseIndex(-5000, 4), 0);
  assert.equal(runnerPhraseIndex(Number.NaN, 4), 0);
  assert.equal(runnerPhraseIndex(8000, 0), 0);

  assert.equal(runnerPhrase(0, "초코"), "세상을 고치는 중…");
  assert.equal(runnerPhrase(12000, "초코"), "초코가 지켜보고 있어요");
  assert.equal(runnerPhrase(12000, null), "세상을 고치는 중…", "세 줄짜리 순환은 12초에 한 바퀴");
  assert.equal(typeof runnerPhrase(1e9, "초코"), "string", "몇 분짜리 턴에도 문구가 있다");
  console.log("✓ 문구 순환 24건");
}

// ─── ③ 누구 얼굴로 달리는가 ────────────────────────────────────────────────
{
  assert.deepEqual(runnerFace(WORLDS, "kq-run"), { emoji: "🐿️", guest: "도토" });
  // 아직 아무 세상도 안 열린 첫 턴: ✨ 로 달리고 이름은 부르지 않는다.
  assert.deepEqual(runnerFace(WORLDS, null), { emoji: "✨", guest: null });
  // 프로필에 없는 id(옛 세션 복원 등)에서도 남의 세상 이모지를 빌려 오지 않는다.
  assert.deepEqual(runnerFace(WORLDS, "kq-gone"), { emoji: "✨", guest: null });
  assert.deepEqual(runnerFace([], "kq-run"), { emoji: "✨", guest: null });
  assert.deepEqual(runnerFace(undefined, "kq-run"), { emoji: "✨", guest: null });
  // 이모지만 비어 있는 세상이면 얼굴만 폴백, 이름은 그대로 쓴다.
  assert.deepEqual(runnerFace([{ id: "x", guest: "초코", emoji: "  " }], "x"), {
    emoji: "✨",
    guest: "초코",
  });
  console.log("✓ 러너 얼굴 6건");
}

// ─── 회귀 가드 — 배선과 움직임 (DOM 없이 확인할 수 있는 만큼) ──────────────
{
  const here = dirname(fileURLToPath(import.meta.url));
  const panel = readFileSync(join(here, "..", "webview-ui", "src", "ChatPanel.tsx"), "utf8");
  const css = readFileSync(join(here, "..", "webview-ui", "src", "styles.css"), "utf8");

  assert.ok(
    /shouldShowRunner\(\{ streaming: busy, worldCount: worlds\.length, tone: appTone \}\)/.test(panel),
    "러너 표시 조건이 순수 함수를 거치지 않는다 — 조건이 갈라지면 테스트가 못 잡는다",
  );
  // 2026-08-20 검토 — 친구를 누른 뒤 streamStart 가 오기까지(세상 HTML+엔진 왕복,
  // 보관, index.html 쓰기) `streaming` 은 아직 false 다. 그 구간에 스트립이 살아
  // 있으면 아이의 연타로 세상 열기가 겹친다. 두 가드를 **같은 값**에 묶는다.
  assert.ok(
    /const busy = streaming \|\| worldPending;/.test(panel),
    "세상 여는 중을 응답 중과 같이 다루지 않는다",
  );
  assert.ok(
    /disabled=\{busy\}/.test(panel),
    "세상 여는 중에도 친구 버튼이 살아 있다 — 연타로 세상 열기가 겹친다",
  );
  assert.ok(
    /if \(busy\) return;\s*\n\s*setWorldPending\(true\);/.test(panel),
    "친구 클릭이 pending 을 세우지 않는다",
  );
  // 지금 열린 세상은 다시 못 누른다 — 재클릭은 아이가 고친 세상을 원본으로 되돌린다.
  assert.ok(
    /disabled=\{disabled \|\| open\}/.test(panel),
    "열린 세상 버튼이 눌린다 — 한 번 탭에 고치던 세상이 초기화된다",
  );
  // Clear 직후에도 무엇을 누르라는 한 줄은 남아야 한다(첫 화면 칩은 중복 제거로 없다).
  assert.ok(
    /showLabel=\{props\.openWorldId === null \|\| messages\.length === 0\}/.test(panel),
    "Clear 뒤 첫 화면에 안내가 하나도 남지 않는다",
  );
  assert.ok(
    panel.includes("<RunnerBar face={runnerWho} running={runnerRunning} />"),
    "작성란 위에 러너 바가 붙어 있지 않다",
  );
  // 러너는 세상 스트립 **위**에 온다(작성란에서 먼 쪽). 순서가 뒤집히면 친구 버튼이
  // 응답 중에 아래로 밀려 손가락이 엉뚱한 세상을 누른다.
  assert.ok(
    panel.indexOf("<RunnerBar") < panel.indexOf("<WorldStrip"),
    "러너 바가 친구 스트립 아래로 내려갔다",
  );
  assert.ok(
    /clearInterval\(timer\)/.test(panel),
    "턴이 끝나도 타이머가 남으면 다음 턴 문구가 엉뚱한 지점에서 시작한다",
  );

  assert.ok(css.includes("@keyframes hps-runner-run"), "달리는 움직임이 없다");
  assert.ok(css.includes("@keyframes hps-runner-hop"), "바운스가 없다");
  assert.ok(/\.hps-runner-dust\b/.test(css), "먼지 점이 없다");
  assert.ok(
    /animation:\s*hps-runner-run\s+2\.4s/.test(css),
    "달리기 주기가 2.4s 가 아니다",
  );
  // 접힌 상태에서도 요소가 남아 있어야 나타남/사라짐이 둘 다 부드럽다.
  assert.ok(
    /\.hps-runner\s*\{[^}]*transition:[^}]*height/.test(css),
    "높이 전환이 없으면 작성란이 40px 튄다",
  );
  // prefers-reduced-motion: 이동은 끄고 깜빡임만 남긴다.
  const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.ok(reduced.includes(".hps-runner-go"), "reduced-motion 에서 달리기를 끄지 않는다");
  assert.ok(reduced.includes("hps-runner-blink"), "reduced-motion 에서 점 깜빡임이 없다");
  assert.ok(
    /\.hps-runner-face\s*\{\s*animation:\s*none/.test(reduced),
    "reduced-motion 에서 얼굴이 계속 뛴다",
  );
  // 어두운 배경에 어두운 글자가 되지 않도록 색은 토큰에서만 온다.
  assert.ok(
    /\.hps-runner\s*\{[^}]*color:\s*var\(--vscode-/.test(css),
    "러너 글자색이 VS Code 토큰이 아니다 — 밝은 테마에서 묻힌다",
  );
  assert.ok(
    /\.hps-runner-on\s*\{[^}]*background:\s*var\(--vscode-/.test(css),
    "러너 카드 배경이 VS Code 토큰이 아니다",
  );
  // 응답 중 흐림이 **열린 세상 칩**까지 먹으면, 아이가 1~3분 내내 보는 유일한
  // "나 지금 어디" 표시가 12px 본문에서 4.5:1 아래로 떨어진다(2026-08-20 검토).
  assert.ok(
    /\.hps-world:disabled:not\(\.hps-world-open\)\s*\{[^}]*opacity:\s*0\.6/.test(css),
    "열린 세상 칩까지 흐려진다 — 상태 표시의 대비가 깨진다",
  );
  assert.ok(
    /\.hps-world-open:disabled\s*\{[^}]*opacity:\s*1/.test(css),
    "열린 세상 칩은 상호작용 대상이 아니라 상태 표시다",
  );
  console.log("✓ 배선·움직임 회귀 가드 20건");
}
