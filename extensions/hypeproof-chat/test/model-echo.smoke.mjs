// #897 H-13 — 요청 ↔ 응답 모델 판정의 대조군 포함 스모크.
//
// 배경: Codex 가 합성 SSE 로 같은 요청에 두 모델을 에코시켰더니 **화면 전체
// innerText 가 완전히 같았다**(2026-09-11 H-05 부분 관측). 조용한 대체가 성공과
// 구별되지 않았다는 뜻이다.
//
// 이 파일이 잠그는 것:
//   1. 명시적 선택이 바뀌면 **말한다**
//   2. 수업 기본값·legacy alias 의 서버 해석은 **말하지 않는다** (정상 경로)
//   3. 날짜 접미만 다른 에코는 대체가 아니다 — 거짓 경고 금지
//   4. 에코가 없으면 일치라고도 불일치라고도 적지 않는다
//   5. 공급자를 모르면 "공급자가 바뀌었다" 고 적지 않는다
//   6. 어떤 경우에도 자동 재전송·자동 모델 변경 문구를 만들지 않는다
//
// Run: node --experimental-strip-types test/model-echo.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { modelEchoVerdict, modelEchoNotice, describeModelEcho } =
  await import("../src/modelEchoHelpers.ts");

const CHOICES = [
  { alias: "gpt-5.6-luna", id: "gpt-5.6", label: "루나", provider: "openai" },
  { alias: "sonnet", id: "claude-sonnet-4-6", label: "소네트", provider: "anthropic" },
  { alias: "haiku", id: "claude-haiku-4-5", label: "하이쿠" },
];
const base = (over = {}) => ({
  requestedAlias: "gpt-5.6-luna",
  source: "explicit",
  resolved: "gpt-5.6",
  choices: CHOICES,
  seatProvider: "openai",
  ...over,
});

// ─── §0 계측기부터 — 정상 경로가 실제로 조용한가, 그리고 진짜 대체는 잡히는가 ───
// 아래 대부분이 "문구가 없다" 형태의 단언이다. 판정기가 항상 null 을 돌려주는
// 고장이면 그 전부가 조용히 통과한다.
{
  assert.deepEqual(modelEchoVerdict(base()), { kind: "match", dated: false });
  assert.equal(modelEchoNotice(modelEchoVerdict(base())), null, "정상 응답에 경고가 붙는다");

  const swapped = modelEchoVerdict(base({ resolved: "claude-sonnet-4-6" }));
  assert.equal(swapped.kind, "substituted", "명시 선택이 바뀌었는데 판정이 없다 — 판정기가 죽어 있다");
  const notice = modelEchoNotice(swapped);
  assert.ok(notice && notice.includes("루나"), "무엇을 골랐는지 말하지 않는다");
  assert.ok(notice.includes("claude-sonnet-4-6"), "무엇이 답했는지 말하지 않는다");
}

// ─── §1 Codex 관측 재현: 같은 요청, 두 에코 ─────────────────────────────────
{
  const matched = modelEchoVerdict(base({ resolved: "gpt-5.6" }));
  const substituted = modelEchoVerdict(base({ resolved: "claude-sonnet-4-6" }));
  assert.notDeepEqual(matched, substituted, "두 에코가 같은 판정으로 접혔다 — 관측된 결함 그대로다");
  assert.notEqual(
    modelEchoNotice(matched),
    modelEchoNotice(substituted),
    "화면에 나가는 문구가 두 경우 같다 — 이것이 H-05 가 관측한 상태다",
  );
  // 공급자까지 바뀐 경우는 더 말한다.
  assert.equal(substituted.providerChanged, true);
  assert.match(modelEchoNotice(substituted), /만드는 곳이 바뀐/);
}

