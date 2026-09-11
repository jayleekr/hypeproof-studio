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
  const at = host.indexOf("private proxyUsageRecorder");
  // 아래 `indexOf` 들이 -1 이면 slice 가 파일 나머지 전체가 되어 검사가 **공짜로
  // 통과한다** — 이 파일이 §8 뒤쪽에서 이미 한 번 당한 형태다. 위치를 먼저 단언한다.
  assert.ok(at > 0, "proxyUsageRecorder 를 찾지 못했다");
  const recorder = host.slice(at);
  const end = recorder.indexOf("\n  }");
  assert.ok(end > 0 && end < 1600, "proxyUsageRecorder 본문의 끝을 찾지 못했다");
  const body = recorder.slice(0, end);
  // 호출 문자열을 한 덩어리로 고정하지 않는다 — 인자가 늘면(서버 판정, REQ-M42) 줄이
  // 갈라지고, 그러면 이 단언은 **배선이 멀쩡한데도** 깨진다. 재려는 것은 "판정을
  // usage 의 model 로 한다" 이므로 그것만 잠근다.
  assert.ok(body.includes("modelEchoVerdict(") && body.includes("resolved: u.model"),
    "usage 의 model 로 판정하지 않는다 — 다른 값을 재고 있으면 이 파일의 단언이 전부 무의미하다");
  assert.ok(body.includes("this.modelNoticeTurn === turnId"), "한 턴에 안내가 여러 번 쌓이는 것을 막지 않는다");
  assert.ok(body.includes("onNotice(notice)"), "판정은 하는데 화면으로 보내지 않는다");

  // 전송 경로가 **출처와 선택지를 실제로 넘기는가**. 이게 없으면 모든 턴이
  // unknown 으로 떨어져 경고가 영원히 안 뜬다(조용한 통과).
  const decl = "const modelEcho: ModelEchoContext = {";
  assert.ok(host.includes(decl), "전송 경로가 판정 문맥을 만들지 않는다");
  const ctx = host.slice(host.indexOf(decl));
  // `indexOf` 가 -1 이면 `slice(0,-1)` 이 파일 나머지 전체가 되어 아래 검사가 **전부
  // 공짜로 통과한다** — 변이 대조군이 이 구멍을 잡아냈다(2026-09-11). 끝 표식의
  // 존재와 위치를 먼저 단언한다.
  const ctxEnd = ctx.indexOf("\n      };");
  assert.ok(ctxEnd > 0 && ctxEnd < 600, "판정 문맥 선언을 찾지 못했다");
  const args = ctx.slice(0, ctxEnd);
  for (const field of ["requestedAlias: model", "source:", "choices:", "seatProvider:"]) {
    assert.ok(args.includes(field), `판정 문맥이 ${field} 를 담지 않는다`);
  }
  assert.ok(args.includes("'explicit'") && args.includes("'course_default'") && args.includes("'legacy_alias'"),
    "출처 세 갈래를 구분하지 않는다 — 하나로 접으면 정상 해석까지 경고하거나 진짜 대체를 놓친다");

  // proxy 경로는 둘이다: 일반 전송과 브라우저 루프. **둘 다** 문맥과 안내 경로를
  // 넘겨야 한다 — 한쪽만 배선하면 그 경로에서는 대체가 영원히 조용하다.
  for (const site of ["this.proxyUsageRecorder(streamId, modelEcho, onDelta)",
                      "this.proxyUsageRecorder(p.streamId, p.modelEcho, p.onDelta)"]) {
    assert.ok(host.includes(site), `proxy 경로 하나가 배선되지 않았다: ${site}`);
  }
}

