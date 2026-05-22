# 보아치과 v4 슈퍼서치엔진 — 챗 패널 스냅샷 (2026-05-26 워크숍)

HypeProof Studio 안에서 보아치과 cohort 토큰으로 들어갔을 때 실제로 보이는
챗 패널 화면 10장. **hypeprooflab 커리큘럼 페이지에 임베드용**으로 캡처됨.

- 캡처 도구: Playwright (`e2e/tests/99-dental-demo.spec.ts`) — 재생성 가능
- 대상: `boah-dental-teaser-2026-s1` profile + v4 system prompt
- 빌드: HypeProof Studio v0.1.3 (자동 업데이트 #73 으로 사용자 도달)

## 5블록 흐름 + 핵심 UX

| # | 파일 | 무엇을 보여주나 | 본질 (Essence) |
|---|---|---|---|
| 01 | `01-greeting.png` | **블록 1 도입**: "치과 지식 슈퍼서치엔진을 함께 만들어요 🔍 마지막엔 원장님을 이겨봅니다" greeting + 직군별 4 good 칩 (위생사·코디·사모님) + 1 weak 칩 ("치과 관련 질문 답해줘"). 좋은 입력 모양 vs 막연한 입력의 대비. | E7 Intent Clarity (weak 칩의 교육적 대비) |
| 02 | `02-chip-pick.png` | **블록 2 탐색**: 위생사 칩 클릭 → 임플란트 후 운동 시점 시나리오가 textarea에 들어감. 미션카드 제시 금지 — 참가자가 자기 문제로 진입하는 입구. | E7 Intent Clarity |
| 03 | `03-intent-clarity.png` | **블록 3 V1 제작**: 막연한 "환자 안내 도와줘"에 대해 코치가 "어떤 결정/상황?"으로 reframe. 검색 목적이 *결정 모양*으로 잡히기 전엔 V1 안 만듦. | E7 Intent Clarity |
| 04 | `04-v1-axes.png` | **블록 3 V1 제작**: V1 초안에 채울 4축 입력 — ① 알고 싶은 것 ② 이 검색이 도와야 하는 결정 ③ 피해야 할 것 ④ 원장님께 확인할 것. Context Design 행동의 가시화. | E2 Context Design |
| 05 | `05-followup-chips.png` | **7 AI Native Assets 캡션 링**: 첫 응답 후 follow-up 칩 7개가 등장. 각 캡션에 Essence 번호 (E2/E7/E9/E11/E12/E13/E14) — 참가자가 다음 한 수가 어떤 Asset 행동인지 *눈에 보이게*. | E2·E7·E9·E11·E12·E13·E14 (전부) |
| 06 | `06-clinical-guard.png` | **Delegation 가드 (E12)**: 임상 결론 미끼 ("환자한테 운동해도 된다고 말해도 돼?")에 코치가 직접 답하지 않고 원장님 질문으로 변환. 핵심 안전 장치. | E12 Delegation Judgment |
| 07 | `07-verdict.png` | **블록 4 원장님을 이겨라**: V1 한 개를 코치가 *모의 원장님* 입장으로 PASS / 더 확인 / 위험 중 하나로 판정. 깨지는 게 학습의 클라이맥스. | E11 Verification Reflex |
| 08 | `08-save-packet.png` | **블록 5 저장**: 판정에서 나온 한 줄 ("광고 출처는 보류한다")를 다음 검색에 자동 적용되는 *우리 병원 검색 규칙*으로 저장. 일회성 답이 아니라 자산. | E14 Ownership |
| 09 | `09-short-input-hint.png` | **UX 디테일**: 너무 짧은 입력 시 hint — "조금 더 구체적으로 — *환자가 묻는 것·내가 헷갈리는 것·확인 필요한 결정* 중 하나라도요". 게임용 어휘(캐릭터·점수) 제거됨. | E7 Intent Clarity |
| 10 | `10-roll-input.png` | **UX 디테일**: roll-input 버튼 ("✨ 한 번 더 다듬어보기")을 누르면 확장 배너가 뜨고 "이 검색이 도와야 하는 *결정*은 뭔가요?" 프로브. 막연한 입력 → 구체화 유도. | E7 Intent Clarity / E2 Context Design |

## 재생성 방법

LLM 응답이 매번 달라서 03·04·06·07·08 패널은 결정적이지 않음 — 다시 깔끔한 응답이 필요하면 spec을 다시 돌리면 됨.

```bash
# 1. dental dev-stack 부팅
HPS_COHORT=boah-dental-2026-a HPS_PROFILE=boah-dental-teaser-2026-s1 \
  HPS_USER=smoke-dental bash scripts/dev-stack.sh

# 2. 캡처 spec 실행 (~1.2분, 모든 PNG 덮어씀)
cd e2e && npx playwright test tests/99-dental-demo.spec.ts

# 3. 결과 위치
ls docs/curriculum-snapshots/boah-dental-v4/*.png
```

## 파일 사이즈

총 ~1.1 MB. 각 파일 598×1616 (사이드바 전체 높이). hypeprooflab 커리큘럼 페이지에 임베드 시
필요에 따라 thumbnail로 추가 리사이즈 가능.

## 다른 cohort 만들고 싶다면

같은 스펙 구조로 sk-biopharm 1회차용 캡처 시리즈도 가능. dental과 다른 점:
- `naming_mode = user_names_it` → naming 카드 패널이 시작 화면
- 게임 빌드 흐름 + 미리보기 (live_server) 시연 추가
- 4원칙 (전심전력·만족유예·잇기·역목표) 캡션 칩

작업하려면 `tests/99-sk-biopharm-demo.spec.ts` 추가 + dev-stack를 sk profile로 재기동.
