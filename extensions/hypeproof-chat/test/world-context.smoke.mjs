// kids-quest — "코치는 지금 세상만 본다" (#644, 2026-08-20 실기기).
//
// 실기기 증상 셋. ① 공용 engine.js 에는 9개 세상 스프라이트가 전부 들어 있어서
// (S_PENG 펭귄·S_ICE 얼음…) 코치가 그 파일을 한 번 읽자 **초코 세상에서 얼음
// 이야기**를 꺼냈다. ② '이전 세상/' 보관본과 루트에 남은 옛 세상 *.html 도 같은
// 오염원이다 — 목록에 뜨기만 하면 코치가 읽는다. ③ 대화를 지우면 코치의 기억만
// 비고 화면의 세상은 그대로라, 아이의 "불 대신 물"에 코치가 무슨 세상인지 몰라
// 되묻거나 새 파일을 만들었다.
//
// Run: node --experimental-strip-types test/world-context.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { worldEngineUrls, filterCoachVisibleFiles, openWorldNotice, WORLD_ARCHIVE_DIR } =
  await import("../src/chatPanelHelpers.ts");

// ─── ① 엔진 주소 — 그 세상 것 먼저, 공용은 폴백 ────────────────────────────
{
  const urls = worldEngineUrls("https://api.hypeproof-ai.xyz/v1", "kq-catcher");
  assert.deepEqual(urls, [
    "https://api.hypeproof-ai.xyz/v1/worlds/kq-catcher/engine.js",
    "https://api.hypeproof-ai.xyz/v1/worlds/engine.js",
  ]);
  assert.equal(urls[0].indexOf("/worlds/kq-catcher/engine.js") > 0, true, "세상별 엔진이 첫 후보");
  // 끝 슬래시가 붙은 설정값에서도 `//worlds` 가 되면 워커가 404 를 준다.
  assert.deepEqual(
    worldEngineUrls("https://api.hypeproof-ai.xyz/v1/", "kq-run"),
    [
      "https://api.hypeproof-ai.xyz/v1/worlds/kq-run/engine.js",
      "https://api.hypeproof-ai.xyz/v1/worlds/engine.js",
    ],
    "끝 슬래시는 하나로 정리한다",
  );
  // id 는 경로 조각이 된다 — 인코딩하지 않으면 경로를 벗어난다.
  assert.equal(
    worldEngineUrls("https://x/v1", "../profile")[0],
    "https://x/v1/worlds/..%2Fprofile/engine.js",
    "id 는 인코딩해서 경로를 벗어나지 못하게",
  );
  console.log("✓ 세상 엔진 주소 — 세상별 우선 · 공용 폴백 4건");
}

// ─── ② 코치에게 보이는 파일 목록 ──────────────────────────────────────────
{
  const kids = { minor_cohort: true, game: { template_tier: "kids-quest" } };
  const files = [
    "index.html",
    "engine.js",
    `${WORLD_ARCHIVE_DIR}/초코의 불볕 마당.html`,
    `${WORLD_ARCHIVE_DIR}/도토의 부러진 가지 (2).html`,
    "도토의 부러진 가지.html", // v0.1.48 이전 — 루트에 쌓인 보관본
    "그림.png",
  ];
  assert.deepEqual(
    filterCoachVisibleFiles(files, kids),
    ["index.html", "그림.png"],
    "아이 트랙에서 코치가 보는 세상은 지금 것 하나뿐",
  );
  // 티어만 kids-quest 여도(minor_cohort 미도착) 같은 규칙.
  assert.deepEqual(filterCoachVisibleFiles(files, { game: { template_tier: "kids-quest" } }), [
    "index.html",
    "그림.png",
  ]);
  // minor_cohort 만으로는 걸지 않는다 (2026-08-20 검토). 이 필터의 근거는 "세상 =
  // index.html 하나" 라는 kids-quest 고유 사실이라, 미성년이라는 이유만으로 teen·
  // kids-rich 트랙의 game.js·추가 페이지까지 코치 목록에서 지우면 코치가 '없는 파일'
  // 로 보고 다시 만든다.
  assert.deepEqual(filterCoachVisibleFiles(files, { minor_cohort: true }), files, "티어를 모르면 건드리지 않는다");
  assert.deepEqual(
    filterCoachVisibleFiles(files, { minor_cohort: true, game: { template_tier: "teen" } }),
    files,
    "미성년이어도 kids- 트랙이 아니면 무변경",
  );
  assert.deepEqual(
    filterCoachVisibleFiles(files, { minor_cohort: true, game: { template_tier: "kids-basic" } }),
    ["index.html", "그림.png"],
    "minor_cohort + kids- 티어는 같은 규칙",
  );
  // 윈도우발 역슬래시 경로도 같은 보관 폴더다.
  assert.deepEqual(
    filterCoachVisibleFiles([`${WORLD_ARCHIVE_DIR}\\초코.html`, "index.html"], kids),
    ["index.html"],
    "역슬래시 경로로도 보관본이 새어 나오면 안 된다",
  );
  // engine.js 는 어디에 있든 숨긴다. 이름이 비슷한 남의 파일까지 지우지는 않는다.
  assert.deepEqual(filterCoachVisibleFiles(["sub/engine.js", "my-engine.js"], kids), ["my-engine.js"]);
  // index.html 은 루트의 것만 — 하위 폴더의 index.html 은 지금 세상이 아니다.
  assert.deepEqual(filterCoachVisibleFiles(["old/index.html", "index.html"], kids), ["index.html"]);

  // 성인 트랙은 무변경 — 작업 폴더 전체가 그들의 작업물이다.
  const adult = { game: { template_tier: "website" } };
  assert.deepEqual(filterCoachVisibleFiles(files, adult), files, "성인 트랙은 한 줄도 빼지 않는다");
  assert.deepEqual(filterCoachVisibleFiles(files, undefined), files, "프로필을 모르면 건드리지 않는다");
  assert.deepEqual(filterCoachVisibleFiles([], kids), [], "빈 목록은 빈 목록 (undefined 와 다르다)");
  console.log("✓ 코치에게 보이는 파일 — 아이 트랙은 index.html 하나 11건");
}

