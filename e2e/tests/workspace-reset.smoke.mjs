// 워크스페이스 초기화 가드 — 앱 없이, 밀리초.
//
// 이 함수는 **파일을 지운다.** 판정이 틀리면 복구가 안 된다. 그래서 대조군을
// 붙인다: 지워도 되는 것은 통과해야 하고(양성), 지우면 안 되는 것은 반드시
// 막혀야 한다(음성). 음성 쪽이 여기서는 훨씬 중요하다 — 통과 쪽으로 틀리면
// 홈 디렉터리가 날아간다.
//
// Run: node --experimental-strip-types tests/workspace-reset.smoke.mjs

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { isWipeableWorkspace, resetWorkspace } = await import("../fixtures/workspace.ts");

const home = fs.realpathSync(os.homedir());
const tmp = fs.realpathSync(os.tmpdir());

// ─── 음성 대조군 — 절대 지우면 안 되는 경로 ─────────────────────────────────
{
  const forbidden = [
    ["", "빈 문자열"],
    ["relative/path", "상대 경로"],
    ["/", "루트"],
    [home, "홈 디렉터리 자체"],
    [path.dirname(home), "홈의 부모 (/Users)"],
    [path.join(home, "Documents"), "홈 아래 일반 폴더"],
    [path.join(home, "Desktop"), "바탕화면"],
    ["/Applications", "앱 폴더"],
    [path.join(home, "Projects", "HypeProofSomething"), "이름은 맞지만 홈 바로 아래가 아님"],
  ];
  for (const [p, label] of forbidden) {
    assert.equal(isWipeableWorkspace(p), false, `거부해야 한다: ${label} (${p})`);
    // 실제 호출도 아무것도 지우지 않고 null 을 돌려줘야 한다.
    assert.equal(resetWorkspace(p), null, `resetWorkspace 도 거부해야 한다: ${label}`);
  }
  console.log(`✓ 음성 대조군 ${forbidden.length}건 — 위험 경로는 전부 거부`);
}

// ─── 양성 대조군 — 지워도 되는 경로 ─────────────────────────────────────────
{
  assert.equal(isWipeableWorkspace(path.join(home, "HypeProofClinic")), true, "코호트 워크스페이스");
  assert.equal(isWipeableWorkspace(path.join(home, "HypeProofGames")), true, "다른 코호트");
  assert.equal(isWipeableWorkspace(path.join(tmp, "hps-e2e-abc", "ws")), true, "e2e 임시 워크스페이스");
  console.log("✓ 양성 대조군 — 워크스페이스는 허용");
}

// ─── 실제 삭제 동작 (임시 폴더에서만) ───────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(tmp, "hps-wsreset-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  fs.writeFileSync(path.join(dir, "agent.md"), "# 인계");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "a.txt"), "x");

  const removed = resetWorkspace(dir);
  assert.ok(removed, "임시 폴더는 초기화된다");
  assert.equal(removed.length, 3, "파일 2 + 폴더 1");
  assert.deepEqual(fs.readdirSync(dir), [], "비워졌다");
  // 폴더 자체는 남아야 한다 — 워크스페이스가 사라지면 앱이 폴더를 다시 연다.
  assert.ok(fs.existsSync(dir), "워크스페이스 폴더 자체는 유지");

  assert.deepEqual(resetWorkspace(dir), [], "이미 빈 폴더는 0건");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("✓ 삭제 동작 — 내용만 비우고 폴더는 유지");
}

console.log("\n✓ workspace-reset smoke 통과");