// ─── §2 명시 선택이 아니면 경고하지 않는다 ──────────────────────────────────
{
  for (const source of ["course_default", "legacy_alias", "unknown"]) {
    const v = modelEchoVerdict(base({ source, resolved: "claude-sonnet-4-6" }));
    assert.equal(v.kind, "server_resolved", `${source}: 서버 해석을 대체로 판정했다`);
    assert.equal(modelEchoNotice(v), null, `${source}: 정상 경로에 경고가 붙는다 — 매 턴 경고는 진짜 경고를 묻는다`);
  }
  // 허용 목록에 없는 구형 alias 도 같은 취급이다(명시 선택이라 주장할 근거가 없다).
  const legacy = modelEchoVerdict(base({ requestedAlias: "gpt-4o-mini-legacy", resolved: "gpt-5.6" }));
  assert.equal(legacy.kind, "server_resolved");
  assert.equal(modelEchoNotice(legacy), null);

  // 양성 대조군 — 같은 입력이 explicit 이면 반드시 잡힌다. 없으면 "전부 조용" 구현이 위를 통과한다.
  assert.equal(modelEchoVerdict(base({ resolved: "claude-sonnet-4-6" })).kind, "substituted");
}

// ─── §3 날짜 변형은 대체가 아니다 ───────────────────────────────────────────
{
  for (const resolved of ["gpt-5.6-20260901", "gpt-5.6-260901"]) {
    const v = modelEchoVerdict(base({ resolved }));
    assert.equal(v.kind, "match", `${resolved}: 날짜 접미만 다른데 대체로 잡았다 — 정상 응답마다 거짓 경고가 뜬다`);
    assert.equal(v.dated, true, "날짜 변형이라는 사실 자체는 남아야 한다");
    assert.equal(modelEchoNotice(v), null);
  }
  // 음성 대조군 — 접미가 날짜가 **아니면** 다른 모델이다. 접두만 같다고 같은 모델이 아니다.
  assert.equal(modelEchoVerdict(base({ resolved: "gpt-5.6-turbo" })).kind, "substituted",
    "접두가 같다는 이유로 다른 모델을 같은 것으로 접었다");
  assert.equal(modelEchoVerdict(base({ resolved: "gpt-5.61" })).kind, "substituted");
}

// ─── §4 관측 부재 ───────────────────────────────────────────────────────────
{
  for (const resolved of [null, "", "   "]) {
    const v = modelEchoVerdict(base({ resolved }));
    assert.deepEqual(v, { kind: "unobserved", why: "no_echo" }, "에코가 없는데 판정을 만들었다");
    assert.equal(modelEchoNotice(v), null);
    assert.equal(describeModelEcho(v), "model=unobserved(no_echo)");
    assert.notEqual(v.kind, "match", "측정하지 못한 것을 일치로 적었다");
  }
  const unknownReq = modelEchoVerdict(base({ requestedAlias: null }));
  assert.deepEqual(unknownReq, { kind: "unobserved", why: "unknown_request" });
  assert.equal(modelEchoNotice(unknownReq), null);
}

// ─── §5 공급자를 모르면 바뀌었다고 적지 않는다 ──────────────────────────────
{
  // 허용 목록 밖의 모델이 답했다 — 대체는 맞지만 그 모델의 공급자는 **모른다**.
  const outside = modelEchoVerdict(base({ resolved: "mistral-large" }));
  assert.equal(outside.kind, "substituted");
  assert.equal(outside.providerChanged, false, "모르는 공급자를 '바뀌었다' 로 단정했다");
  assert.ok(!modelEchoNotice(outside).includes("만드는 곳이 바뀐"));

  // 선택지에 provider 가 없으면 좌석 공급자를 쓴다 — 같은 좌석 안의 교체는 공급자 변경이 아니다.
  const sameSeat = modelEchoVerdict({
    ...base({ requestedAlias: "sonnet", resolved: "claude-haiku-4-5" }),
    seatProvider: "anthropic",
  });
  assert.equal(sameSeat.kind, "substituted");
  assert.equal(sameSeat.providerChanged, false, "같은 공급자 안의 교체를 공급자 변경으로 적었다");
}

// ─── §6 대소문자·공백 정규화, 그리고 기록 문자열 ────────────────────────────
{
  assert.equal(modelEchoVerdict(base({ resolved: "  GPT-5.6 " })).kind, "match");
  assert.equal(modelEchoVerdict(base({ requestedAlias: "GPT-5.6-LUNA" })).kind, "match");
  assert.equal(describeModelEcho(modelEchoVerdict(base())), "model=match");
  assert.equal(describeModelEcho(modelEchoVerdict(base({ resolved: "gpt-5.6-20260901" }))), "model=match(dated)");
  assert.match(describeModelEcho(modelEchoVerdict(base({ resolved: "claude-sonnet-4-6" }))), /^model=substituted\(gpt-5\.6-luna->claude-sonnet-4-6,provider_changed\)$/);
}