// ─── ③ Clear 뒤 첫 전송에 붙는 한 줄 ──────────────────────────────────────
{
  const choco = {
    id: "kq-catcher",
    guest: "초코",
    emoji: "🐕",
    chip: "🐕 초코 세상에 가볼래",
    aliases: ["강아지"],
    line: "마당이 너무 뜨거워",
  };
  const notice = openWorldNotice(choco);
  assert.ok(notice.startsWith("[Studio 안내:"), "세상을 열 때와 같은 [Studio 안내: …] 형식");
  assert.ok(notice.endsWith("]"), "한 줄로 닫힌다 — 아이 말과 섞이면 안 된다");
  assert.ok(!notice.includes("\n"), "여러 줄이면 모델이 아이 말과 구분을 못 한다");
  assert.ok(notice.includes("초코") && notice.includes("🐕"));
  assert.ok(notice.includes("마당이 너무 뜨거워"), "무슨 문제를 푸는 중인지가 핵심");
  // 2026-08-20 검토 — 이 문구는 프로필의 **정적 기본값**(처음 상태)이다. 아이가 이미
  // 🔥 를 💧 로 바꿔 해결한 뒤에도 붙으므로, 코치가 그것을 현재 상태로 읽고 고쳐 놓은
  // 것을 되돌리지 않도록 시점을 못박는다.
  assert.ok(notice.includes("처음 문제:"), "정적 기본값을 현재 상태처럼 말하면 안 된다");
  assert.ok(notice.includes("이미 고쳤을 수 있다"), "코치가 되돌리는 제안을 하지 않게");
  assert.ok(notice.includes("지금 상태를 확인"), "현재 상태의 출처는 파일이다");
  assert.ok(notice.includes("index.html"), "새로 만들지 말고 지금 파일을 고치라고 못박는다");
  assert.ok(!notice.includes("게임"), "이건 '세상' 이다 — '게임' 이라는 낱말을 쓰지 않는다");
  // line 이 없는 세상도 안내는 나온다(문제만 빠진다).
  assert.ok(openWorldNotice({ ...choco, line: undefined }).includes("초코"));
  assert.ok(!openWorldNotice({ ...choco, line: "  " }).includes("문제:"), "빈 문제는 적지 않는다");
  // 열린 세상이 없으면 아무것도 붙이지 않는다.
  assert.equal(openWorldNotice(null), "");
  assert.equal(openWorldNotice(undefined), "");
  console.log("✓ Clear 뒤 열린 세상 안내 13건");
}

