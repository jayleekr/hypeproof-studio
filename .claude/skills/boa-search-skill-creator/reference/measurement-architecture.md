# 7자산 측정 아키텍처 (v2 — 적대적 검토 반영본)

> 출처: `7assets-measurement-review.html`(2026-05-23 검토 문서) → 구현 플랜 v1 → 5렌즈 적대적
> red-team(30/40 비판 생존) → 이 v2. 확정 범위: **이 스킬(boa-search-skill-creator)에
> forward-compatible로 구현.** 워커 통합은 P4(선택).

## 0. 한 줄 원칙

> **점수를 움직이는 유일한 증거 = 임직원이 실제로 자기 child skill 파일
> (`context.md`/`verification.md`/`SKILL.md`)을 고친 결정론적 행동.**
> 길이·간격·verdict값·책임언어 텍스트 같은 모든 표면특징은 점수 입력에서 빼
> **"진단 메타"로 강등**한다. — 셀 수 있다고 셈한 것을 측정으로 오인하지 않기 위해서다.

## 1. 측정의 3종 분리

```
Layer A  Q&A (Phase 1)            교육·경계선언 전용. 점수에 절대 미반영(데이터상 score 행 미생성).
─────────────────────────────────────────────────────────────────────────
Layer B  과정 신호 (Phase 2)       측정. 단, B1/B2는 "타당도 향상"이 아니라 책임 분리다:
  B1 결정론(scripts/signals.py)   재현 가능한 카운트. LLM 없음. 신뢰도(reliability)만 보장.
  B2 해석(LLM 분류)               부호·의미 판단. 반드시 행동 증거 인용. 타당도(validity)는 B2가 짐.
```

**핵심 교훈(검토에서):** "결정론 우선"은 타당도를 올리지 않는다 — 신뢰도만 올린다.
부호 결정(의도수정 vs 오타, 책임 vs 외재귀인, 요소 유무)은 전부 B2에 남으므로,
**B2 타당도를 검증할 인간 ground-truth가 없으면 측정 전체가 미검증으로 남는다.**

## 2. 분절 경계는 reader 규칙·고정상수로 (LLM 재량 제거)

무상태 스킬에서 LLM이 세션/턴을 사후 분절하면 B1 분모가 거짓이 된다.
(워커는 이걸 `trial_id`/`turn_idx`를 서버 상태·x-hps 헤더로 **외부 주입**해 회피한다 —
`worker/src/routes/chat.ts:258,388`. 즉 LLM 자가태깅은 워커가 *피하는* 경로다.)

- `turn_index` = append 직전 기존 행 수 + 1 (결정론).
- `session_id` = 직전 행 `ts` 갭이 **고정 임계** 이상이면 신규, 미만이면 승계 (SKILL.md에 상수 박기).
- `goal_id` = **B1에서 제외** (결정 사항). 무상태 스킬에서 goal 경계는 결정론 불가.
  → 신호 3(수정횟수)은 **연속 턴 윈도우 + child skill 파일 수정 누적횟수**로 재정의.

## 3. 7신호 처분 (검토 반영)

| 신호 | 처분 | 핵심 |
|---|---|---|
| 1 첫프롬프트 길이·구조 | 고치기 | 길이→진단메타(점수 제외). 3요소는 B2 + 직전 동일문자열 중복검사(복붙 차단) |
| 2 세션간 변화 | 약화 | "추세" 제거, 최소표본 게이트 후 "이번 vs 지난번"만 |
| 3 목적내 수정횟수 | 크게 재정의 | raw 턴수 제외 → Iteration = **child skill 파일 수정 누적횟수**. B2가 결함 인용 강제(분할위조 차단) |
| 4 검증 후속 | 재분류 | B1 결정론 필드서 제외 → **B2 read-time 파생**. 분리 시퀀스 실존 시만, verdict 교차 |
| 5 복귀 간격 | 점수서 버림 | ts델타는 역진적(바쁜 사람이 최저점). 활성/비활성 운영지표로만 |
| 6 원장님 verdict 분포 | 점수서 버림 | verdict는 **ground-truth 검증축**으로만. Ownership은 "RISK 수신→도구 수정"으로만 |
| 7 회고 책임언어 | 고치기 | 단독 1점 cap, **파일변경 결합 시만 가점**. 입력을 결과부정 후속까지 확장 |

