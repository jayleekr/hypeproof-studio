// kids-quest — 덮어쓰기 전 보관 (#649, 2026-08-20). 순수 판단부만 검사한다:
// "보관할까" (내용 비교) 와 "무슨 이름으로" (제목 + 중복 번호).
// 실기기 사고: 같은 세상을 다시 눌렀다는 이유로 보관을 건너뛰어, 아이가 몇 분
// 동안 고친 index.html 이 원본으로 덮여 사라졌다.
import assert from "node:assert/strict";
const { WORLD_ARCHIVE_DIR, worldArchiveTitle, worldArchiveFileName, shouldArchiveWorld } =
  await import("../src/chatPanelHelpers.ts");

assert.equal(WORLD_ARCHIVE_DIR, "이전 세상");

// ---- 보관 여부: 오직 내용 비교 -------------------------------------------
const mine = "<!doctype html><title>초코의 불볕 마당</title><body>물이 떨어진다</body>";
const fresh = "<!doctype html><title>초코의 불볕 마당</title><body>불이 떨어진다</body>";
assert.equal(shouldArchiveWorld(mine, fresh), true, "같은 세상이라도 내용이 다르면 보관한다");
assert.equal(shouldArchiveWorld(fresh, fresh), false, "똑같으면 보관본만 쌓인다");
assert.equal(shouldArchiveWorld(`\n${fresh}\n`, fresh), false, "앞뒤 공백 차이는 차이가 아니다");
assert.equal(shouldArchiveWorld(null, fresh), false, "파일이 없으면 보관할 것도 없다");
assert.equal(shouldArchiveWorld(undefined, fresh), false);
assert.equal(shouldArchiveWorld("   ", fresh), false, "빈 파일은 보관 대상이 아니다");

// ---- 파일 이름: <title> + 중복이면 ' (2)' --------------------------------
assert.equal(worldArchiveTitle(fresh), "초코의 불볕 마당");
assert.equal(worldArchiveTitle("<title>초코 : 마당?</title>"), "초코 마당", "경로 금지 문자는 지우고 공백은 한 칸으로");
assert.equal(worldArchiveTitle("<body>제목 없음</body>"), "이전 세상", "제목이 없어도 이름은 있어야 한다");

assert.equal(worldArchiveFileName("초코의 불볕 마당", []), "초코의 불볕 마당.html");
assert.equal(
  worldArchiveFileName("초코의 불볕 마당", ["초코의 불볕 마당.html"]),
  "초코의 불볕 마당 (2).html",
  "먼저 보관한 것을 덮으면 되돌릴 길이 없다",
);
assert.equal(
  worldArchiveFileName("초코의 불볕 마당", ["초코의 불볕 마당.html", "초코의 불볕 마당 (2).html"]),
  "초코의 불볕 마당 (3).html",
);
assert.equal(
  worldArchiveFileName("Choco Yard", ["choco yard.html"]),
  "Choco Yard (2).html",
  "대소문자만 다른 이름은 같은 파일인 파일시스템이 있다(macOS/Windows)",
);
assert.equal(worldArchiveFileName("", []), "이전 세상.html");

// ---- <title> 변형 (2026-08-20 검토) --------------------------------------
// 좁은 정규식 때문에 서로 다른 세상이 전부 '이전 세상.html' 로 뭉쳤다. 코치가
// "제목 바꿔줘" 로 그 줄을 다시 쓰면 실제로 걸리는 변형들이다.
assert.equal(worldArchiveTitle("<TITLE>초코의 마당</TITLE>"), "초코의 마당", "대문자 태그");
assert.equal(worldArchiveTitle('<title id="t">초코의 마당</title>'), "초코의 마당", "속성이 붙은 태그");
assert.equal(worldArchiveTitle("<title>\n  초코의 마당\n</title>"), "초코의 마당", "여러 줄 제목");
const long = "가".repeat(45);
assert.equal(worldArchiveTitle(`<title>${long}</title>`), "가".repeat(40), "긴 제목은 버리지 말고 자른다");

// ---- 중복 상한: 999 에서도 덮어쓰지 않는다 --------------------------------
// 옛 루프는 n=999 에서 조건이 깨진 채 빠져나와 이미 있는 이름을 그대로 돌려줬다
// (호출부는 검증 없이 writeFile 한다 = 조용한 덮어쓰기).
{
  const many = ["초코.html", ...Array.from({ length: 998 }, (_, i) => `초코 (${i + 2}).html`)];
  const name = worldArchiveFileName("초코", many, new Date(2026, 7, 20, 14, 3, 9));
  assert.equal(name, "초코 (2026-08-20 14-03-09).html", "상한에 닿으면 시각으로 떨어진다");
  assert.ok(
    !many.map((n) => n.toLowerCase()).includes(name.toLowerCase()),
    "이미 있는 보관본을 덮는 이름을 절대 돌려주지 않는다",
  );
  // 같은 초에 두 번이면 임의 꼬리까지 붙여 유일성을 지킨다.
  const again = worldArchiveFileName("초코", [...many, name], new Date(2026, 7, 20, 14, 3, 9));
  assert.notEqual(again.toLowerCase(), name.toLowerCase());
}
console.log("✓ 세상 보관 판단·이름 22건");
