// #897 V0 — 음성 capability 계측기. 기능이 아니라 **측정기**를 검증한다.
//
// 이 파일이 지키는 것은 하나다: **측정하지 않은 것을 막혔다고 적지 않는다.**
// 그 구분이 없으면 "음성 안 됨" 이 "아직 안 쟀음" 을 덮고, 나중에 patch 가 들어가도
// 아무도 다시 재지 않는다.
//
// 설치본 0.1.51 번들 코어에서 webview iframe 의 allow 목록에 `microphone` 이 0건임을
// 확인했으므로 **오늘은 모든 빌드가 blocked 로 나온다.** 그래서 양성 대조군이 특히
// 중요하다 — 분류기를 `return "blocked"` 로 써도 나머지가 전부 통과한다.
//
// Run: node --experimental-strip-types test/voice-capability.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const {
  VOICE_CAPABILITY_SCHEMA,
  VoiceProbeMalformedError,
  buildVoiceCapabilityReport,
  summarizeVoiceCapability,
} = await import("../src/voiceCapabilityHelpers.ts");

const META = { probedAt: "2026-09-10T10:00:00.000Z", appVersion: "0.1.51", extensionVersion: "0.1.5", platform: "darwin-arm64" };
const notAttempted = { attempted: false };
const base = {
  mediaDevicesPresent: true,
  getUserMedia: notAttempted,
  audioContext: notAttempted,
  htmlAudioDataUri: notAttempted,
  audioWorkletBlob: notAttempted,
  cspObserved: "default-src 'none'; script-src 'nonce-x'",
  userAgent: "Mozilla/5.0 Electron/39.8.7",
};
const report = (o) => buildVoiceCapabilityReport({ ...base, ...o }, META);

// ─── 양성 대조군 — 이게 없으면 분류기를 "blocked" 로 고정해도 전부 통과한다 ───
// 오늘 실제 빌드에서는 절대 나오지 않는 모양이다. 그래서 합성으로라도 잠근다:
// core patch 가 들어간 날 이 단언이 제품을 판정하는 유일한 줄이 된다.
{
  const r = report({
    getUserMedia: { attempted: true, outcome: "granted", trackCount: 1, trackReadyState: "live" },
  });
  assert.equal(r.verdict.input, "allowed", "허용된 관측은 allowed 여야 한다");
  assert.match(summarizeVoiceCapability(r), /마이크 입력: 가능/);
}

// ─── 트랙이 죽어 있으면 허용이 아니다 ──────────────────────────────────────
// 열렸다가 즉시 끝나는 경우를 allowed 로 적으면 그 위 UI 가 "켰는데 안 들어온다"
// 로 나타난다. 사용자에게는 그게 더 나쁜 실패다.
{
  const r = report({
    getUserMedia: { attempted: true, outcome: "granted", trackCount: 1, trackReadyState: "ended" },
  });
  assert.equal(r.verdict.input, "blocked", "죽은 트랙은 허용이 아니다");
}

// ─── 오늘의 실제 모양 — 거부, 그리고 어느 관문인지 기록 ────────────────────
{
  const r = report({
    getUserMedia: { attempted: true, outcome: "rejected", errorName: "NotAllowedError", errorMessage: "Permission denied" },
  });
  assert.equal(r.verdict.input, "blocked");
  assert.ok(r.notes.some((n) => n.includes("gate:")), "어느 관문에서 막혔는지 단서를 남긴다");
  assert.ok(
    r.notes.some((n) => n.includes("NotAllowedError")),
    "오류 이름을 보고서에 남긴다 — boolean 으로 접으면 관문을 가릴 수 없다",
  );
}

// ─── mediaDevices 자체가 없으면 관문 1 ─────────────────────────────────────
{
  const r = report({ mediaDevicesPresent: false });
  assert.equal(r.verdict.input, "blocked");
  assert.ok(r.notes.some((n) => n.includes("관문 1")), "관문 1에서 끝났음을 적는다");
}

// ─── 음성 대조군 ①: 안 쟀으면 unknown — blocked 가 아니다 ──────────────────
// 이 단언이 이 파일의 존재 이유다. 측정하지 않은 것을 막혔다고 적으면, patch 가
// 들어간 뒤에도 보고서가 계속 "막힘" 이라고 말하고 아무도 다시 재지 않는다.
{
  const r = report({});
  assert.equal(r.verdict.input, "unknown", "시도하지 않았으면 unknown");
  assert.notEqual(r.verdict.input, "blocked", "안 잰 것을 막혔다고 적지 않는다");
  assert.equal(r.verdict.output, "unknown", "출력도 같은 규칙");
  assert.match(summarizeVoiceCapability(r), /측정 안 됨/);
}

