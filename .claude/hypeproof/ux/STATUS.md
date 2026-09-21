# STATUS — 2026-09-21

다음 세션이 **제일 먼저** 읽는 문서. 그다음 `MASTER_PROMPT.md` (v4).

---

## 0. 지금 상태 — PR #1218 이 열려 있다

https://github.com/jayleekr/hypeproof-studio/pull/1218 (`feat/sx-observation-capability-split`)

CI 를 통과하면 머지한다. 레이트 리밋은 풀렸다 — 2026-09-21 세션에서 검토 에이전트
26개가 시간당 5000 을 소진해 PR 생성이 약 1시간 막혔었다. **검토 직후에 PR 을 내는
순서는 다시 쓰지 않는다** (MASTER_PROMPT v4 §6).

`hype-pr` 로 다시 작업해야 하면 함정 넷:

1. `GH_TOKEN="$(gh auth token)"` 없이는 `HTTP unknown` 으로 죽는다
2. `fingerprint` 는 inspect 마다 바뀐다 (작업 트리가 깨끗해도) → inspect·채움·prepare 를
   한 명령에 이어 돌린다
3. `evidence` 는 **20자 이상** (`"Clean on ee9a9d7."` 는 17자라 탈락했다)
4. `disposition: unknown` 은 followups 에 **추적 이슈 URL** 필요 (#1217 을 만들어 뒀다),
   `implementation` 링크는 **requirement 노드와 test 노드 둘 다** 필요 (`ST-DES-*` 불가)

평가서에서 직접 손댄 노드 7개 (나머지 45개는 `no-impact`):
`ST-DES-STUDIO-NATIVE-TRIAL-UX` · `ST-TEST-STUDIO-NATIVE-TRIAL-UX` · `ST-IMP-SX-P1` ·
`ST-IMP-SX-P1B` · `ST-REQ-UX` · `ST-TEST-UX` 는 satisfied,
**`ST-VAL-NATIVE` 는 unknown** → followups `…/issues/1217`.

---

## 1. 이 브랜치가 한 일 — 커밋 6개

```
ee9a9d7  fix(sx): 적대적 검토 16건 수리
d9b8599  fix(sx): 사진으로만 찾은 서랍 결함 2건
39e67ab  feat(measurement): 새 평가는 6역량 모델로 (7자산 아님)
bda6774  fix(sx): 작업 화면이 학생에게 자기 평가를 권하지 않는다
2bf9dbe  feat(worker): observation 을 record 와 assess 로 쪼갠다 (ADR 0010 1단계)
9123550  test(worker): 각 반의 좌석이 /v1/profile 에서 무엇을 받는지 고정
```

### Jay 가 이 세션에서 짚은 세 가지와 그 결과

1. **"7에셋이 없어진지가 언젠데"** — 상태바(`assetStatusBar.ts`)는 이미 지워져 있었는데
   **굴러가는 평가와 학생 화면은 아직 7자산**이었다. 이제 새 평가는 6역량으로 나가고
   화면은 `FRAMING` 대신 **문제 구성**을 보인다. 저장된 7자산 기록은 자기 모델로
   검증되어 그대로 읽힌다.
2. **"아이가 자기 점수를 확인하는 게 UX 설계상 맞아?"** — 맞지 않고, **SX-59 가 이미
   금지하고 있었는데 코드만 안 따라갔다.** 관측 결과 패널이 작업 화면에서 사라졌다.
   (주의: 당시 내가 "P0 4개가 금지한다"고 말한 것은 틀렸다. 행을 세어 보니 SX-59 하나다.)
3. **"관측이 백그라운드에서만 일어나는 줄 알았는데"** — 지금은 학생이 `관찰 받기`
   버튼을 눌러 채점을 받는 구조였다. `record`(배경)와 `assess`(버튼)를 쪼갰고
   **기본값은 `record: true, assess: false`** 다.

**중요한 단서**: 지금 아이 코호트는 관측이 **아예 꺼져 있다.** 그래서 이 변경은 새는
것을 막은 게 아니라, **앞으로 켤 때 새지 않도록 미리 막아 둔 것**이다. Jay 가 말한
"모든 반에 관측을 켠다"(= ADR 0010 4단계)에서 이 게이트가 없었으면 **기록을 켜는 순간
모든 아이 화면에 "평가받기" 버튼이 같이 켜졌을 것**이다.

---

## 2. 게이트 상태 (커밋 `ee9a9d7` 기준)

```
worker  npm test      0 fail
worker  tsc           0
ext     npm test      0 fail
ext     tsc           0
webview npm run build  0
프로필 서빙 스냅샷      9 프로필 × 4 축 = 36칸 불변
심은 결함 검사          5종 전부 의도한 테스트만 빨개짐
적대적 검토             22 보고 → 16 확인 → 16 수리 완료
```

---

## 3. **검증하지 않은 것** — 이름으로 적는다

| 안 한 것 | 왜 중요한가 |
|---|---|
| **실기 증거 0** | 앱을 한 번도 안 띄웠다. 전부 정적 렌더 + 라우트 응답 |
| **실제 provider 호출 0** | 새 루브릭(`m2026.09.21-1`)으로 모델이 진짜 6개 키를 내는지 모른다. 테스트는 프롬프트를 되받아치는 **스텁**이라, 모델이 못 따르는 루브릭이어도 초록이다 |
| **Playwright `e2e/trial-ux` 로컬 미실행** | 로컬에 playwright 가 없다. **CI 에서는 돈다** — `start-page-browser` 잡이다. 검토와 내가 "CI 에 없다"고 한 것은 틀렸고, 실제로 그 잡이 TUX-OBS-10 실패를 잡아 줬다 |
| **사진의 테마는 내가 채운 값** | `--vscode-*` 를 VS Code Dark Modern 기본값으로 직접 넣었다. 실제 앱 테마가 아니다 |
| `.hps-access button` | 같은 커밋에서 고쳤지만 **한 번도 렌더해 보지 않았다** |

→ 전부 **이슈 #1217** 에 적어 뒀다. `ST-VAL-NATIVE` 가 `unknown` 인 이유다.

---

## 4. 다음 작업 — 우선순위 순

### 4a. ADR 0010 나머지 단계 (2~5)

`docs/adr/0010-observation-capability-split.md` 참조. 1단계만 끝났다.

아직 **legacy `enabled`** 를 읽는 곳이 정확히 셋 남아 있다:

```
worker/src/lib/chat-gate.ts:189   native grant     → 세션 게이팅으로 (2단계)
worker/src/routes/chat.ts:268     세션 게이트       → 세션 게이팅으로 (2단계)
worker/src/routes/admin.ts:284    체험 좌석 발급    → profile.trial.individual 로 (3단계)
```

- **2단계**: 세션 게이팅과 체험 좌석 발급을 관측에서 떼어낸다.
  스냅샷의 `no-session` 축이 바로 이걸 잰다 — `enabled` 하나 켜면 좌석이 `200 → 403` 이
  되는 것이 음성 대조군으로 이미 기록돼 있다
- **3단계**: assess 라우트가 provider 에 맞는 모델을 고르거나 **이름을 대고 거절**한다
  (지금 `gpt-5.6-luna`·`glm-5.2` 코호트는 assess 가 502 로 죽는다 — ADR 의 "설정은
  맞는데 동작이 없는" 유형)
- **4단계**: `record` 기본 켜기 ← **Jay 가 원한 것**. 3단계까지 끝나야 안전하다
- **5단계**: `enabled` 제거 (독립 커밋)

각 단계마다 `profile-serving-snapshot` 을 다시 돌리고 **diff 를 읽고** 커밋한다.

### 4b. 수업 내용이 하나도 없다 — 그릇만 있다

`session_design` / `lesson` 키가 **`worker/src/profiles/types.ts` 에만** 있다.
9개 프로필 어디에도 수업 내용이 없다. `worker/test/fixtures/session-design/week-*.json`
은 **테스트 픽스처**이고 어떤 실제 반도 그걸 싣지 않는다.

즉 관측 플래그를 다 풀어도 **띄울 수업이 없다.** 이건 Jay 의 결정이 필요하다:
미션 문장(`3주차 · AI가 만든 걸 내가 확인했나?` 같은)을 누가 쓰나.

### 4c. Jay 결정 대기

- 위 4b — 수업 내용 작성 주체
- 학생 화면 문구가 초등학생에게 통하나. 내가 의심한 것들:
  `종류로 추리기` · `기대 조건 남기기` / `들은 말 남기기` · `출처 미기록` ·
  `이건 실제로 있었던 일인가요` 의 선택지 `아직 확인 전` vs `내가 그렇다고 적은 것`
  (이 둘의 차이를 아이가 구분할지가 제일 걱정된다)
- 어느 실제 반에 `hps-observation/2` 를 줄 것인가
- SX-T 행들을 위한 앱 빌드 승인 (1~2시간)

### 4d. 남은 문서 표류

- SX-24 (팀 기여) — `/2` 스키마가 머지됐으니 이제 풀렸다
- P2 (경계 회고)
- 테스팅 문서의 층·명령 index 표류 약 30곳

---

## 5. 이 세션이 배운 것 — MASTER_PROMPT v4 에 반영됨

1. **화면을 건드렸으면 사진을 찍는다** (v4 G7). 결함 2건이 모든 테스트를 통과한 채
   살아 있었다. 글자 계측기는 대비·빈 줄을 못 본다
2. **출하된 빌드를 연다** (v4 G8). `git show <tag>:<파일>` 30초면 `length === 7` 이 보인다
3. **산문 주장은 명령으로 뒷받침한다** (v4 §4). v3 에 이미 규칙이 있었는데 세 번 틀렸다.
   규칙을 적는 것으로는 안 지켜진다 — 검사를 강제해야 지켜진다
4. **건너뛴 테스트는 초록으로 보고된다** (v4 §5a). SX-59 P0 게이트가 CI 에서 100%
   skip 이었다
5. **게이트를 다 통과해도 적대적 검토는 필요하다** (v4 §6). HIGH 4건이 나왔다
6. 검토는 **GitHub 레이트 리밋을 태운다** — PR 계획이 있으면 순서를 잡는다

---

## 6. 만든 산출물 위치

```
docs/adr/0010-observation-capability-split.md          ADR (1단계만 구현됨)
docs/curriculum/studio-trial/native-rubric.json        6역량 루브릭 m2026.09.21-1
docs/curriculum/studio-trial/native-rubric-legacy-seven.json   7자산 루브릭 (옛 앱용, 보존)
worker/test/fixtures/profile-serving-baseline.json     36칸 기준선
.claude/hypeproof/ux/REQUIREMENTS-HARDENING-2026-09-20.md
https://github.com/jayleekr/hypeproof-studio/issues/1217   실기 검증 공백
```
