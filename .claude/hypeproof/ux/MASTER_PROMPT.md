# 학습 경험 우선 Studio: 자율 개발 마스터 프롬프트 (v4)

> v1 2026-09-18 · v2 2026-09-20 (자기모순으로 폐기) · v3 2026-09-20 · **v4 2026-09-21**
> v4 의 개정 근거는 **v3 의 여섯 게이트를 전부 통과한 작업이 적대적 검토에서 16건을
> 맞은 일**이다. 게이트를 늘린 게 아니라 **v3 이 못 보던 자리**를 채웠다.
> 재개할 때는 **`STATUS.md` → 이 문서 → `.claude/rules/verification.md`** 순으로 읽는다.

---

## 0. v3 이 통과시킨 결함 — v4 가 존재하는 이유

2026-09-21 세션은 커밋 5개를 v3 의 여섯 게이트로 **전부 초록**으로 만들고 PR 직전까지
갔다. 그 상태에서 네 렌즈 적대적 검토가 22건을 보고했고 **16건이 반증을 견뎠다.**

HIGH 4건과, v3 의 어느 게이트도 그것을 볼 수 없었던 이유:

| 결함 | v3 이 못 본 이유 |
|---|---|
| **이미 설치된 앱이 새 응답을 거부.** 워커가 6개 키를 보내는데 출하된 `v0.1.56` 은 `length === 7` 을 검사한다. 토큰은 쓰고, 앱은 터지고, 저장이 안 돼 **영구 복구 불가** | 게이트가 전부 **현재 소스 안**에서 돈다. 출하된 바이너리를 아무도 안 열었다 |
| **e2e 스위트(TUX-OBS-01~10)를 깨고 안 돌림** | 그 스위트는 CI 에 없다(GUI 정책). `ext test 0 fail` 이 **돌지도 않은 것**을 초록으로 보고했다 |
| **`/v1/profile` 이 새 필드를 프로필에서 유도하는지 아무도 안 봄** — 상수를 박아도 전 테스트 통과 | G4(도달성)를 라우트 3개에만 걸고, **클라이언트가 그 값을 배우는 단 한 곳**을 빠뜨렸다 |
| **워커가 무엇을 *보내는지* 아무 테스트도 안 봄** (프롬프트·스키마 enum) | G2·G3 을 전부 "받은 것" 방향으로만 세웠다 |

그리고 **산문이 세 번 틀렸다.** v3 §4 가 이미 "주장하기 전에 센다"고 적어 둔 그 실수를,
v3 을 읽고 일한 세션이 세 번 반복했다.

**그래서 v4 의 결론은 하나다: 규칙을 적어 두는 것으로는 안 지켜진다.**
v4 가 새로 넣은 것은 전부 **"명령을 돌리고 출력을 붙여라"** 형태다. 성실함에 기대는
문장은 규칙이 아니라 소망이다 — v3 §0 이 이미 그렇게 말했고, 그래서 §4 가 실패했다.

---

## 1. 임무와 정본

`jayleekr/hypeproof-studio` 안에서 실행되는 자율 개발 세션이다. 요구사항화된 문서를
**구현·검증·PR** 까지 올린다. 문서를 다시 쓰는 게 아니라 문서대로 만든다.

정본 사슬: philosophy(Lab) → mission(Lab) → intent → requirement → design →
implementation → test → validation. 이 세션은 **intent 이하만** 건드린다.

**성과는 만든 개수가 아니다.** *학생이 실제로 쓸 수 있는 것이 늘었는가* 하나다.
2026-09-20 은 P1 을 통째로 만들고 모든 게이트를 통과하고도 그 수치가 **0** 이었다.

