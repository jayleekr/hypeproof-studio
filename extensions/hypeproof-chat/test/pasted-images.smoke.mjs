// #421 — 붙여넣은 이미지를 워크스페이스 파일로 남기는 경로의 순수 판정 테스트.
//
// 계측기 규율(.claude/rules/verification.md 규칙 2): 판정마다 **양성·음성 대조군**을
// 둔다. 양성 = 진짜 붙여넣기가 통과해야 한다(너무 엄격한 검사를 잡는다).
// 음성 = 이미지가 아닌 것이 저장되면 안 된다(너무 관대한 검사를 잡는다).
//
// 여기서 재지 않는 것: vscode.workspace.fs 로 실제 쓰는 부분(호스트). 그건
// chatPanelProvider 에 있고 vscode API 가 필요해 노드에서 못 돈다 → PR 본문의
// "실기기 미검증" 에 명시했다.

import assert from "node:assert/strict";
import {
  PASTED_IMAGE_DIR,
  parsePastedImage,
  pastedImageFailureLabel,
  pastedImageName,
  pastedImageNote,
  pastedImageSavedLabel,
} from "../src/pastedImages.ts";

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ── 양성 대조군 — 실제로 웹뷰가 보내는 모양이 통과해야 한다 ────────────────
// 출처: webview-ui/src/ChatPanel.tsx — FileReader.readAsDataURL(원본 유지) 및
// canvas.toDataURL("image/jpeg", q)(#389 축소본). 둘 다 받아야 한다.

ok("PNG 붙여넣기(원본 경로)를 받는다", () => {
  const r = parsePastedImage("data:image/png;base64,iVBORw0KGgo=");
  assert.equal(r?.mime, "image/png");
  assert.equal(r?.ext, "png");
  assert.equal(r?.base64, "iVBORw0KGgo=");
});

ok("JPEG 축소본(#389 canvas.toDataURL)을 받는다", () => {
  const r = parsePastedImage("data:image/jpeg;base64,/9j/4AAQSkZJRg==");
  assert.equal(r?.ext, "jpg");
});

ok("webp · gif 도 받는다", () => {
  assert.equal(parsePastedImage("data:image/webp;base64,UklGRg==")?.ext, "webp");
  assert.equal(parsePastedImage("data:image/gif;base64,R0lGODlh")?.ext, "gif");
});

ok("base64 안의 줄바꿈/공백을 흘려보내지 않는다", () => {
  // 일부 인코더가 76자마다 줄을 바꾼다. 그대로 Buffer.from 에 넘기면 깨진다.
  const r = parsePastedImage("data:image/png;base64,iVBOR\nw0KG\t go=");
  assert.equal(r?.base64, "iVBORw0KGgo=");
});

// ── 음성 대조군 — 저장되면 안 되는 것들 ──────────────────────────────────
// 이 경로는 "웹뷰가 준 문자열로 디스크에 쓴다" 이므로, 관대하면 그대로 결함이다.

ok("이미지가 아닌 data URL 은 거절한다", () => {
  assert.equal(parsePastedImage("data:text/html;base64,PHNjcmlwdD4="), null);
  assert.equal(parsePastedImage("data:application/javascript;base64,YWxlcnQoMSk="), null);
  assert.equal(parsePastedImage("data:image/svg+xml;base64,PHN2Zz4="), null); // SVG = 실행 가능 마크업
});

ok("base64 가 아닌 data URL 은 거절한다", () => {
  assert.equal(parsePastedImage("data:image/png,notbase64"), null);
  assert.equal(parsePastedImage("data:image/png;utf8,hello"), null);
});

ok("data URL 이 아예 아니면 거절한다", () => {
  assert.equal(parsePastedImage("https://example.com/a.png"), null);
  assert.equal(parsePastedImage("file:///etc/passwd"), null);
  assert.equal(parsePastedImage(""), null);
  assert.equal(parsePastedImage(undefined), null);
  assert.equal(parsePastedImage(null), null);
  assert.equal(parsePastedImage(42), null);
});

ok("본문이 빈 data URL 은 거절한다", () => {
  assert.equal(parsePastedImage("data:image/png;base64,"), null);
});

