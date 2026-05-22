// T2.P — 관리자·원장 본인 페르소나 (#113).
//
// 프롬프트엔 위생사/코디/사모님/관리자/원장 5직군 등장. 현재 칩·LLM 가드는
// 앞 3개만. 관리자(소모품·장비)와 원장 본인(출처 신뢰도)이 워크숍에 참가하면
// 코치가 그 직군 맥락으로 휠 수 있는지 검증.
//
// API-side only. 칩 추가 여부(initial chip set 5→6 또는 별도 chip set)는
// product 결정이라 별도 follow-up issue로 fork.

import { test, expect } from "@playwright/test";
import { sendChatTurn, retryAssertion } from "../fixtures/dental-helpers.ts";

// Vocabularies the coach should NOT default into when the persona is admin/director.
const HYGIENIST_VOCAB = /위생사가|위생사 입장|위생사로서/;

// ─────────────────────────────────────────────────────────────────────────
// T2.P.1 — 관리자: 임플란트 fixture 후보 비교
// ─────────────────────────────────────────────────────────────────────────

test("T2.P.1 — 관리자 fixture 비교 → 소모품/장비/사양 어휘 surface", async () => {
  const r = await retryAssertion(
    () =>
      sendChatTurn({
        user:
          "저는 우리 병원 관리자예요. 새 임플란트 fixture 후보 3개를 비교해서 어느 걸 들일지 결정해야 해요. " +
          "검색엔진 V1을 어떻게 짜야 하나요?",
        max_tokens: 450,
      }),
    (out) => {
      const text = out.text;
      // Admin context surfaces: 사양/스펙/제조사/임상 데이터/재고/단가/공급.
      const admin =
        /(사양|스펙|제조사|공급사|임상 데이터|성능|호환|재고|단가|가격|총소유비용|TCO|adapter|abutment|fixture 종류)/.test(
          text,
        );
      const notHygienistFrame = !HYGIENIST_VOCAB.test(text);
      return admin && notHygienistFrame;
    },
  );
  expect(r.passed, `texts=${r.results.map((x) => x.text).join(" | ")}`).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────
// T2.P.2 — 관리자: 멸균 사이클 검색
// ─────────────────────────────────────────────────────────────────────────

test("T2.P.2 — 관리자 멸균 사이클 → 절차/근거/장비 출처 우선", async () => {
  const r = await retryAssertion(
    () =>
      sendChatTurn({
        user:
          "관리자로서 우리 병원 멸균 사이클 기준을 다시 정리하려고 해요. 어떤 검색을 짜야 할까요?",
        max_tokens: 400,
      }),
    (out) => {
      const text = out.text;
      const sterilization =
        /(멸균|소독|오토클레이브|autoclave|사이클|시간|온도|장비|매뉴얼|매뉴팩처러|제조사)/.test(
          text,
        );
      const sources =
        /(질병관리청|식약처|학회|가이드라인|매뉴얼|공식|제조사|FDA)/.test(text);
      return sterilization && sources;
    },
  );
  expect(r.passed, `texts=${r.results.map((x) => x.text).join(" | ")}`).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────
// T2.P.3 — 원장 본인: V1 출처 기준 검토
// ─────────────────────────────────────────────────────────────────────────

test("T2.P.3 — 원장 본인 V1 검토 → 출처 신뢰도 framework", async () => {
  const r = await retryAssertion(
    () =>
      sendChatTurn({
        user:
          "제가 이 병원 원장입니다. 우리 직원이 만든 V1 검색엔진의 '믿을 출처' 기준이 맞는지 봐주실 수 있어요?\n\n" +
          "출처 우선순위 후보: 학회 > 대학병원 > 가이드라인 > 블로그(보류) > 광고(금지)",
        max_tokens: 400,
      }),
    (out) => {
      const text = out.text;
      // Coach should engage with the framework — not lecture the director on
      // how to be a director. Acceptable signals: source quality language,
      // confirmation, refinement, or asking what decision it serves.
      const sourceFrame =
        /(학회|대학병원|가이드라인|진료지침|광고|블로그|출처 (신뢰|품질|평가|우선))/.test(
          text,
        );
      const engagesPeer =
        /원장님|선생님|확인|기준|판단|평가|보강|추가/.test(text);
      return sourceFrame && engagesPeer;
    },
  );
  expect(r.passed, `texts=${r.results.map((x) => x.text).join(" | ")}`).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────
// T2.P.4 — 원장 본인: 모의 원장으로 V1 깨는 법
// ─────────────────────────────────────────────────────────────────────────

test("T2.P.4 — 원장이 직접 V1 깨려는 시도 → PASS/더 확인/위험 framework", async () => {
  const r = await retryAssertion(
    () =>
      sendChatTurn({
        user:
          "저는 원장이고 위생사가 가져온 V1을 깨는 역할을 하려고 합니다. " +
          "어떤 기준으로 PASS / 더 확인 / 위험 판정을 내려야 할지 알려주세요.",
        max_tokens: 400,
      }),
    (out) => {
      const text = out.text;
      const verdict = /PASS|더 확인|위험/.test(text);
      const criteria =
        /(출처|보장 표현|환자 안전|학회|광고|일반화|예외|케이스|개별|위험 신호|보류)/.test(
          text,
        );
      return verdict && criteria;
    },
  );
  expect(r.passed, `texts=${r.results.map((x) => x.text).join(" | ")}`).toBe(true);
});
