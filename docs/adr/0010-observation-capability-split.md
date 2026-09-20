# ADR 0010 — `observation.enabled` 를 쪼갠다

- 상태: **Accepted** (2026-09-20, Jay 결정)
- 대상: `worker/src/profiles/types.ts`, `routes/chat.ts`, `routes/observations.ts`, `routes/admin.ts`,
  `extensions/hypeproof-chat/src/chatPanelProvider.ts`
- 관련: SX-44~48, MC-10·15·18·21·22, `docs/requirements/studio-native-trial.md:113-114`,
  `.claude/hypeproof/ux/judge-P1-2026-09-20.md` F-1

---

## 결정

`Profile.observation` 을 **하나의 불리언에서 세 칸으로** 쪼갠다.

```ts
observation?: {
  /** 학생 기기에 학습 이벤트를 기록한다. 서랍·완료 게이트가 이것으로 켜진다. */
  record: boolean;
  /** POST /v1/observations/assess 를 쓸 수 있다 — 배치 전체가 Anthropic 으로 나간다. */
  assess: boolean;
  format?: "hps-observation/1" | "hps-observation/2";
};
```

그리고 **오늘 이 플래그에 얹혀 있던 두 가지를 떼어낸다**:

| 지금 `observation.enabled` 가 겸하는 것 | 어디로 가나 |
|---|---|
| `/v1/profile` 이 세션 게이트(활성 세션·로스터·일시정지)를 타는가 | **별도 조건으로 뗀다.** 관측과 무관하다 |
| `native_trial` 좌석을 발급할 수 있는가 | **`profile.trial.individual`(신설)** 로 뗀다. 관측과 무관하다 |

기본값은 **`record: true`, `assess: false`** 다. 관측 기록은 Studio 안에서 기본으로 켜지고,
기기 밖으로 나가는 것만 명시적 opt-in 이다.

---

## 왜 — 이 플래그는 이름보다 많은 일을 하고 있었다

2026-09-20 조사에서 실측한 것. **어느 문서에도 적혀 있지 않았다.**

| 딸려 움직이던 것 | 실측 |
|---|---|
| `/v1/profile` 세션 게이트 | `routes/chat.ts:266` — **9개 프로필 중 7개가 200 → 403.** 학생이 수업 시작 전에 토큰을 넣고 자기 반·안내문·모델 목록을 볼 수 없게 된다 |
| 채팅 기록 저장 키 | `nativeHistoryScope` 가 null → `native-<scope>` 로 뒤집히고 `historyKey()` 가 그것을 우선한다. **기존 학생의 지난 대화가 사라지고**, 토큰 재발급마다 또 리셋된다 |
| 개인 체험 좌석 발급 | `routes/admin.ts:284` 가 `!selected?.observation?.enabled` 로 막고 있다. 관측을 켜면 **아이 코호트에도 체험 토큰이 발급 가능**해진다 — 관리 권한 변경이 관측 변경에 올라탄다 |
| 평가 모델 라우팅 | `routes/observations.ts:109,117` 이 `modelIdFor(profile.model.default, 'anthropic')` 을 부른다. `gpt-5.6-luna`·`glm-5.2` 는 **throw → 502 `assessment_failed`.** 관측 화면은 보이는데 버튼이 항상 실패한다 |

마지막 줄은 `.claude/rules/verification.md` 가 "설정은 맞는데 동작이 없는" 으로 부르는 유형이고,
P1 평가가 F-1 로 잡은 것과 **같은 유형**이다.

한 낱말이 네 가지를 뜻하면, 그중 하나를 바꾸려는 사람이 나머지 셋을 모르고 바꾼다.

---

## 아이 코호트 — `assess: false`

기록 자체는 **기기 밖으로 나가지 않는다.** `NativeObservationRecorder` 는 VS Code
`workspaceState` 에만 쓴다. 설계가 그렇게 적혀 있었고 코드로 확인했다.

나가는 구멍은 **하나**다. `POST /v1/observations/assess` 가 배치 전체 — **학생이 쓴 원문과
코치가 만든 워크스페이스 파일 본문** — 를 워커로, 다시 `hypeproof-sediment.fly.dev` 를 거쳐
Anthropic 으로 보낸다. 자동이 아니고 학생이 동의 체크박스를 누를 때만 발사된다.