// ─── §9 서버가 직접 말한 판정 (REQ-M42, `x-hps-model-substituted`) ──────────
//
// 여기가 문자열 비교로는 **구별이 불가능했던** 자리다:
//
//   요청 hypeproof-fast → 응답 gpt-5.6-luna    정상 alias 번역
//   요청 claude-opus-5  → 응답 gpt-5.6-luna    요청이 버려졌다
//
// 둘 다 "다르다" 로 보이므로 §2 의 규칙(정상 해석에 경고하지 않는다)을 지키려면
// 허용 목록 밖 alias 는 **침묵**해야 했고, 그 대가로 진짜 버려진 요청도 조용했다.
// 서버가 말해 주면 그 교환이 사라진다.
{
  // 허용 목록 **밖**의 명시 선택(선택기 목록이 수업 재확정으로 바뀐 경우).
  const outside = { ...base(), requestedAlias: "claude-opus-5", resolved: "gpt-5.6" };

  // 대조군 먼저 — 서버 신호가 없으면 **전과 똑같이 조용하다**. 이게 깨지면 이 절의
  // 단언들은 "서버 신호 덕분" 이 아니라 그냥 전부 경고하는 고장을 재는 것이다.
  const quiet = modelEchoVerdict(outside);
  assert.equal(quiet.kind, "server_resolved", "서버 신호 없이 경고로 올라갔다 — 정상 해석까지 경고한다");
  assert.equal(modelEchoNotice(quiet), null);
  assert.equal(describeModelEcho(quiet), "model=server_resolved(gpt-5.6)");

  // 서버가 "못 지켰다" 고 말하면 같은 입력이 경고가 된다.
  const told = modelEchoVerdict({ ...outside, serverSubstituted: true, serverRequested: "claude-opus-5" });
  assert.equal(told.kind, "substituted", "서버가 말해 줬는데도 조용하다 — 신호를 읽지 않는다");
  assert.equal(told.requested, "claude-opus-5");
  assert.equal(told.requestedLabel, "claude-opus-5", "라벨을 모르면 요청 값을 쓴다");
  const notice = modelEchoNotice(told);
  assert.ok(notice && notice.includes("claude-opus-5") && notice.includes("gpt-5.6"));
  // 요청 쪽 공급자를 **모른다**(허용 목록 밖이다). 모르는 것을 "바뀌었다" 로 적지 않는다.
  assert.equal(told.providerChanged, false, "모르는 공급자를 바뀌었다고 적었다");
  assert.doesNotMatch(notice, /만드는 곳이 바뀐/);

  // 위 단언 하나만으로는 **판별이 안 된다**: 답한 모델의 공급자가 좌석 공급자와 같으면
  // 요청 쪽을 좌석 공급자로 잘못 채워도 결과가 똑같이 false 다. 변이 시험에서 그 고장이
  // 살아남아서 드러났다(2026-09-11). 두 공급자가 **갈리는** 시료로 다시 잰다.
  const crossed = modelEchoVerdict({
    ...outside, resolved: "claude-sonnet-4-6", serverSubstituted: true, serverRequested: "claude-opus-5",
  });
  assert.equal(crossed.kind, "substituted");
  assert.equal(crossed.providerChanged, false,
    "요청 쪽 공급자를 좌석 값으로 채워 넣었다 — 모르는 것을 비교 대상으로 삼았다");
  assert.doesNotMatch(modelEchoNotice(crossed), /만드는 곳이 바뀐/);

  // 헤더 부재는 "아니다" 가 아니다 — `false`·`undefined` 둘 다 정보 없음으로 다룬다.
  for (const v of [false, undefined, null]) {
    assert.equal(modelEchoVerdict({ ...outside, serverSubstituted: v }).kind, "server_resolved",
      `serverSubstituted=${v} 를 단정으로 읽었다`);
  }

  // 학생이 고른 것이 아니면 **화면에는 말하지 않는다**(§2 규칙 유지) — 그러나
  // 기록에는 남는다. 수업 기본값이 허용 밖 모델을 들고 있다는 신호다.
  for (const source of ["course_default", "legacy_alias", "unknown"]) {
    const v = modelEchoVerdict({ ...outside, source, serverSubstituted: true });
    assert.equal(v.kind, "server_resolved", `${source} 인데 학생 화면으로 올라갔다`);
    assert.equal(modelEchoNotice(v), null);
    assert.equal(describeModelEcho(v), "model=server_resolved(gpt-5.6,server_substituted)",
      `${source} 의 서버 판정이 기록에서 사라졌다`);
  }

  // **같은 모델이 답했다는 관측이 헤더보다 강하다.** 서버가 치환이라고 말해도 실제로
  // 같은 모델이 답했으면 학생에게 "다른 모델이 답했다" 고 적지 않는다 — 그게 더 나쁜 오류다.
  const agrees = modelEchoVerdict({ ...base(), serverSubstituted: true });
  assert.deepEqual(agrees, { kind: "match", dated: false },
    "같은 모델이 답했는데 헤더만 보고 대체라고 적었다");
  assert.equal(modelEchoNotice(agrees), null);

  // 목록 **안**의 명시 선택이 바뀐 경우는 서버 신호가 있어도 전과 같다(이중 경로 금지).
  const inside = modelEchoVerdict(base({ resolved: "claude-sonnet-4-6", serverSubstituted: true }));
  assert.deepEqual(inside, modelEchoVerdict(base({ resolved: "claude-sonnet-4-6" })),
    "서버 신호가 기존 판정을 덮어써서 결과가 달라졌다");
}

// ─── §10 그 신호가 **실제로 배선돼 있나** (소스 잠금) ───────────────────────
// 판정기만 고치고 헤더를 읽지 않으면 위 §9 는 영원히 dead branch 다.
{
  const client = readFileSync(join(here, "..", "src", "proxyClient.ts"), "utf8");
  assert.ok(client.includes('res.headers.get("x-hps-model-substituted")'),
    "응답 헤더를 읽지 않는다 — §9 는 도달하지 않는 분기다");
  assert.ok(client.includes('res.headers.get("x-hps-model-requested")'),
    "무엇을 요청했는지 되돌려 받지 않는다");
  assert.ok(client.includes('=== "1"'),
    "헤더 값을 엄격히 비교하지 않는다 — 빈 문자열·0 이 참이 될 수 있다");
  // **부재를 거짓으로 내려보내지 않는다**: 치환이 아닐 때는 필드를 아예 싣지 않아야
  // 판정 층이 정보 없음으로 다룬다.
  assert.match(client, /substituted\s*\n?\s*\?\s*\{ serverSubstituted: true/,
    "치환이 아닐 때도 serverSubstituted 를 실어 보낸다 — 부재가 단정이 된다");

  const host = readFileSync(join(here, "..", "src", "chatPanelProvider.ts"), "utf8");
  assert.ok(host.includes("u.serverSubstituted === true"),
    "usage 에 실려 온 서버 판정을 판정기로 넘기지 않는다");
}

console.log("model-echo.smoke: ok");
