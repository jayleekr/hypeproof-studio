// #747 (E1, AE-07 표시 일관성) — one identity resolver shared by host and webview,
// and every sentence that names the AI built from it.
//
// Three locks:
//  1. Parity: resolveCoachIdentity === resolveCoach for every existing case.
//  2. Default-name strings are byte-identical to the literals they replaced
//     (e2e/tests/native-safety-live.spec.ts and e2e/start-page/run.mjs filter
//     on "코치가 파일을 저장하려고 해요" / "코치와 작업을 시작하세요" /
//     "코치와 계속 작업하기"; those must keep passing for a default cohort).
//  3. Static: ChatPanel.tsx imports the shared resolver and no longer carries
//     its own copy of the fixed-name rule (REQ-M33 mirror removed).
// Run: node --experimental-strip-types test/coach-identity.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const id = await import("../src/coachIdentity.ts");
const { resolveCoach, COACH_DEGRADED_NOTICE } = await import("../src/chatPanelHelpers.ts");

// ─── 1. parity with resolveCoach ──────────────────────────────────────
const CASES = [
  [{ name: "마법사", personality: "엉뚱" }, { ux: { coach: { naming_mode: "fixed", fallback_name: "코치" } } }],
  [null, { ux: { coach: { naming_mode: "fixed", fallback_name: "코치" } } }],
  [{ name: "마법사", personality: "엉뚱" }, { ux: { coach: { naming_mode: "user_names_it", fallback_name: "코치" } } }],
  [{ name: "", personality: "" }, { ux: { coach: { naming_mode: "user_names_it", fallback_name: "별이" } } }],
  [null, null],
  [{ name: "햇님", personality: "친절" }, null],
  [{ name: "   ", personality: "  " }, { ux: { coach: { naming_mode: "user_names_it", fallback_name: "코치" } } }],
  [{ name: "anything", personality: "x" }, { ux: { coach: { naming_mode: "fixed", fallback_name: "" } } }],
  // lesson-projected (ADR-0005): fixed + lesson name beats a stored alias
  [{ name: "별이", personality: "장난" }, { ux: { coach: { naming_mode: "fixed", fallback_name: "제작 파트너" } } }],
];
for (const [state, profile] of CASES) {
  const a = id.resolveCoachIdentity(state, profile), b = resolveCoach(state, profile);
  assert.deepEqual({ name: a.name, personality: a.personality }, b, JSON.stringify([state, profile]));
  assert.equal(a.fixed, profile?.ux.coach.naming_mode === "fixed");
}

// ─── 2a. particles ───────────────────────────────────────────────────
for (const [name, subj, comp, topic, obj] of [
  ["코치", "코치가", "코치와", "코치는", "코치를"],
  ["제작 파트너", "제작 파트너가", "제작 파트너와", "제작 파트너는", "제작 파트너를"],
  ["별똥별", "별똥별이", "별똥별과", "별똥별은", "별똥별을"],
  ["검토 도우미", "검토 도우미가", "검토 도우미와", "검토 도우미는", "검토 도우미를"],
  ["Réviseur", "Réviseur가", "Réviseur와", "Réviseur는", "Réviseur를"],
  ["별똥별)", "별똥별)이", "별똥별)과", "별똥별)은", "별똥별)을"],   // trailing bracket skipped
  ["😀", "😀가", "😀와", "😀는", "😀를"],
]) {
  assert.equal(id.asSubject(name), subj);
  assert.equal(id.asCompanion(name), comp);
  assert.equal(id.asTopic(name), topic);
  assert.equal(id.asObject(name), obj);
}

