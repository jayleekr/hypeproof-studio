// 상대경로 절대화 — 앱 없이, 밀리초.
//
// 이 함수는 코치가 넘긴 입력을 **고쳐서** 실행시킨다. 잘못 고치면 엉뚱한 파일을
// 읽거나 쓴다. 그래서 대조군을 양쪽으로 붙인다:
//   양성 — 상대경로는 워크스페이스 기준으로 절대화되어야 한다
//   음성 — 절대경로·패턴·비경로 필드는 **손대지 않아야** 한다
//
// 음성 쪽이 더 위험하다. 패턴을 절대화하면 Glob 이 조용히 아무것도 못 찾고,
// 그 실패는 "파일이 없다"로 보여서 다시 find ~ 로 이어진다 — 고치려던 바로 그
// 증상이 다른 얼굴로 돌아온다.
//
// Run: node --experimental-strip-types test/absolutize-paths.smoke.mjs

import assert from "node:assert/strict";
import * as path from "node:path";

const { absolutizeToolPaths } = await import("../src/sdkCoachHelpers.ts");

const ROOT = "/Users/student/HypeProofClinic";
const run = (toolName, input, workspaceRoot = ROOT) =>
  absolutizeToolPaths({ toolName, input, workspaceRoot });

// 오라클은 **구현이 쓰는 것과 같은 연산**이어야 한다: 제품은 path.resolve 다
// (sdkCoachHelpers.ts absolutizeToolPaths). path.join 으로 기대값을 만들면
// Windows 에서만 드라이브 문자(`C:`) 유무가 갈려 멀쩡한 제품이 빨강이 된다.
// POSIX 에서는 두 연산의 결과가 같으므로 이 교체는 macOS/CI 동작을 바꾸지 않는다.
const abs = (...segments) => path.resolve(ROOT, ...segments);

// ─── 양성 대조군 — 상대경로는 절대화된다 ────────────────────────────────────
{
  for (const [tool, key] of [
    ["Read", "file_path"],
    ["Write", "file_path"],
    ["Edit", "file_path"],
    ["NotebookEdit", "notebook_path"],
  ]) {
    const r = run(tool, { [key]: "agent.md" });
    assert.equal(r.input[key], abs("agent.md"), `${tool}.${key} 절대화`);
    assert.equal(r.rewritten.length, 1);
    assert.deepEqual(r.rewritten[0], { key, from: "agent.md", to: abs("agent.md") });
  }

  // 하위 경로 · ./ 접두 · 중첩
  assert.equal(run("Read", { file_path: "./index.html" }).input.file_path, abs("index.html"));
  assert.equal(run("Read", { file_path: "sub/dir/a.css" }).input.file_path, abs("sub/dir/a.css"));

  // Glob 의 `path`(탐색 시작 디렉터리)는 경로다 → 절대화 대상
  assert.equal(run("Glob", { path: "src", pattern: "**/*.ts" }).input.path, abs("src"));

  console.log("✓ 양성 대조군 — 상대경로는 워크스페이스 기준으로 절대화된다");
}

// ─── 음성 대조군 — 건드리면 안 되는 것 ──────────────────────────────────────
{
  // workspaceRoot 를 기본 인자로 두지 않는다 — `undefined` 를 명시적으로 넘기는
  // 사례(워크스페이스 없음)가 기본값으로 되돌아가 검사가 무력화됐다. 대조군이
  // 그걸 잡았다.
  const untouched = (label, tool, input, workspaceRoot) => {
    const r = absolutizeToolPaths({ toolName: tool, input, workspaceRoot });
    assert.deepEqual(r.input, input, `손대지 말아야 한다: ${label}`);
    assert.equal(r.rewritten.length, 0, `rewritten 이 비어야 한다: ${label}`);
    // 원본 객체를 제자리에서 바꾸지 않았는지도 본다 (호출부가 원본을 재사용한다)
    assert.equal(r.input, input, `새 객체를 만들지 말아야 한다: ${label}`);
  };

  untouched("이미 절대경로", "Read", { file_path: "/Users/student/HypeProofClinic/agent.md" }, ROOT);
  untouched("루트 밖 절대경로 (막는 건 containment 의 몫)", "Read", { file_path: "/etc/passwd" }, ROOT);
  untouched("Glob 패턴", "Glob", { pattern: "**/*.{html,css,md}" }, ROOT);
  untouched("Grep 패턴 (정규식이다)", "Grep", { pattern: "href=\"about" }, ROOT);
  untouched("경로 아닌 필드", "Read", { limit: 100, offset: 0 }, ROOT);
  untouched("빈 문자열", "Read", { file_path: "" }, ROOT);
  untouched("문자열이 아닌 값", "Read", { file_path: 42 }, ROOT);
  untouched("워크스페이스 루트가 없으면 그대로", "Read", { file_path: "agent.md" }, undefined);

  // 파일 도구가 아닌 것은 통째로 제외 — Bash 의 command 를 건드리면 안 된다
  untouched("Bash", "Bash", { command: "ls -la ." }, ROOT);
  untouched("browser_open", "mcp__hypeproof__browser_open", { url: "boaclinic.com" }, ROOT);
  untouched("WebFetch", "WebFetch", { url: "https://example.com/a" }, ROOT);

  console.log("✓ 음성 대조군 — 절대경로·패턴·비경로 필드·비파일도구는 그대로 둔다");
}