// ── 이름 짓기 — 덮어쓰기가 나면 참가자 사진이 조용히 사라진다 ──────────────

ok("파일명은 시각+순번이라 다음 턴이 이전 턴을 덮지 않는다", () => {
  const t1 = new Date(2026, 7, 2, 14, 30, 12);
  const t2 = new Date(2026, 7, 2, 14, 30, 13);
  assert.equal(pastedImageName(t1, 1, "png"), "pasted-20260802-143012-1.png");
  assert.notEqual(pastedImageName(t1, 1, "png"), pastedImageName(t2, 1, "png"));
  assert.notEqual(pastedImageName(t1, 1, "png"), pastedImageName(t1, 2, "png"));
});

ok("한 자리 월/일/시/분/초를 0 으로 채운다", () => {
  assert.equal(
    pastedImageName(new Date(2026, 0, 5, 9, 8, 7), 1, "jpg"),
    "pasted-20260105-090807-1.jpg",
  );
});

ok("dedupe 는 같은 초 충돌에 다른 이름을 준다", () => {
  const t = new Date(2026, 7, 2, 14, 30, 12);
  const names = new Set([
    pastedImageName(t, 1, "png"),
    pastedImageName(t, 1, "png", 1),
    pastedImageName(t, 1, "png", 2),
  ]);
  assert.equal(names.size, 3);
});

ok("파일명에 경로 구분자가 들어갈 수 없다", () => {
  // 확장자는 mime 화이트리스트에서만 오고 이름은 숫자로만 조립된다 —
  // 참가자·모델 문자열이 파일명에 닿는 경로가 없다는 것을 고정한다.
  for (const ext of ["png", "jpg", "webp", "gif"]) {
    const n = pastedImageName(new Date(2026, 7, 2, 14, 30, 12), 1, ext);
    assert.ok(!n.includes("/") && !n.includes("\\") && !n.includes(".."), n);
  }
});

// ── 코치에게 넘기는 문구 — 이 문구가 원래 증상을 막는 실물이다 ─────────────

ok("저장이 없으면 문구도 없다 (프롬프트를 공짜로 늘리지 않는다)", () => {
  assert.equal(pastedImageNote([], "/Users/x/HypeProofClinic"), "");
});

ok("문구에 상대경로와 작업폴더가 함께 들어간다", () => {
  const note = pastedImageNote(
    [`${PASTED_IMAGE_DIR}/pasted-20260802-143012-1.png`],
    "/Users/x/HypeProofClinic",
  );
  assert.ok(note.includes("assets/pasted-20260802-143012-1.png"));
  assert.ok(note.includes("/Users/x/HypeProofClinic"));
  assert.ok(note.includes("<pasted-images>") && note.includes("</pasted-images>"));
});

ok("문구가 '저장해 달라'는 되묻기를 명시적으로 막는다", () => {
  // 2026-07-24 실강의에서 코치가 실제로 한 말이 "파일로 저장해 주시겠어요?" 였다.
  // 파일이 생긴 뒤에도 같은 말을 하지 않게 하는 문장이 있는지 고정한다.
  const note = pastedImageNote(["assets/a.png"], "/w");
  assert.ok(note.includes("요청하지 않고"));
  assert.ok(note.includes("<img src>"));
});

ok("여러 장이면 전부 나열한다", () => {
  const note = pastedImageNote(["assets/a.png", "assets/b.jpg"], "/w");
  assert.ok(note.includes("assets/a.png") && note.includes("assets/b.jpg"));
  assert.ok(note.includes("2장"));
});

// ── 참가자에게 보이는 줄 ────────────────────────────────────────────────

ok("저장 성공/실패 라벨이 서로 구분된다", () => {
  assert.ok(pastedImageSavedLabel(["assets/a.png"]).includes("assets/a.png"));
  assert.ok(pastedImageSavedLabel(["assets/a.png", "assets/b.png"]).includes("2장"));
  assert.ok(pastedImageFailureLabel(2).includes("2장"));
  assert.notEqual(pastedImageSavedLabel(["assets/a.png"]), pastedImageFailureLabel(1));
});

console.log(`\n#421 pasted-images: ${passed} checks passed`);
