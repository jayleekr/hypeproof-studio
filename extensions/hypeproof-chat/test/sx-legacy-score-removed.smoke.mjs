// SX-59 / SX-43 — no capability score on the screen during work. Proof of absence for the
// removal of the legacy `assetStatusBar`.
// Run: node --experimental-strip-types test/sx-legacy-score-removed.smoke.mjs
//
// Why this file exists. A test that guards something deleted **must not import the deleted
// thing.** That is the trap this repository has already been bitten by once (#904→#910,
// memory "Assertion proves absence via the defect"): a green test that took the defect as
// its subject of measurement blocked the fix for that defect. So here we read the source
// tree **as files** — we never call the removed module, so it goes red if the module comes
// back and green when the module is gone.
//
// What it counts (verification.md rule 1b — count the creation sites before writing "out of
// scope"):
//   1. The two modules that drew the 7 assets in the status bar are not in the tree.
//   2. Zero forbidden tokens in the two student-facing source trees (src, webview-ui/src).
//   3. The host→webview message `streamAssetScore` is gone from the protocol.
//   4. **Negative control**: the same scanner must catch a sample with the deleted strings
//      planted in it. A proof of absence with no control is indistinguishable from
//      "a check that counts nothing".

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..");

/** Tokens that must never appear in student-facing screen source. Canon: requirements SX-35·SX-59. */
const FORBIDDEN = [
  { id: "seven_assets", re: /7\s*자산/ },
  { id: "asset_histogram_command", re: /showAssetHistogram/ },
  { id: "asset_status_bar", re: /AssetStatusBar/ },
  { id: "asset_score_sink", re: /AssetScoreSink/ },
];

/** Only these extensions are looked at. Build leftover `.js` is untracked, so it is excluded. */
const SOURCE_EXT = /\.(ts|tsx|css)$/;

function sourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (SOURCE_EXT.test(name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

function scan(files) {
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const rule of FORBIDDEN) {
      if (rule.re.test(text)) hits.push(`${relative(ext, file)} :: ${rule.id}`);
    }
  }
  return hits;
}

{
  // 1. The two modules are not in the tree.
  for (const gone of ["src/assetStatusBar.ts", "src/assetStatus.ts", "test/asset-status.smoke.mjs"]) {
    assert.equal(existsSync(join(ext, gone)), false, `${gone} 이 아직 있다 — SX-59 미완`);
  }
  console.log("ok 구형 상태바 모듈과 그 스모크 테스트가 트리에 없다");
}

{
  // 2. Zero forbidden tokens in the student-facing source.
  const files = [...sourceFiles(join(ext, "src")), ...sourceFiles(join(ext, "webview-ui", "src"))];
  assert.ok(files.length > 40, `스캔 대상이 ${files.length}개뿐이다 — 계측기가 트리를 못 찾았다`);
  const hits = scan(files);
  assert.deepEqual(hits, [], `금지 토큰 잔존:\n  ${hits.join("\n  ")}`);
  console.log(`ok src·webview-ui/src ${files.length}개 파일에 금지 토큰 0건`);
}

{
  // 3. The host→webview message is gone. The `AssetScoreChunk` type **stays** —
  //    the proxy SSE parser still needs the path that reads an asset_score chunk and
  //    discards it (design §"디자인 시스템", `test/proxy-client-asset-score.smoke.mjs`).
  const protocol = readFileSync(join(ext, "src", "protocol.ts"), "utf8");
  assert.equal(/streamAssetScore/.test(protocol), false, "streamAssetScore 가 프로토콜에 남아 있다");
  assert.ok(/AssetScoreChunk/.test(protocol), "AssetScoreChunk 타입은 남아 있어야 한다 (SSE 청크를 버리는 경로)");
  console.log("ok streamAssetScore 는 사라지고 AssetScoreChunk 타입은 남았다");
}

{
  // 4. Negative control — does the same scanner catch a planted defect.
  //    These strings are the shape `src/assetStatus.ts:51` actually shipped before 2026-09-20.
  const planted = [
    "$(graph) 7자산 0/7  · Taste  · Intent",
    'this.item.command = "hypeproof-chat.showAssetHistogram";',
    "export class AssetStatusBar implements AssetScoreSink {}",
  ];
  for (const sample of planted) {
    const caught = FORBIDDEN.filter((rule) => rule.re.test(sample));
    assert.ok(caught.length > 0, `음성 대조군이 통과했다 — 계측기가 아무것도 안 세고 있다: ${sample}`);
  }
  console.log("ok 음성 대조군 3건을 전부 잡는다 — 이 검사는 실제로 무언가를 센다");
}

console.log("PASS SX-59 부재 증명: 구형 7자산 상태바가 없고, 계측기는 심은 결함을 잡는다");