// ─── 워크스페이스 탈출은 절대화만 하고 판정은 넘긴다 ────────────────────────
{
  // 이 함수는 막지 않는다. evaluateSdkToolUse 의 containment 가 막는다.
  // 여기서 막으면 판정이 두 곳으로 갈라져 한쪽만 고쳐지는 사고가 난다.
  const r = run("Write", { file_path: "../../../etc/passwd" });
  assert.equal(r.input.file_path, abs("../../../etc/passwd"), "절대화는 한다");
  // 절대화가 `..` 를 실제로 접었는지 — 오라클과 구현이 같은 연산이라 위 단언만으로는
  // 약해진다. 루트를 벗어났고 절대경로라는 것은 연산과 무관하게 참이어야 한다.
  assert.ok(path.isAbsolute(r.input.file_path), "절대경로여야 한다");
  assert.ok(!r.input.file_path.includes("HypeProofClinic"), "`..` 가 접혀 루트를 벗어나야 한다");
  assert.equal(r.rewritten.length, 1);

  const { evaluateSdkToolUse } = await import("../src/sdkCoachHelpers.ts");
  const v = evaluateSdkToolUse({
    toolName: "Write",
    input: r.input,
    permittedTools: ["Write"],
    workspaceRoot: ROOT,
  });
  assert.equal(v.decision, "deny", "탈출은 containment 가 막아야 한다");
  console.log("✓ 탈출 경로 — 절대화는 하되 차단은 containment 단일 지점이 한다");
}

console.log("\n✓ absolutize-paths smoke 통과");

// ─── displayPath — 세 상황이 다르게 보여야 한다 ─────────────────────────────
{
  const { displayPath, summarizeToolInput } = await import("../src/sdkCoachHelpers.ts");

  // 워크스페이스 안 → 루트 기준 상대
  assert.equal(displayPath(`${ROOT}/agent.md`, ROOT), "agent.md");
  // displayPath 는 path.relative 로 만든다 → 구분자는 그 플랫폼의 것이다.
  assert.equal(displayPath(`${ROOT}/sub/a.css`, ROOT), path.join("sub", "a.css"));
  // 워크스페이스 밖 → 전체 경로 (눈에 띄어야 한다)
  assert.equal(displayPath("/etc/passwd", ROOT), "/etc/passwd");
  assert.equal(displayPath("/Users/student/Desktop/x.html", ROOT), "/Users/student/Desktop/x.html");
  // 상대경로 → ./ 를 붙여 절대경로와 구분
  assert.equal(displayPath("agent.md", ROOT), "./agent.md");
  assert.equal(displayPath("./agent.md", ROOT), "./agent.md");
  // 루트를 모르면 절대경로는 그대로
  assert.equal(displayPath("/x/y.md", undefined), "/x/y.md");

  // 예전 방식이 뭉개던 세 경우가 이제 서로 다르다 — 이게 이 변경의 전부다.
  const shown = [
    summarizeToolInput("Read", { file_path: `${ROOT}/agent.md` }, 60, ROOT),
    summarizeToolInput("Read", { file_path: "agent.md" }, 60, ROOT),
    summarizeToolInput("Read", { file_path: "/etc/passwd" }, 60, ROOT),
  ];
  assert.equal(new Set(shown).size, 3, `세 경우가 구분되어야 한다: ${JSON.stringify(shown)}`);
  console.log("✓ displayPath — 정상/상대경로/워크스페이스밖이 서로 다르게 보인다");
}
