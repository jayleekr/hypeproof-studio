# Runbook — 보아치과 HypeProof 티저 세션 (2026-05-26, D-day)

강사·보조강사(비-Jay)가 당일 그대로 따라가는 단일 런북. 빌드/릴리스 메커니즘은
[RELEASE-CHECKLIST.md](./RELEASE-CHECKLIST.md) · [../worker/DEPLOY.md](../worker/DEPLOY.md)
가 진실 소스 — 여기선 **이 행사 고유의 절차만**. 중복 금지.

용어: 본 행사는 **티저 세션**(≠ 워크숍). "워크숍"이라는 단어는 *SK바이오팜 가족 워크숍 (8h)*
한정 — 혼동 금지. "참가자" = 보아치과측 청중(직접 Studio 써보는 사람들), "강사·보조강사" =
HypeProof 측 6명(런북 실행, 강의 진행).

| | |
|---|---|
| 행사 | 보아치과 HypeProof 티저 세션 (성인, ~3h) |
| D-day | 2026-05-26 |
| cohort | `boah-dental-2026-a` |
| profile | `boah-dental-teaser-2026-s1` |

## 0. 누가 / 무엇을
강사·보조강사 6명이 실행. 빌드는 안 함 — 프리빌드 `.app`을 받음 (Phase 5 빌드는 Jay 완료 — #18).

## 1. 선행 조건 (D-1까지 확인)
- [ ] SaaS 라이브: `curl -s https://api.hypeproof-ai.xyz/v1/health` → `{"ok":true,...}`
- [ ] **dental profile이 프로덕션에 배포됨** — `boah-dental-teaser-2026-s1`은 main에
      머지됐으나 prod Worker는 *마지막 배포 번들*을 돎. 강의 전 `worker/`에서
      `npx wrangler deploy` 1회 필요 (담당: Jay/재형, DEPLOY.md). **이게 안 되면
      §2가 fail 한다.**
- [ ] 빌트인 `.app` 준비 (Phase 5 게이트 #18, Jay 5/23) — 채팅 패널 active

## 2. D-3 리허설 + D-1 사전 검증 (프로덕션 왕복)
**리허설은 D-1이 아니라 D-3 (5/23 금요일 저녁)** — D-1·D-2는 fix buffer. 같은 명령을
D-3 리허설 / D-1 최종확인 두 번 돌립니다.


```bash
cd worker
BASE_URL=https://api.hypeproof-ai.xyz \
  COHORT=boah-dental-2026-a PROFILE=boah-dental-teaser-2026-s1 \
  bash scripts/smoke-dental-e2e.sh
```
→ `═══ PASS ═══` 이어야 GO. (이 스크립트가 토큰발급→403→roster→session→200
한국어 응답까지 한 번에 검증 — #14.) FAIL이면 §5.

## 3. 토큰 배포

참가자 1인 1토큰. **강사 self-service 가 기본** — 강사가 본인 issuer 토큰만
가지고 있으면 prod 시크릿 없이 학생 토큰을 무한 발급할 수 있다 (PR #61).

### Option D — sediment self-fetch (강사가 본인 토큰을 한 줄로 받음, 2026-05-22 추가)

본인 issuer 토큰 자체를 분실했거나 새 머신에서 셋업 중일 때:

```bash
curl -u <name>:<passphrase> https://hypeproof-sediment.fly.dev/api/v1/issuer/<name>
```

응답에 본인 issuer 토큰 (`.token` 필드) 그대로 들어있음 — 그걸 Option A·B 의
"본인 issuer 토큰 paste" 자리에 쓰면 됨. passphrase 는 Jay 가 5/22 개별 DM
으로 보낸 것.

토큰 만료 (60일) 가까워질 때 본인이 갱신:

```bash
curl -u <name>:<passphrase> -X POST \
  -H 'content-type: application/json' -d '{"confirm":true,"days":60}' \
  https://hypeproof-sediment.fly.dev/api/v1/issuer/<name>/rotate
```

응답에 새 토큰. 옛 jti 는 자동 revoke. 새 토큰을 본인이 어딘가 저장하세요 —
sediment Fly 재시작 시 in-memory 갱신만 휘발될 수 있음 (best-effort persist).

구현 참고: `sediment#14` / `sediment/services/sediment/applications/sediment_platform/routers/issuer.py`.

### Option A — `/issuer` 웹 페이지 (어디서나, 권장)

1. <https://api.hypeproof-ai.xyz/issuer> 접속
2. 본인 issuer 토큰 paste (Jay가 5/20 DM으로 보낸 것; 분실 시 단톡 / DM)
3. 학생 handle (소문자·영숫자·하이픈), cohort, profile, hours 입력 → **발급**
4. 출력된 토큰을 학생에게 전달

issuer 토큰은 세션 동안 sessionStorage에 자동 저장 — 한 번 paste 후 연속 발급
간단. **localStorage 사용 안 함** (탭 닫으면 사라짐 — 의도된 보안).

### Option B — Studio v0.1.4+ 인앱 명령

브라우저 갔다 오기 싫으면 Studio에서 바로:
- `Cmd+Shift+P` → `HypeProof Chat: 학생 토큰 발급 (강사용)`
- issuer 토큰은 SecretStorage에 저장 (keychain 동급) — 한 번 입력하면 자동 사용
- cohort 디폴트는 issuer 토큰의 scope에서 자동 추출
- 발급 성공 시 클립보드 자동 복사 + 만료 시각 토스트

### Option C — `issue-token.ts` (긴급 fallback, Jay만)

Self-service가 안 되는 비상 상황:
```bash
cd worker
HPS_SIGNING_SECRET=<prod와 동일> node --experimental-strip-types \
  scripts/issue-token.ts --user <참가자핸들> \
  --cohort boah-dental-2026-a --profile boah-dental-teaser-2026-s1 --hours 6
```

이건 prod 시크릿이 손에 있어야 작동 — 강사 보내지 말 것.

### 공통

- 발급한 `<참가자핸들>` 들을 §4의 roster에 **그대로** 넣어야 인가됨.
- 로컬 dev 시연이면 `bash scripts/dev-stack.sh` (cohort/profile env override —
  #15) 가 토큰을 `/tmp/hps-token.txt`에 써서 앱이 자동 임포트.

### 강사 issuer 토큰 재발급 (Jay만)

분실 등으로 issuer 토큰을 새로 만들어야 할 때 (시그니처 secret 필요):

```bash
cd worker
HPS_SIGNING_SECRET=<prod와 동일> node --experimental-strip-types \
  scripts/issue-issuer-token.ts \
  --instructor <name> \
  --cohorts boah-dental-2026-a,sk-biopharm-2026-a \
  --profiles boah-dental-teaser-2026-s1,sk-biopharm-kids-2026-grade-3-4-s1 \
  --max-hours 12 --days 60
```

JSON 출력에서 `token` 필드만 추출 → 본인에게 DM. **보안 사유로 기존 issuer를
revoke해야 하면**: 5/20 발급 jti는 memory `instructor-issuer-tokens-2026-05-20`
참고하여 `POST /admin/tokens/revoke` (admin 인증). 새 토큰 재발급은 위 명령.

## 4. 당일 설치 + 세션 오픈
1. 참가자 설치 (원라이너):
   `curl -fsSL https://raw.githubusercontent.com/jayleekr/hypeproof-studio-releases/main/install-mac.sh | bash`
   (현재 빌드 디폴트가 이미 `api.hypeproof-ai.xyz/v1` — proxyUrl 수동설정 불필요)
2. roster 등록 + 티저 세션 오픈 (강사, admin):
   ```bash
   AUTH=$(printf ':%s' "<HPS_ADMIN_PASSWORD>" | base64)
   curl -fsS -X POST https://api.hypeproof-ai.xyz/admin/cohorts/boah-dental-2026-a/roster \
     -H "Authorization: Basic $AUTH" -H 'content-type: application/json' \
     -d '{"users":["참가자1","참가자2","..."]}'
   curl -fsS -X POST https://api.hypeproof-ai.xyz/admin/cohorts/boah-dental-2026-a/session \
     -H "Authorization: Basic $AUTH" -H 'content-type: application/json' \
     -d '{"profile_id":"boah-dental-teaser-2026-s1","starts_at":"<ISO now>","ends_at":"<ISO +4h>"}'
   ```
3. 참가자: 💬 → "HypeProof Chat: Set Workshop Token" → 본인 토큰 붙여넣기 → "안녕"

## 5. 폴백
| 증상 | 대응 |
|---|---|
| 채팅 403 | roster에 그 user 없음 / 세션 창 밖 → §4-2 roster·session 재확인 |
| 채팅 401 | 토큰 서명 불일치(서명키 prod≠발급) → prod `HPS_SIGNING_SECRET`로 재발급 |
| Gemini 503 / 끊김 | `gemini-2.5-flash` 고정 + 503 retry 이미 적용. 지속 시 잠깐 후 재시도 |
| profile not found | §1 — prod 미배포. `wrangler deploy` 후 §2 재실행 |
| 앱 Gatekeeper 경고 | install-mac.sh가 quarantine 해제함; 그래도 막히면 우클릭→열기 |
| 전면 불능 | 로컬 `dev-stack.sh` + curl 데모로 대체, 또는 재일정 (이 티저는 SK 1회차 Plan B(METAPLAN §9)와 무관) |

## 6. 수용 게이트 (이게 true면 성공)
- [ ] §2 프로덕션 스모크 PASS
- [ ] 참가자 전원 설치 성공
- [ ] 참가자 전원 토큰 등록 + "안녕" → 한국어 응답
- [ ] 4원칙(전심전력·만족유예·잇기·역목표)을 *직접 해봤다* 는 체험 확인 (#13)

## 참조 (중복 안 함)
- 빌드/릴리스: [RELEASE-CHECKLIST.md](./RELEASE-CHECKLIST.md)
- Worker 배포/시크릿: [../worker/DEPLOY.md](../worker/DEPLOY.md)
- 스모크: `worker/scripts/smoke-dental-e2e.sh` (#14) · 로컬 스택: `scripts/dev-stack.sh` (#15)
- Plan B (SK 1회차 전용, 이 티저 아님): METAPLAN §9
