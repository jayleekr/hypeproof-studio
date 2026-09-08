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
// Trailing punctuation/symbols/whitespace are decoration, not the deciding
// letter; digits use their Sino-Korean reading; Latin and emoji keep the vowel
// form (their Korean reading is ambiguous and a wrong 받침 reads worse).
for (const [name, subj, comp, topic, obj, pred] of [
  ["코치", "코치가", "코치와", "코치는", "코치를", "코치예요"],
  ["제작 파트너", "제작 파트너가", "제작 파트너와", "제작 파트너는", "제작 파트너를", "제작 파트너예요"],
  ["별똥별", "별똥별이", "별똥별과", "별똥별은", "별똥별을", "별똥별이에요"],
  ["검토 도우미", "검토 도우미가", "검토 도우미와", "검토 도우미는", "검토 도우미를", "검토 도우미예요"],
  ["Réviseur", "Réviseur가", "Réviseur와", "Réviseur는", "Réviseur를", "Réviseur예요"],
  ["별똥별)", "별똥별)이", "별똥별)과", "별똥별)은", "별똥별)을", "별똥별)이에요"],   // trailing bracket
  ["별똥별!", "별똥별!이", "별똥별!과", "별똥별!은", "별똥별!을", "별똥별!이에요"],   // trailing punctuation
  ["별똥별 ✨", "별똥별 ✨이", "별똥별 ✨과", "별똥별 ✨은", "별똥별 ✨을", "별똥별 ✨이에요"], // trailing symbol
  ["코치1", "코치1이", "코치1과", "코치1은", "코치1을", "코치1이에요"],               // 일 → 받침
  ["도우미2", "도우미2가", "도우미2와", "도우미2는", "도우미2를", "도우미2예요"],       // 이 → none
  ["😀", "😀가", "😀와", "😀는", "😀를", "😀예요"],
]) {
  assert.equal(id.asSubject(name), subj, name);
  assert.equal(id.asCompanion(name), comp, name);
  assert.equal(id.asTopic(name), topic, name);
  assert.equal(id.asObject(name), obj, name);
  assert.equal(id.asPredicate(name), pred, name);
}
// Degenerate inputs never throw and never invent a 받침.
for (const name of ["", "   ", "!!!", "\u200b"]) {
  assert.equal(id.asSubject(name), `${name}가`, JSON.stringify(name));
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
assert.equal(id.composerLabel(D), "코치에게 보낼 메시지");
assert.equal(id.coachIntroSentence(D), "저는 코치예요.");
assert.equal(sp.disconnectedLead, "수업을 연결하면 이곳에서\n내 코치와 작업을 이어갈 수 있습니다.");
// Error copy: the stall constant keeps the exact string its own smoke tests and
// the SDK error path compare against. Gateway auth failure names the code, not
// the AI (#760), so it is deliberately not in this module.
assert.equal(id.stallNotice(), "코치 응답이 너무 오래 걸려요. 다시 한 번 보내주세요. 🕐");
assert.equal(id.profileNotReadyNotice(), "코치 프로필을 아직 못 받았어요. 잠시 후 다시 시도해주세요.");
assert.equal(id.imageAttachPrompt(D, "shot.png"), '🖼 방금 연 이미지 "shot.png"를 코치 채팅에 붙일까요?');

// ─── 2c. a lesson / student name flows into every sentence ────────────
assert.equal(id.approvalCopyFor("제작 파트너").writeFile.title, "제작 파트너가 파일을 저장하려고 해요:");
assert.equal(id.shellApprovalTitle("별똥별"), "별똥별이 명령을 실행하려고 해요:");
assert.equal(id.coachDegradedNotice("별똥별").startsWith("지금 별똥별은 "), true);
assert.equal(id.startPageCopy("별똥별").startedTitle, "별똥별과 작업을 시작하세요");
assert.equal(id.startPageCopy("제작 파트너").confirmDescription, "수업과 제작 파트너를 확인한 뒤 작업을 시작하세요.");
assert.equal(id.observationIntro("제작 파트너"), "내가 요청한 내용과 제작 파트너·도구가 수행한 일을 나누어 확인합니다.");
assert.equal(id.coachIntroSentence("별똥별"), "저는 별똥별이에요.");
assert.equal(id.composerLabel("제작 파트너"), "제작 파트너에게 보낼 메시지");
assert.equal(id.stallNotice("제작 파트너").startsWith("제작 파트너 응답이"), true);
assert.equal(id.profileNotReadyNotice("제작 파트너").startsWith("제작 파트너 프로필을"), true);
assert.equal(id.imageAttachPrompt("별똥별", "a.png"), '🖼 방금 연 이미지 "a.png"를 별똥별 채팅에 붙일까요?');
assert.equal(id.startPageCopy("별똥별").disconnectedLead.includes("내 별똥별과 작업을"), true);

// ─── 2d. approval titles stay recognisable without the name ───────────
// e2e/observe/watch.mjs must tell a coach approval from a VS Code dialog; keying
// on a literal "코치가 " prefix breaks the moment an instructor renames the AI.
for (const name of [D, "제작 파트너", "별똥별", "별똥별!", "Réviseur"]) {
  const titles = [
    ...Object.values(id.approvalCopyFor(name)).map((t) => t.title),
    id.approvalFallbackTitle(name), id.shellApprovalTitle(name), id.browserApprovalTitle(name),
  ];
  for (const t of titles) assert.match(t, id.APPROVAL_TITLE_PATTERN, `${name}: ${t}`);
}
// Negative control: a VS Code dialog must NOT match.
for (const other of ["Move to Trash", "변경 내용을 저장하시겠습니까?", "파일을 삭제할까요?"]) {
  assert.doesNotMatch(other, id.APPROVAL_TITLE_PATTERN, other);
}
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
assert.doesNotMatch(codeOnly(chatPanel), /"코치에게 보낼 메시지"/, "the composer label comes from the shared module");
for (const literal of ["코치와 작업을 시작하세요", "코치와 계속 작업하기", "수업과 코치를 확인", "코치와 작은 시도부터", "내 코치와 작업을 이어갈"]) {
  assert.doesNotMatch(startPage, new RegExp(literal), `start page no longer hardcodes "${literal}"`);
}
const stallSrc = readFileSync(new URL("../src/sdkCoachHelpers.ts", import.meta.url), "utf8");
assert.doesNotMatch(codeOnly(stallSrc), /"코치 응답이 너무 오래 걸려요/, "stall copy comes from the shared module");

// ─── 4. long-name layout: every sentence that carries a name can wrap ──
// #746 feature B acceptance: a valid 40-character name is one unbreakable token,
// and `word-break: keep-all` (right for Korean phrase breaks) then let it run past
// the card — measured 1202px inside a 1140px window before the fix. Every rule that
// renders a name must pair keep-all with overflow-wrap:anywhere.
const startCss = readFileSync(new URL("../webview-ui/src/start.css", import.meta.url), "utf8");
const rule = (selector) => {
  const at = startCss.indexOf(selector + " {");
  assert.notEqual(at, -1, `${selector} exists in start.css`);
  return startCss.slice(at, startCss.indexOf("}", at));
};
for (const selector of [".studio-connect h2", ".studio-card-description", ".studio-process p", ".studio-primary", ".studio-disconnected p"]) {
  assert.match(rule(selector), /overflow-wrap:\s*anywhere/, `${selector} lets an over-long name wrap`);
}

// The start page's top row and a name-bearing error notice must survive the
// narrow + 200%-zoom condition B6 checks (a 440px window reads as 220 CSS px).
assert.match(rule(".studio-top"), /flex-wrap:\s*wrap/, "the brand/nav row wraps instead of overflowing a very narrow window");
assert.match(startCss, /@media\(max-width:260px\)/, "a very-narrow breakpoint exists for the 200%-zoom case");
const chatCss = readFileSync(new URL("../webview-ui/src/styles.css", import.meta.url), "utf8");
const errAt = chatCss.indexOf(".hps-tool-error .hps-tool-label {");
assert.notEqual(errAt, -1, "error tool rows have their own label rule");
const errRule = chatCss.slice(errAt, chatCss.indexOf("}", errAt));
assert.match(errRule, /white-space:\s*normal/, "an error notice wraps instead of being ellipsized with no expand control");

console.log("✅ coach-identity: parity, particles+copula, default-string locks, error copy, watcher pattern, static mirror check");
