// Smoke for workspaceRouting.ts — "진입할 때 코호트가 다른 폴더를 지정하면
// 자동으로 갈아탄다" 의 규칙 전체.
//
// 왜 이 파일이 중요한가: 이 기능의 실패 모드는 "안 갈아탐"이 아니라 **무한 리로드**다.
// `openFolder` 가 창을 리로드하고 리로드 후 다시 판정하므로, 동일성 비교가 조금만
// 어긋나면 학생 기기가 수업 중에 리로드 루프에 빠진다. 아래 대조군이 그 방향을 잰다.
//
// Run: node --experimental-strip-types test/workspace-routing.smoke.mjs

import assert from "node:assert/strict";
import path from "node:path";

const { decideWorkspaceSwitch, isSameLocation } = await import("../src/workspaceRouting.ts");

const results = [];
function check(label, fn) {
  try { fn(); results.push(true); console.log(`✅ ${label}`); }
  catch (err) { results.push(false); console.log(`❌ ${label}\n   ${err}`); }
}

const GAMES = path.join("/home", "kid", "HypeProofGames");
const CLINIC = path.join("/home", "kid", "HypeProofClinic");

// ─── 갈아타야 하는 경우 (이 기능의 존재 이유) ────────────────────────────────
check("코호트가 다른 폴더를 지정하면 갈아탄다", () => {
  const d = decideWorkspaceSwitch({ openFolders: [GAMES], desiredRoot: CLINIC });
  assert.equal(d.switch, true);
  assert.equal(d.to, CLINIC);
  assert.equal(d.from, GAMES);
});

// ─── 갈아타면 안 되는 경우 ───────────────────────────────────────────────────
check("이미 코호트 폴더면 no-op (리로드 루프의 1차 방어선)", () => {
  const d = decideWorkspaceSwitch({ openFolders: [CLINIC], desiredRoot: CLINIC });
  assert.equal(d.switch, false);
});
check("프로필이 폴더를 지정하지 않으면 현재 폴더 유지", () => {
  assert.equal(decideWorkspaceSwitch({ openFolders: [GAMES], desiredRoot: null }).switch, false);
});
check("열린 폴더가 없으면 전환이 아니라 최초 open 경로", () => {
  assert.equal(decideWorkspaceSwitch({ openFolders: [], desiredRoot: CLINIC }).switch, false);
});
check("멀티루트에 이미 목적지가 있으면 단일루트로 접지 않는다", () => {
  const d = decideWorkspaceSwitch({ openFolders: ["/work/other", CLINIC], desiredRoot: CLINIC });
  assert.equal(d.switch, false);
});
check("e2e 런에서는 픽스처가 연 폴더를 빼앗지 않는다 (#42)", () => {
  const d = decideWorkspaceSwitch({ openFolders: [GAMES], desiredRoot: CLINIC, isE2E: true });
  assert.equal(d.switch, false);
});

// ─── 리로드 루프 차단 (실패 방향이 가장 위험한 지점) ──────────────────────────
check("직전 시도가 실패했으면 같은 목적지를 재시도하지 않는다", () => {
  const d = decideWorkspaceSwitch({
    openFolders: [GAMES],          // 목적지가 안 열렸다 = openFolder 실패
    desiredRoot: CLINIC,
    lastAttemptedRoot: CLINIC,     // 그런데 방금 그걸 시도했다
  });
  assert.equal(d.switch, false, "재시도하면 무한 리로드");
});
check("직전 시도와 다른 목적지면 (코호트 변경) 정상 전환", () => {
  const d = decideWorkspaceSwitch({
    openFolders: [GAMES],
    desiredRoot: CLINIC,
    lastAttemptedRoot: path.join("/home", "kid", "HypeProofTeaser"),
  });
  assert.equal(d.switch, true);
});

// ─── 동일성 비교 — 여기가 어긋나면 루프가 난다 ───────────────────────────────
check("canonicalize(심링크/리다이렉트된 홈)로 같은 곳이면 갈아타지 않는다", () => {
  // /home/kid → /private/home/kid 처럼 한쪽만 풀린 상태. #384 에서 실제로 데였다.
  const canonicalize = (p) => p.replace(/^[/\\]home/, path.join("/private", "home"));
  const d = decideWorkspaceSwitch({
    openFolders: [CLINIC],
    desiredRoot: path.join("/private", "home", "kid", "HypeProofClinic"),
    canonicalize,
  });
  assert.equal(d.switch, false, "심링크 차이를 다른 폴더로 읽으면 영원히 리로드한다");
});
check("후행 구분자 차이는 같은 폴더다", () => {
  assert.equal(isSameLocation(CLINIC, CLINIC + path.sep), true);
});
check("정말 다른 폴더는 다르다 (음성 대조군)", () => {
  assert.equal(isSameLocation(GAMES, CLINIC), false);
});
check("상위/하위 관계는 같은 폴더가 아니다", () => {
  assert.equal(isSameLocation(path.join("/home", "kid"), CLINIC), false);
});

// win32 에서만 의미가 있는 성질 — 대소문자와 드라이브 문자를 흡수해야 한다.
// (path.relative 가 플랫폼별로 처리하므로 win32 에서 실행될 때만 잰다.)
if (process.platform === "win32") {
  check("win32: 대소문자 차이는 같은 폴더다", () => {
    assert.equal(isSameLocation("C:\\Users\\Kid\\HypeProofClinic", "c:\\users\\kid\\hypeproofclinic"), true);
  });
  check("win32: 대소문자만 다른 root 로는 갈아타지 않는다", () => {
    const d = decideWorkspaceSwitch({
      openFolders: ["c:\\Users\\신제형\\HypeProofGames"],
      desiredRoot: "C:\\Users\\신제형\\HypeProofGames",
    });
    assert.equal(d.switch, false, "VS Code 는 드라이브 문자를 소문자로 준다 — 여기서 루프가 났을 것");
  });
  check("win32: 한글 경로에서도 다른 코호트면 정상 전환", () => {
    const d = decideWorkspaceSwitch({
      openFolders: ["C:\\Users\\신제형\\HypeProofGames"],
      desiredRoot: "C:\\Users\\신제형\\HypeProofClinic",
    });
    assert.equal(d.switch, true);
  });
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