// ─── 회귀 가드 — 배선이 살아 있는가 (vscode 없이 확인할 수 있는 만큼) ─────
{
  const here = dirname(fileURLToPath(import.meta.url));
  const provider = readFileSync(join(here, "..", "src", "chatPanelProvider.ts"), "utf8");
  const coach = readFileSync(join(here, "..", "src", "sdkCoach.ts"), "utf8");

  assert.ok(
    provider.includes("worldEngineUrls(base, id)"),
    "revealPrebuiltWorld 가 세상별 엔진을 먼저 받지 않는다",
  );
  assert.ok(
    !/fetch\(base \+ "\/worlds\/engine\.js"/.test(provider),
    "공용 엔진을 곧바로 받던 옛 경로가 되살아났다 — 남의 세상 스프라이트가 다시 들어온다",
  );
  assert.ok(
    provider.includes("openWorldNotice(open)"),
    "Clear 뒤 첫 전송에 열린 세상 안내를 붙이지 않는다",
  );
  assert.ok(
    /history\.length === 0 && this\.lastPrebuiltWorld/.test(provider),
    "안내 조건이 '히스토리가 비었고 열린 세상이 있을 때' 가 아니다",
  );
  assert.ok(
    coach.includes("coachVisibleWorkspaceFiles(args.cwd, args.profile)"),
    "SDK 코치가 걸러지지 않은 파일 목록을 받는다",
  );
  assert.ok(
    !/workspaceFiles: listWorkspaceFiles\(/.test(coach),
    "필터를 거치지 않는 옛 호출이 남아 있다",
  );

  // 2026-08-20 검토분 —
  // (a) 엔진 두 후보가 다 실패하면 아이 파일에 손대지 않는다. 예전엔 그대로 진행해
  //     index.html 만 새 세상이 되고 engine.js 는 이전 세상 것이라 검은 화면이었다.
  assert.ok(
    /if \(!engineJs\) return false;/.test(provider),
    "엔진을 못 받았는데도 index.html 을 덮어쓴다 — 검은 화면이 조용히 남는다",
  );
  // (b) 보관은 **파일을 실제로 덮어쓰는 지점**(revealBuilt) 한 곳에서. 여기 없으면
  //     "보여줘"/▶ Run 이 옛 펜스로 아이 작업을 보관 없이 덮는다.
  assert.ok(
    provider.includes("this.lastArchivedWorldFile = await this.archiveCurrentWorld(checked.html, opts?.streamId)"),
    "revealBuilt 가 덮어쓰기 전에 보관하지 않는다",
  );
  assert.ok(
    provider.indexOf("archiveCurrentWorld(checked.html") <
      provider.indexOf("await this.saveGameToWorkspace(checked.html)"),
    "보관이 저장보다 뒤에 있으면 보관본이 새 세상이 된다",
  );
  assert.ok(
    !/await this\.archiveCurrentWorld\(html\)/.test(provider),
    "세상 열기 경로에 보관이 남아 있으면 같은 턴에 보관본이 두 벌 생긴다",
  );
  // (c) 보관본은 자체로 열려야 한다 — '이전 세상/' 하위에서는 상대경로 engine.js 가
  //     404 라 S_* ReferenceError 로 빈 화면이 된다.
  assert.ok(
    /const body = await this\.inlineEngineIfNeeded\(html\);/.test(provider),
    "보관본에 엔진을 인라인하지 않으면 열어도 빈 화면이다",
  );
  // 순서: 보관(옛 엔진 인라인) → 새 엔진 저장 → 새 index.html 저장. 엔진을 먼저
  // 갈아 끼우면 보관본에 **다음 세상** 스프라이트가 들어가 어차피 깨진다.
  assert.ok(
    provider.indexOf("archiveCurrentWorld(checked.html") <
      provider.indexOf("if (opts?.engineJs !== undefined) await this.saveEngineToWorkspace(opts.engineJs)"),
    "엔진 교체가 보관보다 앞서면 보관본에 다음 세상 엔진이 들어간다",
  );
  assert.ok(
    provider.indexOf("if (opts?.engineJs !== undefined) await this.saveEngineToWorkspace(opts.engineJs)") <
      provider.indexOf("await this.saveGameToWorkspace(checked.html)"),
    "엔진과 index.html 은 한 짝으로 붙어서 저장돼야 한다",
  );
  // (d) 연타로 세상 열기가 겹치면 보관·index.html 쓰기가 경합한다.
  assert.ok(
    /if \(this\.worldOpening\) return false;/.test(provider),
    "세상 열기 재진입 가드가 없다",
  );
  // (e) 창을 다시 열어도 "지금 열린 세상" 이 남아야 한다(스트립 강조·러너 얼굴·안내).
  assert.ok(
    provider.includes("openWorldKeyForCohort(this.activeCohortId)"),
    "열린 세상이 메모리에만 있으면 창 리로드에서 통째로 사라진다",
  );
  console.log("✓ 배선 회귀 가드 14건");
}
