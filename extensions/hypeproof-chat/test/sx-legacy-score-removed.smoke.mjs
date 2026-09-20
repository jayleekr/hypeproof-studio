// SX-59 / SX-43 — 작업 중 화면에 역량 점수가 없다. 구형 `assetStatusBar` 제거의 부재 증명.
// Run: node --experimental-strip-types test/sx-legacy-score-removed.smoke.mjs
//
// 왜 이 파일이 있나. 삭제한 것을 지키는 테스트는 **삭제한 것을 import 하면 안 된다.**
// 그게 이 저장소가 이미 한 번 물린 함정이다(#904→#910, memory
// "Assertion proves absence via the defect"): 결함을 계측 대상으로 삼은 초록 테스트가
// 그 결함의 수정을 막았다. 그래서 여기서는 소스 트리를 **파일로** 읽는다 —
// 지워진 모듈을 부르지 않으므로, 모듈이 돌아오면 빨개지고 모듈이 없으면 초록이다.
//
// 무엇을 세는가 (verification.md 규칙 1b — "범위 밖" 을 쓰기 전에 생성 지점을 센다):
//   1. 상태바에 7자산을 그리던 두 모듈이 트리에 없다.
//   2. 학생에게 닿는 두 소스 트리(src, webview-ui/src)에 금지 토큰이 0건이다.
//   3. 호스트→웹뷰 메시지 `streamAssetScore` 가 프로토콜에서 사라졌다.
//   4. **음성 대조군**: 같은 검사기가 지워진 문자열을 심은 시료에서는 반드시 잡는다.
//      대조군 없는 부재 증명은 "아무것도 안 세는 검사" 와 구분되지 않는다.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..");

/** 학생에게 닿는 화면 소스에서 절대 나오면 안 되는 토큰. 정본은 요구 SX-35·SX-59. */
const FORBIDDEN = [
  { id: "seven_assets", re: /7\s*자산/ },
  { id: "asset_histogram_command", re: /showAssetHistogram/ },
  { id: "asset_status_bar", re: /AssetStatusBar/ },
  { id: "asset_score_sink", re: /AssetScoreSink/ },
];

/** 이 확장자만 본다. 빌드 잔재 `.js` 는 추적되지 않으므로 제외한다. */
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
  // 1. 두 모듈이 트리에 없다.
  for (const gone of ["src/assetStatusBar.ts", "src/assetStatus.ts", "test/asset-status.smoke.mjs"]) {
    assert.equal(existsSync(join(ext, gone)), false, `${gone} 이 아직 있다 — SX-59 미완`);
  }
  console.log("ok 구형 상태바 모듈과 그 스모크 테스트가 트리에 없다");
}

{
  // 2. 학생에게 닿는 소스에 금지 토큰 0건.
  const files = [...sourceFiles(join(ext, "src")), ...sourceFiles(join(ext, "webview-ui", "src"))];
  assert.ok(files.length > 40, `스캔 대상이 ${files.length}개뿐이다 — 계측기가 트리를 못 찾았다`);
  const hits = scan(files);
  assert.deepEqual(hits, [], `금지 토큰 잔존:\n  ${hits.join("\n  ")}`);
  console.log(`ok src·webview-ui/src ${files.length}개 파일에 금지 토큰 0건`);
}

{
  // 3. 호스트→웹뷰 메시지가 사라졌다. 타입 `AssetScoreChunk` 는 **남는다** —
  //    프록시 SSE 파서가 asset_score 청크를 읽고 버리는 경로가 계속 필요하다
  //    (설계 §디자인 시스템, `test/proxy-client-asset-score.smoke.mjs`).
  const protocol = readFileSync(join(ext, "src", "protocol.ts"), "utf8");
  assert.equal(/streamAssetScore/.test(protocol), false, "streamAssetScore 가 프로토콜에 남아 있다");
  assert.ok(/AssetScoreChunk/.test(protocol), "AssetScoreChunk 타입은 남아 있어야 한다 (SSE 청크를 버리는 경로)");
  console.log("ok streamAssetScore 는 사라지고 AssetScoreChunk 타입은 남았다");
}

{
  // 4. 음성 대조군 — 같은 검사기가 심은 결함을 잡는가.
  //    이 문자열들은 2026-09-20 이전 `src/assetStatus.ts:51` 이 실제로 출하하던 형태다.
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