그래서 아이 코호트(`sk-biopharm-kids-*`)는 **`record: true, assess: false`** 다.

사람이 결정할 것이 두 개 **남아 있고, 이 ADR 은 그것을 결정하지 않는다**:

1. 보호자 동의 `child_upload_consent` 는 **"아이 문답 원문 업로드"** 문구다. 평가 전송을
   덮는지 확인되지 않았다
2. 체크박스 문구 *"서버에 원문을 저장하지 않습니다"* 는 **워커에 대해서는 참**이지만
   Anthropic 으로 전송된다는 말이 없다. 보호자가 읽을 문장은 이쪽이다

둘 다 해결되기 전에는 아이 코호트에서 `assess` 를 켜지 않는다.

---

## `studio-gpt-practice` 는 계속 `record: false`

이 프로필의 `enabled: false` 는 **의도된 것**이었다. 같은 커밋이 요구를 같이 적었다:

> `docs/requirements/studio-native-trial.md:113` —
> "Claude SDK의 파일·셸·검색·브라우저 도구와 **관찰 평가가 제공된다고 표시하지 않는다.**"

OpenAI 프록시 런타임이라 평가가 **구조적으로** 안 돈다(`native-assessment.ts` 는 Anthropic 전용).
그 요구를 고치지 않고 플래그만 뒤집으면 요구가 금지한 바로 그 행동이 된다.

`studio-model-practice` 는 `structuredClone(gpt)` 로 **상속**한다. 하나를 바꾸면 둘이 바뀐다 —
이것도 어디에도 적혀 있지 않았다.

---

## 오늘 켜도 필드에서는 아무 일도 없다

출시된 Studio 빌드 중 `hps-observation/2` 를 받을 수 있는 것이 **하나도 없다.**
v0.1.52~v0.1.56 이 전부 `x-hps-observation-format: hps-observation/1` 을 하드코딩한다.
`/2` 는 커밋 `ba8ff6c` 이 들어간 빌드가 나간 뒤에야 필드에 존재한다.

반대로 **켜지는 것은 있다**: v0.1.51 이하 좌석은 포맷 헤더를 보내지 않으므로 인사말 뒤에
*"이 앱 버전은 작업 관찰 화면을 지원하지 않습니다… Studio를 업데이트해 주세요"* 를 받는다.

→ 그래서 **배너 조건을 먼저 좁힌다.** 관측을 켜는 것과 업데이트를 조르는 것은 다른 일이다.

---

## 마이그레이션 — 기존 동작을 한 바이트도 바꾸지 않는다

`enabled` 를 읽는 코드가 8곳이다. 한 번에 뒤집지 않는다.

1. `record`·`assess` 를 **더하고**, `enabled` 는 당분간 남긴다.
   해석: `record = enabled ?? 기본값`, `assess = enabled ?? false`
2. 세션 게이트와 체험 좌석 발급을 **각자의 조건으로** 뗀다. 이때 기존 프로필의 동작이
   그대로인지 **프로필마다 200/403 을 재서** 확인한다(9개 전부)
3. 평가 라우트가 프로필 공급자에 맞는 모델을 고르거나, 못 고르면 **이름 있는 거절**을 한다.
   502 `assessment_failed` 로 뭉개지 않는다
4. 그 다음에 `record` 기본값을 켠다
5. `enabled` 제거는 별도 커밋

각 단계마다 **9개 프로필 전부에 대해 `/v1/profile` 응답을 찍어 비교한다.** 라우트 응답이
계약이다 — 헬퍼 단위 테스트는 이것을 못 잡는다(F-1 이 그렇게 지나갔다).

---

## 되돌리기

프로필 한 줄씩이다. `record: false` 로 돌리면 서랍·게이트가 사라지고,
`assess: false` 로 돌리면 전송 버튼이 사라진다. 세션 게이트와 좌석 발급은 이미
자기 조건을 갖고 있으므로 관측을 껐다고 같이 움직이지 않는다 — **그것이 이 ADR 의 요점이다.**