// ─── 2b. default-name strings == previous literals (e2e locks) ────────
const D = id.DEFAULT_COACH_NAME;
assert.equal(D, "코치");
assert.deepEqual(id.approvalCopyFor(D), {
  writeFile: { title: "코치가 파일을 저장하려고 해요:", verb: "저장" },
  readFile: { title: "코치가 파일을 읽으려고 해요:", verb: "읽기" },
  webSearch: { title: "코치가 웹에서 찾아보려고 해요:", verb: "검색" },
  delegateAgent: { title: "코치가 다른 에이전트에게 맡기려고 해요:", verb: "맡기기" },
  browserType: { title: "코치가 페이지에 입력하려고 해요:", verb: "입력" },
});
assert.equal(id.approvalFallbackTitle(D), "코치가 작업을 하려고 해요");
assert.equal(id.shellApprovalTitle(D), "코치가 명령을 실행하려고 해요:");
assert.equal(id.browserApprovalTitle(D), "코치가 브라우저를 열려고 해요:");
assert.equal(
  id.coachDegradedNotice(D),
  "지금 코치는 파일 저장·명령 실행 도구 없이 돌고 있어요 — 만들기와 미리보기는 그대로 되지만, 저장소·배포는 이 상태에서 안 돼요. 스태프를 불러주세요.",
);
assert.equal(COACH_DEGRADED_NOTICE, id.coachDegradedNotice(D), "exported constant keeps the default-name text");
assert.equal(id.pageAttachedNotice(D, true, "제목"), "🖼 화면과 내용을 코치에게 붙였어요 — 제목. 이제 질문을 입력해 보내세요.");
assert.equal(id.pageAttachedNotice(D, false, "https://x"), "📄 내용을 코치에게 붙였어요 — https://x. 이제 질문을 입력해 보내세요.");
const sp = id.startPageCopy();   // undefined name → default
assert.equal(sp.startedTitle, "코치와 작업을 시작하세요");
assert.equal(sp.continueButton, "코치와 계속 작업하기");
assert.equal(sp.startedDescription, "코치 채팅을 열었습니다. 채팅 입력창에 만들고 싶은 것을 적어주세요.");
assert.equal(sp.confirmDescription, "수업과 코치를 확인한 뒤 작업을 시작하세요.");
assert.equal(sp.stepTwo, "코치와 작은 시도부터.");
assert.equal(id.observationIntro(D), "내가 요청한 내용과 코치·도구가 수행한 일을 나누어 확인합니다.");

// ─── 2c. a lesson / student name flows into every sentence ────────────
assert.equal(id.approvalCopyFor("제작 파트너").writeFile.title, "제작 파트너가 파일을 저장하려고 해요:");
assert.equal(id.shellApprovalTitle("별똥별"), "별똥별이 명령을 실행하려고 해요:");
assert.equal(id.coachDegradedNotice("별똥별").startsWith("지금 별똥별은 "), true);
assert.equal(id.startPageCopy("별똥별").startedTitle, "별똥별과 작업을 시작하세요");
assert.equal(id.startPageCopy("제작 파트너").confirmDescription, "수업과 제작 파트너를 확인한 뒤 작업을 시작하세요.");
assert.equal(id.observationIntro("제작 파트너"), "내가 요청한 내용과 제작 파트너·도구가 수행한 일을 나누어 확인합니다.");
// Names are data: markup passes through untouched (renderers escape it).
assert.equal(id.asSubject('<b>제작</b>'), "<b>제작</b>가");

// ─── 3. static — the webview no longer mirrors the rule ──────────────
const chatPanel = readFileSync(new URL("../webview-ui/src/ChatPanel.tsx", import.meta.url), "utf8");
assert.match(chatPanel, /from "\.\.\/\.\.\/src\/coachIdentity"/, "ChatPanel imports the shared resolver");
assert.doesNotMatch(chatPanel, /naming_mode === "fixed"\s*\?\s*\(ux\.coach\.fallback_name/, "hand-mirrored fixed-name rule removed");
// Code lines only — historical comments may still quote the old wording.
const codeOnly = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const provider = codeOnly(readFileSync(new URL("../src/chatPanelProvider.ts", import.meta.url), "utf8"));
for (const literal of ["코치가 파일을 저장하려고 해요", "코치가 명령을 실행하려고 해요", "코치가 브라우저를 열려고 해요", "코치가 작업을 하려고 해요", "코치에게 붙였어요"]) {
  assert.doesNotMatch(provider, new RegExp(literal), `provider no longer hardcodes "${literal}"`);
}
const startPage = readFileSync(new URL("../webview-ui/src/StartPage.tsx", import.meta.url), "utf8");
for (const literal of ["코치와 작업을 시작하세요", "코치와 계속 작업하기", "수업과 코치를 확인", "코치와 작은 시도부터"]) {
  assert.doesNotMatch(startPage, new RegExp(literal), `start page no longer hardcodes "${literal}"`);
}

console.log("✅ coach-identity: parity, particles, default-string locks, lesson-name flow, static mirror check");
