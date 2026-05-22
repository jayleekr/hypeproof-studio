// T2.V — 입력 변종 robustness for boah-dental-teaser-2026-s1 (#112).
//
// T2.E.1만 사투리/반말 1건 검증. 워크숍 청중은 30~60대 전문직 + IT 친숙도
// 편차 큼. 오타·자모·이모지·장문·code-mix·공백 케이스 회귀로 박는다.
//
// API-side (sendChatTurn) only — UI 결정론 케이스(빈 입력 송신 차단, hint
// 표시 타이밍)는 .app 필요해서 별도 follow-up issue로 fork.

import { test, expect } from "@playwright/test";
import { sendChatTurn, hangulRatio, retryAssertion } from "../fixtures/dental-helpers.ts";

// ─────────────────────────────────────────────────────────────────────────
// T2.V.1 — 공백만 입력 → worker가 거부 OR 코치가 무엇이 필요한지 안내
// ─────────────────────────────────────────────────────────────────────────

test("T2.V.1 — 공백만 입력 → 400 또는 무엇이 필요한지 안내", async () => {
  const out = await sendChatTurn({ user: "   \n  \t  ", max_tokens: 200 });
  // Either worker rejects (400-ish) OR coach asks for clarification.
  if (out.status >= 400) {
    expect(out.status).toBeGreaterThanOrEqual(400);
    return;
  }
  // If it got through, the coach should ask what they want — not start coaching.
  expect(out.text).toMatch(/무엇|뭐|어떤|적어|입력|쓰|말씀|질문/);
});

// ─────────────────────────────────────────────────────────────────────────
// T2.V.2 — 이모지만 입력 → 의미 파악 거부 또는 정중한 reframe
// ─────────────────────────────────────────────────────────────────────────

test("T2.V.2 — 이모지만 입력 → 정중한 reframe", async () => {
  const r = await retryAssertion(
    () => sendChatTurn({ user: "🦷🤔😅", max_tokens: 250 }),
    (out) => {
      const text = out.text;
      const asksClarify = /무엇|뭐|어떤|어떻게|적어|질문|치과|환자|상황/.test(text);
      const isKorean = hangulRatio(text) >= 0.4;
      return asksClarify && isKorean;
    },
  );
  expect(r.passed, `texts=${r.results.map((x) => x.text).join(" | ")}`).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────
// T2.V.3 — 자모 분리 ("ㅇㅎ") → 짧은 입력 안내
// ─────────────────────────────────────────────────────────────────────────

test("T2.V.3 — 자모 분리 입력 → 다시 적어달라 요청", async () => {
  const r = await retryAssertion(
    () => sendChatTurn({ user: "ㅇㅎ ㅋㅋ", max_tokens: 250 }),
    (out) => {
      const text = out.text;
      const asks = /다시|적어|쓰|입력|어떤|뭐|무엇|구체|자세히/.test(text);
      return asks;
    },
  );
  expect(r.passed, `texts=${r.results.map((x) => x.text).join(" | ")}`).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────
// T2.V.4 — 사투리·구어 → 존댓말 유지 + 의미 파악
// ─────────────────────────────────────────────────────────────────────────

test("T2.V.4 — 사투리 입력 → 존댓말 유지 + 의미 파악", async () => {
  const r = await retryAssertion(
    () =>
      sendChatTurn({
        user: "환자한테 어케 마 해줄까예. 임플란트 운동 관련해서예.",
        max_tokens: 350,
      }),
    (out) => {
      const text = out.text;
      const polite = /요\.|요\?|니다\.|니다\?|세요/.test(text);
      const understands = /임플란트|운동|환자/.test(text);
      return polite && understands;
    },
  );
  expect(r.passed, `texts=${r.results.map((x) => x.text).join(" | ")}`).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────
// T2.V.5 — 오타·치환 → 의미 파악
// ─────────────────────────────────────────────────────────────────────────

test("T2.V.5 — 오타 입력 → 의미 파악 후 정상 진행", async () => {
  const r = await retryAssertion(
    () =>
      sendChatTurn({
        user: "치꽈에서 임플란뜨 환자가 운동 언제부터 되는지 검색하고 싶어요",
        max_tokens: 350,
      }),
    (out) => {
      const text = out.text;
      const understandsKeywords = /임플란트|운동|환자|검색|치과/.test(text);
      const askingAboutTypos = /(오타|잘못|다시 적|뜻이|뭔지 모르)/.test(text);
      // We want comprehension, NOT a typo-correction loop.
      return understandsKeywords && !askingAboutTypos;
    },
  );
  expect(r.passed, `texts=${r.results.map((x) => x.text).join(" | ")}`).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────
// T2.V.6 — Code-mix (영어 섞임) → 자연 처리
// ─────────────────────────────────────────────────────────────────────────

test("T2.V.6 — code-mix 입력 → 영어 섞임 자연 처리", async () => {
  const r = await retryAssertion(
    () =>
      sendChatTurn({
        user: "임플란트 후 follow-up 검색 도와줘요. patient에게 안내할 timing 관련.",
        max_tokens: 350,
      }),
    (out) => {
      const text = out.text;
      // Response should still be Korean dominant but engage with the topic.
      const koreanDominant = hangulRatio(text) >= 0.5;
      const onTopic = /임플란트|운동|환자|안내|follow|시점|시기|타이밍/.test(text);
      return koreanDominant && onTopic;
    },
  );
  expect(r.passed, `texts=${r.results.map((x) => x.text).join(" | ")}`).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────
// T2.V.7 — 매우 긴 입력 (2000+ chars) → 응답 latency ≤ 60s + 정상 응답
// ─────────────────────────────────────────────────────────────────────────

test("T2.V.7 — 매우 긴 입력 (V1 4축 paste 시뮬) → 60s 내 정상 응답", async () => {
  // Construct a long realistic V1 + bloat. Length target is "well over a
  // typical message" — 1.2K chars in Hangul ≈ ~2K equivalents in English
  // for the model's tokenizer view.
  const filler = "환자 안내문에 들어갈 내용으로 충분히 길게 풀어 적습니다. ".repeat(80);
  const longInput =
    "지금 만든 V1입니다. 판정 부탁드립니다.\n\n" +
    "① 알고 싶은 것: 임플란트 후 운동 시작 시점\n" +
    `② 결정: 환자에게 안내문을 보낼지 — ${filler}\n` +
    "③ 피해야 할 것: 보장 표현, 무조건/완전 같은 단어\n" +
    "④ 원장님께 확인할 것: 우리 병원 케이스별 기준 + 학회 자료";
  expect(longInput.length).toBeGreaterThan(1500);

  const t0 = Date.now();
  const out = await sendChatTurn({ user: longInput, max_tokens: 500 });
  const elapsed = Date.now() - t0;

  expect(out.status, `non-2xx: ${out.status}`).toBeLessThan(400);
  expect(out.text.length, "empty response").toBeGreaterThan(20);
  expect(elapsed, `too slow: ${elapsed}ms`).toBeLessThan(60_000);
});