**역량 모델은 6개다** — `candidate-capability-v1`
(FRAMING·JUDGMENT·ORCHESTRATE·VERIFY·ADAPT·OWNERSHIP, 2026-09-13 Jay 결정 #1020).
7자산은 `legacy-seven-assets`, **읽기 전용 과거**다. 둘 사이 변환표는 **의도적으로 없다**
(`worker/src/lib/measurement-core/capability-models.ts` 머리말). 아직 "7자산"을 현재형으로
말하는 문서를 보면 그게 버그다.

---

## 2. 완료의 정의 — 게이트 여덟

G1~G6 은 v3 과 같다. 바뀐 부분만 쓰고, 신규 G7·G8 은 자세히 쓴다.

### G1. machine_gate — 번들러 둘 + CI

```
worker : npm test && npx tsc --noEmit
ext    : npm test && npx tsc --noEmit
webview: npm run build
```

`npm run build` 를 빼지 마라. 2026-09-21 에 CSS 주석 이중 닫힘을 **오직 이것만** 잡았다.

### G2. control 이 실제 경로를 지나고, 빨강의 사유가 정보를 갖는다

양성 대조군(확실히 좋은 시료가 **통과**) + 음성 대조군(확실히 나쁜 시료가 **실패**).
둘 다 없는 채점기는 믿지 않는다.

**v4 추가 — 양방향으로 세운다.** 받은 것만 검사하면 **보낸 것**이 틀려도 초록이다.
워커가 프롬프트·스키마·enum 을 만들어 보내면 거기에도 단언을 건다.

### G3. 심은 결함 — 목록은 요구의 부정문에서 뽑는다

N개 심고 N개 잡히는지 센다. **어느 테스트가 잡았는지까지** 본다 — 전부 빨개지면
테스트가 구분을 못 하는 것이고, 하나도 안 빨개지면 계측기가 죽은 것이다.

### G4. 도달 가능성 — 이 기능이 실제로 켜지는가

**v4 확장 — "클라이언트는 이 값을 어디서 배우는가"를 반드시 센다.**

새 필드를 응답에 넣었으면 **그 응답을 읽는 테스트**가 있어야 한다. 라우트 분기만
테스트한 것은 도달성이 아니다. 그 한 곳에 상수를 박아도 전부 통과하는지 스스로 해 본다.

### G5. 실기 증거 — 있는 스크립트로, 조용히, 라벨을 달아서

화면이 잠겨 있지 않으면 Electron 을 띄우지 않는다. 실기를 못 했으면 **"실기 증거 0"** 이라고
쓴다. "충분히 검증했다"로 바꿔 쓰지 않는다.

### G6. CI 가 끝날 때까지 본다

---

### G7. **화면을 건드렸으면 사진을 찍는다** (신규)

글자만 뽑는 계측기는 **대비·간격·넘침을 못 본다.** 2026-09-21 에 두 결함이 모든
테스트를 통과한 채 살아 있었다:

- `.hp-evidence-form button` 에 **색 규칙이 아예 없었다** — 브라우저 기본 회색 위 회색 글자
- 말 없는 근거 행이 `1.` 만 찍고 본문이 **빈 줄**이었다

둘 다 렌더 **텍스트**로는 정상으로 보인다. 사진으로만 보인다.

```bash
# 실제 CSS 를 입혀 헤드리스로. Electron 아님 — 창이 안 뜬다.
# 1) test/sx-render.mjs 로 컴포넌트를 렌더해 html 로 쓴다.
#    CSS 는 main.tsx 순서 그대로 인라인: tokens → localReview → start → styles
# 2) Chrome 헤드리스로 찍는다 (백그라운드로!)
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --headless=new --disable-gpu --hide-scrollbars --no-sandbox \
  --user-data-dir=<scratch>/cp --force-device-scale-factor=2 \
  --window-size=440,2600 --virtual-time-budget=3000 \
  --screenshot=<scratch>/raw.png "file://<scratch>/page.html" &
# 3) magick raw.png -bordercolor '#151D19' -border 4 -trim +repage cut.png
# 4) 그 png 를 **읽어서 눈으로 본다**. 필요하면 Jay 에게 보낸다
```

함정 셋:

- **Chrome 이 `--screenshot` 뒤에도 안 죽는다.** 백그라운드로 띄우고 png 크기가
  안정되면 `kill -9` 한다. 앞단에서 기다리면 세션이 멈춘다
- **`--vscode-*` 테마 변수는 직접 채워 넣는 값**이다. 실제 앱 테마가 아니다 —
  사진을 보고할 때 그 사실을 같이 쓴다
- `<details>` 는 닫힌 채 렌더된다. 페이지에 한 줄 넣어 편다:
  `for (const d of document.querySelectorAll("details")) d.open = true;`

### G8. **출하된 것이 이걸 읽을 수 있나** (신규)

워커와 앱은 **따로 배포된다.** 스큐가 예외가 아니라 정상 상태다.
앱이 파싱하는 것을 바꾸려면 **출하된 빌드를 직접 연다.**

```bash
gh release list --limit 3
git show <최신태그>:extensions/hypeproof-chat/src/<그 파일>.ts | sed -n '<해당부>p'
```

이 저장소는 배치 포맷에 대해 **이미 협상을 갖고 있다** — `servedObservationFormat` 이
옛 앱에 `/2` 대신 `/1` 을 내려준다. 새로 무언가를 바꾸면서 같은 협상을 안 붙이면
그게 버그다. 규칙 셋:

- **기본값은 옛 쪽이다.** 선언이 없으면 허가가 아니다
- 선언은 **천장이지 명령이 아니다**
- 인식 못 하는 값(오타·미래 버전)도 옛 쪽으로 떨어진다

**적용 대상**: 응답 스키마, enum, 필드 이름, 저장된 레코드 형식, 프롬프트가 지시하는 키.

---

## 3. 요구가 틀렸을 때 — 발명하되 세고, 갚는다

v3 과 같다. **모호 / 반대 / 불가능**으로 나눈다. 멈추지 않는다. 좁은 예외 +
`spec-debt` 표시로 가고, **한 단계에 2건을 넘기면** 그 단계의 새 task 를 받지 않는다.
요구 문장을 고쳤으면 **원문을 인용해** 커밋에 적는다.

---

## 4. 주장하기 전에 센다 — **기계적으로**

v3 §4 는 "세라"라고 적었고 지켜지지 않았다. v4 는 **검사 명령을 강제한다.**

커밋 본문·PR 본문·코드 주석에 아래 낱말이 들어가면 **그 문장 옆에 명령과 출력을
붙인다.** 못 붙이면 그 문장을 지운다.

| 낱말 | 반드시 붙일 것 |
|---|---|
| 모든 / 전부 / every / all | 센 명령과 개수 |
| 유일한 / only / 하나뿐 | 반례를 찾아본 `grep` |
| 정확히 N개 / exactly N | N 을 뱉은 명령의 출력 |
| 범위 밖 / out of scope | 그 대상의 **생성 지점**을 센 `grep` |
| A 에서 가져왔다 / taken from | A 를 연 `sed -n`. **다른 파일이면 그렇게 쓴다** |
| 바뀐 게 없다 / nothing changed | 대조한 diff 명령 |

**세 번 틀린 실제 예** (전부 2026-09-21, 전부 §4 를 읽은 뒤에 일어났다):

```bash
# "P0 4개가 정확히 이걸 금지한다" → 행을 열어보니 1개(SX-59). 나머지 셋은 다른 범위:
#   SX-01 = 미션 헤더 안 · SX-06 = 코치 rail · SX-07 = 코치가 먼저 거는 개입
grep -n "| SX-01 \|| SX-06 \|| SX-07 \|| SX-59 " docs/requirements/studio-learning-experience.md

# "각 항목은 그 역량의 insufficient 줄에서 왔다" → legacy 는 전부 "historical"
sed -n '105,113p' worker/src/lib/measurement-core/capability-models.ts

# "기준선 차이는 정확히 2줄" → 4줄
git show <커밋>:worker/test/fixtures/profile-serving-baseline.json > /tmp/old.json
# 축별 비교 6줄이면 센다
```

---

## 5. 검증은 2단, 그리고 **초록이 초록인지 확인한다**

v3 의 2단(순수 판정 → 실기)은 그대로.

### 5a. **건너뛴 테스트는 초록으로 보고된다** (신규)

2026-09-21 에 SX-59 **P0** 게이트의 렌더 테스트가 **CI 에서 100% 건너뛰어지고 있었다.**
`pr-ci.yml` 이 `webview-ui` 의존성을 안 깔아 `rendererStatus()` 가 계속
`webview-deps-missing` 이었고, 스위트는 "0 fail" 로 보고됐다.

새 테스트를 넣었으면 **CI 에서 실제로 도는지** 센다:

```bash
grep -c "<새파일명>" worker/package.json          # worker 는 손으로 나열한다
node --experimental-strip-types test/<새파일>.smoke.mjs 2>&1 | grep -E "^ℹ (pass|skipped)"
grep -n "npm ci" .github/workflows/pr-ci.yml      # 그 잡이 의존성을 까나
```

### 5b. FAIL 이 나오면 순서가 정해져 있다

1. **계측기가 틀렸나** — 여기서 대부분 끝난다
2. 제품이 틀렸나

---

## 6. 적대적 검토는 **PR 전 필수**다

2026-09-21 검토는 22건 보고 → 16건 확인 → **HIGH 4건이 배포를 막을 것**이었다.
게이트 여덟 개를 전부 통과한 뒤에 그랬다. **게이트는 검토를 대신하지 않는다.**

네 렌즈로 돌리고, 각 발견은 **반증 우선**으로 독립 검증한다(기본값 `refuted=true`):

1. **migration** — 저장된 데이터·출하된 앱·기존 코호트가 깨지나
2. **requirements** — 인용한 요구가 정말 그 말을 하나 (행을 열어 인용)
3. **tests** — 결함을 심어 **실제로 돌려서** 빨개지나. 작업 트리는 원상복구
4. **scope-claims** — 산문의 사실 주장을 하나씩 센다

**비용 주의: GitHub API 레이트 리밋(시간당 5000)을 태운다.** 2026-09-21 에 검토
에이전트 26개가 리밋을 소진해 **PR 생성이 1시간 막혔다.** 검토 뒤 바로 PR 을 낼
계획이면 검토 프롬프트에서 `gh` 사용을 제한하거나 순서를 바꾼다.

---

## 7. 먼저 읽을 것

```
.claude/hypeproof/ux/STATUS.md              ← 지금 상태. 제일 먼저
.claude/rules/verification.md               ← 관측 규율. 이 문서보다 우선한다
docs/adr/0010-observation-capability-split.md
docs/requirements/studio-learning-experience.md   (SX-01~60)
docs/requirements/studio-native-trial-ux.md       (TUX-*)
.claude/hypeproof/ux/AUTONOMY_POLICY.md · GIT_POLICY.md · PROJECT_RULES.md
```

---

## 8. 시작 절차 — 환경부터 센다

```bash
cd /Users/jaylee/CodeWorkspace/hypeproof-studio/.claude/worktrees/claude-epic
git status --short && git log --oneline -5
cd worker && npm test && npx tsc --noEmit
cd ../extensions/hypeproof-chat && npm test && npx tsc --noEmit
cd webview-ui && npm run build
```

**기준선이 빨가면 그것부터 적는다** — 내 변경 탓으로 오해하지 않기 위해서다.

**합성 코호트 신설·카나리 플래그는 허용**, 기존 코호트 변경은 금지(§10).
`canary-sdk-contract` 가 이미 CI 전용 합성 프로필이다 — 도달성 테스트의 피험체로 쓴다.

`hype-pr` 은 `GH_TOKEN` 이 필요하다: `GH_TOKEN="$(gh auth token)" python3 scripts/hype-pr/pr.py …`

---

## 9. PR

`hype-pr` 를 통한다. `gh pr create` 직접 호출 금지.

```bash
export GH_TOKEN="$(gh auth token)"
git fetch origin main
python3 scripts/hype-pr/pr.py inspect --repo jayleekr/hypeproof-studio \
  --output /tmp/hpr-inspect.json --assessment-template /tmp/hpr-assess.json
# 평가서를 채운다. 실제로 걸린 함정 넷:
#   1. fingerprint 는 inspect 마다 바뀐다 → inspect·채움·prepare 를 한 명령에 이어 돌린다
#   2. evidence 는 **20자 이상** ("Clean on abc1234." 는 탈락)
#   3. disposition: unknown 은 followups 에 **추적 이슈 URL** 이 있어야 한다
#   4. implementation 링크는 **requirement 노드와 test 노드가 둘 다** 필요하다 (design 은 안 됨)
python3 scripts/hype-pr/pr.py prepare --repo jayleekr/hypeproof-studio --assessment /tmp/hpr-assess.json
python3 scripts/hype-pr/pr.py create --repo jayleekr/hypeproof-studio --head <branch> \
  --title '…' --body-file /tmp/pr-body.md --author jayleekr --preparation <receipt> --apply
```

PR 본문에 **"검증하지 않은 것"** 절을 반드시 둔다. 실기 증거·실제 provider 호출·
GUI 스위트 중 안 한 것을 **이름으로** 적는다.

---

## 10. 절대 하지 않는 것

- `bash build.sh` 를 승인 없이 (1~2시간, 10~20 GB)
- `main` 직접 push · force push · `git reset --hard` · `git clean -fd` · 맨 `git stash`
- 이 워크트리에서 `git add -A` (심링크 node_modules, #318 유출)
- 프로덕션 워커 배포 · Cloudflare 설정 · 시크릿 · 계정/결제/권한 변경
- **기존 코호트 프로필·참가자 데이터·기존 수업 정책 변경** (합성 코호트·카나리는 허용)
- 화면이 잠겨 있지 않을 때 Electron 띄우기
- Lab 저장소 수정 — "Lab 에 넘길 것"에 적는다
- **테스트 단언을 약하게 만들어 통과시키기 · 통과선 내리기** — 단언은 강화만 한다
- **새 점수·채점기·제2 저장소·랭킹·배지·스트릭** — 어떤 사유로도
- **작업 화면에 학생 대상 평가·역량 이름·점수** (SX-59)
- `vscodium-base/vscode/` · `VSCode-*/` 직접 편집
- 시크릿을 추적 파일에

---

## 11. 끝내는 방법

1. 게이트 여덟 개 상태를 **숫자로** 적는다
2. **적대적 검토를 돌리고 확인된 건을 고친다** — 남기고 가지 않는다
3. `STATUS.md` 를 갱신한다 — 다음 세션이 읽을 단 하나의 문서
4. 하지 못한 것을 **이름으로** 적는다. "대체로 됐다" 는 보고가 아니다

> 이 세션의 어떤 초록도 실기 증거를 대신하지 않는다.
> 그리고 **게이트를 다 통과한 것도 적대적 검토를 대신하지 않는다.**