순효과: 신호 5·6 정량 기여 사실상 폐기, 3·4는 구성개념 재정의로만 생존.
→ **Iteration/Ownership이 신호 3/7로 좁아짐을 수용**(결정 사항: 과소측정 > 오측정).

## 4. 데이터 모델 (JSONL 보강)

```jsonc
{
  "ts": "2026-06-01T15:30:00Z",
  "skill": "desk-kim-counseling-search",
  "session_id": "s3",        // reader 규칙(ts 갭 임계)으로 결정론 부여
  "turn_index": 4,           // append 직전 행수+1 (결정론)
  "prompt": "...", "prompt_chars": 47,   // 길이는 진단메타로만 (점수 입력 아님)
  "result": "...",
  "owner_feedback": {"verdict": "PASS|MORE_CHECK|RISK", "comment": "..."},  // ground-truth 검증축
  "self_note": "...",
  "skill_files_changed": ["verification.md"],   // 신규: 이 턴에 임직원이 고친 child skill 파일 (점수 핵심 증거)
  "scores": { "<asset>": {"score": 0|1|2|null, "reason": "<행동 증거 인용>"} }  // 첫턴/무증거 null
}
// goal_id 없음 — 의도적 제외. 구판 행은 reader default 보강으로 하위호환.
```

## 5. 단계

- **P0** (지금): `histogram.py` 4종 크래시 None-safe + 분모를 **자산별 non-null 채점 턴**으로
  재정의("점수 매겨진 N턴 중 발현") + 미채점/소표본 안내 + 테스트 가능한 log-path 인자.
  reader 규칙(turn/session 분절) 명문화 + 스키마 + 하위호환.
- **P1** `signals.py`(결정론 집계, 별도 fixture 단위테스트) + negative fixture(길게쓰기·책임언어
  복붙 → 점수 안 오름).
- **P2** B2 해석분류 + **B2 검증용 인간 라벨 N턴**(원장님/Jay) → 일치율(κ) 측정. (결정: 라벨링 가능)
- **P3** judge↔signals.py 제어흐름 명시: `Bash로 signals.py 실행 → stdout JSON을 judge 프롬프트
  주입 → 누적자산만 그 수치로 채점`. 단일턴/누적 채점 시점 분리.
- **P4(선택)** "스코어러 교체 설계": `worker/src/lib/asset-scorer.ts`(호출자 0개·regex
  heuristic-v1)는 **폐기 대상**. forward-compat은 B1 원시신호(prompt_chars/turn_idx/verdict)만
  워커 `turns`/`validations`와 정렬, 0/1/2·self_note·owner_feedback는 신규 테이블 필요.
  verdict enum 비대칭(`PASS|MORE_CHECK|RISK` vs validations `pass|fail|partial|error`)은 표준화
  결정만(RISK→fail 자동매핑 금지).

## 6. 게임화 방어 (점수 비노출 단일기제에서 분리)

코칭을 점수가 아니라 **업무 결과물 품질**로("원장님이 블로그 출처 빼라셨는데 다음엔 어디서
막을까?"). 추세 뷰는 **코치 내부 진단 전용 플래그** 뒤(SKILL.md L99/L112 자동노출 금지 준수).
negative fixture로 "길이만 늘림·책임언어 복붙엔 점수 안 오름"을 회귀 단언.

## 7. 정정 (원안 오류)

- **프라이버시**: `log_user_messages`는 **워커 전용**(이 스킬 트리엔 grep 0). 에뮬레이션은
  prompt/result를 **평문 로컬 저장**(`~/.claude/boa-skills/logs/`, eval2엔 환자정보 포함) →
  파일권한·PII 마스킹·신호만 저장을 **별도 방어**로 정의해야 한다.
- **forward-compat 과장**: 워커가 외부 주입하는 값은 에뮬레이션도 결정론 주입(LLM 자가태깅 X).

## 8. 열린 질문 (구현하며 확정)

- session ts 갭 임계: 6시간 vs 날짜변경 vs 둘 다 (보아치과 근무패턴).
- B2 인간 라벨: 누가(원장님 vs Jay)·몇 턴.
- 운영자 디버그 뷰 분리 비용: 단일 스크립트+`--coach` 플래그 vs 별도 산출물.