// ─── 음성 대조군 ②: 거짓말하는 관측은 분류하지 않고 거부한다 ───────────────
// VO-T05 의 "미실행을 PASS 로 기록한 fixture 는 거부한다" 를 내 산출물에 적용.
{
  const malformed = [
    [{ getUserMedia: { attempted: false, outcome: "granted" } }, "시도 안 했는데 결과가 있다"],
    [{ getUserMedia: { attempted: true, outcome: "granted" } }, "granted 인데 트랙 수가 없다"],
    [{ getUserMedia: { attempted: true, outcome: "granted", trackCount: 0 } }, "granted 인데 트랙이 0"],
    [{ getUserMedia: { attempted: true, outcome: "rejected" } }, "rejected 인데 오류 이름이 없다"],
    [{ audioContext: { attempted: false, rendered: true } }, "출력도 같은 규칙"],
  ];
  for (const [obs, why] of malformed) {
    assert.throws(() => report(obs), VoiceProbeMalformedError, `거부해야 한다: ${why}`);
  }
}

// ─── 음성 대조군 ③: 계측기를 먼저 의심한다 (규칙 6) ────────────────────────
{
  const r = report({
    cspObserved: "default-src 'none'; media-src data: blob:",
    htmlAudioDataUri: { attempted: true, loaded: false },
  });
  assert.ok(
    r.notes.some((n) => n.startsWith("instrument_suspect")),
    "CSP 가 허용하는데 실패하면 제품이 아니라 프로브를 의심한다",
  );
}

// ─── 출력 판정 세 갈래 ─────────────────────────────────────────────────────
// Web Audio 만 되면 `media-src` 를 **넣지 않는** 근거가 된다. 그래서 이 구분이
// CSP 를 한 칸 아끼는 판단으로 이어진다.
{
  assert.equal(
    report({ audioContext: { attempted: true, rendered: true }, htmlAudioDataUri: { attempted: true, loaded: false } })
      .verdict.output,
    "web-audio-only",
  );
  assert.equal(
    report({ audioContext: { attempted: true, rendered: true }, htmlAudioDataUri: { attempted: true, loaded: true } })
      .verdict.output,
    "full",
  );
  assert.equal(
    report({ audioContext: { attempted: true, rendered: false }, htmlAudioDataUri: { attempted: true, loaded: false } })
      .verdict.output,
    "blocked",
  );
}

// ─── 보고서가 인수에 쓸 수 있는 모양인가 ───────────────────────────────────
{
  const r = report({ getUserMedia: { attempted: true, outcome: "rejected", errorName: "NotAllowedError" } });
  assert.equal(r.schema, VOICE_CAPABILITY_SCHEMA);
  // 앱과 확장 버전을 **둘 다** 적는다: 설치본은 0.1.51, 소스 확장은 0.1.5 다.
  // 한 칸만 쓰면 어느 쪽을 읽은 보고서인지 알 수 없고 그 모호함이 인수 기록에 박힌다.
  assert.equal(r.app_version, "0.1.51");
  assert.equal(r.extension_version, "0.1.5");
  assert.notEqual(r.app_version, r.extension_version, "두 버전은 실제로 다르다 — 한 칸으로 합치면 안 된다");
  assert.equal(r.surface, "chat-webview");
  assert.equal(r.csp_observed, base.cspObserved, "소스가 말하는 CSP 가 아니라 적용된 CSP 를 싣는다");
  assert.ok(r.probed_at);
}

// ─── 이 슬라이스가 제품을 켜지 않았는가 (범위 락) ──────────────────────────
// 계측기가 슬그머니 기능이 되는 것을 막는다. 학생에게 보이는 것이 없어야 한다.
{
  const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  const csp = readFileSync(join(here, "..", "src", "cspBuilder.ts"), "utf8");

  // 채팅 패널 CSP 를 건드리지 않았다 — 이 슬라이스는 CSP 가 필요한지 **재는** 것이다.
  const chatCsp = csp.slice(csp.indexOf("buildChatPanelCsp"), csp.indexOf("buildChatPanelCsp") + 700);
  assert.doesNotMatch(chatCsp, /media-src/, "채팅 패널 CSP 에 media-src 를 넣지 않았다");
  assert.doesNotMatch(chatCsp, /microphone/, "채팅 패널 CSP 에 마이크 관련 지시문을 넣지 않았다");

  // 명령은 등록하되 학생용 UI 는 없다.
  const cmds = (manifest.contributes?.commands ?? []).map((c) => c.command);
  assert.ok(cmds.includes("hypeproof-chat.diagnoseVoiceCapability"), "진단 명령이 등록돼 있다");
  const menus = JSON.stringify(manifest.contributes?.menus ?? {});
  assert.doesNotMatch(menus, /diagnoseVoiceCapability/, "메뉴·툴바에 노출하지 않는다 — 학생이 누를 자리가 없어야 한다");

  // 업로드 경로에 끼워넣지 않았다: 보고서는 로컬 전용이다.
  const spool = readFileSync(join(here, "..", "src", "spoolUploader.ts"), "utf8");
  assert.doesNotMatch(spool, /voice/i, "보고서를 업로드 경로에 넣지 않았다");
}

console.log("voice-capability smoke OK — 계측기만, 기능 아님");