// ─── §7 자동 실행을 약속하지 않는다 ─────────────────────────────────────────
{
  // Codex 의 요청: "공급자 변경을 별도 승인 없이 자동 실행하는 정책을 추가하지 않는다."
  // 문구가 그런 약속을 하면 학생은 기다린다(REQ-M27 계열: 지킬 수 없는 약속 금지).
  const notices = [
    modelEchoNotice(modelEchoVerdict(base({ resolved: "claude-sonnet-4-6" }))),
    modelEchoNotice(modelEchoVerdict(base({ resolved: "mistral-large" }))),
  ];
  for (const n of notices) {
    assert.ok(!/다시 보낼게요|자동으로|되돌릴게요|바꿔서 다시/.test(n), `자동 실행을 약속한다: ${n}`);
    assert.ok(/다시 골라도|이어가도/.test(n), "다음 행동을 주지 않는다");
  }
  const src = readFileSync(join(here, "..", "src", "modelEchoHelpers.ts"), "utf8");
  assert.ok(!/from ['"]vscode['"]/.test(src), "순수 계층이 vscode 를 import 한다");
}

// ─── §8 판정이 실제로 화면까지 이어져 있나 (소스 잠금) ──────────────────────
// 판정만 재면 그 답을 동작으로 바꾸는 배선이 비어 있어도 전부 통과한다 — 이 레포가
// REQ-R2 (2) 에서 이미 겪은 형태다. 웹뷰/호스트는 단독 실행이 안 되므로 소스로 잠근다.
{
  const host = readFileSync(join(here, "..", "src", "chatPanelProvider.ts"), "utf8");
  const recorder = host.slice(host.indexOf("private proxyUsageRecorder"));
  const body = recorder.slice(0, recorder.indexOf("\n  }"));
  assert.ok(body.includes("modelEchoVerdict({ ...echo, resolved: u.model })"),
    "usage 의 model 로 판정하지 않는다 — 다른 값을 재고 있으면 이 파일의 단언이 전부 무의미하다");
  assert.ok(body.includes("this.modelNoticeTurn === turnId"), "한 턴에 안내가 여러 번 쌓이는 것을 막지 않는다");
  assert.ok(body.includes("onNotice(notice)"), "판정은 하는데 화면으로 보내지 않는다");

  // 전송 경로가 **출처와 선택지를 실제로 넘기는가**. 이게 없으면 모든 턴이
  // unknown 으로 떨어져 경고가 영원히 안 뜬다(조용한 통과).
  const anchor = "onUsage: this.proxyUsageRecorder(streamId, {";
  assert.ok(host.includes(anchor), "전송 경로가 판정 문맥을 넘기지 않는다");
  const sendSite = host.slice(host.indexOf(anchor));
  // `indexOf` 가 -1 이면 `slice(0,-1)` 이 파일 나머지 전체가 되어 아래 필드 검사가
  // **전부 공짜로 통과한다** — 변이 대조군이 이 구멍을 잡아냈다(2026-09-11). 그래서
  // 끝 표식의 존재와 위치를 먼저 단언한다.
  const end = sendSite.indexOf("}, onDelta)");
  assert.ok(end > 0 && end < 600, "안내가 턴 텍스트로 나가는 경로(onDelta)가 끊겼다");
  const args = sendSite.slice(0, end);
  for (const field of ["requestedAlias: model", "source:", "choices:", "seatProvider:"]) {
    assert.ok(args.includes(field), `전송 경로가 ${field} 를 넘기지 않는다`);
  }
  assert.ok(args.includes("'explicit'") && args.includes("'course_default'") && args.includes("'legacy_alias'"),
    "출처 세 갈래를 구분하지 않는다 — 하나로 접으면 정상 해석까지 경고하거나 진짜 대체를 놓친다");
}

console.log("model-echo.smoke: ok");
